/**
 * LLM 通信层 — SSE 流式请求 + 工具调用增量拼接
 * 对应 Java 框架的 LlmClient + SseStreamProcessor + StreamingFcCollector
 *
 * 架构：streamChatIter（async generator）是流式原语，持有 reader 并逐 chunk yield。
 * streamChat 是对它的便捷包装，收集所有事件后返回完整响应。
 */

import { newSpanId, extractUsage } from './telemetry.js'

// ---------------------------------------------------------------------------
// Internal helpers — provider reverse-lookup + llm.call event construction.
//
// Scope constraint (tasks.md 2.1): we may not modify providers.js, so the
// URL → system mapping lives inline here and mirrors the static table in
// providers.js. Custom providers registered via `registerProvider` will
// fall through to `'unknown'`; that is acceptable default behavior and the
// caller can map it themselves if needed.
// ---------------------------------------------------------------------------

function _providerFromUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return 'unknown'
  const u = url.toLowerCase()
  if (u.includes('api.openai.com')) return 'openai'
  if (u.includes('api.deepseek.com')) return 'deepseek'
  if (u.includes('api.anthropic.com')) return 'anthropic'
  if (u.includes('dashscope.aliyuncs.com')) return 'qwen'
  if (u.includes('api.x.ai')) return 'x-grok'
  if (u.includes('api.moonshot.cn')) return 'moonshot'
  if (u.includes('open.bigmodel.cn')) return 'zhipu'
  return 'unknown'
}

function _classifyError(err) {
  if (err instanceof LlmApiError) return 'api_error'
  if (err && err.name === 'AbortError') return 'aborted'
  return 'exception'
}

/** Build an OTel GenAI-shaped `llm.call` payload. */
function _buildLlmCallPayload({
  ctx,
  spanId,
  url,
  body,
  durationMs,
  responseModel,
  finishReasons,
  usage,
  ok,
  error,
}) {
  const u = usage ?? {
    input_tokens: null,
    output_tokens: null,
    cached_tokens: null,
    reasoning_tokens: null,
  }
  const payload = {
    'gen_ai.system': _providerFromUrl(url),
    'gen_ai.request.model': body?.model ?? null,
    'gen_ai.response.model': responseModel ?? null,
    'gen_ai.response.finish_reasons': finishReasons ?? [],
    'gen_ai.usage.input_tokens': u.input_tokens,
    'gen_ai.usage.output_tokens': u.output_tokens,
    'gen_ai.usage.cached_tokens': u.cached_tokens,
    'gen_ai.usage.reasoning_tokens': u.reasoning_tokens,
    'gen_ai.client.operation.duration': durationMs,
    'gen_ai.operation.name': ctx.operationName,
    ok,
    traceId: ctx.traceId,
    spanId,
    parentSpanId: ctx.parentSpanId ?? null,
  }
  if (!ok) payload.error = error
  return payload
}

/**
 * 流式异步生成器 — 逐 chunk yield 事件，真正实现流式推送。
 * 持有底层 reader，通过 try/finally 保证取消或异常时释放资源。
 *
 * @param {object} opts
 * @param {string} opts.url - API endpoint
 * @param {string} opts.apiKey - Bearer token
 * @param {object} opts.body - 请求体（含 messages, model, tools 等）
 * @param {AbortSignal} [opts.signal] - 取消信号
 * @param {{ ctx: object|null, onLlmSpanStart?: (spanId: string) => void }} [opts.telemetry]
 *   - When `telemetry.ctx` is falsy, no bus events or span callbacks fire.
 *   - When present, one `llm.call` event is emitted on success/failure, and
 *     `onLlmSpanStart(spanId)` is invoked right before HTTP dispatch so the
 *     caller (Agent) can wire child tool-call spans to this call.
 * @param {boolean} [opts.validateCompletion=true] - 是否要求流以非空
 *   finish_reason 收尾（否则抛 LlmStreamIncompleteError）。零 chunk 流恒为
 *   错误，不受此开关影响。设 false 恢复旧的宽容行为，用于合法不发
 *   finish_reason 的 provider。
 * @yields {{ type: 'delta'|'reasoning'|'tool_call'|'usage'|'done', ... }}
 *   - { type: 'delta', content: string }
 *   - { type: 'reasoning', content: string }
 *   - { type: 'tool_call', index: number, toolCall: object }
 *   - { type: 'usage', usage: Usage_Object } — emitted at most once per stream
 *   - { type: 'done', response: object } — 最终重构的非流式等价响应（含 usage）
 */
