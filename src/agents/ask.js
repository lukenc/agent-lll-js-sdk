/**
 * AskRegistry —— 多路提问路由。
 *
 * 多个 subagent 可能同时向用户提问。每个问题拿一个 askId 并登记提问者，用户的
 * 回答按 askId 定向送回对应的等待方 —— 主机因此可以乱序回答。
 *
 * 两条应答通道**竞速**，先到先赢，后到者 no-op：
 *   1. `hooks.onAskUser(question, meta)` 的返回值（经 `onQuestion` 回调转发进来）
 *   2. `agent.answerQuestion(askId, answer)`
 *
 * 后到者之所以必须是静默 no-op 而不是抛错：两条通道同时存在时竞速是**合法**的
 * 用法（主机可能既挂了 hook 又开了 UI），对迟到者抛错等于让一次正常竞速把主机
 * 打崩；反过来若让迟到者覆盖，等待方就会拿到另一个人说的话。
 *
 * 回答**不走**邮箱/注入通道：提问方正阻塞在自己的 `ask_user` 工具调用里，settle
 * 这个 Promise 就等于把回答当作那次工具调用的结果直接交还给它。
 */

let SEQ = 0

export class AskRegistry {
  /**
   * @param {object} [opts]
   * @param {number|null} [opts.timeoutMs=null] null = 永不超时（与现有 onAskUser 行为一致）
   * @param {(type: string, payload: object) => void} [opts.emit]
   * @param {(agentId: string, waiting: boolean) => void} [opts.onStateChange]
   * @param {((question: string, meta: object) => unknown)|null} [opts.onQuestion]
   *   问题登记后被调用一次的通知通道（主机的 `hooks.onAskUser`）。返回值非 null
   *   时算一次 `via: 'hook'` 的回答；返回 null/undefined 表示"稍后经 API 回答"；
   *   抛错则取消该提问，等待方拿到说明而不是挂死。
   */
  constructor({ timeoutMs = null, emit = () => {}, onStateChange = () => {}, onQuestion = null } = {}) {
    this.timeoutMs = timeoutMs
    this.emit = emit
    this.onStateChange = onStateChange
    this.onQuestion = onQuestion
    /** @type {Map<string, object>} askId → 内部记录（含 settle 函数） */
    this._pending = new Map()
  }

  /**
   * 登记一个提问。返回的 Promise 在被回答 / 取消 / 超时时 settle —— 永不 reject，
   * 因为它的 settle 值会直接变成提问方 `ask_user` 工具的结果字符串。
   *
   * @param {object} args
   * @param {string} args.agentId
   * @param {string} args.agentName
   * @param {string} [args.parentAgentId='main']
   * @param {string|null} [args.nodeId=null]
   * @param {string} [args.taskDescription='']
   * @param {string} args.question
   * @param {((meta: object) => unknown)|null} [args.notify=null]
   *   **本次提问专属**的送达通道，语义与 `onQuestion` 完全一致（返回非 null 算一次
   *   回答，抛错则取消），但只对这一条提问生效，且**取代** `onQuestion` 而不是叠加。
   *   宿主自带 `ask_user` 工具时由 `Agent` 传入，把那个工具的 `execute` 接成通道。
   *   取代而非叠加是必须的：两者都是"把问题送到用户面前"，同时触发就会为同一个问题
   *   弹两次窗，用户答了一个另一个还悬着。就近的那个通道（模型实际调用的那个工具）赢。
   * @returns {Promise<string>}
   */
  ask({ agentId, agentName, parentAgentId = 'main', nodeId = null, taskDescription = '', question, notify = null }) {
    SEQ = (SEQ + 1) >>> 0
    const askId = `ask_${SEQ.toString(16).padStart(6, '0')}`
    const askedAt = Date.now()

    return new Promise((resolve) => {
      let settled = false
      let timer = null
      // 两条应答通道 + 超时 + 取消全部经过这一个函数，因此"先到先赢"就是这里的
      // 幂等性。`_pending.delete` 已经能挡住多数迟到者，但持有 record 引用的调用
      // 方（取消路径遍历的是快照）绕得过那道门，所以闸门放在 settle 本身。
      const settle = (value) => {
        if (settled) return false
        settled = true
        if (timer) clearTimeout(timer)
        this._pending.delete(askId)
        this.onStateChange(agentId, false)
        resolve(value)
        return true
      }

      const meta = {
        askId, agentId, agentName, parentAgentId, nodeId, taskDescription, question, askedAt,
      }
      this._pending.set(askId, { ...meta, state: 'pending', settle })
      this.onStateChange(agentId, true)
      this.emit('ask.user', { ...meta })

      if (this.timeoutMs != null) {
        timer = setTimeout(() => {
          if (settle(`The user did not answer within ${this.timeoutMs}ms（用户未在 ${this.timeoutMs}ms 内回答）. `
            + 'Decide for yourself: proceed with a clearly-stated assumption, or stop and report that you are blocked.')) {
            this.emit('ask.cancelled', { askId, agentId, reason: 'timeout' })
          }
        }, this.timeoutMs)
        // **故意不 unref**：这个 timer 是"等人回答"这段阻塞的唯一活口。unref 掉
        // 之后，若一个提问的超时是事件循环里最后一件事，Node 会直接退出，等待方的
        // Promise 永远不 settle —— 一次带超时的提问反而变成了静默挂死（本模块的
        // 超时测试就是这么挂的）。拆除路径 `cancelAll()` 会 clearTimeout，因此
        // 关闭之后不会有 timer 拖着进程不放。
      }

      // 通知通道与 `answer()` 竞速；先到先赢由 settle 的 `settled` 闸门保证。
      // `notify`（本次提问专属）存在时取代 `onQuestion`——见 ask() 的参数说明：
      // 两个都是送达通道，同时触发等于为同一个问题弹两次窗。
      const channel = notify ?? this.onQuestion
      if (channel) {
        let notified
        try {
          notified = Promise.resolve(channel(question, { ...meta }))
        } catch (err) {
          notified = Promise.reject(err)
        }
        notified.then(
          (answer) => {
            if (answer == null) return
            // 宿主工具的返回值**不经 String()**：它可能是对象/数组，而 `answer()`
            // 会把它压成 "[object Object]"。工具结果的字符串化是 `tool.js` 的
            // `stringifyToolResult` 的职责（它会走 JSON），这里越俎代庖等于把宿主
            // 富返回值的信息在半路丢掉。hook 通道维持既有的 String() 语义不变。
            if (notify) {
              if (settle(answer)) this.emit('ask.answered', { askId, agentId, agentName, via: 'tool' })
              return
            }
            this.answer(askId, answer, { via: 'hook' })
          },
          (err) => this.cancel(askId, `ask handler failed: ${err?.message ?? err}`),
        )
      }
    })
  }

