/**
 * PlanAndExecute 执行策略 — 先规划完整计划，再逐步执行。
 * 对应 Java 框架的 PlanAndExecuteStrategy
 *
 * 三阶段流程：
 *   1. Planning：调用 LLM 生成结构化执行计划（JSON 步骤列表）
 *   2. Execution：对每个步骤，使用内部 ReAct 循环执行（支持工具调用）
 *   3. Synthesis：汇总所有步骤结果，生成最终回答
 *
 * 支持自适应重规划：当某个步骤执行失败时，可重新规划剩余步骤。
 */

import { syncChat, streamChat } from './llm-client.js'
import { formatToolsForOpenAI, parseToolCalls, formatToolResult } from './tool.js'
import { childContext, extractUsage, utf8ByteLength } from './telemetry.js'

/** 计划步骤状态 */
export const StepStatus = {
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  FAILED: 'failed',
  SKIPPED: 'skipped',
}

/**
 * Zero-valued `Usage_Object` — matches the shape produced by
 * `extractUsage()` / `_sumUsage()` in telemetry/agent. Every field is a
 * number (no `null`) so callers can always sum into it without null-checks;
 * this is the per-step accumulator, not a direct provider echo.
 */
function _zeroStepUsage() {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cached_tokens: 0,
    reasoning_tokens: 0,
  }
}

/**
 * Null-safe addition of a provider-normalized Usage_Object into an
 * accumulator. `null` contributes 0 so that steps without usage reports
 * don't poison the total (matches agent.js::_foldRunIntoSession).
 * @param {{input_tokens:number,output_tokens:number,cached_tokens:number,reasoning_tokens:number}} acc
 * @param {{input_tokens:number|null,output_tokens:number|null,cached_tokens:number|null,reasoning_tokens:number|null}} usage
 */
function _addUsage(acc, usage) {
  if (!usage) return
  acc.input_tokens += usage.input_tokens ?? 0
  acc.output_tokens += usage.output_tokens ?? 0
  acc.cached_tokens += usage.cached_tokens ?? 0
  acc.reasoning_tokens += usage.reasoning_tokens ?? 0
}

/**
 * 单个计划步骤 — 持有该步骤的完整执行轨迹，便于审计 / 回放 / UI 渲染 / replan。
 *
 * 字段约定（与 Agent 的 Run_Metrics / OTel GenAI 语义约定对齐）：
 *   - `toolCalls`:   该步骤内实际发起的工具调用的结构化记录
 *   - `messages`:    该步骤内部 ReAct 循环的完整消息序列（OpenAI 格式）
 *   - `usage`:       该步骤跨轮累积的 token 使用量（null-safe 求和）
 *   - `rounds`:      该步骤内部 ReAct 循环的实际轮数
 *   - `durationMs`:  该步骤从 markInProgress 到 markCompleted/markFailed 的墙钟耗时
 */
export class PlanStep {
  constructor(index, description) {
    this.index = index
    this.description = description
    this.status = StepStatus.PENDING
    this.result = null
    this.durationMs = 0
    // Structured trace — populated by `_reactLoop` during step execution.
    // Initialized to empty collections so consumers can iterate without
    // null-checks even on PENDING / SKIPPED steps.
    this.toolCalls = []
    this.messages = []
    this.usage = _zeroStepUsage()
    this.rounds = 0
  }

  markInProgress() { this.status = StepStatus.IN_PROGRESS }

  markCompleted(result, durationMs) {
    this.status = StepStatus.COMPLETED
    this.result = result
    this.durationMs = durationMs
  }

  markFailed(reason, durationMs) {
    this.status = StepStatus.FAILED
    this.result = reason
    this.durationMs = durationMs
  }

  markSkipped(reason) {
    this.status = StepStatus.SKIPPED
    this.result = reason
  }
}

/** 默认配置 */
const DEFAULTS = {
  maxPlanSteps: 35,
  stepMaxRounds: 300,
  maxReplanAttempts: 2,
  planningTimeoutMs: 180_000,
  synthesisTimeoutMs: 180_000,
}

