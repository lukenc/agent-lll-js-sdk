/**
 * SubagentRuntime —— 组装 subagent 系统的全部部件，并暴露给 `Agent` 的
 * 单一入口。`Agent` 只认这一个对象，不直接碰 registry / runner / graph。
 */
import { AgentRegistry } from './registry.js'
import { ArtifactTrack } from './artifacts.js'
import { SubagentRunner, cancelHandle, classifyFailure } from './runner.js'
import { AgentGraph, GRAPH_TERMINAL_STATES, GRAPH_IN_FLIGHT_STATES } from './graph.js'
import { createWorktree } from './isolation.js'
import { resolveModelAliases, resolveModel } from './models.js'
import { getAgentType, listAgentTypes, registerAgentType } from './types.js'
import { createSubagentTools } from './tools.js'
import { Mailbox } from './mailbox.js'
import { AskRegistry } from './ask.js'
import { resolveA2ATransport, newEnvelopeId } from './a2a/index.js'
// 内置 local transport 自注册的副作用 import（`a2a/index.js` 不认识它，
// 与 `mcp/transports/*` 同一套路）。
import './a2a/local.js'

let GRAPH_SEQ = 0

/**
 * 生成 `gph_` + 8 位十六进制的进程内唯一图 id。
 *
 * **纯单调计数器，不混时间位** —— 与 `registry.js` 的 `newAgentId`、
 * `a2a/index.js` 的 `newEnvelopeId` 同一理由，本项目已经在那两处各踩过一次：
 * 混进时间位就只剩几位给计数器，同一毫秒内开的第 N 张图会拿到与第 1 张相同的
 * id，而 `graphs.set` 是静默覆盖 —— 前一张图连它记录的节点归属一起消失，不报
 * 任何错。图条目自己带 `createdAt`，id 里再编一份创建时间本就是多余的。
 */
function newGraphId() {
  GRAPH_SEQ = (GRAPH_SEQ + 1) >>> 0
  return `gph_${GRAPH_SEQ.toString(16).padStart(8, '0')}`
}

