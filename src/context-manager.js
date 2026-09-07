/**
 * ContextManager — 上下文管理器（认知/模型层）
 * 对应 Java 框架的 fc.state.ContextManager + TokenBudget
 *
 * 负责组装最终发送给 LLM 的 prompt，控制 token 用量。
 * 超预算时按优先级裁剪：TOOLS → HISTORY → KNOWLEDGE，SYSTEM_PROMPT 不裁剪。
 */

import { formatToolsForOpenAI } from './tool.js'
import { sliceWithoutOrphanTools } from './memory.js'
import { BASE_TOOLS } from './tool-filter.js'
// 计价的家在 memory-policy.js —— 依赖方向要求它在下层（本模块已依赖它，
// 反过来会成环）。两处必须共用同一份实现：预算判断与裁剪判断用不同算法，
// 会出现「预算说超了、裁剪却认为没超」的死角。
import { ROLE_OVERHEAD, BLOCK_OVERHEAD, estimateMessageTokens } from './memory-policy.js'

const CHARS_PER_TOKEN = 4

// 重新导出，让既有调用方仍可从 context-manager 拿到这几个符号。
export { ROLE_OVERHEAD, BLOCK_OVERHEAD, estimateMessageTokens }

/**
 * @typedef {object} TokenBudget
 * @property {number} totalTokens
 * @property {number} systemPromptRatio
 * @property {number} knowledgeRatio
 * @property {number} historyRatio
 * @property {number} toolsRatio
 */

/** @returns {TokenBudget} */
export function defaultTokenBudget() {
  return {
    totalTokens: 120000,
    systemPromptRatio: 0.15,
    knowledgeRatio: 0.20,
    historyRatio: 0.45,
    toolsRatio: 0.20,
  }
}

/**
 * @typedef {object} AssembleRequest
 * @property {string} [systemPrompt]
 * @property {string} [userMessage]
 * @property {object[]} [history] - 对话历史消息数组
 * @property {import('./knowledge-base.js').KnowledgeBase} [knowledgeBase]
 * @property {import('./tool.js').ToolDef[]} [filteredTools]
 * @property {TokenBudget} [tokenBudget]
 */

/**
 * @typedef {object} AssembleResult
 * @property {object[]} messages - 组装后的 messages 数组（可直接发给 LLM）
 * @property {object[]|undefined} tools - OpenAI tools 格式（如有工具）
 * @property {number} systemPromptTokens
 * @property {number} knowledgeTokens
 * @property {number} historyTokens
 * @property {number} toolsTokens
 * @property {number} totalTokens
 * @property {boolean} trimmed
 */

export class ContextManager {
  constructor() {
    /** @type {import('./knowledge-base.js').KnowledgeBase|null} */
    this.knowledgeBase = null
  }

