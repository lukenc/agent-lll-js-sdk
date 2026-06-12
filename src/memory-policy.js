const CHARS_PER_TOKEN = 4

export function estimateMessageTokens(msg) {
  const text = msg?.content ?? ''
  return Math.ceil(String(text).length / CHARS_PER_TOKEN)
}

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
  if (summaryTexts.length === 0) return rest.map(cloneMessage)
  const summaryBlock = summaryTexts.join('\n\n')
  const firstSysIdx = rest.findIndex(m => m && m.role === 'system')
  if (firstSysIdx === -1) return [{ role: 'system', content: summaryBlock }, ...rest.map(cloneMessage)]
  const out = rest.map(cloneMessage)
  const base = out[firstSysIdx].content ?? ''
  out[firstSysIdx] = { ...out[firstSysIdx], content: base ? `${base}\n\n${summaryBlock}` : summaryBlock }
  delete out[firstSysIdx]._isSummary
  return out
}

export function adjustCutPointForToolPairs(nonSystem, cutIndex) {
  if (cutIndex <= 0 || cutIndex >= nonSystem.length) return cutIndex
  const originalCutIndex = cutIndex
  while (cutIndex > 0 && nonSystem[cutIndex].role === 'tool') cutIndex--
  if (nonSystem[cutIndex].role === 'assistant' && nonSystem[cutIndex].tool_calls?.length > 0) {
    return cutIndex
  }
  return originalCutIndex
}

export function sliceWithoutOrphanTools(nonSystem, cutIndex) {
  const adjusted = adjustCutPointForToolPairs(nonSystem, cutIndex)
  const sliced = nonSystem.slice(adjusted).map(cloneMessage)
  let stripFrom = 0
  while (stripFrom < sliced.length && sliced[stripFrom].role === 'tool') stripFrom++
  return stripFrom === 0 ? sliced : sliced.slice(stripFrom)
}

export class SlidingWindowPolicy {
  constructor(maxMessages = 40) {
    this.maxMessages = maxMessages
  }

  apply(messages) {
    const system = messages.filter(m => m.role === 'system').map(cloneMessage)
    const nonSystem = messages.filter(m => m.role !== 'system')
    if (nonSystem.length <= this.maxMessages) return [...system, ...nonSystem.map(cloneMessage)]
    const cutIndex = nonSystem.length - this.maxMessages
    return [...system, ...sliceWithoutOrphanTools(nonSystem, cutIndex)]
  }
}

export class TokenBudgetPolicy {
  constructor(maxTokens = 50000) {
    this.maxTokens = maxTokens
  }

  apply(messages) {
    const system = messages.filter(m => m.role === 'system').map(cloneMessage)
    const nonSystem = messages.filter(m => m.role !== 'system')
    let totalTokens = system.reduce((sum, m) => sum + estimateMessageTokens(m), 0)
    const kept = []
    for (let i = nonSystem.length - 1; i >= 0; i--) {
      const tokens = estimateMessageTokens(nonSystem[i])
      if (totalTokens + tokens > this.maxTokens) break
      kept.unshift(nonSystem[i])
      totalTokens += tokens
    }
    const cutIndex = nonSystem.length - kept.length
    return [...system, ...sliceWithoutOrphanTools(nonSystem, cutIndex)]
  }
}

export class SummaryPolicy {
  constructor({ threshold = 20, keepRecent = 5 } = {}) {
    this.threshold = threshold
    this.keepRecent = keepRecent
  }

  plan(messageEvents, previousSummary) {
    const nonSystemEvents = messageEvents.filter(event =>
      event.type === 'message' && event.message?.role !== 'system'
    )
    if (nonSystemEvents.length <= this.threshold) return null
    const cutIndex = adjustCutPointForToolPairs(
      nonSystemEvents.map(event => event.message),
      nonSystemEvents.length - this.keepRecent,
    )
    const toSummarize = nonSystemEvents.slice(0, cutIndex)
    const toKeep = sliceWithoutOrphanTools(
      nonSystemEvents.map(event => event.message),
      cutIndex,
    )
    const prevBlock = previousSummary
      ? `[Previous summary]\n${previousSummary}\n\n[New messages]\n`
      : ''
    const text = prevBlock + toSummarize
      .map(event => `[${event.message.role}]: ${event.message.content ?? ''}`)
      .join('\n')
    return {
      text,
      sourceEventIds: toSummarize.map(event => event.id),
      keepMessages: toKeep,
    }
  }
}

export function cloneMessage(message) {
  if (message == null || typeof message !== 'object') return message
  return JSON.parse(JSON.stringify(message))
}
