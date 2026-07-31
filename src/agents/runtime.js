/**
 * SubagentRuntime —— 组装 subagent 系统的全部部件，并暴露给 `Agent` 的
 * 单一入口。`Agent` 只认这一个对象，不直接碰 registry / runner / graph。
 */
import { AgentRegistry } from './registry.js'
import { ArtifactTrack } from './artifacts.js'
import { SubagentRunner, cancelHandle, classifyFailure } from './runner.js'
import { resolveModelAliases, resolveModel } from './models.js'
import { getAgentType, listAgentTypes, registerAgentType } from './types.js'
import { createSubagentTools } from './tools.js'
import { Mailbox } from './mailbox.js'
import { AskRegistry } from './ask.js'
import { resolveA2ATransport, newEnvelopeId } from './a2a/index.js'
// 内置 local transport 自注册的副作用 import（`a2a/index.js` 不认识它，
// 与 `mcp/transports/*` 同一套路）。
import './a2a/local.js'

export function createSubagentRuntime({
  parent,
  types = [],
  defaultType = 'general-purpose',
  maxConcurrent = 4,
  maxDepth = 2,
  modelAliases,
  retry = {},
  artifacts: artifactOpts = {},
  retainCompleted = 20,
  a2a = {},
  ask: askOpts = {},
  createAgent,
} = {}) {
  for (const type of types) registerAgentType(type)

  const sharedHistory = parent?.memory?.runtimeHistory ?? null
  const registry = new AgentRegistry({ maxConcurrent, retainCompleted })
  const artifacts = new ArtifactTrack({
    sharedHistory,
    policy: artifactOpts.policy ?? 'warn',
  })
  const aliases = resolveModelAliases(parent, modelAliases)
  const emit = (type, payload) => parent.emit(type, payload)

  const mailbox = new Mailbox()
  const transport = resolveA2ATransport({ ...a2a, transport: a2a.transport ?? 'local', mailbox, registry })

  /**
   * 多路提问路由。全部提问（main 自己的与每个 subagent 的）共用这一个登记表，
   * 因此主机拿到的 `pendingQuestions()` 是一张跨 agent 的全局待答清单。
   *
   * `onQuestion` 把主机的 `hooks.onAskUser` 接进来 —— 也就是说 subagent 的提问
   * 同样会送到主机 hook（带上子 agent 的归属 meta），而不只是躺在登记表里等一个
   * 恰好在轮询 `pendingQuestions()` 的 UI。每次读 `parent.hooks` 而不是在这里
   * 捕获一份，主机在构造之后改 hooks 也能生效。
   */
  const ask = new AskRegistry({
    timeoutMs: askOpts.timeoutMs ?? null,
    emit,
    onStateChange: (agentId, waiting) => {
      const handle = registry.get(agentId)
      // `main` 不在注册表里（它是父 Agent 自己），没有 handle 要迁移。
      if (!handle || handle.isTerminal()) return
      const to = waiting ? 'waiting_input' : 'running'
      if (handle.state === to) return
      const from = handle.state
      try {
        handle.transition(to)
      } catch {
        // 提问期间发生了别的合法迁移（例如刚被 agent_cancel 掉）时，状态可视化
        // 让位给那个更权威的迁移 —— 一次状态标注不该把提问路径打断。
        return
      }
      emit('agent.state', {
        agentId: handle.agentId, agentName: handle.name, parentAgentId: handle.parentAgentId,
        from, to,
      })
    },
    onQuestion: (question, meta) => parent?.hooks?.onAskUser?.(question, meta),
  })

  const runner = new SubagentRunner({
    parent, registry, artifacts, sharedHistory, aliases,
    opts: { retry: { maxAttempts: retry.maxAttempts ?? 3, attemptTimeoutMs: retry.attemptTimeoutMs ?? 600000 }, maxDepth },
    emit,
    mailbox,
    ask,
    ...(createAgent ? { createAgent } : {}),
  })

  /** @type {Set<Promise<unknown>>} 在跑的后台任务 */
  const inflight = new Set()

  const runtime = {
    parent, registry, artifacts, runner, sharedHistory, aliases, defaultType, maxDepth,
    mailbox, transport, ask,
    /** 供 `Agent` 注入的工具集 */
    tools: [],

    /** Level 1 清单：注入 system 消息，让模型知道 subagent_type 能填什么。 */
    typesNote() {
      const lines = listAgentTypes().map((t) => {
        const tools = t.tools === '*' ? 'all' : t.tools.join(', ')
        return `- ${t.name}: ${t.description} (model: ${t.model ?? 'inherited'}, tools: ${tools})`
      })
      return `Available agent types for the \`agent\` tool:\n${lines.join('\n')}`
    },

    /**
     * 起一个 subagent。`background: true` 时立即返回 started 行，结果稍后由
     * `_onBackgroundSettled` 经轮边界注入通知父 agent。
     */
    async spawn({
      description, prompt, subagentType, model, background = true, isolation = null,
      nodeId = null, inputs = [], depth = 1, parentAgentId = 'main', signal, onHandle,
    }) {
      const typeName = subagentType ?? defaultType
      const type = getAgentType(typeName)
      if (!type) {
        return `Error: unknown subagent_type "${typeName}". Available types: `
          + `${listAgentTypes().map(t => t.name).join(', ')}. Pick one of these and retry.`
      }
      let resolved
      try {
        resolved = resolveModel({ requested: model, type, aliases, parent })
      } catch (err) {
        return `Error: ${err.message}`
      }

      const handle = registry.create({
        type: typeName, description, parentAgentId, depth, nodeId,
        model: resolved, isolation,
      })
      // 图调度用它把 agentId 回填到节点。Task 16 会在这之后插入 worktree 创建。
      onHandle?.(handle)

      // 每个 agent 一个 AbortController，agent_cancel 就是 abort 它。父的 signal
      // 一旦 abort，子也跟着停。
      const controller = new AbortController()
      handle._abort = controller
      if (signal) {
        if (signal.aborted) controller.abort(signal.reason)
        else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
      }
      const childSignal = controller.signal

      const task = (async () => {
        const release = await registry.acquireSlot(depth, { signal: childSignal })
        try {
          return await runner.run(handle, { prompt, inputs, signal: childSignal })
        } finally {
          release()
        }
      })()

      if (!background) return task

      const tracked = task.then(
        (result) => { runtime._onBackgroundSettled(handle, result); return result },
        (err) => { runtime._onBackgroundSettled(handle, `[agent:${handle.name} failed] ${err?.message ?? err}`) },
      ).finally(() => inflight.delete(tracked))
      inflight.add(tracked)

      return `[agent:${handle.name} started] background; 完成后会通知你。用 agent_status 查看进度。`
    },

    /**
     * 后台 agent settle 后的通知：走轮边界注入，不打断父 agent 手上的活。
     *
     * `role: 'user'` + `<agent-notification>` 标记 —— `enqueueMessage` 只接受
     * user / system，一条伪造的 assistant 轮会让父模型以为这话是它自己说的。
     */
    _onBackgroundSettled(handle, result) {
      parent.enqueueMessage?.({
        role: 'user',
        content: `<agent-notification agent="${handle.name}" state="${handle.state}">\n${result}\n</agent-notification>`,
      })
    },

    /**
     * A2A 发信。**不打断**收信方手上的工具调用：信落进收信方的收件箱，在它下一个
     * ReAct 轮边界被注入。
     *
     * 三条投递路径：
     *   - `main` —— 立刻排进父 Agent 的待注入队列（父自己没有收件箱轮询点）；
     *   - 在跑的 subagent —— 留在收件箱，由 `SubagentRunner` 的 `onRoundStart` 取走；
     *   - 已终态但上下文还在的 subagent —— 用它保留的 memory 续跑一轮（`_resume`）。
     *
     * 全部失败路径返回可纠正的字符串，不抛 —— 与其余元工具一致。
     */
    async sendMessage({ to, body, summary, from }) {
      if (typeof to !== 'string' || to.trim() === '') {
        return 'Error: `to` is required — an agent id or name, or "parent" / "main".'
      }
      if (typeof body !== 'string' || body.trim() === '') {
        return 'Error: `message` is required — an empty message tells the other agent nothing.'
      }
      const targetId = runtime._resolveTarget(to, from)
      if (!targetId) return `Error: agent "${to}" not found. Use agent_status to list agents.`

      const envelope = {
        jsonrpc: '2.0', id: newEnvelopeId(), method: 'message/send',
        params: { from, to: { agentId: targetId }, kind: 'message', correlationId: null, body, meta: { summary } },
      }
      const sent = transport.send(envelope)
      if (!sent.ok) return `Error: could not deliver to "${to}" (${sent.reason}).`
      emit('a2a.delivered', {
        envelopeId: envelope.id, from: from.agentId, to: targetId, kind: 'message',
      })

      if (targetId === 'main') {
        for (const env of mailbox.drain('main')) {
          parent.enqueueMessage({ role: 'user', content: mailbox.formatForInjection(env) })
        }
        return 'delivered to main; it will read this at its next round boundary.'
      }

      const handle = registry.get(targetId)
      if (handle.isTerminal()) {
        if (registry.evicted(handle.agentId) || !handle._child) {
          // 信已经投进收件箱了，但这个收件箱再也不会被读 —— 排空掉，否则它会一直
          // 计在 mailbox.size() 里，看起来像"待送达"。
          mailbox.drain(handle.agentId)
          return `Error: agent ${handle.name} already finished (${handle.state}) and its context has been `
            + 'evicted. Start a new agent instead.'
        }
        return runtime._resume(handle)
      }
      return `delivered to ${handle.name}; it will read this at its next round boundary.`
    },

    /**
     * 解析收信人。`main` 恒指主 agent；`parent` 指**发信人自己的上级**（depth 1 的
     * agent 那就是 main，与 `main` 等价；depth 2 的 agent 则是派出它的那个 agent，
     * 而不是越级到 main）。其余按 agentId / name 查注册表。
     */
    _resolveTarget(to, from) {
      if (to === 'main') return 'main'
      if (to === 'parent') return registry.get(from?.agentId)?.parentAgentId ?? 'main'
      return registry.get(to)?.agentId ?? null
    },

    /** 向已结束的 agent 发消息 = 用它保留的 memory 续跑一轮。 */
    async _resume(handle) {
      const pending = mailbox.drain(handle.agentId)
      const text = pending.map(env => mailbox.formatForInjection(env)).join('\n\n')
      // 这里**故意**绕过 handle.transition() —— 状态机不允许离开终态（那是为了
      // 拦住并发路径上的非法迁移），而续跑是主 agent 明确要求的、单线程的复活。
      const from = handle.state
      // 新 AbortController：旧的那个多半已经 abort 过（或已随上一轮结束作废），
      // 复用它会让续跑期间的 agent_cancel 打空 —— abort 一个已 abort 的 controller
      // 什么都不会发生。
      handle._abort = new AbortController()
      handle.state = 'running'
      handle.endedAt = null
      emit('agent.state', {
        agentId: handle.agentId, agentName: handle.name, parentAgentId: handle.parentAgentId,
        from, to: 'running',
      })
      try {
        const reply = await handle._child.chat(text, { signal: handle._abort.signal })
        return runtime._settleResume(handle, { status: 'succeeded', text: reply })
      } catch (err) {
        return runtime._settleResume(handle, {
          status: 'failed', failureKind: classifyFailure(err), lastError: String(err?.message ?? err),
        })
      }
    },

    /**
     * 给续跑收尾。同样绕过状态机，但**取消优先**：`agent_cancel` 若在续跑期间把
     * handle 转成了 cancelled，那是一次显式的终态，不能被续跑的结果覆盖成
     * succeeded —— 这与 `runner._finishSucceeded` / `_finishFailed` 让位给
     * `_finishCancelled` 是同一条规则。
     */
    _settleResume(handle, result) {
      if (handle.state === 'cancelled') {
        handle.result = {
          status: 'cancelled', failureKind: 'aborted', lastError: handle._cancelReason ?? 'cancelled',
        }
      } else {
        handle.state = result.status
        handle.result = result
        emit('agent.state', {
          agentId: handle.agentId, agentName: handle.name, parentAgentId: handle.parentAgentId,
          from: 'running', to: result.status,
        })
      }
      handle.endedAt = Date.now()
      return runner.formatResult(handle)
    },

    hasPending() {
      return inflight.size > 0 || registry.list().length > 0
    },

    /** 等全部后台任务 settle。测试与 closeSubagents 用。 */
    async drain() {
      while (inflight.size > 0) await Promise.allSettled([...inflight])
    },

    async close() {
      // 先取消全部待答提问：阻塞在 `ask_user` 里的 agent 必须先拿到一个结果才能
      // 走完当前这轮，否则下面的 drain() 会等一个永远不会 settle 的 Promise。
      ask.cancelAll('runtime closed')
      for (const handle of registry.list()) {
        if (!handle.isTerminal()) {
          // 统一走 cancelHandle：跟 agent_cancel 工具用同一条路径转态 + abort，
          // 不再各写各的 abort() 用法（历史上这里是裸 abort() 无 reason，
          // agent_cancel 是 abort(reason) 这个原始字符串——两者传导进子 agent
          // 后 classifyFailure 看到的东西不一样，一个能归类成 aborted，另一个
          // 因为字符串没有 .name 会误判成 tool_error）。cancelHandle 内部构造
          // 一个 name=AbortError 的 Error 当 reason，两条路径此后行为一致，
          // 'runtime closed' 这个人类可读理由还能顺着 lastError 一路带到
          // 渲染出的 Agent_Result 里，而不只是留在下面这个事件 payload 里。
          cancelHandle(handle, { reason: 'runtime closed', emit, ask })
        }
      }
      await runtime.drain()
    },
  }

  runtime.tools = createSubagentTools(runtime)
  return runtime
}