  /**
   * 组装最终发送给 LLM 的 prompt。
   * @param {AssembleRequest} request
   * @returns {AssembleResult}
   */
  assemblePrompt(request) {
    const budget = request.tokenBudget ?? defaultTokenBudget()

    // 1. 收集各区段原始内容
    const systemPrompt = request.systemPrompt ?? ''
    const kb = request.knowledgeBase ?? this.knowledgeBase
    let knowledgeContent = kb ? kb.buildKnowledgePrompt() : ''
    let historyInput = request.history ?? []
    let filteredTools = request.filteredTools ?? []

    // 1b. 从 history 中抽出带 _isSummary 标记的摘要消息（由 SummarizingMemory 注入），
    //     避免作为独立 system 消息散落；后面合并进 system prompt。见 todo.md P0-2。
    const summaryMessages = historyInput.filter(m => m.role === 'system' && m._isSummary === true)
    let historyMessages = historyInput.filter(m => !(m.role === 'system' && m._isSummary === true))
    const summaryContent = summaryMessages.map(m => m.content ?? '').filter(Boolean).join('\n\n')

    // 2. 估算各区段 token
    //    历史与工具都改成「按真实发送形态」计价：逐条累加消息（含 role/tool_calls
    //    结构开销），工具按 JSON Schema 而非 markdown 描述。旧算法把历史拼成一个
    //    大字符串再估，漏掉了每条消息的 JSON 框架成本。
    let sysTokens = estimateTokens(systemPrompt) + estimateTokens(summaryContent) + ROLE_OVERHEAD
    let knowledgeTokens = estimateTokens(knowledgeContent)
    let historyTokens = sumMessageTokens(historyMessages)
    let toolsTokens = estimateToolsTokens(filteredTools)
    let trimmed = false

    const totalEstimate = sysTokens + knowledgeTokens + historyTokens + toolsTokens

    // 3. 超预算时按优先级裁剪：TOOLS → HISTORY → KNOWLEDGE
    if (totalEstimate > budget.totalTokens) {
      trimmed = true

      // 3a. 裁剪工具描述
      const toolsBudget = Math.floor(budget.totalTokens * budget.toolsRatio)
      if (toolsTokens > toolsBudget) {
        filteredTools = trimTools(filteredTools, toolsBudget)
        toolsTokens = estimateToolsTokens(filteredTools)
      }

      // 3b. 裁剪对话历史
      const remaining = budget.totalTokens - sysTokens - knowledgeTokens - toolsTokens
      if (historyTokens > remaining && remaining > 0) {
        historyMessages = trimHistory(historyMessages, remaining)
        historyTokens = sumMessageTokens(historyMessages)
      } else if (remaining <= 0) {
        // 连一点余量都没有：仍然走 trimHistory 的保底路径保住最后一条，
        // 而不是清空。空历史意味着模型看不到用户刚说的话。
        historyMessages = trimHistory(historyMessages, 0)
        historyTokens = sumMessageTokens(historyMessages)
      }

      // 3c. 裁剪知识注入
      const remainingAfterHistory = budget.totalTokens - sysTokens - historyTokens - toolsTokens
      if (knowledgeTokens > remainingAfterHistory && remainingAfterHistory > 0) {
        knowledgeContent = knowledgeContent.slice(0, remainingAfterHistory * CHARS_PER_TOKEN)
        knowledgeTokens = estimateTokens(knowledgeContent)
      } else if (remainingAfterHistory <= 0) {
        knowledgeContent = ''
        knowledgeTokens = 0
      }
    }

    // 4. 组装 messages 数组
    const messages = []

    // system prompt + summary + knowledge 合并为 system message
    let sysContent = systemPrompt
    if (summaryContent) sysContent += (sysContent ? '\n\n' : '') + summaryContent
    if (knowledgeContent) sysContent += (sysContent ? '\n\n' : '') + knowledgeContent
    if (sysContent) messages.push({ role: 'system', content: sysContent })

    // 对话历史
    for (const msg of historyMessages) {
      messages.push(msg)
    }

    // 用户消息
    if (request.userMessage) {
      messages.push({ role: 'user', content: request.userMessage })
    }

    // 工具
    const tools = filteredTools.length > 0 ? formatToolsForOpenAI(filteredTools) : undefined

    // 5. 请求压力：能复用锚点就复用，否则全量估算
    //
    //    锚点 = 上一次成功调用的**真实用量**。信封（system + 工具集）没变时，
    //    只需要对锚点之后新增的历史做估算，误差从「整体估算」缩小到「只有增量
    //    是估算的」。信封变了就必须重估 —— 对齐 dsh 的 G4。
    const estimatedTotal = sysTokens + knowledgeTokens + historyTokens + toolsTokens
    const fingerprint = headerFingerprint(systemPrompt, filteredTools)
    const anchor = request.anchor
    let totalTokens = estimatedTotal
    let tokenConfidence = 'estimated'

    if (isUsableAnchor(anchor) && anchor.fingerprint === fingerprint) {
      // 守恒校验（dsh G2）：只有锚点**不小于**同期估算时才采信真实用量。
      // 锚点若比估算还小（例如缓存计费导致真实用量偏低），从它出发做有符号
      // 增量会系统性偏低，越滚越不准 —— 这种情况宁可退回估算。
      if (anchor.totalTokens >= anchor.estimatedAtAnchor) {
        // 有符号增量：历史可能增长，也可能因摘要压缩而**收缩**
        totalTokens = Math.max(0, anchor.totalTokens + (historyTokens - anchor.historyTokens))
        tokenConfidence = 'usage'
      }
    }

    return {
      messages,
      tools,
      systemPromptTokens: sysTokens,
      knowledgeTokens,
      historyTokens,
      toolsTokens,
      totalTokens,
      trimmed,
      /**
       * 这个 totalTokens 可不可信：
       *   'usage'     —— 基于上一次真实用量的锚点 + 本轮增量
       *   'estimated' —— 纯启发式估算
       * 新增字段，不影响既有调用方（dsh 的 G5：置信度必须暴露）。
       */
      tokenConfidence,
      /** 纯估算值，便于调用方与锚定值对比、或作为下一次锚点的 estimatedAtAnchor */
      estimatedTokens: estimatedTotal,
      /** 本次请求的信封指纹，调用方拿到真实用量后要连同它一起存为下次的锚点 */
      headerFingerprint: fingerprint,
    }
  }
}

