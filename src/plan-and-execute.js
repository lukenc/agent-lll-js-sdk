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

/** 计划步骤状态 */
export const StepStatus = {
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  FAILED: 'failed',
  SKIPPED: 'skipped',
}

/** 单个计划步骤 */
export class PlanStep {
  constructor(index, description) {
    this.index = index
    this.description = description
    this.status = StepStatus.PENDING
    this.result = null
    this.durationMs = 0
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
 * @param {number} [opts.temperature=1]
 * @param {import('./tool.js').ToolDef[]} [opts.tools=[]]
 * @param {number} [opts.maxPlanSteps=35]
 * @param {number} [opts.stepMaxRounds=300]
 * @param {number} [opts.maxReplanAttempts=2]
 * @param {number} [opts.planningTimeoutMs=120000]
 * @param {number} [opts.synthesisTimeoutMs=120000]
 * @param {boolean} [opts.useStreaming=false] - 使用流式 API 调用（浏览器端建议开启）
 * @param {function} [opts.onPhase] - (phase, message) => void
 * @param {function} [opts.onPlanGenerated] - (steps: PlanStep[]) => void
 * @param {function} [opts.onStepStart] - (index, description) => void
 * @param {function} [opts.onStepComplete] - (index, success, result) => void
 * @param {function} [opts.onPlanRevised] - (steps: PlanStep[]) => void
 */
export class PlanAndExecuteStrategy {
  constructor(opts) {
    this.url = opts.url
    this.apiKey = opts.apiKey
    this.model = opts.model
    this.temperature = opts.temperature ?? 1
    this.tools = opts.tools ?? []
    this.maxPlanSteps = opts.maxPlanSteps ?? DEFAULTS.maxPlanSteps
    this.stepMaxRounds = opts.stepMaxRounds ?? DEFAULTS.stepMaxRounds
    this.maxReplanAttempts = opts.maxReplanAttempts ?? DEFAULTS.maxReplanAttempts
    this.planningTimeoutMs = opts.planningTimeoutMs ?? DEFAULTS.planningTimeoutMs
    this.synthesisTimeoutMs = opts.synthesisTimeoutMs ?? DEFAULTS.synthesisTimeoutMs
    this.useStreaming = opts.useStreaming ?? false

    // 回调
    this.onPhase = opts.onPhase ?? (() => {})
    this.onPlanGenerated = opts.onPlanGenerated ?? (() => {})
    this.onStepStart = opts.onStepStart ?? (() => {})
    this.onStepComplete = opts.onStepComplete ?? (() => {})
    this.onPlanRevised = opts.onPlanRevised ?? (() => {})
  }

  /**
   * 执行 PlanAndExecute 策略
   * @param {string} userMessage
   * @param {object} [opts]
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<{ content: string, plan: PlanStep[], toolCallHistory: object[] }>}
   */
  async execute(userMessage, { signal } = {}) {
    const allToolCallHistory = []

    // ============ Phase 1: Planning ============
    this.onPhase('planning', '正在分析任务并制定执行计划...')

    let plan = await this._generatePlan(userMessage, signal)
    if (!plan || plan.length === 0) {
      this.onPhase('fallback', '计划生成失败，切换到 ReAct 模式...')
      const result = await this._reactLoop(userMessage, null, this.stepMaxRounds, signal)
      return { content: result, plan: [], toolCallHistory: allToolCallHistory }
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
      this.onStepStart(step.index, step.description)

      const stepStart = Date.now()
      try {
        const stepResult = await this._executeStep(step, stepsContext, signal)
        const duration = Date.now() - stepStart

        step.markCompleted(stepResult, duration)
        stepsContext += `\n[Step ${step.index + 1} completed]: ${truncate(stepResult, 500)}`
        this.onStepComplete(step.index, true, stepResult)
      } catch (err) {
        const duration = Date.now() - stepStart
        const errorMsg = err.message || 'Step execution failed'
        step.markFailed(errorMsg, duration)
        stepsContext += `\n[Step ${step.index + 1} FAILED]: ${truncate(errorMsg, 300)}`
        this.onStepComplete(step.index, false, errorMsg)

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

    const synthesis = await this._synthesizeResults(userMessage, plan, stepsContext, signal)
    this.onPhase('completed', '执行完成')

    return { content: synthesis, plan, toolCallHistory: allToolCallHistory }
  }

  /**
   * 流式执行 — 通过 async generator 推送进度事件
   * @param {string} userMessage
   * @param {object} [opts]
   * @param {AbortSignal} [opts.signal]
   * @yields {{ type: string, ... }}
   */
  async *stream(userMessage, { signal } = {}) {
    let plan = null
    let stepsContext = ''
    let replanCount = 0

    // Phase 1: Planning
    yield { type: 'phase', phase: 'planning', message: '正在分析任务并制定执行计划...' }

    plan = await this._generatePlan(userMessage, signal)
    if (!plan || plan.length === 0) {
      yield { type: 'phase', phase: 'fallback', message: '计划生成失败，切换到 ReAct 模式...' }
      const result = await this._reactLoop(userMessage, null, this.stepMaxRounds, signal)
      yield { type: 'done', content: result, plan: [] }
      return
    }

    yield { type: 'plan_generated', plan: plan.map(s => ({ index: s.index, description: s.description })) }

    // Phase 2: Execution
    yield { type: 'phase', phase: 'executing', message: '开始执行计划...' }

    for (let i = 0; i < plan.length; i++) {
      signal?.throwIfAborted()
      const step = plan[i]
      step.markInProgress()
      yield { type: 'step_start', index: step.index, description: step.description }

      const stepStart = Date.now()
      try {
        const stepResult = await this._executeStep(step, stepsContext, signal)
        const duration = Date.now() - stepStart
        step.markCompleted(stepResult, duration)
        stepsContext += `\n[Step ${step.index + 1} completed]: ${truncate(stepResult, 500)}`
        yield { type: 'step_complete', index: step.index, success: true, result: stepResult, duration }
      } catch (err) {
        const duration = Date.now() - stepStart
        const errorMsg = err.message || 'Step execution failed'
        step.markFailed(errorMsg, duration)
        stepsContext += `\n[Step ${step.index + 1} FAILED]: ${truncate(errorMsg, 300)}`
        yield { type: 'step_complete', index: step.index, success: false, result: errorMsg, duration }

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
    const synthesis = await this._synthesizeResults(userMessage, plan, stepsContext, signal)
    yield { type: 'phase', phase: 'completed', message: '执行完成' }
    yield { type: 'done', content: synthesis, plan: plan.map(s => ({ index: s.index, description: s.description, status: s.status, result: s.result })) }
  }

  // ==================== Planning ====================

  /**
   * 统一的 LLM 调用方法 — 根据 useStreaming 选择 syncChat 或 streamChat。
   * streamChat 返回的格式与 syncChat 一致（已内部重构），因此调用方无需区分。
   */
  async _callLlm(body, signal) {
    if (this.useStreaming) {
      return streamChat({ url: this.url, apiKey: this.apiKey, body, signal, onDelta: () => {} })
    }
    return syncChat({ url: this.url, apiKey: this.apiKey, body, signal })
  }

  async _generatePlan(userMessage, signal) {
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
      '5. Each step description should be specific enough for an executor to understand\n\n' +
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
        { role: 'user', content: userMessage },
      ],
      temperature: this.temperature,
    }

    try {
      const response = await callWithTimeout(
        () => this._callLlm(body, signal),
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
    )
  }

  /**
   * 内部 ReAct 循环 — 复用 Agent 的核心逻辑，用于执行单个步骤。
   * @param {string} userMessage
   * @param {string|null} systemPrompt - 步骤级 system prompt（null 时使用默认）
   * @param {number} maxRounds
   * @param {AbortSignal} [signal]
   * @returns {Promise<string>}
   */
  async _reactLoop(userMessage, systemPrompt, maxRounds, signal) {
    const toolMap = Object.fromEntries(this.tools.map(t => [t.name, t]))
    const openaiTools = this.tools.length > 0 ? formatToolsForOpenAI(this.tools) : undefined

    const messages = []
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt })
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

      const response = await this._callLlm(body, signal)
      const message = response.choices?.[0]?.message
      if (!message) throw new Error('Empty LLM response')

      const textContent = message.content ?? ''
      const toolCalls = parseToolCalls(response)

      if (toolCalls.length === 0) {
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
        let result
        if (!tool) {
          result = `Error: Tool "${call.name}" not found. Available: ${this.tools.map(t => t.name).join(', ')}`
        } else {
          try {
            result = await tool.execute(call.arguments)
          } catch (err) {
            result = `Error executing ${call.name}: ${err.message}`
          }
        }
        messages.push(formatToolResult(call.id, call.name, result))
      }
    }

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

    const replanPrompt =
      `The original task was: ${userMessage}\n\n` +
      `Completed steps:\n${completedSteps}\n\n` +
      `Failed step:\n${failedStep}\n\n` +
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
        () => this._callLlm(body, signal),
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

  async _synthesizeResults(userMessage, plan, stepsContext, signal) {
    const fallback = buildFallbackSynthesis(plan)

    const completedCount = plan.filter(s => s.status === StepStatus.COMPLETED).length
    if (plan.length === 1 && completedCount === 1) return plan[0].result
    if (completedCount === 0) return fallback

    const synthesisPrompt =
      'You completed a multi-step task. Here is the summary:\n\n' +
      `Original request: ${userMessage}\n\n` +
      `Steps and results:\n${stepsContext}\n\n` +
      'Please provide a comprehensive final answer to the original request, ' +
      'incorporating the results from all completed steps. Be concise but thorough.'

    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: 'You are a helpful assistant. Synthesize the results of a multi-step execution plan into a final answer.' },
        { role: 'user', content: synthesisPrompt },
      ],
      temperature: this.temperature,
    }

    try {
      const response = await callWithTimeout(
        () => this._callLlm(body, signal),
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
