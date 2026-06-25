/**
 * 对话记忆策略 — 对应 Java 框架的 fc.memory 包
 *
 * 内置 Memory 类对外保持原有接口；内部通过 RuntimeHistory 保存完整事实，
 * 再用不同策略投影出发送给模型的上下文。
 */

import { RuntimeHistory } from './runtime-history.js'
import {
  SlidingWindowPolicy,
  SummaryPolicy,
  TokenBudgetPolicy,
  adjustCutPointForToolPairs,
  cloneMessage,
  estimateMessageTokens,
  projectSummaryForWire,
  sliceWithoutOrphanTools,
} from './memory-policy.js'

export { adjustCutPointForToolPairs, projectSummaryForWire, sliceWithoutOrphanTools }

class RuntimeBackedMemory {
  constructor() {
    this.runtimeHistory = new RuntimeHistory()
    this._legacyRaw = []
    this._legacyDirty = false
    this._legacyProxy = this._createLegacyProxy(this._legacyRaw)
  }

  get messages() {
    return this._legacyProxy
  }

  set messages(value) {
    if (!Array.isArray(value)) {
      throw new TypeError('messages must be assigned an array')
    }
    this._legacyRaw = value.map(cloneMessage)
    this._legacyProxy = this._createLegacyProxy(this._legacyRaw)
    this._legacyDirty = false
    this.runtimeHistory.rebuildFromMessages(this._legacyRaw)
  }

  add(message) {
    this._syncFromLegacyIfDirty()
    this.runtimeHistory.appendMessage(message)
    this._legacyRaw.push(cloneMessage(message))
    this._refreshLegacyFromProjection()
  }

  addAll(messages) {
    this._syncFromLegacyIfDirty()
    for (const message of messages) {
      this.runtimeHistory.appendMessage(message)
      this._legacyRaw.push(cloneMessage(message))
    }
    this._refreshLegacyFromProjection()
  }

  clear() {
    this.runtimeHistory.clear()
    this._legacyRaw.length = 0
    this._legacyDirty = false
    this._onClear()
  }

  get size() {
    this._syncFromLegacyIfDirty()
    return this._projectedMessages().length
  }

  _onClear() {}

  _createLegacyProxy(raw) {
    return new Proxy(raw, {
      set: (target, prop, value) => {
        target[prop] = value
        this._legacyDirty = true
        return true
      },
      deleteProperty: (target, prop) => {
        delete target[prop]
        this._legacyDirty = true
        return true
      },
    })
  }

  _syncFromLegacyIfDirty() {
    if (!this._legacyDirty) return
    this.runtimeHistory.rebuildFromMessages(this._legacyRaw.filter(Boolean))
    this._legacyDirty = false
  }

  _refreshLegacyFromProjection() {
    const projected = this._projectedMessages()
    this._legacyRaw.length = 0
    this._legacyRaw.push(...projected.map(cloneMessage))
    this._legacyDirty = false
  }

  _baseModelMessages(options = {}) {
    this._syncFromLegacyIfDirty()
    return this.runtimeHistory.projectMessages('model', options)
  }

  _projectedMessages() {
    return this._baseModelMessages({ includeSummary: true })
  }
}

// ---- SlidingWindowMemory ----

export class SlidingWindowMemory extends RuntimeBackedMemory {
  /** @param {number} maxMessages 最大消息数（不含 system prompt） */
  constructor(maxMessages = 40) {
    super()
    this.maxMessages = maxMessages
    this._policy = new SlidingWindowPolicy(maxMessages)
  }

  getMessages() {
    this._syncFromLegacyIfDirty()
    return this._policy.apply(this.runtimeHistory.projectMessages('model', { includeSummary: true }))
  }

  /** 返回非 system 消息（用于 ContextManager 的 history 输入） */
  getHistory() {
    return this.getMessages().filter(m => m.role !== 'system')
  }

  _projectedMessages() {
    return this.getMessages()
  }

  _trim() {
    this._refreshLegacyFromProjection()
  }
}

// ---- SummarizingMemory ----

/**
 * 摘要记忆 — 超过阈值时通过 summarizer 函数压缩旧消息。
 * 对应 Java 框架的 fc.memory.SummarizingMemory。
 */
