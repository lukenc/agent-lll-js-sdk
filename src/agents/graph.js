/**
 * AgentGraph —— 依赖图的声明与惰性调度。
 *
 * 关键语义（§7）：**声明 ≠ 创建**。blocked / awaiting_confirm 的节点不占任何
 * 运行时资源 —— 没有 AgentHandle、没有子 Agent、不占并发槽，只有进入 queued
 * 才真正构造 subagent。
 *
 * 而且默认路径下，节点就绪时框架**不**启动它：先把上游产物交回主 agent，由主
 * agent 看过上游实际产出之后再写这个节点的最终 Task Contract（`start()`）。
 * 因为前序结果经常会改变后续该干什么。`on_ready: 'auto'` 是给"活儿事先就定死
 * 了"的节点开的后门。
 *
 * 本模块是纯逻辑，无 I/O：状态机、环检测、就绪集合计算。真正的 spawn / cancel
 * 由调用方（runtime 侧的 `agent_graph` / `graph_start` 工具）接线。
 *
 * **宿主回调一律隔离**：`onReadyNode` / `onAutoStart` / `emit` 都是宿主代码，都会
 * 因为普通原因抛异常（通知入队失败、spawn 失败……）。一次 tick 里往往有一批节点
 * 同时就绪，所以一个回调抛出去绝不能中断这一轮遍历 —— 否则同批还没访问到的兄弟
 * 节点会永久留在 blocked，而且没有任何东西会再来 tick 它们，图就卡死了。
 * 见 `_invoke` / `_emit`。
 */
import { AgentGraphError } from './errors.js'

/**
 * 节点状态。
 *
 *   blocked → awaiting_confirm → queued → running ⇄ waiting_input → succeeded | failed
 *   blocked → queued（on_ready:'auto'，跳过确认闸门）
 *   blocked → skipped（上游失败且 on_upstream_failure:'skip'）
 *   任何非终态 → cancelled
 *
 * "ready"（依赖已满足）不是一个静止状态：它在同一次 tick 里立刻分流成
 * awaiting_confirm（默认，等主 agent 定契约）或 queued（auto）。
 *
 * running / waiting_input 由调用方通过 `onAgentSettled` 回报 —— **waiting_input
 * 算"还在跑"**：一个卡在向用户提问上的 agent 并没有干完。
 */

/** 终态：不再迁移，也不会被迟到的 settle 复活。 */
export const GRAPH_TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled', 'skipped'])

/** 还有活要干的状态。含 waiting_input。 */
export const GRAPH_PENDING_STATES = new Set([
  'blocked', 'awaiting_confirm', 'queued', 'running', 'waiting_input',
])

/** 调用方可以回报的 agent 状态（`onAgentSettled` 的 state 入参）。 */
const REPORTABLE_STATES = new Set([
  'queued', 'running', 'waiting_input', 'succeeded', 'failed', 'cancelled',
])

/** 上游落到这些状态时，下游永远等不到它了。 */
const UPSTREAM_DEAD_REASON = Object.freeze({
  failed: 'upstream_failed',
  cancelled: 'upstream_cancelled',
  skipped: 'upstream_skipped',
})

/**
 * Kahn 拓扑排序。返回 null（无环）或一条可读的环路径。
 *
 * @param {Array<{ nodeId: string, dependsOn?: string[] }>} incoming 待并入的节点
 * @param {Map<string, { dependsOn?: string[] }>} [existing] 已在图里的节点
 * @returns {string[]|null}
 */
