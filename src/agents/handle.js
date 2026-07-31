/**
 * AgentHandle —— 一个 subagent 实例的身份、状态与度量。
 *
 * 状态机（§2 / §7）：
 *   pending → queued → running → succeeded | failed | cancelled
 *   running ⇄ waiting_input（向用户提问期间）
 * 终态不可再迁移。非法迁移抛 SubagentError —— 这是编程错误，不该软失败。
 */
import { SubagentError } from './errors.js'

export const AGENT_STATES = [
  'pending', 'queued', 'running', 'waiting_input', 'succeeded', 'failed', 'cancelled',
]

export const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled'])

export const VALID_TRANSITIONS = Object.freeze({
  pending: ['queued', 'cancelled'],
  queued: ['running', 'cancelled'],
  running: ['waiting_input', 'succeeded', 'failed', 'cancelled'],
  waiting_input: ['running', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
})

export class AgentHandle {
  constructor({
    agentId, name, type, description,
    parentAgentId = 'main', depth = 1, nodeId = null,
    model = null, isolation = null, now = () => Date.now(),
  }) {
    this.agentId = agentId
    this.name = name
    this.type = type
    this.description = description
    this.parentAgentId = parentAgentId
    this.depth = depth
    this.nodeId = nodeId
    /** @type {{ alias: string|null, model: string, apiKey: string, url: string }|null} */
    this.model = model
    this.isolation = isolation

    this.state = 'pending'
    this.attempt = 0
    /** @type {Array<{ attempt: number, failureKind: string|null, error: string|null, startedAt: number, endedAt: number|null }>} */
    this.attempts = []
    this.result = null
    this.metrics = { rounds: 0, llmCalls: 0, toolCalls: 0, usage: null, wallClockMs: 0 }
    /** @type {string[]} */
    this.artifactKeys = []

    this._now = now
    this.createdAt = now()
    this.startedAt = null
    this.endedAt = null
  }

  isTerminal() {
    return TERMINAL_STATES.has(this.state)
  }

  transition(to) {
    if (!AGENT_STATES.includes(to)) {
      throw new SubagentError(`unknown agent state "${to}"`, { agentId: this.agentId, agentName: this.name })
    }
    const allowed = VALID_TRANSITIONS[this.state]
    if (!allowed.includes(to)) {
      throw new SubagentError(
        `illegal agent state transition ${this.state} -> ${to}`,
        { agentId: this.agentId, agentName: this.name },
      )
    }
    this.state = to
    if (TERMINAL_STATES.has(to)) this.endedAt = this._now()
    return this
  }

  beginAttempt() {
    this.attempt += 1
    const startedAt = this._now()
    if (this.startedAt == null) this.startedAt = startedAt
    this.attempts.push({ attempt: this.attempt, failureKind: null, error: null, startedAt, endedAt: null })
    return this
  }

  /** @param {{ failureKind?: string|null, error?: string|null }} [outcome] */
  endAttempt({ failureKind = null, error = null } = {}) {
    const current = this.attempts[this.attempts.length - 1]
    if (current) {
      current.failureKind = failureKind
      current.error = error
      current.endedAt = this._now()
    }
    return this
  }

  /**
   * 纯数据快照，供 `agent_status` 工具与主机使用。
   * **apiKey 被显式剔除** —— handle 会被序列化进工具结果与事件 payload。
   */
  toStatus() {
    return {
      agentId: this.agentId,
      name: this.name,
      type: this.type,
      description: this.description,
      parentAgentId: this.parentAgentId,
      depth: this.depth,
      nodeId: this.nodeId,
      state: this.state,
      attempt: this.attempt,
      attempts: this.attempts.map(a => ({ ...a })),
      model: this.model ? { alias: this.model.alias, model: this.model.model } : null,
      isolation: this.isolation ? { ...this.isolation } : null,
      metrics: { ...this.metrics },
      artifactKeys: [...this.artifactKeys],
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
    }
  }
}