export async function* streamChatIter({ url, apiKey, body, signal, telemetry, validateCompletion = true }) {
  const ctx = telemetry?.ctx || null
  // Stopwatch + span id are only meaningful when ctx is present. Keep the
  // zero-telemetry path free of observable side effects.
  const startPerfNow = ctx ? performance.now() : 0
  let spanId = null
  if (ctx) {
    spanId = newSpanId()
    telemetry.onLlmSpanStart?.(spanId)
  }

  const collected = {
    content: '',
    reasoning: '',
    toolCalls: new Map(),
    finishReason: null,
    usage: null,
    responseModel: null,
  }
  let usageYielded = false
  let parsedChunkCount = 0

  try {
    // 只对初始连接重试，流开始后不重试（已经 yield 了部分数据）
    const response = await withRetry(async () => {
      // 强制开启 stream_options.include_usage，让 OpenAI 兼容流式接口（OpenAI /
      // DeepSeek / Qwen-dashscope / Moonshot / Zhipu / x-grok）在 [DONE] 前
      // 多吐一帧带 `usage` 的 chunk。调用方已传入 stream_options 时尊重其设置，
      // 仅补齐缺失的 include_usage 字段，避免覆盖 include_reasoning 等同级选项。
      const streamOpts = { ...(body.stream_options || {}) }
      if (streamOpts.include_usage == null) streamOpts.include_usage = true
      const mergedBody = { ...body, stream: true, stream_options: streamOpts }
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(mergedBody),
        signal,
      })

      if (!resp.ok) {
        const errorBody = await resp.text().catch(() => '')
        throw new LlmApiError(resp.status, errorBody, Object.fromEntries(resp.headers.entries()))
      }

      return resp
    }, { signal })

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop()

        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '[DONE]' || !data) continue

          let json
          try { json = JSON.parse(data) } catch { continue }
          parsedChunkCount++

          // Capture the response model from the first chunk that carries it
          // (some providers include it on every chunk; we only need it once).
          if (collected.responseModel == null && typeof json.model === 'string') {
            collected.responseModel = json.model
          }

          // Detect provider-emitted usage chunks — must run before the
          // `delta` gate below because OpenAI-compat providers often ship
          // usage on a final chunk with empty choices/no delta.
          if (json.usage && !usageYielded) {
            const u = extractUsage(json)
            collected.usage = u
            usageYielded = true
            yield { type: 'usage', usage: u }
          }

          const choice = json.choices?.[0]
          if (choice?.finish_reason) collected.finishReason = choice.finish_reason

          const delta = choice?.delta
          if (!delta) continue

          if (delta.reasoning_content) {
            collected.reasoning += delta.reasoning_content
            yield { type: 'reasoning', content: delta.reasoning_content }
          }

          if (delta.content) {
            collected.content += delta.content
            yield { type: 'delta', content: delta.content }
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
              yield { type: 'tool_call', index: idx, toolCall: { ...acc } }
            }
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    // 语义层完整性校验（对齐 openai-node finalizeChatCompletion / Anthropic
    // message_stop 检测）：OpenAI 兼容流正常完成时，最后一个内容 chunk 的
    // finish_reason 必非空。传输层无法区分"干净的提前断开"和正常结束，
    // 只能在这里判。零 chunk 恒为错误，不受开关控制。
    if (parsedChunkCount === 0) {
      throw new LlmStreamIncompleteError({ chunkCount: 0, partialContentLength: 0 })
    }
    if (validateCompletion && collected.finishReason == null) {
      throw new LlmStreamIncompleteError({
        chunkCount: parsedChunkCount,
        partialContentLength: collected.content.length,
      })
    }

    // Success path — emit `llm.call` right before the terminal `done` yield
    // so the span appears in the trace in the expected order.
    if (ctx) {
      const durationMs = performance.now() - startPerfNow
      const finishReasons = collected.finishReason != null ? [collected.finishReason] : []
      ctx.bus.emit(
        'llm.call',
        _buildLlmCallPayload({
          ctx,
          spanId,
          url,
          body,
          durationMs,
          responseModel: collected.responseModel,
          finishReasons,
          usage: collected.usage,
          ok: true,
        })
      )
    }

    yield { type: 'done', response: reconstructResponse(collected) }
  } catch (err) {
    if (ctx) {
      const durationMs = performance.now() - startPerfNow
      const finishReasons = collected.finishReason != null ? [collected.finishReason] : []
      ctx.bus.emit(
        'llm.call',
        _buildLlmCallPayload({
          ctx,
          spanId,
          url,
          body,
          durationMs,
          responseModel: collected.responseModel,
          finishReasons,
          // Usage may still be populated if a usage chunk arrived before the
          // failure (unlikely but possible); otherwise nulls.
          usage: collected.usage,
          ok: false,
          error: {
            type: _classifyError(err),
            message: err?.message || String(err),
          },
        })
      )
    }
    throw err
  }
}