export function detectCycle(incoming, existing = new Map()) {
  /** @type {Map<string, string[]>} nodeId → 依赖 */
  const deps = new Map()
  for (const [nodeId, node] of existing) deps.set(nodeId, node.dependsOn ?? [])
  for (const node of incoming) deps.set(node.nodeId, node.dependsOn ?? [])

  const indegree = new Map()
  const dependents = new Map()
  for (const [nodeId, nodeDeps] of deps) {
    indegree.set(nodeId, (indegree.get(nodeId) ?? 0) + nodeDeps.length)
    for (const dep of nodeDeps) {
      const list = dependents.get(dep) ?? []
      list.push(nodeId)
      dependents.set(dep, list)
      if (!indegree.has(dep)) indegree.set(dep, 0)
    }
  }

  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id)
  let visited = 0
  while (queue.length > 0) {
    const nodeId = queue.shift()
    visited += 1
    for (const dependent of dependents.get(nodeId) ?? []) {
      const next = indegree.get(dependent) - 1
      indegree.set(dependent, next)
      if (next === 0) queue.push(dependent)
    }
  }
  if (visited === indegree.size) return null

  // 有环：从任一残留节点顺着依赖走。残留节点的未解析依赖必然也残留，所以路径
  // 不会断，一定会走回一个访问过的节点 —— 那一段就是环。
  const remaining = new Set(
    [...indegree.entries()].filter(([, d]) => d > 0).map(([id]) => id))
  const path = []
  let cursor = [...remaining][0]
  while (!path.includes(cursor)) {
    path.push(cursor)
    cursor = (deps.get(cursor) ?? []).find(d => remaining.has(d))
  }
  return [...path.slice(path.indexOf(cursor)), cursor]
}

/** 归一化 depends_on：容忍单个字符串，去重，其他形状一律报错（整批拒绝）。 */
function normalizeDependsOn(raw, nodeId) {
  if (raw == null) return []
  const list = typeof raw === 'string' ? [raw] : raw
  if (!Array.isArray(list)) {
    throw new AgentGraphError(
      `agent_graph: node "${nodeId}" depends_on must be an array of node ids`, { nodeId })
  }
  for (const dep of list) {
    if (typeof dep !== 'string' || dep.length === 0) {
      throw new AgentGraphError(
        `agent_graph: node "${nodeId}" has a non-string entry in depends_on`, { nodeId })
    }
  }
  return [...new Set(list)]
}

/** 枚举字段校验。默认值是"安全的那一侧"，但拼错的值必须报错而不是被静默吞掉。 */
function normalizeEnum(value, allowed, fallback, field, nodeId) {
  if (value == null) return fallback
  if (!allowed.includes(value)) {
    throw new AgentGraphError(
      `agent_graph: node "${nodeId}" has invalid ${field} `
      + `${JSON.stringify(value)} (expected ${allowed.map(v => `"${v}"`).join(' | ')})`,
      { nodeId },
    )
  }
  return value
}

export class AgentGraph {
  /**
   * @param {object} opts
   * @param {(node: object, upstream: object[]) => void} [opts.onReadyNode]
   *        节点就绪且需要主 agent 确认契约时调用。收到的是**快照**，不是活对象。
   * @param {(node: object, upstream: object[]) => void} [opts.onAutoStart]
   *        on_ready:'auto' 的节点就绪时调用（此时节点已是 queued）。同样是快照。
   * @param {(type: string, payload: object) => void} [opts.emit]
   * @param {() => number} [opts.now]
   */
  constructor({ onReadyNode = () => {}, onAutoStart = () => {}, emit = () => {}, now = () => Date.now() } = {}) {
    this.onReadyNode = onReadyNode
    this.onAutoStart = onAutoStart
    this.emit = emit
    this._now = now
    /** @type {Map<string, object>} 内部活节点。对外一律发快照。 */
    this.nodes = new Map()
    /**
     * 声明时带的并发上限。**本类不执行它** —— 真正的并发槽在 AgentRegistry 的
     * 分层池里，而那个池还要跟非图内的 subagent 抢；图自己再限一次只会重复
     * 限流甚至互锁。这里只做记录 + 渲染，给调用方看。
     */
    this.maxConcurrent = null
  }

  /** @returns {object|null} 节点快照（每次调用都是新对象） */
  get(nodeId) {
    const node = this.nodes.get(nodeId)
    return node ? snapshot(node) : null
  }

  /**
   * 声明一批节点。任何校验失败都**整批拒绝**：先在暂存区里把整批校验完
   * （含环检测，环检测同时考虑已声明的旧节点），全部通过才写进图里，
   * 所以被拒绝的声明不会留下半个图。
   *
   * @param {object[]} rawNodes 工具入参形状（snake_case）
   * @param {{ maxConcurrent?: number }} [opts]
   * @returns {{ accepted: string[] }}
   */
  declare(rawNodes, { maxConcurrent } = {}) {
    if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
      throw new AgentGraphError('agent_graph: nodes must be a non-empty array')
    }
    const staged = []
    const stagedIds = new Set()

