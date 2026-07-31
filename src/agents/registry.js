/**
 * AgentRegistry —— subagent 的身份分配、并发槽与完成态保留。
 *
 * **并发槽按 depth 分层**（§7）。若全局共用一个槽池，maxConcurrent=4 时 4 个
 * depth 1 的 agent 各自同步派一个 depth 2 的孙 agent，槽会被父辈全占着、孙辈
 * 永远等不到，而父辈又在等孙辈返回 —— 死锁。每层独立槽池让这种死锁在结构上
 * 不可能发生。
 */
import { AgentHandle } from './handle.js'

let SEQ = 0

/** 生成 `agt_` + 8 位十六进制。进程内单调计数 + 时间低位，避免依赖 crypto。 */
function newAgentId(now) {
  SEQ = (SEQ + 1) >>> 0
  const mixed = ((now() & 0xffffff) * 256 + (SEQ & 0xff)) >>> 0
  return `agt_${mixed.toString(16).padStart(8, '0').slice(-8)}`
}

export class AgentRegistry {
  constructor({ maxConcurrent = 4, retainCompleted = 20, now = () => Date.now() } = {}) {
    this.maxConcurrent = maxConcurrent
    this.retainCompleted = retainCompleted
    this._now = now
    /** @type {Map<string, AgentHandle>} agentId → handle（插入序 = 创建序） */
    this._byId = new Map()
    /** @type {Map<string, string>} name → agentId（重名后写覆盖 = 最新者胜） */
    this._byName = new Map()
    /** @type {Map<string, number>} type → 已分配序号 */
    this._nameSeq = new Map()
    /** @type {Map<number, { used: number, queue: Array<{ resolve, reject, signal, onAbort }> }>} */
    this._slots = new Map()
    /** @type {string[]} 终态 agentId，按 settle 顺序 */
    this._completed = []
    /** @type {Set<string>} 已被淘汰上下文的 agentId */
    this._evicted = new Set()
  }

  allocateName(type) {
    let n = (this._nameSeq.get(type) ?? 0) + 1
    let name = `${type}-${n}`
    while (this._byName.has(name)) {
      n += 1
      name = `${type}-${n}`
    }
    this._nameSeq.set(type, n)
    return name
  }

  create({ type, description, parentAgentId = 'main', depth = 1, nodeId = null, model = null, isolation = null }) {
    const agentId = newAgentId(this._now)
    const name = this.allocateName(type)
    const handle = new AgentHandle({
      agentId, name, type, description, parentAgentId, depth, nodeId, model, isolation, now: this._now,
    })
    /** 子 Agent 实例，供 send_message 续跑；被 LRU 淘汰后置 null。 */
    handle._child = null
    this._byId.set(agentId, handle)
    this._byName.set(name, agentId)
    return handle
  }

  get(idOrName) {
    if (typeof idOrName !== 'string') return null
    const direct = this._byId.get(idOrName)
    if (direct) return direct
    const viaName = this._byName.get(idOrName)
    return viaName ? this._byId.get(viaName) ?? null : null
  }

  list({ includeFinished = false } = {}) {
    const all = [...this._byId.values()]
    return includeFinished ? all : all.filter(h => !h.isTerminal())
  }

  _slotPool(depth) {
    let pool = this._slots.get(depth)
    if (!pool) {
      pool = { used: 0, queue: [] }
      this._slots.set(depth, pool)
    }
    return pool
  }

  slotsInUse(depth) {
    return this._slotPool(depth).used
  }

  /**
   * 取一个该 depth 层的并发槽。返回释放函数（幂等）。
   * @param {number} depth
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {Promise<() => void>}
   */
  acquireSlot(depth, { signal } = {}) {
    const pool = this._slotPool(depth)

    const makeRelease = () => {
      let released = false
      return () => {
        if (released) return
        released = true
        pool.used -= 1
        this._pump(depth)
      }
    }

    if (signal?.aborted) return Promise.reject(abortError())
    if (pool.used < this.maxConcurrent) {
      pool.used += 1
      return Promise.resolve(makeRelease())
    }

    return new Promise((resolve, reject) => {
      const waiter = { resolve: () => resolve(makeRelease()), reject, signal, onAbort: null }
      if (signal) {
        waiter.onAbort = () => {
          const idx = pool.queue.indexOf(waiter)
          if (idx >= 0) pool.queue.splice(idx, 1)
          reject(abortError())
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      pool.queue.push(waiter)
    })
  }

  _pump(depth) {
    const pool = this._slotPool(depth)
    while (pool.used < this.maxConcurrent && pool.queue.length > 0) {
      const waiter = pool.queue.shift()
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort)
      pool.used += 1
      waiter.resolve()
    }
  }

  /** 登记终态并淘汰最旧的完成态上下文（handle 本身保留，只丢子 Agent 实例）。 */
  settle(handle) {
    if (!this._completed.includes(handle.agentId)) this._completed.push(handle.agentId)
    while (this._completed.length > this.retainCompleted) {
      const victimId = this._completed.shift()
      const victim = this._byId.get(victimId)
      if (victim) victim._child = null
      this._evicted.add(victimId)
    }
  }

  evicted(agentId) {
    return this._evicted.has(agentId)
  }
}

function abortError() {
  const err = new Error('slot acquisition aborted')
  err.name = 'AbortError'
  return err
}
