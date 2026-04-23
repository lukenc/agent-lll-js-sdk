/**
 * 供应商适配 — 对应 Java 框架的 LlmProviderAdapterRegistry
 * 处理不同供应商的 API URL 差异
 */

const PROVIDERS = {
  openai: {
    url: 'https://api.openai.com/v1/chat/completions',
  },
  deepseek: {
    url: 'https://api.deepseek.com/chat/completions',
  },
  anthropic: {
    url: 'https://api.anthropic.com/v1/messages',
    // Anthropic 使用不同的认证头和消息格式，暂不在 MVP 中支持
    // 后续版本添加 AnthropicProtocolAdapter
  },
  qwen: {
    url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
  },
  'x-grok': {
    url: 'https://api.x.ai/v1/chat/completions',
  },
  moonshot: {
    url: 'https://api.moonshot.cn/v1/chat/completions',
  },
  zhipu: {
    url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  },
}

/**
 * 解析供应商配置，返回 API URL
 * @param {string} provider - 供应商名称（不区分大小写）
 * @param {string} [customUrl] - 自定义 URL（优先级最高）
 * @returns {string} API URL
 */
export function resolveProviderUrl(provider, customUrl) {
  if (customUrl) return customUrl
  const key = provider.toLowerCase()
  const config = PROVIDERS[key]
  if (!config) {
    // 未知供应商，假设是 OpenAI 兼容格式，用户必须提供 url
    throw new Error(
      `Unknown provider "${provider}". Either use a known provider (${Object.keys(PROVIDERS).join(', ')}) or provide a custom url.`
    )
  }
  return config.url
}

/** 注册自定义供应商 */
export function registerProvider(name, config) {
  PROVIDERS[name.toLowerCase()] = config
}