/**
 * PlanAndExecuteStrategy — 可独立使用，也可通过 Agent 的 strategy 选项启用。
 *
 * @param {object} opts
 * @param {string} opts.url - LLM API URL
 * @param {string} opts.apiKey - API Key
 * @param {string} opts.model - 模型名称
 * @param {number} [opts.temperature=0]
 * @param {import('./tool.js').ToolDef[]} [opts.tools=[]]
 * @param {number} [opts.maxPlanSteps=35]
 * @param {number} [opts.stepMaxRounds=300]
 * @param {number} [opts.maxReplanAttempts=2]
 * @param {number} [opts.planningTimeoutMs=120000]
 * @param {number} [opts.synthesisTimeoutMs=120000]
 * @param {boolean} [opts.useStreaming=false] - 使用流式 API 调用（浏览器端建议开启）
 * @param {boolean} [opts.validateStreamCompletion=true] - 透传给内部 streamChat
 *   调用的流完整性校验开关（仅在 useStreaming 时生效）；对齐 Agent 的同名选项，
 *   使 plan_and_execute 策略下的 escape hatch 与 react 策略一致生效（Finding I-1）。
 * @param {function} [opts.onPhase] - (phase, message) => void
 * @param {function} [opts.onPlanGenerated] - (steps: PlanStep[]) => void
 * @param {function} [opts.onStepStart] - (index, description, step: PlanStep) => void
 *   第三个参数是完整的 PlanStep（含 `status` / `toolCalls` / `messages` /
 *   `usage` / `rounds`，此时均为初始化后的空集合）。原 `(index, description)`
 *   签名完全保留 — 仅在末尾追加了 `step`，老代码无需修改。
 * @param {function} [opts.onStepComplete] - (index, success, result, step: PlanStep) => void
 *   第四个参数是完整的 PlanStep，包含 `status` / `result` / `durationMs` /
 *   `toolCalls` / `messages` / `usage` / `rounds`，适合做审计 / 回放 / UI
 *   渲染 / replan prompt 注入。原 `(index, success, result)` 签名完全保留。
 * @param {function} [opts.onPlanRevised] - (steps: PlanStep[]) => void
 */
export class PlanAndExecuteStrategy {
  constructor(opts) {
    this.url = opts.url
    this.apiKey = opts.apiKey
    this.model = opts.model
    this.temperature = opts.temperature ?? 0
    this.tools = opts.tools ?? []
    this.maxPlanSteps = opts.maxPlanSteps ?? DEFAULTS.maxPlanSteps
    this.stepMaxRounds = opts.stepMaxRounds ?? DEFAULTS.stepMaxRounds
    this.maxReplanAttempts = opts.maxReplanAttempts ?? DEFAULTS.maxReplanAttempts
    this.planningTimeoutMs = opts.planningTimeoutMs ?? DEFAULTS.planningTimeoutMs
    this.synthesisTimeoutMs = opts.synthesisTimeoutMs ?? DEFAULTS.synthesisTimeoutMs
    this.useStreaming = opts.useStreaming ?? false
    this.validateStreamCompletion = opts.validateStreamCompletion ?? true

    // 回调 —— 统一经 safeCallback 包裹：应用侧回调抛异常（或异步 reject）
    // 不得打断 plan/step 主流程（与 Agent._safeHook 同一约定）。
    this.onPhase = safeCallback(opts.onPhase ?? (() => {}), 'onPhase')
    this.onPlanGenerated = safeCallback(opts.onPlanGenerated ?? (() => {}), 'onPlanGenerated')
    this.onStepStart = safeCallback(opts.onStepStart ?? (() => {}), 'onStepStart')
    this.onStepComplete = safeCallback(opts.onStepComplete ?? (() => {}), 'onStepComplete')
    this.onPlanRevised = safeCallback(opts.onPlanRevised ?? (() => {}), 'onPlanRevised')
  }