    for (const raw of rawNodes) {
      const nodeId = raw?.node_id
      if (typeof nodeId !== 'string' || nodeId.length === 0) {
        throw new AgentGraphError('agent_graph: every node needs a non-empty node_id')
      }
      if (this.nodes.has(nodeId) || stagedIds.has(nodeId)) {
        throw new AgentGraphError(`agent_graph: duplicate node_id "${nodeId}"`, { nodeId })
      }
      if (typeof raw.description !== 'string' || raw.description.length === 0) {
        throw new AgentGraphError(`agent_graph: node "${nodeId}" needs a description`, { nodeId })
      }
      const onReady = normalizeEnum(raw.on_ready, ['confirm', 'auto'], 'confirm', 'on_ready', nodeId)
      if (onReady === 'auto' && (typeof raw.prompt !== 'string' || raw.prompt.length === 0)) {
        throw new AgentGraphError(
          `agent_graph: node "${nodeId}" uses on_ready "auto" and therefore needs a prompt`, { nodeId })
      }
      staged.push({
        nodeId,
        dependsOn: normalizeDependsOn(raw.depends_on, nodeId),
        description: raw.description,
        prompt: typeof raw.prompt === 'string' && raw.prompt.length > 0 ? raw.prompt : null,
        subagentType: raw.subagent_type ?? null,
        model: raw.model ?? null,
        onReady,
        onUpstreamFailure: normalizeEnum(
          raw.on_upstream_failure, ['block', 'skip'], 'block', 'on_upstream_failure', nodeId),
        state: 'blocked',
        blockedReason: null,
        agentId: null,
        result: null,
        /** 宿主回调抛出的异常消息（`_invoke` 记的），失败原因的人类可读部分。 */
        error: null,
        declaredAt: this._now(),
      })
      stagedIds.add(nodeId)
    }

    for (const node of staged) {
      for (const dep of node.dependsOn) {
        if (!this.nodes.has(dep) && !stagedIds.has(dep)) {
          throw new AgentGraphError(
            `agent_graph: node "${node.nodeId}" depends on unknown node "${dep}"`, { nodeId: node.nodeId })
        }
      }
    }

    // 连已声明的旧节点一起算。注意：当下"跨批次的环"其实造不出来 —— 依赖必须
    // 已经存在（上面那道未知依赖检查），所以边只会指向更早声明的节点，环只可能
    // 落在同一批里。传 this.nodes 是为了哪天依赖变得可改写时仍然守得住。
    const cycle = detectCycle(staged, this.nodes)
    if (cycle) {
      throw new AgentGraphError(
        `agent_graph: dependency cycle detected: ${cycle.join(' -> ')}`, { cycle })
    }

