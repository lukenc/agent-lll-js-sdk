/**
 * 模型别名解析。
 *
 * `agent` 工具的 `model` 入参形状恒为 `{ type: 'string', enum: [...] }`（对齐
 * 参考实现），但 enum 内容由主机配置的别名表生成 —— 本 SDK 是多供应商的，
 * 写死 Claude 型号对 DeepSeek / Qwen 用户毫无意义。
 *
 * 默认两个别名：
 *   fast → Agent 的 simpleModel / simpleApiKey / simpleUrl（既有 sidecar 三件套）
 *   main → Agent 的 model / apiKey / url
 */
import { AgentTypeError } from './errors.js'

/**
 * @param {{ model: string, apiKey: string, url: string,
 *           simpleModel: string, simpleApiKey: string, simpleUrl: string }} parent
 * @param {Record<string, { model?: string, apiKey?: string, url?: string }>|undefined} configured
 * @returns {Record<string, { model: string, apiKey: string, url: string }>}
 */
export function resolveModelAliases(parent, configured) {
  if (!configured || Object.keys(configured).length === 0) {
    return {
      fast: { model: parent.simpleModel, apiKey: parent.simpleApiKey, url: parent.simpleUrl },
      main: { model: parent.model, apiKey: parent.apiKey, url: parent.url },
    }
  }
  /** @type {Record<string, { model: string, apiKey: string, url: string }>} */
  const out = {}
  for (const [alias, spec] of Object.entries(configured)) {
    out[alias] = {
      model: spec?.model ?? parent.model,
      apiKey: spec?.apiKey ?? parent.apiKey,
      url: spec?.url ?? parent.url,
    }
  }
  return out
}

/** 别名键数组，用于 `agent` / `graph_start` 工具 schema 的 enum。不含任何凭据。 */
export function modelEnum(aliases) {
  return Object.keys(aliases)
}

/**
 * 优先级：调用入参 `model` > `Agent_Type.model` > 继承父模型。
 * @returns {{ alias: string|null, model: string, apiKey: string, url: string }}
 */
export function resolveModel({ requested, type, aliases, parent }) {
  const alias = requested ?? type?.model ?? null
  if (alias == null) {
    return { alias: null, model: parent.model, apiKey: parent.apiKey, url: parent.url }
  }
  const spec = aliases[alias]
  if (!spec) {
    throw new AgentTypeError(
      `unknown model alias "${alias}". Available: ${modelEnum(aliases).join(', ')}`,
    )
  }
  return { alias, model: spec.model, apiKey: spec.apiKey, url: spec.url }
}