  /**
   * 执行 PlanAndExecute 策略
   * @param {string} userMessage
   * @param {object} [opts]
   * @param {AbortSignal} [opts.signal]
   * @param {Array<{role:string,content:string}>} [opts.history] - 对话历史（user/assistant 明文消息，不含当前 userMessage），用于规划与汇总阶段感知上下文
   * @param {object} [opts.telemetry] - 根 TelemetryContext（来自 Agent 当前 run）。传 null 则全链路 no-op。
   * @returns {Promise<{ content: string, plan: PlanStep[], toolCallHistory: object[] }>}
   *   `toolCallHistory` 是所有已执行 step 的 `toolCalls` 的 flat-map，按
   *   步骤顺序聚合；每条记录包含 `{ stepIndex, name, arguments, result, ok,
   *   errorKind?, durationMs, bytes }`。
   */
  async execute(userMessage, { signal, history = [], telemetry = null } = {}) {
    // Per-run root context — used by _callLlm to derive per-operation child
    // contexts. Assigning on each invocation is sufficient for the strategy's
    // existing single-run-at-a-time usage pattern (matches how callbacks
    // like onPhase / onStepStart are already scoped).
    this._rootCtx = telemetry
    const cleanHistory = sanitizeHistory(history)

    // ============ Phase 1: Planning ============
    this.onPhase('planning', '正在分析任务并制定执行计划...')

    let plan = await this._generatePlan(userMessage, signal, cleanHistory)
    if (!plan || plan.length === 0) {
      this.onPhase('fallback', '计划生成失败，切换到 ReAct 模式...')
      // Fallback 路径也要留下 trace：合成一个 "step 0" 作为载体，
      // 这样 toolCallHistory / plan 对消费者仍然是 well-formed。
      const fallbackStep = new PlanStep(0, userMessage)
      fallbackStep.markInProgress()
      const startedAt = Date.now()
      const result = await this._reactLoop(
        userMessage, null, this.stepMaxRounds, signal, cleanHistory, fallbackStep,
      )
      fallbackStep.markCompleted(result, Date.now() - startedAt)
      return {
        content: result,
        plan: [fallbackStep],
        toolCallHistory: _flattenToolCalls([fallbackStep]),
      }
    }

    this.onPlanGenerated(plan)

    // ============ Phase 2: Execution ============
    this.onPhase('executing', '开始执行计划...')

    let stepsContext = ''
    let replanCount = 0

    for (let i = 0; i < plan.length; i++) {
      signal?.throwIfAborted()
      const step = plan[i]

      step.markInProgress()
      // Keep the historical positional signature `(index, description)` as
      // the leading arguments so existing callbacks remain source-compatible;
      // append the full PlanStep as a trailing argument for new consumers
      // that want the structured trace.
      this.onStepStart(step.index, step.description, step)

      const stepStart = Date.now()
      try {
        const stepResult = await this._executeStep(step, stepsContext, signal)
        const duration = Date.now() - stepStart

        step.markCompleted(stepResult, duration)
        stepsContext += `\n[Step ${step.index + 1} completed]: ${truncate(stepResult, 500)}`
        this.onStepComplete(step.index, true, stepResult, step)
      } catch (err) {
        const duration = Date.now() - stepStart
        const errorMsg = (err?.message ?? String(err)) || 'Step execution failed'
        step.markFailed(errorMsg, duration)
        stepsContext += `\n[Step ${step.index + 1} FAILED]: ${truncate(errorMsg, 300)}`
        this.onStepComplete(step.index, false, errorMsg, step)

        // 尝试重规划
        if (replanCount < this.maxReplanAttempts && i < plan.length - 1) {
          const revised = await this._attemptReplan(userMessage, plan, i, stepsContext, signal)
          if (revised && revised.length > 0) {
            replanCount++
            plan = mergeRevisedPlan(plan, i, revised)
            this.onPlanRevised(plan)
          }
        }
      }
    }

    // ============ Phase 3: Synthesis ============
    this.onPhase('synthesizing', '正在汇总执行结果...')

    const synthesis = await this._synthesizeResults(userMessage, plan, stepsContext, signal, cleanHistory)
    this.onPhase('completed', '执行完成')

    return {
      content: synthesis,
      plan,
      toolCallHistory: _flattenToolCalls(plan),
    }
  }