    // —— 校验全过，这里之后才动图 ——
    for (const node of staged) this.nodes.set(node.nodeId, node)
    if (maxConcurrent != null) this.maxConcurrent = maxConcurrent
    const accepted = staged.map(n => n.nodeId)
    this._emit('graph.declared', { accepted: [...accepted], total: this.nodes.size })
    this.tick()
    return { accepted }
  }

  /**
   * 把依赖已满足的 blocked 节点往前推，然后按 onReady 分流。跑到不动为止
   * （skipped 会沿着下游继续传播，可能连带解锁/跳过更多节点）。
   *
   * 回调是同步调用的，且允许在回调里重入（`onAutoStart` 里直接
   * `onAgentSettled` 是常见写法）—— 重入的 tick 干完活，外层这一轮会发现
   * 没有新变化然后收工。
   */
  tick() {
    let progressed = true
    while (progressed) {
      progressed = false
      for (const node of [...this.nodes.values()]) {
        if (node.state !== 'blocked') continue

        const upstream = node.dependsOn.map(id => this.nodes.get(id))
        const dead = upstream.find(u => UPSTREAM_DEAD_REASON[u.state] != null)
        if (dead) {
          const reason = UPSTREAM_DEAD_REASON[dead.state]
          if (node.onUpstreamFailure === 'skip') {
            node.state = 'skipped'
            node.blockedReason = reason
            this._emit('graph.node.skipped', { nodeId: node.nodeId, reason, upstreamNodeId: dead.nodeId })
            progressed = true   // 继续向下传播
            continue
          }
          if (node.blockedReason !== reason) {
            node.blockedReason = reason
            this._emit('graph.node.blocked', { nodeId: node.nodeId, reason, upstreamNodeId: dead.nodeId })
          }
          continue
        }
        if (!upstream.every(u => u.state === 'succeeded')) continue

        const upstreamView = upstream.map(u => ({
          nodeId: u.nodeId, agentId: u.agentId, state: u.state, result: u.result,
        }))
        progressed = true
        if (node.onReady === 'auto') {
          node.state = 'queued'
          this._emit('graph.node.auto_start', { nodeId: node.nodeId })
          const failure = this._invoke(this.onAutoStart, 'onAutoStart', node, upstreamView)
          if (failure != null) {
            node.error = failure
            // 只有节点**还停在 queued** 时才算启动失败 —— 那说明回调连"起来了"
            // 都没来得及报，再没人会启动它；停在 queued 的话，从图外面看跟"正在
            // 正常运行"一模一样，图会永远等一个根本没起来的 agent。
            //
            // 反过来，如果回调已经报过 running（agent 真起来了）之后才抛，那 agent
            // 还在跑，会自己走到终态 —— 这时强行标 failed 会让图跟现实脱节。
            if (node.state === 'queued') {
              node.state = 'failed'
              node.blockedReason = 'launch_failed'
            }
          }
        } else {
          node.state = 'awaiting_confirm'
          this._emit('graph.node.ready', {
            nodeId: node.nodeId,
            upstream: upstreamView.map(u => ({ nodeId: u.nodeId, agentId: u.agentId, state: u.state })),
          })
          // 这里丢掉的只是"通知"，节点本身确实已经就绪 —— 留在 awaiting_confirm，
          // 主 agent 仍能从 statusTable() / agent_status 里发现它并 start()。
          const failure = this._invoke(this.onReadyNode, 'onReadyNode', node, upstreamView)
          if (failure != null) node.error = failure
        }
      }
    }
  }

  /**
   * 调一个宿主回调，异常不外泄。
   * @returns {string|null} null = 正常；否则是异常消息（已记到节点上并发了事件）
   */
  _invoke(fn, name, node, upstreamView) {
    try {
      fn.call(this, snapshot(node), upstreamView)
      return null
    } catch (err) {
      const message = err?.message ? String(err.message) : String(err)
      this._emit('graph.callback.error', { nodeId: node.nodeId, callback: name, error: message })
      return message
    }
  }

  /** 发事件。遥测出口炸了不该拖垮调度，所以这里也吞异常。 */
  _emit(type, payload) {
    try {
      this.emit(type, payload)
    } catch {
      // 没有别的地方可以上报了：emit 本身就是上报通道。
    }
  }

  /**
   * 主 agent 确认（并可改写）契约，启动一个就绪节点。
   * 这是默认路径上唯一让节点变成 queued 的入口 —— 到这一步才该去 spawn。
   *
   * @returns {{ ok: boolean, node?: object, reason?: string }} node 是快照
   */
  start(nodeId, patch = {}) {
    const node = this.nodes.get(nodeId)
    if (!node) return { ok: false, reason: `node "${nodeId}" not found` }
    if (node.state === 'blocked') {
      return { ok: false, reason: `node "${nodeId}" is blocked (${node.blockedReason ?? 'waiting on upstream'})` }
    }
    if (node.state !== 'awaiting_confirm') {
      return {
        ok: false,
        reason: `node "${nodeId}" is ${node.state}; only a node awaiting confirmation can be started`,
      }
    }
    // 先算出最终 prompt 再落盘：启动被拒时不能留下半个 patch。
    const prompt = patch.prompt || node.prompt
    if (!prompt) {
      return { ok: false, reason: `node "${nodeId}" has no prompt; supply one when starting it` }
    }
    node.prompt = prompt
    if (patch.subagent_type) node.subagentType = patch.subagent_type
    if (patch.model) node.model = patch.model
    node.state = 'queued'
    this._emit('graph.node.started', { nodeId: node.nodeId, subagentType: node.subagentType })
    return { ok: true, node: snapshot(node) }
  }

  /**
   * agent 状态回报：登记结果并推进下游。终态之外的 `running` / `waiting_input`
   * 也走这里（顺带把 agentId 挂到节点上），因为图需要知道谁还在飞。
   *
   * 已经是终态的节点会忽略迟到的回报 —— 被取消的 agent 收尾时 runner 仍会报
   * 一次终态，不能让它把 cancelled 覆盖掉、把下游从一条已取消的分支上放出去。
   */
  onAgentSettled({ nodeId, state, agentId = null, result = null } = {}) {
    // state 先校验：不认识的状态是编程错误，跟节点在不在图里无关。
    if (!REPORTABLE_STATES.has(state)) {
      throw new AgentGraphError(
        `agent_graph: cannot report unknown agent state "${state}" for node "${nodeId}"`, { nodeId })
    }
    const node = this.nodes.get(nodeId)
    if (!node) return
    // agentId 是身份不是状态，先记下来：终态节点也允许迟到的回报补上它。
    if (agentId != null) node.agentId = agentId
    if (GRAPH_TERMINAL_STATES.has(node.state)) return
    node.state = state
    if (result != null) node.result = result
    this._emit('graph.node.settled', { nodeId: node.nodeId, state, agentId: node.agentId })
    this.tick()
  }

  /**
   * 取消一个节点。**只改图的状态**：若节点已经有在跑的 agent，调用方必须自己
   * 走 `cancelHandle(handle, { reason, emit, ask: runtime.ask })` —— 卡在
   * ask_user 里的 agent 看不到 abort signal，得连它挂起的提问一起结掉。
   * 所以这里把 agentId 与前一状态一并交回去。
   *
   * @returns {{ ok: boolean, reason?: string, agentId?: string|null, previousState?: string }}
   */
  cancel(nodeId, reason = 'cancelled') {
    const node = this.nodes.get(nodeId)
    if (!node) return { ok: false, reason: `node "${nodeId}" not found` }
    if (GRAPH_TERMINAL_STATES.has(node.state)) {
      return { ok: false, reason: `node "${nodeId}" is already ${node.state}` }
    }
    const previousState = node.state
    node.state = 'cancelled'
    node.blockedReason = reason
    this._emit('graph.node.cancelled', { nodeId: node.nodeId, reason, previousState, agentId: node.agentId })
    this.tick()
    return { ok: true, agentId: node.agentId, previousState }
  }

  /** 还有节点没走到终态？（waiting_input 算还在跑） */
  hasPending() {
    for (const node of this.nodes.values()) {
      if (GRAPH_PENDING_STATES.has(node.state)) return true
    }
    return false
  }

  /** 给 LLM / 人看的图状态。不含任何凭据。 */
  statusTable() {
    if (this.nodes.size === 0) return 'no graph declared'
    const rows = [...this.nodes.values()].map((node) => {
      const deps = node.dependsOn.length > 0 ? ` deps=[${node.dependsOn.join(',')}]` : ''
      const why = node.blockedReason ? ` (${node.blockedReason})` : ''
      const error = node.error ? ` error: ${node.error}` : ''
      return `${node.nodeId} [${node.state}]${why}${deps} — ${node.description}${error}`
    })
    const header = this.maxConcurrent != null ? [`graph (maxConcurrent=${this.maxConcurrent})`] : []
    return [...header, ...rows].join('\n')
  }
}

/** 节点的纯数据快照 —— 对外一律发这个，别把活节点交出去。 */
function snapshot(node) {
  return {
    nodeId: node.nodeId,
    dependsOn: [...node.dependsOn],
    description: node.description,
    prompt: node.prompt,
    subagentType: node.subagentType,
    model: node.model,
    onReady: node.onReady,
    onUpstreamFailure: node.onUpstreamFailure,
    state: node.state,
    blockedReason: node.blockedReason,
    error: node.error,
    agentId: node.agentId,
    result: node.result,
    declaredAt: node.declaredAt,
  }
}
