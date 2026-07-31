/**
 * SubagentRunner —— 造子 Agent、跑、按失败类型重试、把终态渲染成 Agent_Result。
 *
 * 用**组合**而非继承：子 agent 就是一个普通的 `Agent` 实例，因此 ReAct 循环、
 * 工具执行的分类与容错、telemetry、skill / MCP 全部白拿，不复制一份必然分叉的
 * 循环代码。
 *
 * `run()` **永不 throw** —— 任何异常都被分类成 failureKind 并渲染成结构化失败
 * 结果回给主 agent，由主 agent 决定换模型 / 缩范围 / 放弃（§2）。
 */
import { getAgentType } from './types.js'
import { renderContract } from './contract.js'
import { wrapMemoryForMirror } from './mirror.js'
import { SlidingWindowMemory } from '../memory.js'

// 注意：**不要**在这里静态 import `Agent` —— agent.js → runtime.js → runner.js
// 已经构成引用环，静态 import 会让求值顺序变得脆弱。默认工厂改用动态 import，
// 在第一次真正要造子 agent 时才解析。

/** 可重试的失败类型。其余重跑多半同样结果，纯烧 token。 */
export const RETRYABLE_KINDS = new Set(['rate_limited', 'llm_error', 'network', 'timeout'])

/** 子 agent 永远拿不到的元工具（除非其类型 canSpawn）。 */
const SPAWN_TOOLS = new Set(['agent', 'agent_graph', 'graph_start'])

export function classifyFailure(err) {
  if (!err) return 'tool_error'
  // _runOnce 抛的 MaxRoundsError 自带分类，优先采信。
  if (typeof err._failureKind === 'string') return err._failureKind
  const status = typeof err.status === 'number' ? err.status : null
  if (status === 429) return 'rate_limited'
  if (status != null && status >= 500) return 'llm_error'
  if (err.name === 'LlmStreamIncompleteError') return 'llm_error'
  if (err.name === 'AbortError') return 'aborted'
  if (err.name === 'TimeoutError') return 'timeout'
  const message = String(err.message ?? '')
  if (/timed out/i.test(message)) return 'timeout'
  if (/fetch failed|ECONNRESET|ENOTFOUND|ECONNREFUSED|network/i.test(message)) return 'network'
  return 'tool_error'
}

export class SubagentRunner {
  constructor({
    parent, registry, artifacts, sharedHistory, aliases, opts = {}, emit = () => {},
    createAgent = async (options) => {
      const { Agent } = await import('../agent.js')
      return new Agent(options)
    },
    ask = null, mailbox = null,
  }) {
    this.parent = parent
    this.registry = registry
    this.artifacts = artifacts
    this.sharedHistory = sharedHistory
    this.aliases = aliases
    this.opts = opts
    this.emit = emit
    this.createAgent = createAgent
    this.ask = ask
    this.mailbox = mailbox
    /** 最近一次渲染出的契约，便于调试与测试断言。 */
    this.lastRenderedContract = null
  }

  /**
   * 派生子 agent 的构造参数。独立成方法便于测试断言继承关系。
   */
  buildChildOptions(handle, { prompt, inputs }) {
    const type = getAgentType(handle.type)
    const parent = this.parent

    const inherited = type.tools === '*'
      ? parent.tools
      : parent.tools.filter(t => type.tools.includes(t.name))
    const tools = type.canSpawn ? [...inherited] : inherited.filter(t => !SPAWN_TOOLS.has(t.name))

    const contract = renderContract({
      description: handle.description,
      prompt,
      inputs,
      cwd: handle.isolation?.path ?? null,
    })
    this.lastRenderedContract = contract

    return {
      // Agent 构造函数要求 provider 必填（它用来解析默认 URL）。父 Agent 在
      // Task 9 里记住了自己的 provider 名，这里原样传下去；url 显式覆盖，因此
      // 别名可以指向另一个供应商的端点。
      provider: this.parent._providerName,
      url: handle.model.url,
      apiKey: handle.model.apiKey,
      model: handle.model.model,
      systemPrompt: type.systemPrompt,
      tools,
      strategy: 'react',
      maxRounds: type.maxRounds,
      temperature: type.temperature,
      enableIntentRecognition: type.enableIntentRecognition,
      knowledgeBase: parent.knowledgeBase,
      tokenBudget: parent.tokenBudget,
      validateStreamCompletion: parent.validateStreamCompletion,
      hooks: this._childHooks(handle),
      // 给假实例/调试用的归属信息（Agent 会忽略未知选项）
      _agentId: handle.agentId,
      _agentName: handle.name,
      _contract: contract,
    }
  }