  /**
   * 流式执行 — 通过 async generator 推送进度事件
   * @param {string} userMessage
   * @param {object} [opts]
   * @param {AbortSignal} [opts.signal]
   * @param {Array<{role:string,content:string}>} [opts.history] - 对话历史（同 execute()）
   * @param {object} [opts.telemetry] - 根 TelemetryContext（同 execute()）
   * @yields {{ type: string, ... }}
   *   `step_start` / `step_complete` 附带 `step` 字段（完整 PlanStep 快照，
   *   便于审计 / UI 渲染）。`done` 附带 `toolCallHistory: object[]`。
   */
  async *stream(userMessage, { signal, history = [], telemetry = null } = {}) {
    this._rootCtx = telemetry
    let plan = null
    let stepsContext = ''
    let replanCount = 0
    const cleanHistory = sanitizeHistory(history)

    // Phase 1: Planning
    yield { type: 'phase', phase: 'planning', message: '正在分析任务并制定执行计划...' }

    plan = await this._generatePlan(userMessage, signal, cleanHistory)
    if (!plan || plan.length === 0) {
      yield { type: 'phase', phase: 'fallback', message: '计划生成失败，切换到 ReAct 模式...' }
      const fallbackStep = new PlanStep(0, userMessage)
      fallbackStep.markInProgress()
      const startedAt = Date.now()
      const result = await this._reactLoop(
        userMessage, null, this.stepMaxRounds, signal, cleanHistory, fallbackStep,
      )
      fallbackStep.markCompleted(result, Date.now() - startedAt)
      yield {
        type: 'done',
        content: result,
        plan: [snapshotStep(fallbackStep)],
        toolCallHistory: _flattenToolCalls([fallbackStep]),
      }
      return
    }

    yield { type: 'plan_generated', plan: plan.map(s => ({ index: s.index, description: s.description })) }

    // Phase 2: Execution
    yield { type: 'phase', phase: 'executing', message: '开始执行计划...' }

    for (let i = 0; i < plan.length; i++) {
      signal?.throwIfAborted()
      const step = plan[i]
      step.markInProgress()
      yield { type: 'step_start', index: step.index, description: step.description, step: snapshotStep(step) }

      const stepStart = Date.now()
      try {
        const stepResult = await this._executeStep(step, stepsContext, signal)
        const duration = Date.now() - stepStart
        step.markCompleted(stepResult, duration)
        stepsContext += `\n[Step ${step.index + 1} completed]: ${truncate(stepResult, 500)}`
        yield {
          type: 'step_complete',
          index: step.index,
          success: true,
          result: stepResult,
          duration,
          step: snapshotStep(step),
        }
      } catch (err) {
        const duration = Date.now() - stepStart
        const errorMsg = (err?.message ?? String(err)) || 'Step execution failed'
        step.markFailed(errorMsg, duration)
        stepsContext += `\n[Step ${step.index + 1} FAILED]: ${truncate(errorMsg, 300)}`
        yield {
          type: 'step_complete',
          index: step.index,
          success: false,
          result: errorMsg,
          duration,
          step: snapshotStep(step),
        }

        if (replanCount < this.maxReplanAttempts && i < plan.length - 1) {
          const revised = await this._attemptReplan(userMessage, plan, i, stepsContext, signal)
          if (revised && revised.length > 0) {
            replanCount++
            plan = mergeRevisedPlan(plan, i, revised)
            yield { type: 'plan_revised', plan: plan.map(s => ({ index: s.index, description: s.description, status: s.status })) }
          }
        }
      }
    }

    // Phase 3: Synthesis
    yield { type: 'phase', phase: 'synthesizing', message: '正在汇总执行结果...' }
    const synthesis = await this._synthesizeResults(userMessage, plan, stepsContext, signal, cleanHistory)
    yield { type: 'phase', phase: 'completed', message: '执行完成' }
    yield {
      type: 'done',
      content: synthesis,
      plan: plan.map(s => ({ index: s.index, description: s.description, status: s.status, result: s.result })),
      toolCallHistory: _flattenToolCalls(plan),
    }
  }

  // ==================== Planning ====================

  /**
   * 统一的 LLM 调用方法 — 根据 useStreaming 选择 syncChat 或 streamChat。
   * streamChat 返回的格式与 syncChat 一致（已内部重构），因此调用方无需区分。
   *
   * `operationName` 用于派生 TelemetryContext 的 `gen_ai.operation.name`
   * 标签（`'plan.planner'` / `'plan.synthesizer'` / `'plan.replan'` /
   * `'plan.step'`）。当策略未收到 `telemetry`（`_rootCtx == null`），
   * `childContext` 返回 `null`，llm-client 自动降级为 no-op。
   */
  async _callLlm(body, signal, operationName) {
    const ctx = childContext(this._rootCtx ?? null, operationName)
    const telemetry = ctx ? { ctx } : undefined
    if (this.useStreaming) {
      return streamChat({
        url: this.url,
        apiKey: this.apiKey,
        body,
        signal,
        onDelta: () => {},
        telemetry,
        validateCompletion: this.validateStreamCompletion,
      })
    }
    return syncChat({ url: this.url, apiKey: this.apiKey, body, signal, telemetry })
  }

