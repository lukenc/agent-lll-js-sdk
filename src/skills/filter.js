/**
 * SkillFilter — sidecar LLM 调用,按用户消息对 skill 做 Top-K 相关性排序。
 * 独立于 IntentRecognizer。失败 fail-open:返回全量 skills(与
 * IntentRecognizer 失败策略一致)。
 */

import { syncChat } from '../llm-client.js'
import { childContext } from '../telemetry.js'

const SYSTEM_PROMPT_TEMPLATE =
  'You are a skill selector. Given a user message and a list of skills, ' +
  'return the names of the top %TOPK% most relevant skills as a JSON array.\n' +
  'Respond with ONLY a JSON array of skill names, e.g. ["skill-a","skill-b"].\n' +
  'Available skills:\n%SKILLS%'

export class SkillFilter {
  /**
   * @param {object} opts
   * @param {string} opts.url LLM API endpoint
   * @param {string} opts.apiKey
   * @param {string} opts.model 建议使用 simpleModel;未配置时调用方回退主模型
   */
  constructor({ url, apiKey, model }) {
    this.url = url
    this.apiKey = apiKey
    this.model = model
    // 测试注入口(与 Agent._createMCPClient 同款):默认模块级 syncChat。
    this._syncChat = syncChat
  }

  /**
   * @param {string} userMessage
   * @param {import('./model.js').Skill_Def[]} skills
   * @param {{ topK?: number, signal?: AbortSignal, telemetry?: object }} [opts]
   * @returns {Promise<import('./model.js').Skill_Def[]>} 排序后的子集;失败时返回全量
   */
  async filter(userMessage, skills, { topK = 20, signal, telemetry = null } = {}) {
    try {
      const listing = skills.map(s => `- ${s.name}: ${s.description}`).join('\n')
      const systemPrompt = SYSTEM_PROMPT_TEMPLATE
        .replace('%TOPK%', String(topK))
        .replace('%SKILLS%', listing)

      const response = await this._syncChat({
        url: this.url,
        apiKey: this.apiKey,
        body: {
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
          temperature: 0,
        },
        signal,
        telemetry: { ctx: childContext(telemetry, 'agent.skill_filter') },
      })

      const text = response?.choices?.[0]?.message?.content ?? ''
      const start = text.indexOf('[')
      const end = text.lastIndexOf(']')
      if (start < 0 || end <= start) throw new Error('no JSON array in response')
      const names = JSON.parse(text.substring(start, end + 1))
      if (!Array.isArray(names)) throw new Error('response is not an array')

      const byName = new Map(skills.map(s => [s.name, s]))
      const picked = []
      for (const n of names) {
        if (picked.length >= topK) break
        const def = byName.get(n)
        if (def && !picked.includes(def)) picked.push(def)
      }
      if (picked.length === 0) throw new Error('no valid skill names in response')
      return picked
    } catch (e) {
      console.warn('[SkillFilter] Failed, returning all skills:', e.message)
      return skills
    }
  }
}
