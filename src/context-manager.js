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

const CHARS_PER_TOKEN = 4

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
    let sysTokens = estimateTokens(systemPrompt) + estimateTokens(summaryContent)
    let knowledgeTokens = estimateTokens(knowledgeContent)
    let historyTokens = estimateTokens(historyMessages.map(m => `[${m.role}]: ${m.content ?? ''}`).join('\n'))
    let toolsText = buildToolDescriptions(filteredTools)
    let toolsTokens = estimateTokens(toolsText)
    let trimmed = false

    const totalEstimate = sysTokens + knowledgeTokens + historyTokens + toolsTokens

    // 3. 超预算时按优先级裁剪：TOOLS → HISTORY → KNOWLEDGE
    if (totalEstimate > budget.totalTokens) {
      trimmed = true

      // 3a. 裁剪工具描述
      const toolsBudget = Math.floor(budget.totalTokens * budget.toolsRatio)
      if (toolsTokens > toolsBudget) {
        filteredTools = trimTools(filteredTools, toolsBudget)
        toolsText = buildToolDescriptions(filteredTools)
        toolsTokens = estimateTokens(toolsText)
      }

      // 3b. 裁剪对话历史
      const remaining = budget.totalTokens - sysTokens - knowledgeTokens - toolsTokens
      if (historyTokens > remaining && remaining > 0) {
        historyMessages = trimHistory(historyMessages, remaining)
        historyTokens = estimateTokens(historyMessages.map(m => `[${m.role}]: ${m.content ?? ''}`).join('\n'))
      } else if (remaining <= 0) {
        historyMessages = []
        historyTokens = 0
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

    return {
      messages,
      tools,
      systemPromptTokens: sysTokens,
      knowledgeTokens,
      historyTokens,
      toolsTokens,
      totalTokens: sysTokens + knowledgeTokens + historyTokens + toolsTokens,
      trimmed,
    }
  }
}

/** 估算 token 数量（chars / 4 启发式） */
export function estimateTokens(text) {
  if (!text) return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

function buildToolDescriptions(tools) {
  if (!tools || tools.length === 0) return ''
  return tools.map(t => `### ${t.name}\n${t.description}`).join('\n\n')
}

/** 裁剪工具：优先保留 BASE_TOOLS，再按顺序添加直到预算用尽 */
function trimTools(tools, budgetTokens) {
  const base = tools.filter(t => BASE_TOOLS.has(t.name))
  const others = tools.filter(t => !BASE_TOOLS.has(t.name))

  const kept = [...base]
  let currentTokens = estimateTokens(buildToolDescriptions(kept))

  for (const tool of others) {
    const desc = `### ${tool.name}\n${tool.description}`
    const toolTokens = estimateTokens(desc)
    if (currentTokens + toolTokens <= budgetTokens) {
      kept.push(tool)
      currentTokens += toolTokens
    }
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
    const msg = messages[i]
    const msgTokens = estimateTokens(`[${msg.role}]: ${msg.content ?? ''}`)
    if (tokens + msgTokens > budgetTokens) break
    tokens += msgTokens
    cutIndex = i
  }

  if (cutIndex >= messages.length) return []
  return sliceWithoutOrphanTools(messages, cutIndex)
}