/**
 * 发送 SSE 流式请求，返回完整的非流式等价响应 JSON。
 * 基于 streamChatIter 实现，收集所有事件后返回。
 *
 * @param {object} opts
 * @param {string} opts.url - API endpoint
 * @param {string} opts.apiKey - Bearer token
 * @param {object} opts.body - 请求体（含 messages, model, tools 等）
 * @param {AbortSignal} [opts.signal] - 取消信号
 * @param {object} [opts.telemetry] - See `streamChatIter`.
 * @param {boolean} [opts.validateCompletion=true] - See `streamChatIter`.
 * @param {function} [opts.onDelta] - 文本增量回调 (delta: string) => void
 * @param {function} [opts.onReasoning] - 思考过程增量回调
 * @param {function} [opts.onToolCall] - 工具调用增量回调 (index, toolCall) => void
 * @returns {Promise<object>} 重构后的非流式响应 JSON
 */
export async function streamChat({ url, apiKey, body, signal, telemetry, validateCompletion, onDelta, onReasoning, onToolCall }) {
  let response = null
  for await (const event of streamChatIter({ url, apiKey, body, signal, telemetry, validateCompletion })) {
    switch (event.type) {
      case 'delta': onDelta?.(event.content); break
      case 'reasoning': onReasoning?.(event.content); break
      case 'tool_call': onToolCall?.(event.index, event.toolCall); break
      case 'done': response = event.response; break
      // 'usage' events are silently consumed here — callers that need the
      // Usage_Object should either use `streamChatIter` directly or read the
      // `usage` field on the returned response object.
    }
  }
  return response ?? { choices: [{ message: {} }] }
}

/**
 * 同步请求（非流式）
 *
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} opts.apiKey
 * @param {object} opts.body
 * @param {AbortSignal} [opts.signal]
 * @param {{ ctx: object|null, onLlmSpanStart?: (spanId: string) => void }} [opts.telemetry]
 *   Same shape and semantics as `streamChatIter`. When `telemetry.ctx` is
 *   falsy, this function is byte-for-byte equivalent to the pre-telemetry
 *   implementation.
 */
export async function syncChat({ url, apiKey, body, signal, telemetry }) {
  const ctx = telemetry?.ctx || null

  // Fast path — zero telemetry overhead and identical observable behavior to
  // the original implementation. Guarded explicitly so the emit-and-rethrow
  // wrapper below does not run.
  if (!ctx) {
    return withRetry(async () => {
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
        throw new LlmApiError(response.status, errorBody, Object.fromEntries(response.headers.entries()))
      }

      return response.json()
    }, { signal })
  }

  const spanId = newSpanId()
  telemetry.onLlmSpanStart?.(spanId)
  const startPerfNow = performance.now()

  try {
    const raw = await withRetry(async () => {
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
        throw new LlmApiError(response.status, errorBody, Object.fromEntries(response.headers.entries()))
      }

      return response.json()
    }, { signal })

    const durationMs = performance.now() - startPerfNow
    const usage = extractUsage(raw)
    const finishReasons = (raw?.choices ?? [])
      .map(c => c?.finish_reason)
      .filter(r => typeof r === 'string')

    ctx.bus.emit(
      'llm.call',
      _buildLlmCallPayload({
        ctx,
        spanId,
        url,
        body,
        durationMs,
        responseModel: raw?.model ?? null,
        finishReasons,
        usage,
        ok: true,
      })
    )

    return raw
  } catch (err) {
    const durationMs = performance.now() - startPerfNow
    ctx.bus.emit(
      'llm.call',
      _buildLlmCallPayload({
        ctx,
        spanId,
        url,
        body,
        durationMs,
        responseModel: null,
        finishReasons: [],
        usage: null,
        ok: false,
        error: {
          type: _classifyError(err),
          message: err?.message || String(err),
        },
      })
    )
    throw err
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
  // Always include `usage` on the reconstructed response (Requirement 7.4).
  // When no provider usage chunk arrived, every sub-field is `null`.
  const usage = collected.usage ?? {
    input_tokens: null,
    output_tokens: null,
    cached_tokens: null,
    reasoning_tokens: null,
  }
  return {
    choices: [{
      message,
      finish_reason: collected.finishReason ?? null,
    }],
    usage,
  }
}

export class LlmApiError extends Error {
  constructor(status, body, headers = null) {
    super(`LLM API error ${status}: ${body.slice(0, 200)}`)
    this.status = status
    this.body = body
    /** 小写键的响应头普通对象（Headers.entries() 产物），或 null。 */
    this.headers = headers
  }
}