  /**
   * 当前待答提问的纯数据快照（按提问时间排序）。不含 `settle` 之类的函数，也不
   * 泄内部记录的引用 —— 它会被直接交给主机 UI / 序列化。
   * @returns {object[]}
   */
  pending() {
    return [...this._pending.values()]
      .sort((a, b) => a.askedAt - b.askedAt)
      // 解构出的 rest 本身就是新对象，不含 settle，也不是内部记录的引用。
      .map(({ settle, ...rest }) => rest)
  }

  /**
   * 定向应答。返回 false = 该 askId 不存在或已被别的通道抢先 settle（no-op）。
   * @param {string} askId
   * @param {unknown} answer
   * @param {{ via?: string }} [opts]
   * @returns {boolean}
   */
  answer(askId, answer, { via = 'api' } = {}) {
    // null/undefined 不是回答。放过去的话提问方会拿到字符串 "undefined" 当成
    // 人说的话；返回 false 让主机当场发现自己传了个空值。
    if (answer == null) return false
    const record = this._pending.get(askId)
    if (!record) return false
    const ok = record.settle(String(answer))
    if (ok) {
      this.emit('ask.answered', { askId, agentId: record.agentId, agentName: record.agentName, via })
    }
    return ok
  }

  /**
   * 取消一个提问 —— 等待方拿到取消说明而不是挂死。
   * @param {string} askId
   * @param {string} [reason]
   * @returns {boolean}
   */
  cancel(askId, reason = 'cancelled') {
    const record = this._pending.get(askId)
    if (!record) return false
    const ok = record.settle(`Question cancelled: ${reason}`)
    if (ok) this.emit('ask.cancelled', { askId, agentId: record.agentId, reason })
    return ok
  }

  /**
   * 取消某个 agent 的全部待答提问。取消一个 agent 时必须调它 —— 阻塞在
   * `ask_user` 里的 agent 是**卡在一次工具调用里**的，abort 信号要等这次工具调用
   * 返回才被看见，所以不 settle 掉它的提问，`agent_cancel` 就只改了个状态而那个
   * agent 依然在等人回答（连并发槽都还占着）。
   *
   * @param {string} agentId
   * @param {string} [reason]
   * @returns {number} 真的被取消的条数
   */
  cancelByAgent(agentId, reason = 'cancelled') {
    let count = 0
    for (const [askId, record] of [...this._pending]) {
      if (record.agentId !== agentId) continue
      if (this.cancel(askId, reason)) count += 1
    }
    return count
  }

  /**
   * 取消全部待答提问。拆除路径（`runtime.close()` / `reset()`）必须调它，否则
   * 会留下永远不 settle 的 Promise。
   * @param {string} [reason]
   * @returns {number} 真的被取消的条数
   */
  cancelAll(reason = 'cancelled') {
    let count = 0
    for (const askId of [...this._pending.keys()]) {
      if (this.cancel(askId, reason)) count += 1
    }
    return count
  }
}