  _childHooks(handle) {
    const parentHooks = this.parent.hooks ?? {}
    const hooks = {}
    // 转发主机的工具管控策略 —— 不转发等于子 agent 绕过了主机的安全边界。
    if (parentHooks.beforeToolCall) hooks.beforeToolCall = parentHooks.beforeToolCall
    if (parentHooks.afterToolCall) hooks.afterToolCall = parentHooks.afterToolCall
    if (parentHooks.onError) hooks.onError = parentHooks.onError
    if (this.ask) {
      hooks.onAskUser = (question) => this.ask.ask({
        agentId: handle.agentId,
        agentName: handle.name,
        parentAgentId: handle.parentAgentId,
        nodeId: handle.nodeId,
        taskDescription: handle.description,
        question,
      })
    } else if (parentHooks.onAskUser) {
      hooks.onAskUser = parentHooks.onAskUser
    }
    return hooks
  }

  /**
   * 重试前的退避时长。默认指数退避（2s / 4s / 8s 上限）。
   * `opts.retry.backoffMs` 显式给数字时直接采用它 —— 测试要把这里压成 0，否则
   * 光是等退避就能让一个测试文件多跑十几秒。
   */
  _backoffMs(attempt) {
    const configured = this.opts.retry?.backoffMs
    if (typeof configured === 'number' && Number.isFinite(configured)) return Math.max(0, configured)
    return Math.min(2 ** attempt * 1000, 8000)
  }

  /**
   * @returns {Promise<string>} Agent_Result 字符串。永不 reject。
   */
  async run(handle, { prompt, inputs = [], signal } = {}) {
    const type = getAgentType(handle.type)
    const maxDepth = this.opts.maxDepth ?? 2
    const maxAttempts = this.opts.retry?.maxAttempts ?? type.maxAttempts ?? 3

    if (handle.depth > maxDepth) {
      handle.transition('queued'); handle.transition('running')
      handle.beginAttempt()
      handle.endAttempt({ failureKind: 'depth_exceeded', error: `depth ${handle.depth} exceeds maxDepth ${maxDepth}` })
      return this._finishFailed(handle, 'depth_exceeded', `depth ${handle.depth} exceeds maxDepth ${maxDepth}`)
    }

    this.emit('agent.spawn', {
      agentId: handle.agentId, agentName: handle.name, parentAgentId: handle.parentAgentId,
      type: handle.type, description: handle.description, depth: handle.depth,
      nodeId: handle.nodeId, model: handle.model?.alias ?? null,
      isolation: handle.isolation ? handle.isolation.mode : null,
    })

    if (handle.state === 'pending') handle.transition('queued')
    handle.transition('running')
    this._emitState(handle, 'queued', 'running')

    let lastKind = 'tool_error'
    let lastError = 'unknown error'

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      handle.beginAttempt()
      try {
        const text = await this._runOnce(handle, { prompt, inputs, signal })
        handle.endAttempt({})
        return this._finishSucceeded(handle, text)
      } catch (err) {
        const kind = classifyFailure(err)
        lastKind = kind
        lastError = String(err?.message ?? err)
        handle.endAttempt({ failureKind: kind, error: lastError })

        const retryable = RETRYABLE_KINDS.has(kind) && attempt < maxAttempts && !signal?.aborted
        if (!retryable) break

        const delayMs = this._backoffMs(attempt)
        this.emit('agent.retry', {
          agentId: handle.agentId, agentName: handle.name, parentAgentId: handle.parentAgentId,
          attempt, failureKind: kind, delayMs,
        })
        try {
          await sleep(delayMs, signal)
        } catch (abortErr) {
          // 退避期间被取消：按 aborted 收尾，而不是继续下一次尝试。
          lastKind = classifyFailure(abortErr)
          lastError = String(abortErr?.message ?? abortErr)
          break
        }
      }
    }