export class LlmStreamIncompleteError extends Error {
  constructor({ chunkCount, partialContentLength }) {
    super(
      chunkCount === 0
        ? 'LLM stream ended without sending any chunks'
        : `LLM stream ended prematurely: no finish_reason received after ${chunkCount} chunk(s), ` +
          `${partialContentLength} char(s) of partial content. The connection was likely cut by ` +
          'the server or a proxy — retry the request. If your provider legitimately omits ' +
          'finish_reason, pass { validateStreamCompletion: false } to the Agent (or ' +
          'validateCompletion: false to streamChatIter).',
    )
    // Finding M-9: `.name` is a cross-package contract — app code
    // (e.g. edu-desktop-app's agent-handlers.ts) matches on
    // `err.name === 'LlmStreamIncompleteError'` rather than `instanceof`,
    // because symlinked/monorepo installs of this package can produce dual
    // class identities (two copies of this module, so `instanceof` fails
    // across the package boundary) while `.name` survives. Do not rename
    // this string without checking downstream consumers.
    this.name = 'LlmStreamIncompleteError'
    this.chunkCount = chunkCount
    this.partialContentLength = partialContentLength
  }
}

const RETRY_BACKOFF_CAP_MS = 8_000
const RETRY_AFTER_CAP_MS = 60_000

/**
 * 是否可安全重试 — 对齐 openai-node / anthropic-sdk 共同策略：
 * 408/409/429/5xx 与网络层错误（undici 的 TypeError: fetch failed）重试；
 * 4xx 其余、Abort、以及流开始后的截断（LlmStreamIncompleteError —
 * 部分数据已交付消费方，重放不安全）不重试。
 *
 * TypeError 单独判定时收窄到"网络形状"的 TypeError：undici 在网络层失败
 * （连接被拒绝/DNS 失败/连接中途终止等）时抛的 TypeError 消息含
 * 'fetch failed' / 'terminated'，且通常挂有 `.cause`（底层 errno/socket
 * 错误）。不收窄会把调用方闭包里任意确定性的程序员错误（例如对 BigInt
 * 调用 JSON.stringify 抛出的 TypeError）也当成"网络抖动"重试三次，把瞬时
 * 失败拖成 ~7s 的无意义退避。
 */
export function isRetryableError(err) {
  if (err?.name === 'AbortError') return false
  if (err instanceof LlmStreamIncompleteError) return false
  if (err instanceof LlmApiError) {
    return err.status === 408 || err.status === 409 || err.status === 429 || err.status >= 500
  }
  return (
    err instanceof TypeError &&
    (err.message.includes('fetch failed') || err.message.includes('terminated') || err.cause != null)
  )
}

/**
 * 单次重试等待毫秒数。服务端 retry-after-ms（毫秒，优先）/ retry-after
 * （秒或 HTTP 日期）优先并钳制到 60s；否则 min(base·2^attempt, 8s) 乘
 * [0.75, 1.0] 的减法抖动（Stainless 公式）。
 */
export function computeRetryDelayMs(err, attempt, baseDelayMs = 500) {
  const hinted = retryAfterMs(err instanceof LlmApiError ? err.headers : null)
  if (hinted != null) return Math.min(hinted, RETRY_AFTER_CAP_MS)
  const nominal = Math.min(baseDelayMs * Math.pow(2, attempt), RETRY_BACKOFF_CAP_MS)
  return nominal * (1 - 0.25 * Math.random())
}

function retryAfterMs(headers) {
  if (!headers) return null
  const ms = parseFloat(headers['retry-after-ms'])
  if (Number.isFinite(ms) && ms >= 0) return ms
  const raw = headers['retry-after']
  if (raw == null) return null
  const secs = parseFloat(raw)
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000
  const untilMs = Date.parse(raw) - Date.now()
  return Number.isFinite(untilMs) && untilMs >= 0 ? untilMs : null
}

/**
 * 指数退避重试 — 对齐 openai-node / anthropic-sdk 的可重试错误集合与退避公式。
 * @param {() => Promise<T>} fn - 要重试的异步函数
 * @param {object} [opts]
 * @param {number} [opts.maxRetries=3] - 最大重试次数
 * @param {number} [opts.baseDelayMs=500] - 基础延迟（毫秒）
 * @param {AbortSignal} [opts.signal] - 取消信号
 * @returns {Promise<T>}
 */
export async function withRetry(fn, { maxRetries = 3, baseDelayMs = 500, signal } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (!isRetryableError(err) || attempt >= maxRetries) throw err
      signal?.throwIfAborted()
      await new Promise(r => setTimeout(r, computeRetryDelayMs(err, attempt, baseDelayMs)))
    }
  }
}
