/**
 * SubagentRunner —— 造子 Agent、跑、按失败类型重试、把终态渲染成 Agent_Result。
 *
 * 用**组合**而非继承：子 agent 就是一个普通的 `Agent` 实例，因此 ReAct 循环、
 * 工具执行的分类与容错、telemetry、skill / MCP 全部白拿，不复制一份必然分叉的
 * 循环代码。
 *
 * `run()` **永不 throw** —— 任何异常都被分类成 failureKind 并渲染成结构化失败
 * 结果回给主 agent，由主 agent 决定换模型 / 缩范围 / 放弃（§2）。
 *
 * **取消是一等结果，不是失败的一种。** `cancelHandle`（本模块导出，`agent_cancel`
 * 工具与 `runtime.close()` 共用）先把 handle 转到终态 `cancelled` 再 abort；
 * `_finishFailed` / `_finishSucceeded` 发现 handle 已经是 `cancelled` 时一律
 * 让位给 `_finishCancelled`——不管重试循环里兜到的异常长什么样，都不会把一次
 * 主动取消误渲染成 `status: 'failed'`。
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

/**
 * 取消一个 handle 的**唯一**入口 —— `agent_cancel` 工具与 `runtime.close()` 都
 * 必须走这里，不能各自转态 + abort。
 *
 * 原因：两处若各写各的 `abort()` 用法就会分叉——裸 `controller.abort()` 让
 * `signal.reason` 落成一个标准 `DOMException`（name 为 `AbortError`），而
 * `controller.abort(someString)` 会让 fetch 之类的调用点把那个字符串原样
 * reject 出去，字符串没有 `.name`，`classifyFailure` 就误判成 `tool_error`——
 * 一次刻意的取消于是被下游读成了"这个子 agent 出故障了"。这里统一构造一个
 * `name: 'AbortError'` 的 `Error` 当 abort reason，两条路径此后行为一致；人类
 * 可读的取消理由挂在 `.message` 上，因此还能顺着 `classifyFailure` 之后的
 * `lastError` 一路带到 `agent.cancelled` 事件与渲染出的 Agent_Result 里。
 *
 * 同时把 handle 转到终态 `cancelled`——这是让 `_finishFailed` 不再把已取消的
 * handle 误判成失败的前提：转态发生在 `abort()` 调用之前，因此无论 abort 传导
 * 进子 agent 要花多久，`handle.state` 在那之前就已经是 `cancelled` 了。
 *
 * 给了 `ask` 时还会 settle 掉这个 agent 全部待答提问：abort 信号要等当前那次工具
 * 调用返回才被看见，而阻塞在 `ask_user` 里的 agent 正卡在一次工具调用里 —— 不
 * settle 它的提问，这次取消就只是改了个状态，agent 本人还在等人回答。
 *
 * @param {import('./handle.js').AgentHandle} handle
 * @param {{ reason?: string|null, emit?: (type: string, payload: object) => void, ask?: import('./ask.js').AskRegistry|null }} [opts]
 * @returns {boolean} 是否真的执行了取消（handle 已经是终态时为 false，不做任何事）
 */
export function cancelHandle(handle, { reason = null, emit = () => {}, ask = null } = {}) {
  if (handle.isTerminal()) return false
  const humanReason = reason ?? 'cancelled'
  handle._cancelReason = humanReason
  handle.transition('cancelled')
  handle._abort?.abort(makeAbortError(humanReason))
  ask?.cancelByAgent(handle.agentId, humanReason)
  emit('agent.cancelled', {
    agentId: handle.agentId, agentName: handle.name, parentAgentId: handle.parentAgentId,
    reason: humanReason,
  })
  return true
}

