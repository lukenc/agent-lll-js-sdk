/**
 * SubagentRuntime —— 组装 subagent 系统的全部部件，并暴露给 `Agent` 的
 * 单一入口。`Agent` 只认这一个对象，不直接碰 registry / runner / graph。
 */
import { AgentRegistry } from './registry.js'
import { ArtifactTrack } from './artifacts.js'
import { SubagentRunner, cancelHandle, classifyFailure } from './runner.js'
import { AgentGraph } from './graph.js'
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
  keepAlive = true,
  keepAliveTimeoutMs = 600000,
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
      // 只在真的迁移成功之后唤醒 keep-alive —— 上面那些 return 都是"什么也没
      // 发生"，为它们叫醒主 agent 等于白烧一轮 LLM 调用。
      runtime._signalEvent()
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

  /**
   * keep-alive 的等待方。任何"后台状态往前动了一步"的时刻都要唤醒它们，否则
   * 一个已经拿到结果的主 agent 会继续干等到超时。
   * @type {Array<(outcome: string) => void>}
   */
  const waiters = []

  /**
   * 依赖图。两个回调就是"声明 ≠ 创建"落地的地方：
   *
   *   - `onReadyNode`（默认路径）—— **不启动任何东西**，只把上游产物交回主
   *     agent，由它看过实际产出之后再用 `graph_start` 写这个节点的最终契约。
   *   - `onAutoStart` —— `on_ready: 'auto'` 的后门，活儿事先就定死了才用。
   *
   * 两个回调都在 `AgentGraph._invoke` 的保护下同步执行，抛出的异常不会中断同批
   * 兄弟节点的调度（会记到节点上 + 发 `graph.callback.error`）。因此这里**不能**
   * 靠异常外泄来发现启动失败。
   */
  const graph = new AgentGraph({
    emit,
    onReadyNode: (node, upstream) => {
      const lines = upstream.map(u => `- ${u.nodeId} (${u.state}): ${excerpt(u.result)}`)
      const upstreamNote = lines.length > 0
        ? `的上游已全部完成：\n${lines.join('\n')}`
        : '没有依赖，可以直接启动。'
      parent.enqueueMessage({
        role: 'user',
        content: `<graph-node-ready node="${node.nodeId}">\n`
          + `节点 "${node.nodeId}"（${node.description}）${upstreamNote}\n\n`
          + '现在决定它到底该做什么：用 graph_start 给出最终的 prompt 契约来启动它，'
          + '或用 agent_cancel 放弃它。\n</graph-node-ready>',
      })
      // 同 `_onBackgroundSettled`：通知入队后叫醒可能在等的主 agent。
      runtime._signalEvent()
    },
    onAutoStart: (node) => { void runtime._startNode(node, { background: true }) },
  })

  const runtime = {
    parent, registry, artifacts, runner, sharedHistory, aliases, defaultType, maxDepth,
    mailbox, transport, ask, graph,
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
     * 真正把一个 queued 节点变成 subagent —— 图调度**唯一**的创建入口。
     *
     * 入参 `node` 是图给的**快照**（`graph.start()` 与 `onAutoStart` 都发快照），
     * 改它不影响图。所以节点状态一律通过 `graph.onAgentSettled` 回报，不能直接写。
     *
     * @param {object} node 节点快照
     * @param {{ background?: boolean, signal?: AbortSignal }} [opts]
     * @returns {Promise<string>}
     */
    async _startNode(node, { background = true, signal } = {}) {
      // 上游产物作为契约的 inputs 交给子 agent（正文由主 agent 写进 prompt）。
      const upstream = node.dependsOn
        .map(id => graph.get(id))
        .filter(u => u?.agentId)
        .flatMap(u => artifacts.list({ agentId: u.agentId }).map(r => ({
          key: r.key, agentName: r.agentName, summary: r.summary, sha: r.sha,
        })))

      /** @type {import('./handle.js').AgentHandle|null} */
      let handle = null

      /**
       * 把终态回报给图。**以 handle 为准，不靠结果字符串猜** —— 渲染出来的
       * `[agent:x cancelled]` 里没有 ' failed]'，猜的话一次主动取消会被读成
       * succeeded，把下游从一条主 agent 已经放弃的分支上放出来。handle 压根没
       * 创建出来（未知类型 / 模型解析失败）时按 failed 记。
       */
      const settle = (result) => {
        const status = handle?.result?.status ?? (handle?.state === 'cancelled' ? 'cancelled' : null)
        const state = status === 'succeeded' || status === 'cancelled' ? status : 'failed'
        graph.onAgentSettled({ nodeId: node.nodeId, state, agentId: handle?.agentId ?? null, result })
      }

      const spawned = runtime.spawn({
        description: node.description,
        prompt: node.prompt,
        subagentType: node.subagentType ?? undefined,
        model: node.model ?? undefined,
        // 后台化由这里自己做（要在 settle 之后才通知父 agent），spawn 一律同步拿 task。
        background: false,
        nodeId: node.nodeId,
        inputs: upstream,
        depth: 1,
        signal,
        onHandle: (h) => {
          handle = h
          // **趁早**回报 running（这里还在 spawn 的同步段里）：节点若停在 queued
          // 而回调随后抛出，图只能按 launch_failed 处理 —— 而 agent 其实已经起
          // 飞了，会自己走到终态。见 graph.js `onAutoStart` 那段注释。
          graph.onAgentSettled({ nodeId: node.nodeId, state: 'running', agentId: h.agentId })
        },
      })

      if (!background) {
        const result = await spawned
        settle(result)
        return result
      }

      /** 后台收尾：先登记结果推进下游，再通知父 agent。 */
      const finish = (result) => {
        settle(result)
        try {
          // 真 handle 优先：`_onBackgroundSettled` 会把 name / state 写进注入的
          // 通知里，编一个假 handle 等于给父 agent 一个查不到的 agent 名。
          runtime._onBackgroundSettled(
            handle ?? { name: `node:${node.nodeId}`, state: 'failed' }, result)
        } catch (err) {
          // 通知入队失败不该变成一个没人接的 rejection —— 结果已经登记进图了，
          // 主 agent 仍能从 agent_status 的节点表里看到它。
          emit('graph.callback.error', {
            nodeId: node.nodeId, callback: 'notify', error: String(err?.message ?? err),
          })
        }
      }

      const tracked = spawned
        .then(finish, err => finish(`[node:${node.nodeId} failed] ${err?.message ?? err}`))
        .finally(() => inflight.delete(tracked))
      inflight.add(tracked)
      return `[node:${node.nodeId} started] background; 完成后会通知你。用 agent_status 查看进度。`
    },

    /**
     * 取消一个图节点。`graph.cancel` 只改图的状态，**活 agent 必须自己走
     * `cancelHandle`** —— 阻塞在 `ask_user` 里的 agent 要等当前工具调用返回才
     * 看得见 abort signal，不连它挂起的提问一起结掉，这次取消就只是改了个状态。
     *
     * @returns {{ ok: boolean, reason?: string }}
     */
    _cancelNode(nodeId, reason) {
      const cancelled = graph.cancel(nodeId, reason)
      if (!cancelled.ok) return cancelled
      const handle = cancelled.agentId ? registry.get(cancelled.agentId) : null
      if (handle) cancelHandle(handle, { reason, emit, ask })
      return cancelled
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
      // 主 agent 可能正卡在 keep-alive 的等待里 —— 通知入队之后立刻叫醒它。
      runtime._signalEvent()
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
        // 主 agent 可能正停在 keep-alive 的 `nextEvent()` 里。不叫醒它，这封信要
        // 等满一个 keepAliveTimeoutMs（默认 10 分钟）才被读到 —— 而 keep-alive
        // 每轮对话只等一次，那一停之后这轮就收尾了。子 agent 跑到一半回头找父
        // agent 要个决策，正是 A2A 存在的理由。
        runtime._signalEvent()
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

    /** 图还没走完，或还有 agent 没结束？—— "这活干完了吗"用这个。 */
    hasPending() {
      return inflight.size > 0 || registry.list().length > 0 || graph.hasPending()
    },

    /**
     * 真的还有活在飞？—— **"该不该继续等下去"用这个，别用 `hasPending()`**。
     * blocked / awaiting_confirm 的节点等的是主 agent 下一步动作，不是后台任务：
     * 它们不产生任何事件，也不会自行推进，一张声明完就被遗忘的图会让
     * `hasPending()` 永远为真，等事件的调用方于是干等到超时。
     */
    hasInFlight() {
      return inflight.size > 0 || registry.list().length > 0 || graph.hasInFlight()
    },

    /** keep-alive 总开关与单次等待上限（`Agent._keepAliveOnce` 读它们）。 */
    keepAlive,
    keepAliveTimeoutMs,

    /**
     * 唤醒全部 keep-alive 等待方。没人在等时是个无副作用的空操作。
     *
     * **规则：任何把消息排进 `parent.enqueueMessage` 的路径，末尾都要调它。**
     * 判据是"这一步会让主 agent 想重新决策吗" —— 会就得叫醒它，漏调的代价是主
     * agent 干等满一个 `keepAliveTimeoutMs`（默认 10 分钟）才发现事情早变了。
     * 今天的四个投递点：`onReadyNode`、`_onBackgroundSettled`、`sendMessage` 的
     * `to: 'main'` 分支（三个都调了），以及 `Agent._keepAliveOnce` 自己的超时提示
     * ——那条是主 agent 写给自己的，它此刻正好刚从等待里出来，没有等待方可叫。
     *
     * `SubagentRunner._deliverMail` 排的是**子 agent**的队列，不是 parent 的：
     * 子 agent 由 `buildChildOptions` 构造，那里不传 `subagents`，所以整棵树只有
     * 这一个 runtime、一份 `waiters` —— 子 agent 永远不会停在 keep-alive 里。哪天
     * 子 agent 也有了自己的 runtime，那里就得补一个 `child.subagents?._signalEvent()`。
     */
    _signalEvent() {
      for (const resolve of waiters.splice(0, waiters.length)) resolve('event')
    },

    /**
     * 等下一个 subagent 事件。
     *
     * **注册等待方是同步的**（Promise executor 同步执行），所以调用方在
     * `hasInFlight()` 与本调用之间不会漏掉唤醒 —— 中间没有 await。
     *
     * @param {{ signal?: AbortSignal, timeoutMs?: number }} [opts]
     * @returns {Promise<'event'|'timeout'|'aborted'>}
     */
    nextEvent({ signal, timeoutMs = keepAliveTimeoutMs } = {}) {
      if (signal?.aborted) return Promise.resolve('aborted')
      return new Promise((resolve) => {
        let settled = false
        const onAbort = () => finish('aborted')
        const finish = (outcome) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          // abort 监听器**必须显式摘掉**：`{ once: true }` 只在真的 abort 时自摘，
          // 而 keep-alive 每轮都等一次、用的是调用方那同一个 signal —— 走
          // event / timeout 收尾的监听器会一路堆到 MaxListenersExceededWarning。
          signal?.removeEventListener('abort', onAbort)
          const idx = waiters.indexOf(wake)
          if (idx >= 0) waiters.splice(idx, 1)
          resolve(outcome)
        }
        const wake = () => finish('event')
        // **不 unref 这个定时器。** 它是这次等待唯一的兜底：event loop 上没有
        // 别的 ref 时，unref 掉的定时器不会把进程唤回来跑它 —— 于是"最多等
        // keepAliveTimeoutMs"变成"这个 Promise 永不 settle，chat() 挂死"。它
        // 的寿命只有一次等待，且 `finish()` 每条路径都 clearTimeout。
        const timer = setTimeout(() => finish('timeout'), timeoutMs)
        signal?.addEventListener('abort', onAbort, { once: true })
        waiters.push(wake)
      })
    },

    /** 等全部后台任务 settle。测试与 closeSubagents 用。 */
    async drain() {
      while (inflight.size > 0) await Promise.allSettled([...inflight])
    },

    async close() {
      // 先取消全部待答提问：阻塞在 `ask_user` 里的 agent 必须先拿到一个结果才能
      // 走完当前这轮，否则下面的 drain() 会等一个永远不会 settle 的 Promise。
      ask.cancelAll('runtime closed')
      // 图上未终态的节点：走 `_cancelNode`，它会把有 agent 在跑的节点连 handle
      // 一起 cancelHandle 掉。已终态的节点 `graph.cancel` 自己会拒，无需先筛。
      for (const nodeId of [...graph.nodes.keys()]) runtime._cancelNode(nodeId, 'runtime closed')
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

/**
 * 就绪通知里放的上游结果摘录。
 *
 * **整段截断，不解析掉 `formatResult` 的头部** —— 一是剥头部就把这里跟那边的
 * 排版绑死了，那种耦合坏起来是无声的；二是头部的 attempts / rounds 本身就是
 * 主 agent 写下游契约时用得上的信号（第 3 次尝试才成功的上游，值得一份不一样
 * 的 prompt）。头部 + usage 约 150 字符，500 的预算里正文还剩得下。
 */
function excerpt(text, max = 500) {
  const body = String(text ?? '').trim()
  if (body.length === 0) return '(no output)'
  const collapsed = body.replace(/\n{3,}/g, '\n\n')
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed
}
