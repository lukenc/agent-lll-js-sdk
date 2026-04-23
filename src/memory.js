/**
 * 对话记忆策略 — 对应 Java 框架的 fc.memory 包
 *
 * - SlidingWindowMemory: 滑动窗口（按消息数量裁剪）
 * - SummarizingMemory: 摘要记忆（超阈值时通过 LLM 压缩旧消息）
 * - TokenAwareMemory: token 感知记忆（按 token 预算裁剪）
 */

// ---- Helper: adjust trim cut point to respect tool-call groups ----

/**
 * If the initial cut point lands on a `tool` message, walk backward to include
 * the parent `assistant(tool_calls)` message so the kept portion never starts
 * with orphaned tool responses.
 *
 * Exported so other modules (e.g. ContextManager.trimHistory) can reuse the
 * same invariant without duplicating the logic.
 *
 * @param {object[]} nonSystem - array of non-system messages
 * @param {number} cutIndex - initial index where kept messages start
 * @returns {number} adjusted cutIndex (same or smaller)
 */
/**
 * Collapse `_isSummary`-tagged system messages into the first non-summary
 * system message and strip the internal `_isSummary` field, producing a
 * clean OpenAI-compatible message list with exactly one system message at
 * most (modulo any system messages the caller added by hand).
 *
 * Used by `SummarizingMemory.getMessages` so the internal summary tag never
 * leaks onto the wire and so we never emit two system messages from a single
 * summarization event. See todo.md R-1.
 *
 * @param {object[]} messages
 * @returns {object[]}
 */
export function projectSummaryForWire(messages) {
  const summaryTexts = []
  const rest = []
  for (const m of messages) {
    if (m && m.role === 'system' && m._isSummary === true) {
      if (m.content) summaryTexts.push(m.content)
    } else {
      rest.push(m)
    }
  }
  if (summaryTexts.length === 0) return rest
  const summaryBlock = summaryTexts.join('\n\n')
  const firstSysIdx = rest.findIndex(m => m && m.role === 'system')
  if (firstSysIdx === -1) {
    return [{ role: 'system', content: summaryBlock }, ...rest]
  }
  const orig = rest[firstSysIdx]
  const base = orig.content ?? ''
  const merged = { ...orig, content: base ? `${base}\n\n${summaryBlock}` : summaryBlock }
  // Defensive: strip internal-only field if the caller has somehow placed it
  // on the primary system message too.
  delete merged._isSummary
  const out = rest.slice()
  out[firstSysIdx] = merged
  return out
}

export function adjustCutPointForToolPairs(nonSystem, cutIndex) {
  if (cutIndex <= 0 || cutIndex >= nonSystem.length) return cutIndex
  const originalCutIndex = cutIndex
  // Walk backward while the message at cutIndex is a tool message
  while (cutIndex > 0 && nonSystem[cutIndex].role === 'tool') {
    cutIndex--
  }
  // Now cutIndex should point to the assistant(tool_calls) message
  // Verify it's an assistant with tool_calls; if not, we've hit an edge case
  if (nonSystem[cutIndex].role === 'assistant' && nonSystem[cutIndex].tool_calls?.length > 0) {
    return cutIndex
  }
  // Fallback: return original position (shouldn't happen with well-formed history)
  return originalCutIndex
}

/**
 * Slice `nonSystem` starting from `cutIndex`, keeping the orphan-tool
 * invariant: the returned array will never start with a `role: 'tool'`
 * message that lacks a preceding `assistant(tool_calls)`.
 *
 * Strategy:
 *   1. Let `adjustCutPointForToolPairs` try to pull the parent
 *      `assistant(tool_calls)` back into the slice.
 *   2. If adjustment failed (malformed history: tool messages whose parent
 *      was trimmed away), strip the leading orphan `tool` messages so we
 *      never hand a broken sequence to the LLM.
 *
 * Used by all memory `_trim` implementations and by
 * `ContextManager.trimHistory`, so behavior stays consistent across the
 * four call sites. See todo.md R-4.
 *
 * @param {object[]} nonSystem
 * @param {number} cutIndex
 * @returns {object[]}
 */