function makeAbortError(reason) {
  const err = new Error(reason)
  err.name = 'AbortError'
  return err
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
    if (this.mailbox) hooks.onRoundStart = () => this._deliverMail(handle)
    return hooks
  }

  /**
   * 轮边界收件：把这个 agent 收件箱里的信封排进它自己的待注入队列。
   *
   * 挂在 `onRoundStart` 上而不是在工具执行中间投递 —— `Agent` 每轮先调
   * `onRoundStart` 再 `_drainPendingInjections()`，所以这里 enqueue 的消息在**同一轮**
   * 就会落进 memory，且落点一定在上一轮的 `assistant(tool_calls)` 与其全部 `tool`
   * 结果之后（那个配对不变量是裁剪逻辑的前提）。
   *
   * 子 agent 实例还没造好（或是不支持注入的测试替身）时**不排空** —— 排空了信就丢了。
   */
  _deliverMail(handle) {
    const child = handle._child
    if (!child || typeof child.enqueueMessage !== 'function') return
    for (const envelope of this.mailbox.drain(handle.agentId)) {
      child.enqueueMessage({ role: 'user', content: this.mailbox.formatForInjection(envelope) })
    }
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
    // 罕见竞态：`spawn()` 里 `await registry.acquireSlot(...)` 让出过一次微任务，
    // `agent_cancel`/`close()` 可能正好在这个缺口里把 handle 转成了 cancelled——
    // 这里若继续往下走 `transition('running')`，会因终态无出边而抛错，违反
    // "run() 永不 throw"。已经是终态（此刻只可能是 cancelled）就直接按取消收尾。
    if (handle.isTerminal()) return this._finishCancelled(handle, 'aborted', handle._cancelReason)

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
    // 子 agent 在被取消的同一时刻碰巧跑完并返回了结果：`handle.state` 早已被
    // `cancelHandle` 转成终态 `cancelled`，这里再 `transition('succeeded')` 只会
    // 抛出非法迁移错误（终态无出边）。取消发生在先就该按取消收尾，不管子 agent
    // 事后是不是"来得及"返回一个看似成功的文本——那份文本对已经放弃这个任务
    // 的主 agent 而言没有意义。
    if (handle.state === 'cancelled') return this._finishCancelled(handle, 'aborted', handle._cancelReason)
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
    // 同一个竞态的另一半：重试循环里捕获到的异常可能只是"取消导致的连锁反应"
    // （比如上面 `_finishSucceeded` 里那次非法迁移被这层 catch 兜住，重新分类成
    // 了看似无关的 `tool_error`）。只要 handle 已经被标记为 cancelled，就不再
    // 采信这里传入的 failureKind/lastError，一律按取消渲染——这正是这次要修的
    // 缺陷：cancelled 状态 + failed 结果自相矛盾。
    if (handle.state === 'cancelled') return this._finishCancelled(handle, 'aborted', handle._cancelReason ?? lastError)
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
   * 取消收尾。**不**在这里 transition 或 emit `agent.cancelled`——`cancelHandle`
   * 早在 abort 传导进来之前就已经做过这两件事了；这里只负责把 handle.result
   * 定成 `{ status: 'cancelled', ... }`（而不是 'failed'）、结算并发槽/保留窗口、
   * 渲染结果。三个调用点（`run()` 顶部的终态短路、`_finishSucceeded` 的竞态
   * 兜底、`_finishFailed` 的竞态兜底）进来时 `handle.state` 都已经是
   * `cancelled`，所以这里不需要再判断。
   */
  _finishCancelled(handle, failureKind = 'aborted', lastError = null) {
    const records = this._collectArtifacts(handle)
    handle.result = { status: 'cancelled', failureKind, lastError: lastError ?? handle._cancelReason ?? 'cancelled' }
    this.registry.settle(handle)
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

    // 取消是一等结果，不是失败的一种：不重试、不建议重试，头部与
    // succeeded/failed 同风格（机器可读），供主 agent 直接分支判断。
    if (handle.result?.status === 'cancelled' || (!handle.result && handle.state === 'cancelled')) {
      const failureKind = handle.result?.failureKind ?? 'aborted'
      const lastError = handle.result?.lastError ?? handle._cancelReason ?? 'cancelled'
      const lines = [
        `[agent:${handle.name} cancelled] failureKind=${failureKind} attempts=${handle.attempt}`,
        `reason: ${lastError}`,
      ]
      if (artifactLine) lines.push(`--- partial artifacts (${rows.length}) ---`, artifactLine)
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
      // `signal.reason` 优先：`cancelHandle` 把人类可读的取消理由挂在这里
      // （§ classifyFailure 仍然认得出来，因为那也是一个 name=AbortError 的
      // Error）。裸 `AbortController.abort()`（没人传 reason）时 `signal.reason`
      // 是运行时自动生成的标准 DOMException，也照样有 name=AbortError，兜底的
      // `abortError()` 只在 `signal.reason` 意外为空时才用得上。
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason ?? abortError()) }, { once: true })
    }
  })
}

function abortError() {
  const err = new Error('subagent retry aborted')
  err.name = 'AbortError'
  return err
}
