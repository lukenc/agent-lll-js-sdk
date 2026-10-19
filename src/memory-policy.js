import { DEFAULT_IMAGE_PRICING } from './content/image-tokens.js'
import { contentText } from './content/parts.js'

const CHARS_PER_TOKEN = 4

/**
 * 结构开销常量。
 *
 * 密度启发式仍是 chars/4，不上真分词器；精度的改进来自这两个常量。
 * 实际发出去的不是拼接文本而是 JSON：每条消息有 role 字段和对象花括号，
 * 每个工具调用有 id/type/function 三层嵌套。不算这些会**系统性低估**，
 * 而低估的方向是危险那侧 —— 以为没超，实际超了，请求发出去才由服务端报错。
 *
 * 校准锚点：`estimateMessageTokens({role:'user', content:'abcd'})` === 9
 * （4 字符/4=1 + BLOCK 4 + ROLE 4），由 token-accounting.test.js 钉住。
 *
 * 放在本模块（而非 context-manager）是因为依赖方向：context-manager 已经
 * 依赖 memory-policy，反过来会成环。计价是底层能力，两处必须共用同一份 ——
 * 预算判断和裁剪判断用不同算法，会出现「预算说超了、裁剪认为没超」的死角。
 */
export const ROLE_OVERHEAD = 4
export const BLOCK_OVERHEAD = 4

/**
 * 给一条 OpenAI 格式的消息计价，含结构开销。
 *
 * `content` 为字符串时算法与改动前逐字节相同（校准锚点 9 不变）。为数组时逐部件
 * 计价：文本按 chars/4，图片按 `pricing.imageTokens`，每个部件一层块框架 ——
 * **base64 永不按文本计价**（1 MB 图按字符数算会得出 ~33 万 token）。
 *
 * @param {{role?:string, content?:string|object[], tool_calls?:object[]}} msg
 * @param {{ imageTokens(part: object): number }|null} [pricing] 缺省（含 null）用 mimo 公式
 * @returns {number}
 */
export function estimateMessageTokens(msg, pricing) {
  if (!msg || typeof msg !== 'object') return ROLE_OVERHEAD
  const p = pricing ?? DEFAULT_IMAGE_PRICING
  let tokens = Array.isArray(msg.content)
    ? contentPartsTokens(msg.content, p) + BLOCK_OVERHEAD + ROLE_OVERHEAD
    : Math.ceil(String(msg.content ?? '').length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD + ROLE_OVERHEAD
  // 工具调用：函数名与参数是独立计费的字符串，外加一层 JSON 框架
  if (Array.isArray(msg.tool_calls)) {
    for (const call of msg.tool_calls) {
      const fn = call?.function ?? {}
      tokens += Math.ceil(String(fn.name ?? '').length / CHARS_PER_TOKEN)
        + Math.ceil(String(fn.arguments ?? '').length / CHARS_PER_TOKEN)
        + BLOCK_OVERHEAD
    }
  }
  // tool 结果比同长度的普通消息多一层块框架（tool_call_id + 嵌套 content）
  if (msg.role === 'tool') tokens += BLOCK_OVERHEAD
  return tokens
}

function contentPartsTokens(parts, pricing) {
  let tokens = 0
  for (const part of parts) {
    tokens += part?.type === 'image_url'
      ? pricing.imageTokens(part) + BLOCK_OVERHEAD
      : Math.ceil(String(part?.text ?? '').length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
  }
  return tokens
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
    // 保底：一条都装不下时仍然保留最近一条。加上结构开销后单条最低就要
    // BLOCK+ROLE=8 tokens，预算配得小一点就会一条都留不住 —— 模型连用户
    // 刚说的话都看不到，比略微超预算糟糕得多。与 context-manager 的
    // trimHistory 同一取舍：请求有效性优先于严格预算。
    if (kept.length === 0 && nonSystem.length > 0) {
      kept.unshift(nonSystem[nonSystem.length - 1])
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
      // 文本投影：摘要走简单模型、本就只收文本；图片压缩后只剩占位，这是接受的信息损失。
      .map(event => `[${event.message.role}]: ${contentText(event.message.content)}`)
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
  if (Array.isArray(message)) return message.map(cloneMessage)
  const out = Object.create(Object.getPrototypeOf(message))
  for (const key of Object.keys(message)) out[key] = cloneMessage(message[key])
  return out
}