  async _generatePlan(userMessage, signal, history = []) {
    const toolSummary = this.tools.map(t => `- ${t.name}: ${t.description}`).join('\n') || '(no tools available)'

    const planPrompt =
      'You are a planning agent. Your job is to analyze the user\'s request and create a clear, ' +
      'step-by-step execution plan.\n\n' +
      'Available tools:\n' + toolSummary + '\n\n' +
      'Instructions:\n' +
      '1. Break down the task into concrete, actionable steps\n' +
      '2. Each step should be independently executable\n' +
      '3. Consider dependencies between steps\n' +
      '4. Keep the plan concise (max ' + this.maxPlanSteps + ' steps)\n' +
      '5. Each step description should be specific enough for an executor to understand\n' +
      '6. If the prior conversation already contains concrete values/results the user refers to ' +
      '(e.g. "上个结果", "the previous answer"), INLINE those concrete values directly into the ' +
      'relevant step descriptions so the executor does not need to look them up again\n\n' +
      'Output your plan as a JSON array. Example format:\n' +
      '```json\n' +
      '[\n' +
      '  {"step": 1, "description": "Read the main configuration file to understand current settings"},\n' +
      '  {"step": 2, "description": "Search for all usages of the deprecated API"},\n' +
      '  {"step": 3, "description": "Modify each file to use the new API"}\n' +
      ']\n' +
      '```\n\n' +
      'Output ONLY the JSON array, no other text.'

    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: planPrompt },
        ...history,
        { role: 'user', content: userMessage },
      ],
      temperature: this.temperature,
    }

    try {
      const response = await callWithTimeout(
        () => this._callLlm(body, signal, 'plan.planner'),
        this.planningTimeoutMs,
      )
      const content = response.choices?.[0]?.message?.content ?? ''
      return parsePlan(content, this.maxPlanSteps)
    } catch (err) {
      return []
    }
  }

  // ==================== Step Execution ====================

  async _executeStep(step, previousStepsContext, signal) {
    const systemPrompt = buildStepSystemPrompt(step, previousStepsContext)
    return this._reactLoop(
      'Execute this step: ' + step.description,
      systemPrompt,
      this.stepMaxRounds,
      signal,
      [],
      step,
    )
  }

  /**
   * 内部 ReAct 循环 — 复用 Agent 的核心逻辑，用于执行单个步骤。
   *
   * 若传入 `step`（PlanStep 实例），会把该次循环的 messages / toolCalls /
   * usage / rounds 写入 step，让上层（execute / onStepComplete）能拿到完整
   * trace 做审计、replan prompt 注入或可视化。传 null 时（无 step 上下文的
   * 场景，如 fallback）退化为不写 trace。
   *
   * @param {string} userMessage
   * @param {string|null} systemPrompt - 步骤级 system prompt（null 时使用默认）
   * @param {number} maxRounds
   * @param {AbortSignal} [signal]
   * @param {Array<{role:string,content:string}>} [history]
   * @param {PlanStep|null} [step] - 可选的 trace 接收方；populated in-place
   * @returns {Promise<string>}
   */
  async _reactLoop(userMessage, systemPrompt, maxRounds, signal, history = [], step = null) {
    const toolMap = Object.fromEntries(this.tools.map(t => [t.name, t]))
    const openaiTools = this.tools.length > 0 ? formatToolsForOpenAI(this.tools) : undefined

    const messages = []
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt })
    }
    // 仅在 fallback（无 step 上下文）场景注入历史；步骤执行时 history 为 []，
    // 因为 step description 已经由 planner 内联了需要的具体值。
    if (history.length > 0) {
      messages.push(...history)
    }
    messages.push({ role: 'user', content: userMessage })

    for (let round = 0; round < maxRounds; round++) {
      signal?.throwIfAborted()

      const body = {
        model: this.model,
        messages,
        temperature: this.temperature,
        ...(openaiTools ? { tools: openaiTools } : {}),
      }

      const response = await this._callLlm(body, signal, 'plan.step')
      const message = response.choices?.[0]?.message
      if (!message) throw new Error('Empty LLM response')

      // Accumulate usage into the step trace (null-safe; see _addUsage).
      if (step) {
        step.rounds += 1
        _addUsage(step.usage, extractUsage(response))
      }

      const textContent = message.content ?? ''
      const toolCalls = parseToolCalls(response)

      if (toolCalls.length === 0) {
        // Capture the final assistant turn so the step's message trace ends
        // with the same content the caller observes as `step.result`.
        const finalAssistant = { role: 'assistant', content: textContent }
        messages.push(finalAssistant)
        if (step) step.messages = messages.slice()
        return textContent
      }

      // 添加 assistant 消息（含 tool_calls）
      messages.push({
        role: 'assistant',
        content: textContent || null,
        tool_calls: message.tool_calls,
      })

      // 执行工具并添加结果
      for (const call of toolCalls) {
        const tool = toolMap[call.name]
        const toolStartPerf = _perfNow()
        let result
        /** @type {undefined | 'not_found' | 'truncated_args' | 'aborted' | 'exception'} */
        let errorKind
        if (call._truncated && call._parseError) {
          errorKind = 'truncated_args'
          result = `Error: Tool call "${call.name}" was truncated by the model (finish_reason=length). ` +
            `The arguments JSON is incomplete and could not be parsed. Please retry with shorter arguments.`
        } else if (!tool) {
          errorKind = 'not_found'
          result = `Error: Tool "${call.name}" not found. Available: ${this.tools.map(t => t.name).join(', ')}`
        } else {
          try {
            result = await tool.execute(call.arguments, { signal })
          } catch (err) {
            errorKind = (err?.name === 'AbortError' || signal?.aborted)
              ? 'aborted'
              : 'exception'
            // 防 `throw null` / 原始值打穿 catch 块（与 agent.js 同一约定）。
            result = `Error executing ${call.name}: ${err?.message ?? String(err)}`
          }
        }
        messages.push(formatToolResult(call.id, call.name, result))

        // Record the call on the step's structured trace. `bytes` mirrors
        // the utf-8 length of the string appended to `messages`, matching
        // the Agent ReAct-loop tool.call payload shape.
        if (step) {
          /** @type {{stepIndex:number,id:string,name:string,arguments:object|null,result:string,ok:boolean,errorKind?:string,durationMs:number,bytes:number}} */
          const record = {
            stepIndex: step.index,
            id: call.id,
            name: call.name,
            arguments: call.arguments,
            result: typeof result === 'string' ? result : JSON.stringify(result),
            ok: errorKind === undefined,
            durationMs: _perfNow() - toolStartPerf,
            bytes: utf8ByteLength(String(result)),
          }
          if (errorKind !== undefined) record.errorKind = errorKind
          step.toolCalls.push(record)
        }
      }
    }

    // 达到 maxRounds — 保存 trace（含所有 tool_calls / tool 结果）并返回。
    if (step) step.messages = messages.slice()
    return '[max rounds exceeded]'
  }

  // ==================== Replanning ====================

  async _attemptReplan(userMessage, currentPlan, failedStepIndex, stepsContext, signal) {
    const completedSteps = currentPlan
      .filter(s => s.status === StepStatus.COMPLETED)
      .map(s => `✅ Step ${s.index + 1}: ${s.description}`)
      .join('\n')

    const failedStep = `❌ Step ${failedStepIndex + 1}: ${currentPlan[failedStepIndex].description}` +
      ` — ${currentPlan[failedStepIndex].result}`

    // Inline the failed step's tool-call trace into the replan prompt so the
    // planner can see *what was actually attempted* (previously lost — see
    // improvements.md F-A2 / D-10 / D-11). The trace is kept compact: the
    // tool name, stringified arguments, a summary of the outcome, and
    // truncated result text. Empty trace yields the empty string so
    // prompt shape is preserved.
    const failedTrace = _formatFailedStepTrace(currentPlan[failedStepIndex])

    const replanPrompt =
      `The original task was: ${userMessage}\n\n` +
      `Completed steps:\n${completedSteps}\n\n` +
      `Failed step:\n${failedStep}\n\n` +
      (failedTrace ? `Failed step tool calls:\n${failedTrace}\n\n` : '') +
      `Context:\n${stepsContext}\n\n` +
      'Please create a revised plan for the REMAINING work, taking into account ' +
      'what has already been completed and the failure reason.\n\n' +
      'Output ONLY a JSON array of remaining steps. Example:\n' +
      '[{"step": 1, "description": "..."}]'

    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: 'You are a planning agent. Revise the execution plan based on completed and failed steps.' },
        { role: 'user', content: replanPrompt },
      ],
      temperature: this.temperature,
    }

    try {
      const response = await callWithTimeout(
        () => this._callLlm(body, signal, 'plan.replan'),
        this.planningTimeoutMs,
      )
      const content = response.choices?.[0]?.message?.content ?? ''
      const revisedSteps = parsePlan(content, this.maxPlanSteps)
      if (revisedSteps && revisedSteps.length > 0) {
        const startIndex = failedStepIndex + 1
        return revisedSteps.map((s, i) => new PlanStep(startIndex + i, s.description))
      }
    } catch (err) {
      // replan failed, continue with original plan
    }
    return null
  }

  // ==================== Synthesis ====================

  async _synthesizeResults(userMessage, plan, stepsContext, signal, history = []) {
    const fallback = buildFallbackSynthesis(plan)

    const completedCount = plan.filter(s => s.status === StepStatus.COMPLETED).length
    if (plan.length === 1 && completedCount === 1) return plan[0].result
    if (completedCount === 0) return fallback

    const synthesisPrompt =
      'You completed a multi-step task. Here is the summary:\n\n' +
      `Original request: ${userMessage}\n\n` +
      `Steps and results:\n${stepsContext}\n\n` +
      'Please provide a comprehensive final answer to the original request, ' +
      'incorporating the results from all completed steps and any relevant context from the ' +
      'prior conversation. Be concise but thorough.'

    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: 'You are a helpful assistant. Synthesize the results of a multi-step execution plan into a final answer, using prior conversation turns as context when relevant.' },
        ...history,
        { role: 'user', content: synthesisPrompt },
      ],
      temperature: this.temperature,
    }

    try {
      const response = await callWithTimeout(
        () => this._callLlm(body, signal, 'plan.synthesizer'),
        this.synthesisTimeoutMs,
      )
      const content = response.choices?.[0]?.message?.content ?? ''
      return content || fallback
    } catch (err) {
      return fallback
    }
  }
}

