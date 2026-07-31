/**
 * 每个 agent 一个收件箱。消息**不打断**正在执行的工具 —— 只在目标 agent 的
 * ReAct 轮边界被排空注入（复用 Agent#enqueueMessage）。
 *
 * 注意注入用的是 `role: 'user'` 加一个 `<agent-message>` 信封标记，而不是
 * `role: 'assistant'`：`Agent#enqueueMessage` 只接受 `user` / `system`，伪造一条
 * assistant 轮会让模型以为那句话是自己说的。
 */

/**
 * 一次轮边界排空里最多注入几条独立消息，超过就合并成一条。
 *
 * 定义在这里而不是 `agent.js`：它是**注入契约**的一部分（发信方产生多少条消息、
 * 收信方如何合并要对得上），而 `agent.js` 只是这个契约的消费方之一。
 */
export const INJECTION_MERGE_THRESHOLD = 5

export class Mailbox {
  constructor() {
    /** @type {Map<string, object[]>} agentId → 待读信封 */
    this._boxes = new Map()
  }

  deliver(envelope) {
    const to = envelope.params.to.agentId
    const box = this._boxes.get(to) ?? []
    box.push(envelope)
    this._boxes.set(to, box)
    return envelope
  }

  size(agentId) {
    return this._boxes.get(agentId)?.length ?? 0
  }

  drain(agentId) {
    const box = this._boxes.get(agentId) ?? []
    this._boxes.set(agentId, [])
    return box
  }

  formatForInjection(envelope) {
    const from = envelope.params.from?.name ?? envelope.params.from?.agentId ?? 'unknown'
    return `<agent-message from="${from}">\n${envelope.params.body}\n</agent-message>`
  }
}