export function sliceWithoutOrphanTools(nonSystem, cutIndex) {
  const adjusted = adjustCutPointForToolPairs(nonSystem, cutIndex)
  const sliced = nonSystem.slice(adjusted)
  let stripFrom = 0
  while (stripFrom < sliced.length && sliced[stripFrom].role === 'tool') {
    stripFrom++
  }
  return stripFrom === 0 ? sliced : sliced.slice(stripFrom)
}

// ---- SlidingWindowMemory ----

export class SlidingWindowMemory {
  /** @param {number} maxMessages 最大消息数（不含 system prompt） */
  constructor(maxMessages = 40) {
    this.maxMessages = maxMessages
    this.messages = []
  }

  add(message) {
    this.messages.push(message)
    this._trim()
  }

  addAll(messages) {
    this.messages.push(...messages)
    this._trim()
  }

  getMessages() {
    return [...this.messages]
  }

  /** 返回非 system 消息（用于 ContextManager 的 history 输入） */
  getHistory() {
    return this.messages.filter(m => m.role !== 'system')
  }

  clear() {
    this.messages = []
  }

  get size() {
    return this.messages.length
  }

  _trim() {
    const system = this.messages.filter(m => m.role === 'system')
    const nonSystem = this.messages.filter(m => m.role !== 'system')
    if (nonSystem.length > this.maxMessages) {
      const cutIndex = nonSystem.length - this.maxMessages
      this.messages = [...system, ...sliceWithoutOrphanTools(nonSystem, cutIndex)]
    }
  }
}

// ---- SummarizingMemory ----

/**
 * 摘要记忆 — 超过阈值时通过 summarizer 函数压缩旧消息。
 * 对应 Java 框架的 fc.memory.SummarizingMemory。
 *
 * @example
 * const memory = new SummarizingMemory({
 *   threshold: 20,
 *   keepRecent: 5,
 *   summarizer: async (text) => {
 *     // 调用 LLM 生成摘要
 *     return await llmSummarize(text)
 *   },
 * })
 */
export class SummarizingMemory {
  /**
   * @param {object} opts
   * @param {number} [opts.threshold=20] - 触发摘要的消息数阈值
   * @param {number} [opts.keepRecent=5] - 摘要后保留的最近消息数
   * @param {(text: string) => Promise<string>} opts.summarizer - 摘要函数
   */
  constructor({ threshold = 20, keepRecent = 5, summarizer } = {}) {
    this.threshold = threshold
    this.keepRecent = keepRecent
    this.summarizer = summarizer
    this.messages = []
    /** @type {string|null} 上一次摘要内容 */
    this.lastSummary = null
    /**
     * 正在进行的摘要压缩 Promise（in-flight cache）。并发的
     * `getMessages()` / `getHistory()` 会共享这一个 Promise，
     * 避免两个压缩任务同时 race-condition 地重写 `this.messages`。
     * 见 todo.md R-2。
     * @type {Promise<void>|null}
     */
    this._summarizePromise = null
  }

  add(message) {
    this.messages.push(message)
  }

  addAll(messages) {
    this.messages.push(...messages)
  }

  /**
   * 获取消息列表。如果超过阈值且有 summarizer，自动触发摘要压缩。
   * 注意：此方法是异步的（与 SlidingWindowMemory 不同）。
   *
   * 返回值是"可直接送入 LLM"的形态：`_isSummary` 标记的摘要 system
   * 消息会被 **合并到第一条非摘要 system 消息** 里，并剥除 `_isSummary`
   * 内部字段，避免 wire 协议泄漏、避免出现两条 system。见 todo.md R-1。
   * @returns {Promise<object[]>}
   */
  async getMessages() {
    await this._maybeSummarize()
    return projectSummaryForWire([...this.messages])
  }

  /** 同步获取（不触发摘要），同样做摘要合并 / 剥除。 */
  getMessagesSync() {
    return projectSummaryForWire([...this.messages])
  }

  /**
   * 返回对话历史（供 ContextManager 使用）。
   * 注意：此方法为 async —— 会主动触发摘要压缩，并保留带 `_isSummary`
   * 标记的 system 消息（即压缩后的摘要），避免摘要在 ContextManager 路径
   * 下被悄无声息地丢掉。见 todo.md P0-2。
   *
   * 不同于 `getMessages()`，此处 **保留** `_isSummary` 标记，因为
   * `ContextManager.assemblePrompt` 需要识别并与 `systemPrompt` /
   * `knowledgeContent` 合并。ContextManager 会在输出前负责剥除标记。
   */
  async getHistory() {
    await this._maybeSummarize()
    return this.messages.filter(m => m.role !== 'system' || m._isSummary === true)
  }

