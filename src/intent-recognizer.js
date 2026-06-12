/**
 * IntentRecognizer — 意图识别引擎（sidecar LLM 调用）
 * 对应 Java 框架的 fc.runtime.IntentRecognizer
 *
 * 以独立 LLM 调用分析用户请求的清晰度、复杂度，
 * 输出工具过滤建议和推荐执行策略。
 * 失败时返回 defaultResult()，不阻塞主流程。
 */

import { syncChat } from './llm-client.js'
import { childContext } from './telemetry.js'

/**
 * @typedef {object} IntentResult
 * @property {'CLEAR'|'AMBIGUOUS'} clarity
 * @property {'SIMPLE'|'COMPLEX'} complexity
 * @property {'react'|'plan_and_execute'} recommendedStrategy
 * @property {string} reasoning
 * @property {string[]} filteredToolNames
 */

const SYSTEM_PROMPT_TEMPLATE =
  'You are an intent analyzer. You will be given the prior conversation as context, ' +
  'followed by the user\'s LATEST request as the final user message.\n\n' +
  'Analyze the LATEST request in the context of the conversation and respond with JSON:\n' +
  '{"clarity":"CLEAR|AMBIGUOUS","complexity":"SIMPLE|COMPLEX",' +
  '"recommendedStrategy":"react|plan_and_execute",' +
  '"reasoning":"...","filteredToolNames":[...]}\n' +
  'Available tools: %TOOLS%\n\n' +
  'IMPORTANT:\n' +
  '- Resolve references like "继续", "上个结果", "再帮我", "the previous answer" using the prior turns; ' +
  'such requests are typically CLEAR when the context provides the referent.\n' +
  '- A short follow-up that builds on prior turns is NOT automatically AMBIGUOUS.\n' +
  '- CLEAR = request is specific and actionable (possibly once context is applied). ' +
  'AMBIGUOUS = request genuinely needs clarification the context cannot supply.\n' +
  '- SIMPLE = single step (use react). COMPLEX = multi-step task (use plan_and_execute).\n' +
  '- reasoning: briefly cite which prior turn (if any) resolved the reference.'

/** @returns {IntentResult} */
export function defaultIntentResult() {
  return {
    clarity: 'CLEAR',
    complexity: 'SIMPLE',
    recommendedStrategy: 'react',
    reasoning: 'default fallback',
    filteredToolNames: [],
  }
}

/**
 * 仅保留 user/assistant 的纯文本消息（剥离 tool、assistant(tool_calls)、
 * system 等），供 IntentRecognizer 作为上下文使用。
 * 与 plan-and-execute 的 sanitizeHistory 同构。
 * @param {Array<any>} history
 * @returns {Array<{role:'user'|'assistant',content:string}>}
 */
function sanitizeHistoryForIntent(history) {
  if (!Array.isArray(history) || history.length === 0) return []
  return history.filter(m =>
    m
    && (m.role === 'user' || m.role === 'assistant')
    && typeof m.content === 'string'
    && m.content.length > 0
    && !m.tool_calls,
  ).map(m => ({ role: m.role, content: m.content }))
}

export class IntentRecognizer {
  /**
   * @param {object} opts
   * @param {string} opts.url - LLM API endpoint
   * @param {string} opts.apiKey - API key
   * @param {string} [opts.model='gpt-4'] - 用于意图分析的模型
   */
  constructor({ url, apiKey, model }) {
    this.url = url
    this.apiKey = apiKey
    this.model = model ?? 'gpt-4'
  }

  /**
   * 分析用户消息，返回意图识别结果。
   * sidecar 方式独立调用，不影响主对话上下文。
   *
   * @param {string} userMessage - 当前用户消息
   * @param {string[]} availableToolNames
   * @param {object} [opts]
   * @param {Array<{role:string,content:string}>} [opts.history=[]] - 对话历史
   *   （user/assistant 明文消息）。会自动剥离 tool / assistant(tool_calls) /
   *   system。若最后一条正好等于 userMessage 会自动去重，避免重复消息。
   * @param {number} [opts.maxHistoryMessages=12] - 历史消息数量上限，
   *   控制 sidecar 调用规模。超过则保留最近的 N 条。
   * @param {AbortSignal} [opts.signal]
   * @param {object} [opts.telemetry] - 父级（per-run root）`TelemetryContext`。
   *   存在时会派生 `'agent.intent'` 子上下文并透传给 `syncChat`，使本次 LLM
   *   调用作为 `llm.call` 事件挂在会话 root span 下。缺省时退化为 no-op。
   * @returns {Promise<IntentResult>}
   */
  async analyze(userMessage, availableToolNames = [], opts = {}) {
    // 兼容旧签名 analyze(msg, tools, signal)
    if (opts && typeof opts.throwIfAborted === 'function') {
      opts = { signal: opts }
    }
    const { history = [], maxHistoryMessages = 12, signal, telemetry = null } = opts

    try {
      const toolList = availableToolNames.join(', ')
      const systemPrompt = SYSTEM_PROMPT_TEMPLATE.replace('%TOOLS%', toolList)

      // 清洗 + 去重当前 userMessage + 截尾 N 条
      let contextHistory = sanitizeHistoryForIntent(history)
      if (contextHistory.length > 0) {
        const last = contextHistory[contextHistory.length - 1]
        if (last.role === 'user' && last.content === userMessage) {
          contextHistory = contextHistory.slice(0, -1)
        }
      }
      if (contextHistory.length > maxHistoryMessages) {
        contextHistory = contextHistory.slice(-maxHistoryMessages)
      }

      const body = {
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...contextHistory,
          { role: 'user', content: userMessage },
        ],
        temperature: 0.3,
      }

      const response = await syncChat({
        url: this.url,
        apiKey: this.apiKey,
        body,
        signal,
        telemetry: { ctx: childContext(telemetry, 'agent.intent') },
      })
      return parseIntentResponse(response)
    } catch (e) {
      console.warn('[IntentRecognizer] Failed, using default:', e.message)
      return defaultIntentResult()
    }
  }
}

/**
 * 解析 LLM 响应为 IntentResult
 * @param {object} response - OpenAI 格式响应
 * @returns {IntentResult}
 */
function parseIntentResponse(response) {
  const text = response?.choices?.[0]?.message?.content ?? ''
  if (!text) return defaultIntentResult()

  try {
    // 提取 JSON 部分
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return defaultIntentResult()

    const obj = JSON.parse(text.substring(start, end + 1))

    const clarity = String(obj.clarity).toUpperCase() === 'AMBIGUOUS' ? 'AMBIGUOUS' : 'CLEAR'
    const complexity = String(obj.complexity).toUpperCase() === 'COMPLEX' ? 'COMPLEX' : 'SIMPLE'

    let strategy = complexity === 'COMPLEX' ? 'plan_and_execute' : 'react'
    if (obj.recommendedStrategy) strategy = obj.recommendedStrategy

    const filteredToolNames = Array.isArray(obj.filteredToolNames)
      ? obj.filteredToolNames.filter(n => typeof n === 'string')
      : []

    return { clarity, complexity, recommendedStrategy: strategy, reasoning: obj.reasoning ?? '', filteredToolNames }
  } catch {
    return defaultIntentResult()
  }
}