export class SummarizingMemory extends RuntimeBackedMemory {
  /**
   * @param {object} opts
   * @param {number} [opts.threshold=20] - 触发摘要的消息数阈值
   * @param {number} [opts.keepRecent=5] - 摘要后保留的最近消息数
   * @param {((text: string) => Promise<string>) | ((text: string, ctx: object|null) => Promise<string>)} opts.summarizer - 摘要函数。
   */
  constructor({ threshold = 20, keepRecent = 5, summarizer } = {}) {
    super()
    this.threshold = threshold
    this.keepRecent = keepRecent
    this.summarizer = summarizer
    /** @type {string|null} 上一次摘要内容 */
    this.lastSummary = null
    /** @type {Promise<void>|null} 正在进行的摘要压缩 Promise */
    this._summarizePromise = null
    /** @type {object|null} 当前运行的 TelemetryContext */
    this._summaryCtx = null
    this._summaryPolicy = new SummaryPolicy({ threshold, keepRecent })
  }

  /**
   * 注入当前运行的 `TelemetryContext`，后续 `_doSummarize` 会把它
   * 作为第二个实参传给 `summarizer`。
   * @param {object|null} ctx
   */
  setSummaryContext(ctx) {
    this._summaryCtx = ctx ?? null
  }

  /**
   * 获取消息列表。如果超过阈值且有 summarizer，自动触发摘要压缩。
   * 返回值是可直接送入 LLM 的 wire-safe 投影，不泄漏 `_isSummary`。
   * @returns {Promise<object[]>}
   */
  async getMessages() {
    await this._maybeSummarize()
    return projectSummaryForWire(this.runtimeHistory.projectMessages('model', { includeSummary: true }))
  }

  /** 同步获取（不触发摘要），同样做摘要合并 / 剥除。 */
  getMessagesSync() {
    this._syncFromLegacyIfDirty()
    return projectSummaryForWire(this.runtimeHistory.projectMessages('model', { includeSummary: true }))
  }

  /**
   * 返回对话历史（供 ContextManager 使用）。保留 `_isSummary` 标记，
   * 让 ContextManager 能把摘要合并进最终 system prompt。
   */
  async getHistory() {
    await this._maybeSummarize()
    return this.runtimeHistory
      .projectMessages('model', { includeSummary: true })
      .filter(m => m.role !== 'system' || m._isSummary === true)
  }

  _onClear() {
    this.lastSummary = null
    this._summarizePromise = null
  }

  /**
   * 幂等的摘要触发入口：并发调用会共享同一个在途 Promise。
   */
  _maybeSummarize() {
    if (this._summarizePromise) return this._summarizePromise
    this._summarizePromise = this._doSummarize().finally(() => {
      this._summarizePromise = null
    })
    return this._summarizePromise
  }

  async _doSummarize() {
    this._syncFromLegacyIfDirty()
    const previousSummaryIds = this.runtimeHistory
      .getEvents('model')
      .filter(event => event.type === 'summary')
      .flatMap(event => event.sourceEventIds ?? [])
    const alreadyCovered = new Set(previousSummaryIds)
    const messageEvents = this.runtimeHistory
      .getEvents('model')
      .filter(event => event.type === 'message')
      .filter(event => !alreadyCovered.has(event.id))
    const plan = this._summaryPolicy.plan(messageEvents, this.lastSummary)
    if (!plan || !this.summarizer) return

    try {
      this.lastSummary = await this.summarizer(plan.text, this._summaryCtx ?? null)
      this.runtimeHistory.appendSummary({
        content: this.lastSummary,
        sourceEventIds: [...new Set([...previousSummaryIds, ...plan.sourceEventIds])],
      })
      this._refreshLegacyFromProjection()
    } catch (e) {
      console.warn('[SummarizingMemory] Summarization failed:', e.message)
      const fallback = new SlidingWindowPolicy(this.threshold)
        .apply(this.runtimeHistory.projectMessages('model', { includeSummary: true }))
      this.messages = fallback
    }
  }

  _projectedMessages() {
    return this.getMessagesSync()
  }
}

// ---- TokenAwareMemory ----

/**
 * Token 感知记忆 — 按 token 预算裁剪，而非消息数量。
 * 对应 Java 框架的 AdaptiveMemory 的 token 感知部分。
 */
export class TokenAwareMemory extends RuntimeBackedMemory {
  /**
   * @param {number} [maxTokens=50000] - 最大 token 预算
   */
  constructor(maxTokens = 50000) {
    super()
    this.maxTokens = maxTokens
    this._policy = new TokenBudgetPolicy(maxTokens)
  }

  getMessages() {
    this._syncFromLegacyIfDirty()
    return this._policy.apply(this.runtimeHistory.projectMessages('model', { includeSummary: true }))
  }

  getHistory() {
    return this.getMessages().filter(m => m.role !== 'system')
  }

  _estimateTokens(msg) {
    return estimateMessageTokens(msg)
  }

  _projectedMessages() {
    return this.getMessages()
  }

  _trim() {
    this._refreshLegacyFromProjection()
  }
}