    return this._finishFailed(handle, lastKind, lastError)
  }

  async _runOnce(handle, { prompt, inputs, signal }) {
    const options = this.buildChildOptions(handle, { prompt, inputs })
    // `createAgent` 默认是异步的（动态 import 打破引用环）；测试注入的同步工厂
    // 被 await 一视同仁。
    const child = await this.createAgent({
      ...options,
      memory: this._makeChildMemory(handle),
    })
    handle._child = child
    child._toolContextExtra = {
      agentId: handle.agentId, agentName: handle.name,
      depth: handle.depth, cwd: handle.isolation?.path ?? null,
    }
    this._forwardTelemetry(handle, child)

    const text = await child.chat(options._contract, { signal })
    if (child.lastStopReason === 'max_rounds') {
      const err = new Error('subagent exhausted its round budget')
      err.name = 'MaxRoundsError'
      err._failureKind = 'max_rounds'
      throw err
    }
    const metrics = child.getLastRunMetrics?.()
    if (metrics) {
      handle.metrics = {
        rounds: metrics.totalRounds ?? 0,
        llmCalls: metrics.totalLlmCalls ?? 0,
        toolCalls: metrics.totalToolCalls ?? 0,
        usage: metrics.usage ?? null,
        wallClockMs: metrics.wallClockMs ?? 0,
      }
    }
    return text
  }

  /**
   * 子 agent 的 memory：全新实例 + 镜像包装（不继承父上下文）。
   * 用 SlidingWindowMemory 而非默认的 SummarizingMemory —— 子 agent 的任务已经
   * 收窄，让它为了压缩再去打一轮 sidecar LLM 不划算。
   */
  _makeChildMemory(handle) {
    const inner = new SlidingWindowMemory(60)
    return wrapMemoryForMirror(inner, { sharedHistory: this.sharedHistory, agentId: handle.agentId })
  }

  _forwardTelemetry(handle, child) {
    if (typeof child.on !== 'function') return
    for (const eventType of ['llm.call', 'tool.call', 'round.start', 'round.end']) {
      child.on(eventType, (payload) => {
        this.emit(eventType, {
          ...payload,
          agentId: handle.agentId,
          agentName: handle.name,
          parentAgentId: handle.parentAgentId,
        })
      })
    }
  }

  _emitState(handle, from, to) {
    this.emit('agent.state', {
      agentId: handle.agentId, agentName: handle.name, parentAgentId: handle.parentAgentId, from, to,
    })
  }

  _collectArtifacts(handle) {
    const records = this.artifacts?.list?.({ agentId: handle.agentId }) ?? []
    handle.artifactKeys = [...new Set(records.map(r => r.key))]
    return records
  }

  _finishSucceeded(handle, text) {
    const records = this._collectArtifacts(handle)
    handle.result = { status: 'succeeded', text }
    handle.transition('succeeded')
    this._emitState(handle, 'running', 'succeeded')
    this.registry.settle(handle)
    this.emit('agent.succeeded', {
      agentId: handle.agentId, agentName: handle.name, parentAgentId: handle.parentAgentId,
      rounds: handle.metrics.rounds, usage: handle.metrics.usage,
      wallClockMs: handle.metrics.wallClockMs, artifactKeys: handle.artifactKeys,
    })
    return this.formatResult(handle, { text, records })
  }

  _finishFailed(handle, failureKind, lastError) {
    const records = this._collectArtifacts(handle)
    handle.result = { status: 'failed', failureKind, lastError }
    if (!handle.isTerminal()) handle.transition('failed')
    this._emitState(handle, 'running', 'failed')
    this.registry.settle(handle)
    this.emit('agent.failed', {
      agentId: handle.agentId, agentName: handle.name, parentAgentId: handle.parentAgentId,
      failureKind, attempts: handle.attempt, lastError,
    })
    return this.formatResult(handle, { records })
  }

  /**
   * 渲染 Agent_Result（§2）。头部机器可读，正文人可读 —— 主 agent 的后续决策
   * 完全依赖这个头部。
   */
  formatResult(handle, { text = null, records = null } = {}) {
    // 声明的接口是 `formatResult(handle)` —— 只给 handle 也必须能渲染出完整结果。
    // 正文回落到 `handle.result.text`（成功时 _finishSucceeded 已存进去），否则
    // Task 8 里为一个已完成的 handle 补渲染结果会静默丢掉报告正文。
    const body = text ?? handle.result?.text ?? ''
    const rows = records ?? this.artifacts?.list?.({ agentId: handle.agentId }) ?? []
    const artifactLine = rows.length > 0
      ? rows.map(r => `${r.key} (sha:${r.sha}${r.attempt > 1 ? `, attempt=${r.attempt}` : ''})`).join(' · ')
      : null

    if (handle.result?.status === 'succeeded') {
      const m = handle.metrics
      const usage = m.usage ?? {}
      const lines = [
        `[agent:${handle.name} succeeded] type=${handle.type} model=${handle.model?.alias ?? 'inherited'} `
        + `attempts=${handle.attempt} rounds=${m.rounds}`,
        `usage: in=${usage.input_tokens ?? 0} out=${usage.output_tokens ?? 0}  wall=${(m.wallClockMs / 1000).toFixed(1)}s`,
        body,
      ]
      if (artifactLine) lines.push(`--- artifacts (${rows.length}) ---`, artifactLine)
      if (handle.isolation?.dirty) {
        lines.push('--- worktree ---',
          `path=${handle.isolation.path} branch=${handle.isolation.branch} `
          + `changed=${handle.isolation.changedFiles} files (已保留，未自动清理)`)
      }
      return lines.join('\n')
    }

    const { failureKind, lastError } = handle.result ?? {}
    const retried = handle.attempt > 1 ? ` (retried ${handle.attempt - 1}x)` : ''
    const lines = [
      `[agent:${handle.name} failed] failureKind=${failureKind} attempts=${handle.attempt}${retried}`,
      `lastError: ${lastError}`,
    ]
    if (artifactLine) lines.push(`--- partial artifacts (${rows.length}) ---`, artifactLine)
    lines.push('下一步由你决定：换 model 重发、缩小任务范围重发、或跳过该任务继续。')
    return lines.join('\n')
  }
}

async function sleep(ms, signal) {
  if (ms <= 0) return
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    if (signal) {
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(abortError()) }, { once: true })
    }
  })
}

function abortError() {
  const err = new Error('subagent retry aborted')
  err.name = 'AbortError'
  return err
}