export function createSubagentRuntime({
  parent,
  types = [],
  defaultType = 'general-purpose',
  maxConcurrent = 4,
  maxDepth = 2,
  modelAliases,
  retry = {},
  /**
   * worktree 隔离的主机配置（`{ worktreeBaseDir, branchPrefix, cwd, exec }`）。
   * `exec` 是给测试与自带沙箱执行器的主机的注入口，缺省时直接 spawn `git`。
   */
  isolation: isolationOpts = {},
  artifacts: artifactOpts = {},
  retainCompleted = 20,
  /**
   * 保留多少张 closed 图。超限的按 FIFO 整张淘汰 —— 否则"无界增长"只是从节点级
   * 搬到了图级。有在飞节点的图永远不淘汰，见 `_evictClosedGraphs`。
   */
  retainClosedGraphs = 5,
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
    opts: {
      // `{ ...retry }`，不是挑着重建 `{ maxAttempts, attemptTimeoutMs }` 两个键：
      // 早年这里连同 `maxAttempts` 一起 eager 填了默认值 `3`，于是 `runner.js`
      // 那条 `opts.retry?.maxAttempts ?? type.maxAttempts ?? 3` 回退链里
      // `opts.retry.maxAttempts` 恒非 undefined，`?? type.maxAttempts` 永远轮
      // 不到 —— `Agent_Type.maxAttempts` 因此不可达（followup 修复）。默认值
      // 唯一该解析的地方是 runner.js 那条回退链本身，这里不能替它抢答；顺带
      // 让 host 传的其余 retry 字段（比如 `backoffMs`）不再被这里的白名单
      // 悄悄吞掉。
      retry: { ...retry },
      maxDepth,
      isolation: isolationOpts,
    },
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
   * 图容器。**图跟的是任务**：同一个任务同一张可变图，一个 agent 可以同时持有
   * 好几张（不同任务）。每张图有自己的 `nodes` Map，所以 `node_id` 的唯一性天然
   * 收窄到图级 —— 第二个任务重用 `n1` 不再让整批声明被拒。
   *
   * @typedef {{
   *   graph: AgentGraph, graphId: string, label: string|null,
   *   state: 'open'|'closed', createdAt: number, closedAt: number|null,
   * }} GraphEntry
   * @type {Map<string, GraphEntry>} graphId → 条目（插入序 = 创建序）
   */
  const graphs = new Map()

  const runtime = {
    parent, registry, artifacts, runner, sharedHistory, aliases, defaultType, maxDepth,
    mailbox, transport, ask, graphs,
    /** @type {string|null} 当前在用的那张图。构造时不预先开图（惰性）。 */
    activeGraphId: null,
    /** 供 `Agent` 注入的工具集 */
    tools: [],

    /**
     * 活跃图的 `AgentGraph`，没有活跃图时是 `null`。
     *
     * 保留成 getter 是为了让既有调用点最小改动。**别在需要"某张特定图"的地方读
     * 它** —— 尤其不能在回调闭包里读，见 `newGraph` 的注释。
     * @returns {AgentGraph|null}
     */
    get graph() {
      return graphs.get(runtime.activeGraphId)?.graph ?? null
    },

    /**
     * 开一张新图并置为活跃图。
     *
     * 两个宿主回调**在这里为每张图单独构造**，各自闭包捕获自己的 `graphId`：
     * `AgentGraph` 的构造回调不带图身份，而 `onAgentSettled` 对未知 nodeId 是
     * 静默 `return`（graph.js:397）—— 闭包若读 `runtime.graph`（活跃图 getter），
     * 活跃图一变，在飞节点的回报就落到别人的图上，**不报任何错**，只是让节点永远
     * 停在 running。这是这里能出的最坏故障形态。
     *
     * 两个回调都在 `AgentGraph._invoke` 的保护下同步执行，抛出的异常不会中断同批
     * 兄弟节点的调度（会记到节点上 + 发 `graph.callback.error`）。因此这里**不能**
     * 靠异常外泄来发现启动失败。
     *
     * @param {{ label?: string|null }} [opts]
     * @returns {GraphEntry}
     */
    newGraph({ label = null } = {}) {
      const graphId = newGraphId()
      /** @type {GraphEntry} */
      const entry = {
        graphId, label, state: 'open', createdAt: Date.now(), closedAt: null, graph: null,
      }
      entry.graph = new AgentGraph({
        emit,
        // 默认路径 —— **不启动任何东西**，只把上游产物交回主 agent，由它看过实际
        // 产出之后再用 `graph_start` 写这个节点的最终契约。
        onReadyNode: (node, upstream) => runtime._notifyNodeReady(graphId, node, upstream),
        // `on_ready: 'auto'` 的后门，活儿事先就定死了才用。
        onAutoStart: (node) => { void runtime._startNode(node, { graphId, background: true }) },
      })
      graphs.set(graphId, entry)
      runtime.activeGraphId = graphId
      emit('graph.opened', { graphId, label })
      // 新图是"closed 图可能已经超限"的另一个时机：上一轮因为在飞节点跳过的图，
      // 这时可能已经空出来了。
      runtime._evictClosedGraphs()
      return entry
    },

    /**
     * 把一张图标成 closed，并按 `disposition` 处理它里头还没干完的节点。
     *
     * closed 是**容器层的标记**：closed 图仍查得到状态、里头在飞的节点仍取消得掉
     * （解析路径 `_lookupGraph` / `_resolveGraph` 因此对状态不设限），也仍然可以被
     * `reactivateNodes` 重新打开。变化只有两点 —— 不再接受新的声明，以及成为 FIFO
     * 淘汰的候选。
     *
     * **什么时候该关，只有模型判断得出来** —— 框架分不清"新消息是同一个任务的续集"
     * 还是"另一个任务"。而关一张仍有未完成节点的图之前要先问用户，同样只能写在
     * `graph_close` 的 description 里。这一层只执行拿到的决定。
     *
     * @param {string|null} [graphId] 省略时关活跃图。**不会像 `_resolveGraph`
     *        那样顺手新开一张** —— 建一张空图只为了立刻关掉它毫无意义。
     * @param {{ reason?: string|null, disposition?: 'keep_running'|'cancel_outstanding'|null }} [opts]
     *        `keep_running`（宿主省略时的默认）只标记，在飞的 agent 继续跑，
     *        `hasInFlight()` 仍算它们；`cancel_outstanding` 把每个未终态节点走一遍
     *        `_cancelNode`（连它挂在 `ask_user` 上的提问一起结算）。
     * `outstanding` 是每个未终态节点，`inFlight` / `awaitingConfirm` / `blocked` 是
     * 按 `node.state` 拆出来的三个子集（并集等于 `outstanding`）—— `graph_close`
     * 工具靠这三份分别报告"真在跑" vs "等模型自己动手" vs "等上游"，不能把它们
     * 混在一起说成同一件事（见 `tools.js` 的 `keep_running` 分支）。
     * @returns {{ ok: true, entry: GraphEntry, cancelled: string[], stoppedAgents: number,
     *   outstanding: string[], inFlight: string[], awaitingConfirm: string[],
     *   blocked: string[] } | { ok: false, reason: string }}
     */
    closeGraph(graphId = null, { reason = null, disposition = 'keep_running' } = {}) {
      if (disposition !== 'keep_running' && disposition !== 'cancel_outstanding') {
        return {
          ok: false,
          reason: `unknown disposition ${JSON.stringify(disposition ?? null)}. Pass `
            + '"cancel_outstanding" to stop every node that has not finished, or "keep_running" to '
            + 'close the graph and let the agents already in flight run to completion.',
        }
      }
      const found = runtime._lookupGraph(graphId)
      if (!found.ok) return found
      const { entry } = found
      if (entry.state === 'closed') {
        return { ok: false, reason: `graph "${entry.graphId}" is already closed` }
      }
      // 先处置节点再标 closed：`_cancelNode` 会向宿主投递取消（事件、被取消 agent
      // 的收尾），让那些事发生在一张还叫得出名字的 open 图上更好读。
      const cancelled = []
      let stoppedAgents = 0
      if (disposition === 'cancel_outstanding') {
        for (const nodeId of [...entry.graph.nodes.keys()]) {
          const out = runtime._cancelNode(nodeId, reason ?? 'graph closed', { graphId: entry.graphId })
          if (!out.ok) continue
          cancelled.push(nodeId)
          // 节点数不等于 agent 数：blocked / awaiting_confirm 的节点压根没起 agent。
          if (out.agentStopped) stoppedAgents += 1
        }
      }
      const outstandingNodes = [...entry.graph.nodes.values()]
        .filter(node => !GRAPH_TERMINAL_STATES.has(node.state))
      const outstanding = outstandingNodes.map(node => node.nodeId)
      // 三个子集互斥且并集等于 outstanding：GRAPH_IN_FLIGHT_STATES 复用 graph.js
      // 那份状态集合，不是这里另抄一份 —— `hasInFlight()` 用的是同一份。
      const inFlight = outstandingNodes
        .filter(node => GRAPH_IN_FLIGHT_STATES.has(node.state)).map(node => node.nodeId)
      const awaitingConfirm = outstandingNodes
        .filter(node => node.state === 'awaiting_confirm').map(node => node.nodeId)
      const blocked = outstandingNodes
        .filter(node => node.state === 'blocked').map(node => node.nodeId)

      entry.state = 'closed'
      entry.closedAt = Date.now()
      // 关掉活跃图之后就没有活跃图了 —— 下一次不带 graph_id 的声明会新开一张，
      // 而不是继续往一张已经关掉、随时会被淘汰的图里塞节点。
      if (runtime.activeGraphId === entry.graphId) runtime.activeGraphId = null
      emit('graph.closed', {
        graphId: entry.graphId, label: entry.label, reason, disposition,
        cancelled: cancelled.length, stoppedAgents, outstanding: outstanding.length,
      })
      runtime._evictClosedGraphs()
      return { ok: true, entry, cancelled, stoppedAgents, outstanding, inFlight, awaitingConfirm, blocked }
    },

    /**
     * 重新激活一批已终态节点（缓存失效）。**已关闭的图也可以** —— 这正是用例：
     * 任务收尾之后又来了一个局部修改，正好命中一个已完成节点干过的活。激活会把那张
     * 图重新置为 open 并成为在用的那张（接下来的 `graph_start` 该落在它上面）。
     *
     * 返回结构化报告，渲染在 `tools.js`：**框架不自动扩散到下游，但必须把模型漏掉的
     * 东西摆到它面前**。模型手工挑节点会漏 —— 它得靠记忆推断"谁消费过这个节点的
     * 产物"，而它的上下文可能已被压缩过；漏一个下游，那个下游就拿着过期认知继续跑，
     * 而且不报任何错。
     *
     * `downstream[].consumedKeys` 算的是"这个节点的契约 inputs 里出现过被激活节点的
     * 产物 key"。判据是 `_startNode` 那份实现：一个节点拿到的 inputs 恰好是它**直接
     * 上游**已登记的产物，所以"直接依赖 + 那个上游的产物 key"就是它当初读到的东西。
     * 产物 key 必须在 `graph.reactivate` **之前**取 —— 激活会清掉 `agentId`，而产物
     * 是按 agentId 记账的。
     *
     * @param {{ graphId?: string|null, nodeIds?: string[]|null, reason?: string|null }} [opts]
     * @returns {{ ok: true, entry: GraphEntry, reactivated: Array<{ nodeId: string, generation: number }>,
     *   skipped: Array<{ nodeId: string, reason: string }>, reopened: boolean,
     *   staleKeys: string[], downstream: Array<object> } | { ok: false, reason: string }}
     */
    reactivateNodes({ graphId = null, nodeIds = null, reason = null } = {}) {
      if (!Array.isArray(nodeIds) || nodeIds.length === 0
        || nodeIds.some(id => typeof id !== 'string' || id.trim() === '')) {
        return {
          ok: false,
          reason: '`node_ids` must be a non-empty array of node ids — the nodes whose finished work '
            + 'is now out of date.',
        }
      }
      // 只查不建：激活打的是已经声明过的节点，凭它凭空造一张空图毫无意义。
      const found = runtime._lookupGraph(graphId)
      if (!found.ok) return found
      const { entry } = found

      const requested = [...new Set(nodeIds.map(id => id.trim()))]
      /** @type {Array<{ nodeId: string, reason: string }>} */
      const skipped = []
      const present = []
      for (const nodeId of requested) {
        // 多图之后 node_id 可以跨图重名，"不在这张图里"要点名到底哪张图有它 ——
        // `graph.reactivate` 自己只会说 not found，模型没法据此纠正。
        if (entry.graph.nodes.has(nodeId)) present.push(nodeId)
        else skipped.push({ nodeId, reason: runtime._nodeNotHereReason(nodeId, entry) })
      }

      /** @type {Map<string, string[]>} nodeId → 它登记过的产物 key（激活前取） */
      const keysByNode = new Map()
      for (const nodeId of present) {
        const agentId = entry.graph.get(nodeId)?.agentId
        keysByNode.set(nodeId, agentId
          ? [...new Set(artifacts.list({ agentId }).map(r => r.key))]
          : [])
      }

      let outcome = { reactivated: [], skipped: [] }
      if (present.length > 0) outcome = entry.graph.reactivate(present)
      skipped.push(...outcome.skipped)
      const seeds = new Set(outcome.reactivated)

      let reopened = false
      if (seeds.size > 0) {
        if (entry.state === 'closed') {
          entry.state = 'open'
          entry.closedAt = null
          reopened = true
          emit('graph.reopened', { graphId: entry.graphId, label: entry.label, reason })
        }
        // 激活就是"这张图上又有活了"，跟一次成功的声明同一性质，所以跟着切活跃图
        // —— 接下来那句 `graph_start` 不带 graph_id 时该落在这张图上。
        runtime.activeGraphId = entry.graphId
        emit('graph.reactivated', {
          graphId: entry.graphId, nodeIds: [...seeds], reason, reopened,
        })
      }

      return {
        ok: true,
        entry,
        reopened,
        staleKeys: [...new Set([...seeds].flatMap(id => keysByNode.get(id) ?? []))],
        reactivated: [...seeds].map(nodeId => ({
          nodeId, generation: entry.graph.get(nodeId)?.generation ?? 0,
        })),
        skipped,
        downstream: describeDownstream(entry.graph, seeds, keysByNode),
      }
    },

    /**
     * 只查不建：给了 id 就查它，不给就查活跃图。
     *
     * 与 `_resolveGraph` 的区别只有一条 —— 它不会"没有活跃图就新开一张"。取消、
     * 关闭、查状态这类操作凭一次注定失败的调用凭空造出一张空图（还把它设成活跃）
     * 是个说不通的副作用，所以那几条路走这里。
     *
     * @returns {{ ok: true, entry: GraphEntry } | { ok: false, reason: string }}
     */
    _lookupGraph(graphId = null) {
      const entry = graphs.get(graphId ?? runtime.activeGraphId)
      if (entry) return { ok: true, entry }
      return {
        ok: false,
        reason: graphId != null
          ? `graph "${graphId}" not found. ${runtime._knownGraphsNote()}`
          : `no graph is active. ${runtime._knownGraphsNote()}`,
      }
    },

    /**
     * 解析目标图。给了 id 就查（查不到软失败）；不给则用活跃图，**活跃图不存在时
     * 新开一张并置为活跃** —— 让"直接声明一批节点"这条最常见的路径不必先显式开图。
     *
     * 对图的 state 不设限：closed 图也照样解析得到，否则一张 closed 图里还在飞的
     * 节点就再也取消不了、状态也查不到了。要拦 closed 的调用方自己拦（今天只有
     * `agent_graph` 拦，因为往一张可被淘汰的图里声明节点等于让它们随时消失）。
     *
     * @returns {{ ok: true, entry: GraphEntry } | { ok: false, reason: string }}
     */
    _resolveGraph(graphId = null) {
      const found = runtime._lookupGraph(graphId)
      if (found.ok || graphId != null) return found
      return { ok: true, entry: runtime.newGraph() }
    },

    /** 含某个 nodeId 的全部图（含 closed）。软失败提示靠它点名。 */
    findNodeGraphs(nodeId) {
      return [...graphs.values()].filter(entry => entry.graph.nodes.has(nodeId))
    },

    /** 未知 graph_id 的软失败提示：列出模型实际能填的东西。 */
    _knownGraphsNote() {
      if (graphs.size === 0) return 'No graph exists yet — declare one with agent_graph.'
      const known = [...graphs.values()].map(e => `${e.graphId} (${e.state})`).join(', ')
      return `Known graphs: ${known}.`
    },

    /**
     * "这个 node_id 不在这张图里"的软失败提示。**多图之后 node_id 可以跨图重名，
     * 这句提示是模型自我纠正的唯一依据** —— 所以必须点名到底哪几张图含它。
     */
    _nodeNotHereReason(nodeId, entry) {
      const others = runtime.findNodeGraphs(nodeId).filter(e => e !== entry)
      if (others.length === 0) {
        return `node "${nodeId}" is not in graph ${entry.graphId}, and no other graph has it either. `
          + 'Declare it with agent_graph first.'
      }
      const where = others
        .map(e => `${e.graphId}${e.label ? ` (${JSON.stringify(e.label)}, ${e.state})` : ` (${e.state})`}`)
        .join(', ')
      return `node "${nodeId}" is not in graph ${entry.graphId}; it lives in ${where}. `
        + 'Pass graph_id to act on it there.'
    },

    /**
     * closed 图按 FIFO 整张淘汰。
     *
     * **有在飞节点的图一律跳过。** 一张图被关掉不代表它里头的 agent 停了；淘汰它
     * 就把那个还在跑的 agent 的节点归属丢了 —— 它 settle 时找不到自己的图，静默
     * return，节点的终态无处可记。跳过不消耗淘汰额度，所以会继续往更新的 closed
     * 图上找，宁可多留一张也不丢归属。
     */
    _evictClosedGraphs() {
      const closed = [...graphs.values()].filter(e => e.state === 'closed')
      let excess = closed.length - retainClosedGraphs
      if (excess <= 0) return
      // closedAt 相等时 sort 的稳定性让它退回创建序 —— 两者都是合理的 FIFO。
      closed.sort((a, b) => a.closedAt - b.closedAt)
      for (const entry of closed) {
        if (excess <= 0) break
        if (entry.graph.hasInFlight()) continue
        graphs.delete(entry.graphId)
        emit('graph.evicted', {
          graphId: entry.graphId, label: entry.label, nodes: entry.graph.nodes.size,
        })
        excess -= 1
      }
    },

    /**
     * 节点就绪通知（默认路径的 `onReadyNode`）。
     *
     * `graphId` 是入参而不是从活跃图读的：通知里必须写清是哪张图的哪个节点，否则
     * 跨图重名的 `node_id` 会让模型的 `graph_start` 打到别的图上。
     */
    _notifyNodeReady(graphId, node, upstream) {
      const lines = upstream.map(u => `- ${u.nodeId} (${u.state}): ${excerpt(u.result)}`)
      const upstreamNote = lines.length > 0
        ? `的上游已全部完成：\n${lines.join('\n')}`
        : '没有依赖，可以直接启动。'
      parent.enqueueMessage({
        role: 'user',
        content: `<graph-node-ready graph="${graphId}" node="${node.nodeId}">\n`
          + `图 ${graphId} 的节点 "${node.nodeId}"（${node.description}）${upstreamNote}\n\n`
          + '现在决定它到底该做什么：用 graph_start（带上这个 graph_id）给出最终的 prompt 契约来启动它，'
          + '或用 agent_cancel 放弃它。\n</graph-node-ready>',
      })
      // 同 `_onBackgroundSettled`：通知入队后叫醒可能在等的主 agent。
      runtime._signalEvent()
    },

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
        model: resolved, isolation: null,
      })
      // 图调度用它把 agentId 回填到节点。
      onHandle?.(handle)

      // worktree 要在 handle 之后建（路径与分支名都要 agentId），在执行之前建
      // 好（契约里那句"你的工作目录是 X"必须在子 agent 读到首条消息之前就是
      // 真的）。建不出来时**不降级成无隔离** —— 主 agent 之所以要隔离，多半是
      // 因为有别的 agent 在同一批文件上干活；悄悄退回共享目录正是它想避免的。
      if (isolation?.mode === 'worktree') {
        try {
          const wt = await createWorktree({
            agentId: handle.agentId,
            baseDir: isolationOpts.worktreeBaseDir,
            branchPrefix: isolationOpts.branchPrefix,
            cwd: isolationOpts.cwd,
            exec: isolationOpts.exec,
          })
          handle.isolation = {
            mode: 'worktree', path: wt.path, branch: wt.branch, repoRoot: wt.repoRoot,
            dirty: false, changedFiles: 0, removed: false, branchRemoved: false,
          }
        } catch (err) {
          cancelHandle(handle, { reason: `isolation "worktree" unavailable (${err.reason})`, emit, ask })
          return `Error: isolation "worktree" unavailable (${err.reason}): ${err.message}\n`
            + 'Retry without the isolation parameter.'
        }
      }

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
        let release
        try {
          release = await registry.acquireSlot(depth, { signal: childSignal })
        } catch (err) {
          // 还没排到并发槽就被取消：`runner.run()` 压根不会跑，它那条收尾路径也
          // 就不会执行 —— worktree 会一直留在盘上。这里补收一次。
          await runner._finalizeIsolation(handle)
          throw err
        }
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
     * `graphId` 必须由调用方给全：回报要落回**节点自己那张图**，读活跃图 getter
     * 的话活跃图一变回报就落到别人头上，而那是个静默错误。
     *
     * @param {object} node 节点快照
     * @param {{ graphId: string, background?: boolean, signal?: AbortSignal }} opts
     * @returns {Promise<string>}
     */
    async _startNode(node, { graphId, background = true, signal } = {}) {
      const graph = graphs.get(graphId)?.graph
      // 正常路径上不该发生（调用方刚解析过这张图，且启动会立刻让它变成在飞、
      // 从而免于淘汰）。但 `onAutoStart` 那条路是 `void` 掉的 async 调用，这里抛
      // TypeError 会变成一个没人接的 rejection —— 宁可返回一句话。
      if (!graph) return `Error: graph "${graphId}" no longer exists; node "${node.nodeId}" was not started.`

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
       * 这一轮的 generation，**在启动时就捕获**。两次回报（`onHandle` 的 running 与
       * `finish` 的终态）都带上它，图那边对不上就丢弃 —— 节点若在这中间被
       * `reactivate` 送回去重跑，这一轮的回报就属于上一个 generation，采信它等于把
       * 陈旧结果复活、并据此放行本该重跑的下游。见 `graph.onAgentSettled`。
       */
      const generation = node.generation

      /**
       * 把终态回报给图。**以 handle 为准，不靠结果字符串猜** —— 渲染出来的
       * `[agent:x cancelled]` 里没有 ' failed]'，猜的话一次主动取消会被读成
       * succeeded，把下游从一条主 agent 已经放弃的分支上放出来。handle 压根没
       * 创建出来（未知类型 / 模型解析失败）时按 failed 记。
       */
      const settle = (result) => {
        const status = handle?.result?.status ?? (handle?.state === 'cancelled' ? 'cancelled' : null)
        const state = status === 'succeeded' || status === 'cancelled' ? status : 'failed'
        graph.onAgentSettled({
          nodeId: node.nodeId, state, agentId: handle?.agentId ?? null, result, generation,
        })
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
        // **图节点恒为 depth 1、父恒为 main（`parentAgentId` 的默认值），因为只有主
        // agent 能碰图工具。** `runner.js` 的 `GRAPH_TOOLS` 无条件把四个图工具挡在
        // 子 agent 的工具集外，`canSpawn` 也不放行，所以这条路上的调用方只可能是主
        // agent。哪天把图工具重新下发给子 agent，这两个字面量就立刻变成三个错：
        // `maxDepth` 从图这条路失效、`send_message({ to: 'parent' })` 跳掉一层、
        // 以及最要命的——一个 depth-1 的子 agent 调 `graph_start({ run_in_background:
        // false })` 会 await 它自己正占着的那个 depth-1 并发池，默认 maxConcurrent: 4
        // 下四个这样的子 agent 就把池坐死。那种改动必须同时把调用方的 `ctx.depth` /
        // `ctx.agentId` 顺着 `_startNode` 透传进来，而不是只放开工具集。
        depth: 1,
        signal,
        onHandle: (h) => {
          handle = h
          // **趁早**回报 running（这里还在 spawn 的同步段里）：节点若停在 queued
          // 而回调随后抛出，图只能按 launch_failed 处理 —— 而 agent 其实已经起
          // 飞了，会自己走到终态。见 graph.js `onAutoStart` 那段注释。
          graph.onAgentSettled({ nodeId: node.nodeId, state: 'running', agentId: h.agentId, generation })
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
      return `[node:${node.nodeId} in graph ${graphId} started] background; 完成后会通知你。用 agent_status 查看进度。`
    },

    /**
     * 取消一个图节点。`graph.cancel` 只改图的状态，**活 agent 必须自己走
     * `cancelHandle`** —— 阻塞在 `ask_user` 里的 agent 要等当前工具调用返回才
     * 看得见 abort signal，不连它挂起的提问一起结掉，这次取消就只是改了个状态。
     *
     * @param {string} nodeId
     * @param {string} reason
     * @param {{ graphId?: string|null }} [opts] 省略 graphId 时用活跃图
     * @returns {{ ok: boolean, reason?: string, agentId?: string|null, previousState?: string,
     *   agentStopped?: boolean }} `agentStopped` = 这次取消是否真的停掉了一个在跑的
     *   agent（节点上没挂 agent、或它已经自己走到终态时为 false）—— 调用方要向模型
     *   汇报"停了几个"时不能拿节点数当 agent 数。
     */
    _cancelNode(nodeId, reason, { graphId = null } = {}) {
      const found = runtime._lookupGraph(graphId)
      if (!found.ok) return found
      const { entry } = found
      // `graph.cancel` 只会说"node not found"，那在多图之后不够用 —— 同名节点很
      // 可能就在隔壁那张图里。
      if (!entry.graph.nodes.has(nodeId)) {
        return { ok: false, reason: runtime._nodeNotHereReason(nodeId, entry) }
      }
      const cancelled = entry.graph.cancel(nodeId, reason)
      if (!cancelled.ok) return cancelled
      const handle = cancelled.agentId ? registry.get(cancelled.agentId) : null
      const agentStopped = handle ? cancelHandle(handle, { reason, emit, ask }) : false
      return { ...cancelled, agentStopped }
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
      return inflight.size > 0 || registry.list().length > 0 || runtime._anyGraph(g => g.hasPending())
    },

    /**
     * 真的还有活在飞？—— **"该不该继续等下去"用这个，别用 `hasPending()`**。
     * blocked / awaiting_confirm 的节点等的是主 agent 下一步动作，不是后台任务：
     * 它们不产生任何事件，也不会自行推进，一张声明完就被遗忘的图会让
     * `hasPending()` 永远为真，等事件的调用方于是干等到超时。
     */
    hasInFlight() {
      return inflight.size > 0 || registry.list().length > 0 || runtime._anyGraph(g => g.hasInFlight())
    },

    /**
     * 跨**全部**图聚合一个谓词，**含 closed 图**。
     *
     * closed 不能漏：一个在飞的 agent 不因为它所属的图被关掉就停止存在。只问活跃
     * 图的话，主 agent 一切换活跃图就不再等旧图里还在跑的 agent —— 那些结果回来
     * 时没人接。这条同样是 `_evictClosedGraphs` 跳过在飞图的理由。
     */
    _anyGraph(predicate) {
      for (const entry of graphs.values()) {
        if (predicate(entry.graph)) return true
      }
      return false
    },

    /**
     * 全部图里还没走到终态的节点数，**含 closed 图**。
     *
     * 跨图的理由与 `_anyGraph` 一样，但这个数字的用途不同：它是**告知模型**用的
     * （keep-alive 超时时那句"还有 N 个 agent、M 个图节点未完成，请收尾"，以及
     * `run.keep_alive.timeout` 事件）。只数活跃图的话，未完成节点落在非活跃图里时
     * 模型会在它决定要不要停下来的那一刻被告知"0 个图节点未完成"—— 决策路径
     * （`hasInFlight()`）本来是对的，错的只是告知，而模型是照告知行事的。
     */
    pendingNodeCount() {
      let n = 0
      for (const entry of graphs.values()) n += entry.graph.pendingCount()
      return n
    },

    /**
     * 渲染图状态给 LLM / 人看。**默认只渲染活跃图** —— 把全部图都摊开等于把
     * 无界增长从节点级搬到图级，那正是多图容器要收掉的东西。`graphId: 'all'`
     * 是显式的全量出口（含 closed）。
     *
     * @param {{ graphId?: string|null }} [opts]
     * @returns {string}
     */
    statusTable({ graphId = null } = {}) {
      if (graphs.size === 0) return 'no graph declared'
      if (graphId === 'all') {
        return [...graphs.values()].map(e => renderGraphEntry(e, runtime.activeGraphId)).join('\n\n')
      }
      if (graphId != null) {
        const found = runtime._lookupGraph(graphId)
        if (!found.ok) return found.reason
        return renderGraphEntry(found.entry, runtime.activeGraphId)
      }
      const active = graphs.get(runtime.activeGraphId)
      if (!active) {
        return `no active graph (${graphs.size} other graph(s) — pass graph_id "all" to list them)`
      }
      return renderGraphEntry(active, runtime.activeGraphId)
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
      // **全部图，不只是活跃图** —— 一张被关掉或被切走的图里照样可能有 agent 在跑。
      for (const entry of [...graphs.values()]) {
        for (const nodeId of [...entry.graph.nodes.keys()]) {
          runtime._cancelNode(nodeId, 'runtime closed', { graphId: entry.graphId })
        }
      }
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
 * 被激活节点的**拓扑下游**，逐个标注它当初有没有读到被宣告过期的产物。
 *
 * 不动点遍历而不是一次插入序扫描：今天的依赖只能指向更早声明的节点（`declare` 的
 * 未知依赖检查保证了这点），扫一遍其实就够；不动点不依赖那个前提，哪天依赖可改写它
 * 仍然对。
 *
 * `consumedKeys` 只算**直接依赖**：一个节点的契约 inputs 恰好是它直接上游已登记的
 * 产物（见 `_startNode`），再往下的节点读到的是中间那个节点转述过的结论 —— 标成
 * `direct: false` 而不是硬编一份它其实没读过的 key，是为了让模型看到的东西跟实际
 * 发生过的事情对得上。
 *
 * @param {AgentGraph} graph
 * @param {Set<string>} seeds 本次真的被激活的节点
 * @param {Map<string, string[]>} keysByNode 激活前取的 nodeId → 产物 key
 * @returns {Array<{ nodeId: string, state: string, direct: boolean, reactivated: boolean,
 *   consumedKeys: string[], via: string[] }>}
 */
function describeDownstream(graph, seeds, keysByNode) {
  if (seeds.size === 0) return []
  const downstream = new Set()
  let grew = true
  while (grew) {
    grew = false
    for (const [nodeId, node] of graph.nodes) {
      if (downstream.has(nodeId)) continue
      if (node.dependsOn.some(dep => seeds.has(dep) || downstream.has(dep))) {
        downstream.add(nodeId)
        grew = true
      }
    }
  }
  const rows = []
  for (const [nodeId, node] of graph.nodes) {
    if (!downstream.has(nodeId)) continue
    const fromSeeds = node.dependsOn.filter(dep => seeds.has(dep))
    rows.push({
      nodeId,
      state: node.state,
      direct: fromSeeds.length > 0,
      reactivated: seeds.has(nodeId),
      consumedKeys: [...new Set(fromSeeds.flatMap(dep => keysByNode.get(dep) ?? []))],
      via: node.dependsOn.filter(dep => downstream.has(dep)),
    })
  }
  return rows
}

/**
 * 一张图的状态段：`graphId "label" [state, active]` 一行，再接图自己的节点表。
 * 图 id 必须出现在渲染里 —— 跨图重名的 node_id 之后，模型全靠它决定 `graph_id`
 * 该填什么。
 */
function renderGraphEntry(entry, activeGraphId) {
  const bits = [`graph ${entry.graphId}`]
  if (entry.label) bits.push(JSON.stringify(entry.label))
  bits.push(`[${entry.state}${entry.graphId === activeGraphId ? ', active' : ''}]`)
  return `${bits.join(' ')}\n${entry.graph.statusTable()}`
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