/** 锚点是否可用 —— 字段不全的锚点安全忽略，不抛 */
function isUsableAnchor(a) {
  return !!a
    && typeof a.fingerprint === 'string'
    && Number.isFinite(a.totalTokens)
    && Number.isFinite(a.estimatedAtAnchor)
    && Number.isFinite(a.historyTokens)
}

/** 逐条累加消息计价 —— 预算判断与裁剪判断必须共用它，否则两者会打架 */
function sumMessageTokens(messages) {
  let sum = 0
  for (const m of messages) sum += estimateMessageTokens(m)
  return sum
}

/** 估算 token 数量（chars / 4 启发式） */
export function estimateTokens(text) {
  if (!text) return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * 给工具集计价 —— 按**真实发送的 JSON Schema**，而不是 markdown 描述。
 *
 * 旧算法用 `### name\ndescription` 估，漏掉了参数定义、类型、枚举、嵌套对象。
 * 一个参数复杂的工具，schema 的 JSON 长度轻松是描述文本的好几倍；挂了 MCP
 * 服务器、工具数量上去之后这项误差最大。
 *
 * @param {import('./tool.js').ToolDef[]} tools
 * @returns {number}
 */
export function estimateToolsTokens(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return 0
  let json
  try {
    json = JSON.stringify(formatToolsForOpenAI(tools))
  } catch {
    // 循环引用等异常 schema：退回描述文本估算，别让计价把整轮打挂
    return estimateTokens(buildToolDescriptions(tools))
  }
  return estimateTokens(json) + BLOCK_OVERHEAD
}

/**
 * 请求信封的指纹 —— 用来判断「这次请求的固定部分和上次是不是同一套」。
 *
 * 信封 = 系统提示 + 工具集。它没变时，上一次的真实用量才能当锚点复用；
 * 变了就必须全量重估（dsh 的 G4：model / system / tools / config 任一变化
 * 都让锚点失效）。
 *
 * 规范化对齐 dsh 的 `canonicalHeader`：**空 system 与无 system 等价，
 * 空工具数组与无工具等价** —— 否则 `tools: []` 和 `undefined` 会算成两个
 * 信封，每轮都白白丢掉锚点。
 *
 * 用 FNV-1a 而非加密哈希：这是变化检测，不是安全用途；零依赖、Node 与浏览器
 * 行为一致（同 agents/artifacts.js 的 fnv1a32 先例）。
 *
 * @param {string|null|undefined} systemPrompt
 * @param {object[]|null|undefined} tools
 * @returns {string} 8 位十六进制
 */
export function headerFingerprint(systemPrompt, tools) {
  const sys = systemPrompt || ''
  let toolsPart = ''
  if (Array.isArray(tools) && tools.length > 0) {
    try {
      // 用真实发送形态：只比名字的话，schema 改了却复用旧锚点，误差会一直带着走。
      //
      // 但先按名字**排序**：工具的先后顺序不改变请求内容，只改变序列化顺序。
      // 不排序的话，ToolFilter 每轮返回顺序略有不同就会让指纹抖动、锚点白白
      // 失效（真实场景实测过：开着意图识别时几乎每轮都丢锚点）。
      const sorted = [...tools].sort((a, b) => String(a?.name ?? '').localeCompare(String(b?.name ?? '')))
      toolsPart = JSON.stringify(formatToolsForOpenAI(sorted))
    } catch {
      toolsPart = tools.map(t => t?.name ?? '').sort().join(',')
    }
  }
  const input = `${sys} ${toolsPart}`
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h = Math.imul(h ^ input.charCodeAt(i), 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

function buildToolDescriptions(tools) {
  if (!tools || tools.length === 0) return ''
  return tools.map(t => `### ${t.name}\n${t.description}`).join('\n\n')
}

/** 裁剪工具：优先保留 BASE_TOOLS，再按顺序添加直到预算用尽 */
function trimTools(tools, budgetTokens) {
  const base = tools.filter(t => BASE_TOOLS.has(t.name))
  const others = tools.filter(t => !BASE_TOOLS.has(t.name))

  // 与预算判断共用 estimateToolsTokens（按真实 JSON Schema 计价）。
  // 若这里仍按 markdown 描述估，会以为还装得下、实际已超 —— schema 通常
  // 是描述文本的好几倍。
  const kept = [...base]

  for (const tool of others) {
    // 逐个试探：加进去之后的真实体积是否仍在预算内
    if (estimateToolsTokens([...kept, tool]) <= budgetTokens) kept.push(tool)
  }
  return kept
}

/**
 * 裁剪对话历史：保留最近的消息直到预算用尽。
 *
 * 额外保证：裁剪后不产生 orphan `tool` 消息（即首条就是 `role: 'tool'`
 * 但前面没有 `assistant(tool_calls)`）。具体策略由公共工具
 * `sliceWithoutOrphanTools` 提供：优先把父 assistant 一并纳入；纳入失败
 * 则剥掉首部 orphan tool。四处 _trim / trimHistory 共享同一实现，见
 * todo.md R-4。
 *
 * 注意：当成功纳入父 assistant 时，结果可能超出 `budgetTokens`——这是
 * 为了保 OpenAI 协议有效性而做的折中，优先级高于严格预算。
 */
function trimHistory(messages, budgetTokens) {
  let cutIndex = messages.length
  let tokens = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    // 与预算判断共用 estimateMessageTokens —— 两处若用不同算法，会出现
    // 「预算说超了、裁剪却认为没超」的死角，裁完仍然超预算。
    const msgTokens = estimateMessageTokens(messages[i])
    if (tokens + msgTokens > budgetTokens) break
    tokens += msgTokens
    cutIndex = i
  }

  // 保底：一条都装不下时，仍然保留最后一条。
  //
  // 加上结构开销后单条消息最低就要 8 tokens（BLOCK+ROLE），预算被配得极小时
  // 上面的循环会一条都留不下 —— 模型连用户刚说的那句话都看不到，这比略微
  // 超预算糟糕得多。与 `sliceWithoutOrphanTools` 已有的取舍同源：保住请求的
  // 有效性优先于严格守住预算。
  if (cutIndex >= messages.length && messages.length > 0) {
    cutIndex = messages.length - 1
  }

  if (cutIndex >= messages.length) return []
  return sliceWithoutOrphanTools(messages, cutIndex)
}
