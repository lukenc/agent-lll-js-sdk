/**
 * 活动账本 —— 从带归属的遥测事件里攒出"每个 agent 都调过哪些工具"。
 *
 * 框架**刻意不缓存**这份数据:`AgentHandle` 只记 metrics 聚合数,要展示流水必须
 * 主机自己攒。这是接入 subagent 时一定会遇到的第一个问题,所以这份实现同时是给
 * 使用方看的参考。
 *
 * 归属规则只有一条:`payload.agentId ?? 'main'`。主 agent 自己发的 `tool.call`
 * 不带 `agentId`,`runner._forwardTelemetry` 转发子 agent 事件时才补上。
 *
 * 注意:`tool.call` 是工具**执行完**才发的,所以流水里不存在"正在执行"的行。
 * 一个 agent 在 round.start 之后、下一条 tool.call 之前是"思考中",UI 按这个
 * 间隙表达,不要伪造一条进行中的工具行。
 */

/**
 * @param {{ maxTools?: number, maxAgents?: number }} [opts]
 *   maxTools: 每个 agent 保留的工具流水条数。一个跑飞的 agent 可能调几百次工具,
 *   无界数组会把内存和 /agents 的响应体一起撑爆。
 *   maxAgents: 账本里最多留几个 agent,按插入顺序 FIFO 淘汰。
 */
export function createActivityLedger({ maxTools = 20, maxAgents = 50 } = {}) {
  /** @type {Map<string, { rounds: number, tools: Array<{name:string, ok:boolean|null, ms:number|null}>, truncated: number }>} */
  const byAgent = new Map()

  function entry(agentId) {
    let e = byAgent.get(agentId)
    if (!e) {
      e = { rounds: 0, tools: [], truncated: 0 }
      byAgent.set(agentId, e)
      // Map 保持插入顺序,所以第一个 key 就是最旧的。
      while (byAgent.size > maxAgents) {
        const oldest = byAgent.keys().next().value
        if (oldest === agentId) break
        byAgent.delete(oldest)
      }
    }
    return e
  }

  return {
    onRoundStart(payload = {}) {
      const e = entry(payload.agentId ?? 'main')
      // 取 round 的最大值 + 1,不是事件计数 —— 重试会让 round 从 0 重来,
      // 计数会把两次尝试加起来虚报。
      const n = typeof payload.round === 'number' ? payload.round + 1 : e.rounds
      if (n > e.rounds) e.rounds = n
    },

    onToolCall(payload = {}) {
      const e = entry(payload.agentId ?? 'main')
      e.tools.push({
        name: String(payload.name ?? '?'),
        ok: typeof payload.ok === 'boolean' ? payload.ok : null,
        ms: typeof payload.durationMs === 'number' ? Math.round(payload.durationMs) : null,
      })
      while (e.tools.length > maxTools) {
        e.tools.shift()
        e.truncated += 1
      }
    },

    /** @returns {{rounds:number, tools:Array, truncated:number}|null} 未知 agent 返回 null */
    snapshot(agentId) {
      const e = byAgent.get(agentId)
      if (!e) return null
      return { rounds: e.rounds, tools: e.tools.map(t => ({ ...t })), truncated: e.truncated }
    },

    clear() {
      byAgent.clear()
    },
  }
}