  clear() {
    this.messages = []
    this.lastSummary = null
  }

  get size() {
    return this.messages.length
  }

  /**
   * 幂等的摘要触发入口：并发调用会共享同一个在途 Promise，避免两个
   * `await this.summarizer(...)` 同时 race 地重写 `this.messages`。
   * 见 todo.md R-2。
   */
  _maybeSummarize() {
    if (this._summarizePromise) return this._summarizePromise
    this._summarizePromise = this._doSummarize().finally(() => {
      this._summarizePromise = null
    })
    return this._summarizePromise
  }

  async _doSummarize() {
    const nonSystem = this.messages.filter(m => m.role !== 'system')
    if (nonSystem.length <= this.threshold || !this.summarizer) return

    const system = this.messages.filter(m => m.role === 'system')
    const cutIndex = adjustCutPointForToolPairs(nonSystem, nonSystem.length - this.keepRecent)
    const toSummarize = nonSystem.slice(0, cutIndex)
    // `toKeep` uses the orphan-safe slice so the kept portion never begins
    // with a dangling `tool` message even if the parent assistant was
    // pushed into `toSummarize`. See todo.md R-4.
    const toKeep = sliceWithoutOrphanTools(nonSystem, cutIndex)

    // 将上一次摘要作为前缀一并送入 summarizer，防止多次压缩后
    // 早期对话语义彻底丢失（long-term amnesia）。见 todo.md R-3。
    const prevBlock = this.lastSummary
      ? `[Previous summary]\n${this.lastSummary}\n\n[New messages]\n`
      : ''
    const text = prevBlock + toSummarize.map(m => `[${m.role}]: ${m.content ?? ''}`).join('\n')

    try {
      this.lastSummary = await this.summarizer(text)
      const summaryMsg = {
        role: 'system',
        content: `[Previous conversation summary]: ${this.lastSummary}`,
        _isSummary: true,
      }
      this.messages = [...system.filter(m => !m._isSummary), summaryMsg, ...toKeep]
    } catch (e) {
      console.warn('[SummarizingMemory] Summarization failed:', e.message)
      // 回退为滑动窗口行为
      const fallbackCutIndex = nonSystem.length - this.threshold
      this.messages = [...system, ...sliceWithoutOrphanTools(nonSystem, fallbackCutIndex)]
    }
  }
}

// ---- TokenAwareMemory ----

const CHARS_PER_TOKEN = 4

/**
 * Token 感知记忆 — 按 token 预算裁剪，而非消息数量。
 * 对应 Java 框架的 AdaptiveMemory 的 token 感知部分。
 */
export class TokenAwareMemory {
  /**
   * @param {number} [maxTokens=50000] - 最大 token 预算
   */
  constructor(maxTokens = 50000) {
    this.maxTokens = maxTokens
    this.messages = []
  }

  add(message) {
    this.messages.push(message)
    this._trim()
  }

  addAll(messages) {
    this.messages.push(...messages)
    this._trim()
  }

  getMessages() {
    return [...this.messages]
  }

  getHistory() {
    return this.messages.filter(m => m.role !== 'system')
  }

  clear() {
    this.messages = []
  }

  get size() {
    return this.messages.length
  }

  _estimateTokens(msg) {
    const text = msg.content ?? ''
    return Math.ceil(text.length / CHARS_PER_TOKEN)
  }

  _trim() {
    const system = this.messages.filter(m => m.role === 'system')
    const nonSystem = this.messages.filter(m => m.role !== 'system')

    let totalTokens = system.reduce((sum, m) => sum + this._estimateTokens(m), 0)
    const kept = []

    // 从最新消息开始保留
    for (let i = nonSystem.length - 1; i >= 0; i--) {
      const tokens = this._estimateTokens(nonSystem[i])
      if (totalTokens + tokens > this.maxTokens) break
      kept.unshift(nonSystem[i])
      totalTokens += tokens
    }

    const cutIndex = nonSystem.length - kept.length
    this.messages = [...system, ...sliceWithoutOrphanTools(nonSystem, cutIndex)]
  }
}