// ==================== Utility Functions ====================

/**
 * 把应用侧回调包一层保护：同步 throw 被吞（console.warn），返回 Promise
 * 时挂一个 no-op rejection handler，避免异步回调以 unhandled rejection
 * 的形式炸掉进程。函数声明（可提升）—— 构造函数在模块顶部即可引用。
 * @param {Function} fn
 * @param {string} name - 仅用于 warn 日志
 * @returns {Function}
 */
function safeCallback(fn, name) {
  return (...args) => {
    try {
      const ret = fn(...args)
      if (ret && typeof ret.catch === 'function') ret.catch(() => {})
    } catch (err) {
      console.warn(`[plan-and-execute] callback "${name}" threw:`, err?.message || err)
    }
  }
}

/**
 * High-resolution monotonic clock helper. `performance.now()` exists in
 * Node ≥16 and all modern browsers; the `Date.now()` fallback keeps the
 * file robust against edge runtimes without performance timing.
 */
function _perfNow() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

/**
 * Flatten every step's `toolCalls` into a single ordered array. Used by
 * `execute()` and `stream()`'s `done` event to produce the long-promised
 * `toolCallHistory`. The result preserves step order (stable sort by
 * appearance, since `plan` is already ordered) and each record already
 * carries its originating `stepIndex`.
 * @param {PlanStep[]} plan
 */
