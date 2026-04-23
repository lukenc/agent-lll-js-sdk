/**
 * LLM 通信层 — SSE 流式请求 + 工具调用增量拼接
 * 对应 Java 框架的 LlmClient + SseStreamProcessor + StreamingFcCollector
 */

/**
 * 发送 SSE 流式请求，返回完整的非流式等价响应 JSON
 * @param {object} opts
 * @param {string} opts.url - API endpoint
 * @param {string} opts.apiKey - Bearer token
 * @param {object} opts.body - 请求体（含 messages, model, tools 等）
 * @param {AbortSignal} [opts.signal] - 取消信号
 * @param {function} [opts.onDelta] - 文本增量回调 (delta: string) => void
 * @param {function} [opts.onReasoning] - 思考过程增量回调
 * @param {function} [opts.onToolCall] - 工具调用增量回调 (index, toolCall) => void
 * @returns {Promise<object>} 重构后的非流式响应 JSON
 */
export async function streamChat({ url, apiKey, body, signal, onDelta, onReasoning, onToolCall }) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  })

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '')
    throw new LlmApiError(response.status, errorBody)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  // StreamingFcCollector 等价物
  const collected = { content: '', reasoning: '', toolCalls: new Map() }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() // 保留不完整的最后一行

    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]' || !data) continue

      try {
        const json = JSON.parse(data)
        processSSEChunk(json, collected, { onDelta, onReasoning, onToolCall })
      } catch { /* 忽略解析失败的行 */ }
    }
  }

  return reconstructResponse(collected)
}

/**
 * 同步请求（非流式）
 */
export async function syncChat({ url, apiKey, body, signal }) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ ...body, stream: false }),
    signal,
  })

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '')
    throw new LlmApiError(response.status, errorBody)
  }

  return response.json()
}

/** 处理单个 SSE chunk — 对应 SseStreamProcessor.processOpenAiLine */
function processSSEChunk(json, collected, callbacks) {
  const delta = json.choices?.[0]?.delta
  if (!delta) return

  if (delta.reasoning_content) {
    collected.reasoning += delta.reasoning_content
    callbacks.onReasoning?.(delta.reasoning_content)
  }

  if (delta.content) {
    collected.content += delta.content
    callbacks.onDelta?.(delta.content)
  }

  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0
      if (!collected.toolCalls.has(idx)) {
        collected.toolCalls.set(idx, { id: '', type: 'function', name: '', arguments: '' })
      }
      const acc = collected.toolCalls.get(idx)
      if (tc.id) acc.id = tc.id
      if (tc.type) acc.type = tc.type
      if (tc.function?.name) acc.name = tc.function.name
      if (tc.function?.arguments) acc.arguments += tc.function.arguments
      callbacks.onToolCall?.(idx, acc)
    }
  }
}

/** 重构为非流式等价响应 — 对应 StreamingFcCollector.reconstructResponse */
function reconstructResponse(collected) {
  const message = {}
  if (collected.content) message.content = collected.content
  if (collected.reasoning) message.reasoning_content = collected.reasoning
  if (collected.toolCalls.size > 0) {
    message.tool_calls = [...collected.toolCalls.values()].map(tc => ({
      id: tc.id,
      type: tc.type,
      function: { name: tc.name, arguments: tc.arguments },
    }))
  }
  return { choices: [{ message }] }
}

export class LlmApiError extends Error {
  constructor(status, body) {
    super(`LLM API error ${status}: ${body.slice(0, 200)}`)
    this.status = status
    this.body = body
  }
}
