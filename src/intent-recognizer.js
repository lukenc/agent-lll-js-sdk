/**
 * IntentRecognizer — 意图识别引擎（sidecar LLM 调用）
 * 对应 Java 框架的 fc.runtime.IntentRecognizer
 *
 * 以独立 LLM 调用分析用户请求的清晰度、复杂度，
 * 输出工具过滤建议和推荐执行策略。
 * 失败时返回 defaultResult()，不阻塞主流程。
 */

import { syncChat } from './llm-client.js'

/**
 * @typedef {object} IntentResult
 * @property {'CLEAR'|'AMBIGUOUS'} clarity
 * @property {'SIMPLE'|'COMPLEX'} complexity
 * @property {'react'|'plan_and_execute'} recommendedStrategy
 * @property {string} reasoning
 * @property {string[]} filteredToolNames
 */

const SYSTEM_PROMPT_TEMPLATE =
  'You are an intent analyzer. Analyze the user\'s request and respond with JSON:\n' +
  '{"clarity":"CLEAR|AMBIGUOUS","complexity":"SIMPLE|COMPLEX",' +
  '"recommendedStrategy":"react|plan_and_execute",' +
  '"reasoning":"...","filteredToolNames":[...]}\n' +
  'Available tools: %TOOLS%\n' +
  'CLEAR = request is specific and actionable. AMBIGUOUS = request needs clarification.\n' +
  'SIMPLE = single step task (use react). COMPLEX = multi-step task (use plan_and_execute).'

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
   * @param {string} userMessage
   * @param {string[]} availableToolNames
   * @param {AbortSignal} [signal]
   * @returns {Promise<IntentResult>}
   */
  async analyze(userMessage, availableToolNames = [], signal) {
    try {
      const toolList = availableToolNames.join(', ')
      const systemPrompt = SYSTEM_PROMPT_TEMPLATE.replace('%TOOLS%', toolList)

      const body = {
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.3,
      }

      const response = await syncChat({ url: this.url, apiKey: this.apiKey, body, signal })
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