function _flattenToolCalls(plan) {
  if (!Array.isArray(plan) || plan.length === 0) return []
  const out = []
  for (const step of plan) {
    if (step && Array.isArray(step.toolCalls)) {
      for (const rec of step.toolCalls) out.push(rec)
    }
  }
  return out
}

/**
 * Build a plain-object snapshot of a PlanStep for emission on the stream —
 * stream consumers need a defensive clone so mid-run mutations of the
 * PlanStep don't retroactively change a past event. The snapshot includes
 * the structured trace fields (toolCalls / messages / usage / rounds /
 * durationMs) alongside the basic fields.
 * @param {PlanStep} step
 */
function snapshotStep(step) {
  return {
    index: step.index,
    description: step.description,
    status: step.status,
    result: step.result,
    durationMs: step.durationMs,
    rounds: step.rounds,
    usage: { ...step.usage },
    // Shallow-clone the collection arrays; individual records are already
    // plain objects constructed inside the loop so reference-sharing is safe.
    toolCalls: step.toolCalls.slice(),
    messages: step.messages.slice(),
  }
}

/**
 * Render a failed step's tool-call trace as a compact, LLM-readable string
 * for use in the replan prompt. Returns `''` when the step executed no
 * tool calls (e.g. the failure happened before any tool was invoked), so
 * the caller can conditionally drop the "Failed step tool calls" section.
 * @param {PlanStep} step
 */
function _formatFailedStepTrace(step) {
  if (!step || !Array.isArray(step.toolCalls) || step.toolCalls.length === 0) {
    return ''
  }
  return step.toolCalls.map((tc, i) => {
    const args = _compactJson(tc.arguments)
    const status = tc.ok ? 'ok' : `error:${tc.errorKind ?? 'unknown'}`
    const result = truncate(String(tc.result ?? ''), 300)
    return `  ${i + 1}. ${tc.name}(${args}) → [${status}] ${result}`
  }).join('\n')
}

