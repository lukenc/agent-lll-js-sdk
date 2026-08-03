/**
 * 共享历史轨的检索。
 *
 * 搜的是 RuntimeHistory 的**原始事件**，不是投影 —— 所以被 SummarizingMemory
 * 压缩掉的内容照样能捞回来（摘要只影响 projectMessages 的跳过逻辑，原事件仍在）。
 * 这是"找回记忆"的实现基础，也是 subagent 不必继承父上下文的前提。
 */

export const SNIPPET_RADIUS = 120
export const MAX_SNIPPET = 400
export const DEFAULT_LIMIT = 20
export const MAX_CONTEXT = 10

/** 把一个事件压成可搜索的纯文本。 */
function searchableText(event) {
  if (event.type === 'summary') return String(event.content ?? '')
  const msg = event.message
  if (!msg) return ''
  const parts = [String(msg.content ?? '')]
  if (msg.name) parts.push(String(msg.name))
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      parts.push(String(tc?.function?.name ?? ''), String(tc?.function?.arguments ?? ''))
    }
  }
  return parts.filter(Boolean).join('\n')
}

function makeSnippet(text, index, length) {
  const start = Math.max(0, index - SNIPPET_RADIUS)
  const end = Math.min(text.length, index + length + SNIPPET_RADIUS)
  let snippet = text.slice(start, end)
  if (start > 0) snippet = `…${snippet}`
  if (end < text.length) snippet = `${snippet}…`
  return snippet.length > MAX_SNIPPET ? `${snippet.slice(0, MAX_SNIPPET - 1)}…` : snippet
}

/**
 * @param {object} sharedHistory RuntimeHistory 实例
 * @param {object} opts
 * @param {string} opts.query 子串或正则源
 * @param {boolean} [opts.regex=false]
 * @param {string} [opts.agentId] 按 topicId 过滤（子 agent 的 topicId 就是 agentId）
 * @param {string} [opts.role]
 * @param {string} [opts.track='all']
 * @param {number} [opts.since] 时间下界（含）
 * @param {number} [opts.until] 时间上界（含）
 * @param {number} [opts.limit=20]
 * @returns {Array<{ eventId: string, ts: number, agentId: string|null, role: string|null, snippet: string }>}
 */
export function searchHistory(sharedHistory, {
  query, regex = false, agentId, role, track = 'all', since, until, limit = DEFAULT_LIMIT,
} = {}) {
  if (!sharedHistory || typeof sharedHistory.getEvents !== 'function') return []
  if (typeof query !== 'string' || query.length === 0) return []

  /** @type {RegExp|null} */
  let re = null
  if (regex) {
    try {
      re = new RegExp(query, 'gi')
    } catch {
      // 正则编译失败 → 降级为子串。返回空结果好过抛错打断子 agent。
      re = null
      if (!query.replace(/[.*+?^${}()|[\]\\]/g, '').trim()) return []
    }
  }
  const needle = query.toLowerCase()

  const out = []
  for (const event of sharedHistory.getEvents(track)) {
    if (out.length >= limit) break
    if (agentId != null && event.topicId !== agentId) continue
    if (since != null && event.timestamp < since) continue
    if (until != null && event.timestamp > until) continue
    const eventRole = event.type === 'summary' ? 'system' : (event.message?.role ?? null)
    if (role != null && eventRole !== role) continue

    const text = searchableText(event)
    if (!text) continue

    let index = -1
    let matchLength = query.length
    if (re) {
      re.lastIndex = 0
      const m = re.exec(text)
      if (m) { index = m.index; matchLength = m[0].length }
    } else {
      index = text.toLowerCase().indexOf(needle)
    }
    if (index < 0) continue

    out.push({
      eventId: event.id,
      ts: event.timestamp,
      agentId: event.topicId ?? null,
      role: eventRole,
      snippet: makeSnippet(text, index, matchLength),
    })
  }
  return out
}

/**
 * 按 eventId 取完整事件并展开前后文。
 * @returns {{ target: object, before: object[], after: object[] }|null}
 */
export function getHistoryEvent(sharedHistory, { eventId, before = 3, after = 3 } = {}) {
  if (!sharedHistory || typeof sharedHistory.getEvents !== 'function') return null
  const events = sharedHistory.getEvents('all')
  const index = events.findIndex(e => e.id === eventId)
  if (index < 0) return null
  const b = Math.max(0, Math.min(MAX_CONTEXT, Number(before) || 0))
  const a = Math.max(0, Math.min(MAX_CONTEXT, Number(after) || 0))
  return {
    target: events[index],
    before: events.slice(Math.max(0, index - b), index),
    after: events.slice(index + 1, index + 1 + a),
  }
}