/** Best-effort JSON stringify for replan prompts; falls back to `"<unserializable>"`. */
function _compactJson(value) {
  if (value === null || value === undefined) return ''
  try { return JSON.stringify(value) }
  catch { return '"<unserializable>"' }
}

/**
 * 清洗对话历史，仅保留 user/assistant 的纯文本消息。
 * 剥除：system（策略内部自己提供 system prompt）、tool（ReAct 的 tool_call 轮次，
 * 可能没有成对的 assistant+tool，混入会引起 LLM 报错）、任何 assistant(tool_calls) 消息。
 * @param {Array<any>} history
 * @returns {Array<{role:'user'|'assistant',content:string}>}
 */
function sanitizeHistory(history) {
  if (!Array.isArray(history) || history.length === 0) return []
  return history.filter(m =>
    m
    && (m.role === 'user' || m.role === 'assistant')
    && typeof m.content === 'string'
    && m.content.length > 0
    && !m.tool_calls,
  ).map(m => ({ role: m.role, content: m.content }))
}

function truncate(text, maxLen) {
  if (!text) return ''
  return text.length <= maxLen ? text : text.substring(0, maxLen) + '...'
}

function buildStepSystemPrompt(step, previousStepsContext) {
  let prompt = `You are executing step ${step.index + 1} of a multi-step plan.\n\n`
  prompt += `Current step: ${step.description}\n\n`
  if (previousStepsContext) {
    prompt += `Context from previous steps:\n${previousStepsContext}\n\n`
  }
  prompt += 'Instructions:\n'
  prompt += '- Focus on completing ONLY this step\n'
  prompt += '- Use the available tools as needed\n'
  prompt += '- Provide a clear summary of what was accomplished when done\n'
  prompt += '- If you cannot complete the step, explain why\n'
  return prompt
}

/**
 * 解析 LLM 返回的计划 JSON，支持 markdown code block 和纯 JSON。
 * 回退到文本行解析。
 */
export function parsePlan(text, maxSteps = 35) {
  if (!text) return []

  const jsonContent = extractJsonContent(text)
  if (jsonContent) {
    try {
      const arr = JSON.parse(jsonContent)
      if (Array.isArray(arr)) {
        return arr
          .slice(0, maxSteps)
          .map((item, i) => {
            const desc = item.description || item.desc || ''
            return desc ? new PlanStep(i, desc) : null
          })
          .filter(Boolean)
      }
    } catch { /* fall through to text parsing */ }
  }

  // 回退：按行解析
  return parsePlanFromText(text, maxSteps)
}

function extractJsonContent(text) {
  // markdown code block
  const mdMatch = text.match(/```json\s*\n([\s\S]*?)```/)
  if (mdMatch) return mdMatch[1].trim()

  // 直接 JSON 数组
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start >= 0 && end > start) return text.substring(start, end + 1)

  return null
}

function parsePlanFromText(text, maxSteps) {
  const steps = []
  const lines = text.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    const match = trimmed.match(/^(?:\d+[.):]|\s*-|step\s+\d+[.:]?)\s*(.*)/i)
    if (match && match[1] && steps.length < maxSteps) {
      steps.push(new PlanStep(steps.length, match[1].trim()))
    }
  }
  return steps
}

function buildFallbackSynthesis(plan) {
  let result = 'Plan execution completed.\n\n'
  let hasCompleted = false
  for (const step of plan) {
    const icons = { completed: '✅', failed: '❌', skipped: '⏭' }
    const icon = icons[step.status] ?? '⬜'
    if (step.status === StepStatus.COMPLETED) hasCompleted = true
    result += `${icon} Step ${step.index + 1}: ${step.description}`
    if (step.result) result += `\n   ${truncate(step.result, 300)}`
    result += '\n\n'
  }
  if (!hasCompleted) result += 'No steps completed successfully.'
  return result
}

function mergeRevisedPlan(originalPlan, failedStepIndex, revisedSteps) {
  return [...originalPlan.slice(0, failedStepIndex + 1), ...revisedSteps]
}

/**
 * 带超时的 Promise 包装。
 */
function callWithTimeout(fn, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('LLM call timed out')), timeoutMs)
    fn().then(
      result => { clearTimeout(timer); resolve(result) },
      err => { clearTimeout(timer); reject(err) },
    )
  })
}
