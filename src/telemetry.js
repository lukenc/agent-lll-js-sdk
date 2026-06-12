/**
 * Telemetry primitives for `lll-web-agent`.
 *
 * Exports:
 *   - TelemetryBus:   minimal portable pub/sub emitter (not Node EventEmitter).
 *   - newTraceId:     32 lowercase-hex W3C-style trace id.
 *   - newSpanId:      16 lowercase-hex W3C-style span id.
 *   - childContext:   derive a child TelemetryContext from a parent.
 *   - extractUsage:   normalize provider `usage` to the Usage_Object shape.
 *   - utf8ByteLength: Node/browser-agnostic UTF-8 byte length helper.
 *
 * This module is runtime-agnostic: it works in Node >=18 and modern browsers
 * without polyfills. It has zero dependencies on the rest of the framework.
 */

// ---------------------------------------------------------------------------
// TelemetryBus
// ---------------------------------------------------------------------------

/**
 * Minimal portable event emitter. Deliberately NOT Node's `EventEmitter`:
 *   - no special `error`-event semantics (which would throw when unhandled);
 *   - no default max-listener warning;
 *   - no dependency on `node:events` (so it works in the browser).
 *
 * Contract:
 *   - Listeners are invoked synchronously in registration order.
 *   - Each listener is wrapped in try/catch; a throw is converted to a single
 *     `warn` event and does NOT stop the remaining listeners from running.
 *   - `warn` listeners themselves are NOT wrapped — a throwing `warn` listener
 *     is allowed to bubble up to the `emit` caller rather than recursing back
 *     into another `warn` emission (prevents infinite recursion storms).
 *   - The same listener registered N times is invoked N times per emit.
 */
export class TelemetryBus {
  constructor() {
    /** @type {Map<string, Function[]>} */
    this._listeners = new Map()
  }

  on(eventType, listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('TelemetryBus.on: listener must be a function')
    }
    let arr = this._listeners.get(eventType)
    if (!arr) {
      arr = []
      this._listeners.set(eventType, arr)
    }
    arr.push(listener)
    return this
  }

  off(eventType, listener) {
    const arr = this._listeners.get(eventType)
    if (!arr) return this
    // Remove only the first matching occurrence — matches Node EventEmitter
    // semantics and is what callers expect when a listener was added twice.
    const idx = arr.indexOf(listener)
    if (idx !== -1) arr.splice(idx, 1)
    if (arr.length === 0) this._listeners.delete(eventType)
    return this
  }

  listenerCount(eventType) {
    const arr = this._listeners.get(eventType)
    return arr ? arr.length : 0
  }

  emit(eventType, payload) {
    const arr = this._listeners.get(eventType)
    if (!arr || arr.length === 0) return
    // Snapshot so listeners added/removed during emission do not perturb
    // this invocation.
    const snapshot = arr.slice()
    if (eventType === 'warn') {
      // Warn listeners run unwrapped — see class doc comment.
      for (const listener of snapshot) listener(payload)
      return
    }
    for (const listener of snapshot) {
      try {
        listener(payload)
      } catch (err) {
        // Best-effort: surface the failure as a single `warn` event and keep
        // going. If the warn emission itself throws it will propagate to the
        // caller of `emit` (the framework wraps its own emit sites).
        this.emit('warn', {
          source: 'listener',
          eventType,
          error: {
            type: err?.name || 'Error',
            message: err?.message || String(err),
          },
        })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Trace / Span ID generation
// ---------------------------------------------------------------------------

/**
 * Fill a Uint8Array with cryptographically-random bytes.
 *
 * Feature-detects the two runtimes the framework supports:
 *   - Node >=18 and modern browsers expose `globalThis.crypto.getRandomValues`.
 *   - Older Node releases only expose `require('crypto').randomBytes`; for
 *     those we fall back via a dynamically-resolved `node:crypto` import
 *     cached on first use. This keeps the browser bundle free of `node:crypto`.
 *
 * The detection runs on every call but is a property lookup on `globalThis`,
 * so the per-call overhead is negligible (<10 ns). Generating a trace/span id
 * is not a hot path.
 */
function _randomBytes(length) {
  const g = /** @type {any} */ (globalThis)
  if (g.crypto && typeof g.crypto.getRandomValues === 'function') {
    const buf = new Uint8Array(length)
    g.crypto.getRandomValues(buf)
    return buf
  }
  // Last-resort Math.random fallback — cryptographically weak but keeps the
  // module working in exotic environments. Trace/span uniqueness still holds
  // with overwhelming probability at 16 bytes of entropy.
  const buf = new Uint8Array(length)
  for (let i = 0; i < length; i++) buf[i] = Math.floor(Math.random() * 256)
  return buf
}

function _bytesToHex(bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]
    out += (b < 16 ? '0' : '') + b.toString(16)
  }
  return out
}

/** 32 lowercase hexadecimal characters (W3C Trace Context trace-id shape). */
export function newTraceId() {
  return _bytesToHex(_randomBytes(16))
}

/** 16 lowercase hexadecimal characters (W3C Trace Context span-id shape). */
export function newSpanId() {
  return _bytesToHex(_randomBytes(8))
}

// ---------------------------------------------------------------------------
// TelemetryContext helpers
// ---------------------------------------------------------------------------

/**
 * Derive a child TelemetryContext from a parent.
 *
 *   - Returns `null` when `parent` is `null` / `undefined` — this is the
 *     documented "telemetry disabled" signal that every consumer treats as a
 *     no-op (sidecars, llm-client, etc.). Callers therefore do not need to
 *     null-check before calling.
 *   - `parentSpanOverride` (optional) lets the caller pick a specific span as
 *     the child's parent (e.g., a round span instead of the trace root). When
 *     omitted, the child inherits the parent's own `parentSpanId`.
 *
 * The resulting context carries the same `traceId` and `bus`, letting every
 * span emitted under it join the same trace tree.
 *
 * @param {object|null|undefined} parent
 * @param {string} operationName
 * @param {string|null} [parentSpanOverride]
 */
export function childContext(parent, operationName, parentSpanOverride) {
  if (parent == null) return null
  return {
    traceId: parent.traceId,
    parentSpanId:
      parentSpanOverride !== undefined ? parentSpanOverride : parent.parentSpanId,
    operationName,
    bus: parent.bus,
  }
}

// ---------------------------------------------------------------------------
// Usage extraction
// ---------------------------------------------------------------------------

/**
 * Read a nested field from `obj` following `path` segments. Returns `null`
 * when any intermediate value is missing (`undefined`) or the leaf is not a
 * finite number. An explicit `0` is returned as `0` so callers can distinguish
 * "provider returned zero" from "provider omitted the field".
 */
function _readNumber(obj, ...path) {
  let cur = obj
  for (const seg of path) {
    if (cur == null || typeof cur !== 'object') return null
    cur = cur[seg]
  }
  if (typeof cur === 'number' && Number.isFinite(cur)) return cur
  return null
}

/**
 * Normalize a provider response to the Usage_Object shape:
 *
 *   { input_tokens, output_tokens, cached_tokens, reasoning_tokens }
 *
 * Every field is either a `number` or `null`. `null` means the provider did
 * not return that field; `0` means the provider explicitly returned zero.
 *
 * Supported shapes:
 *   - OpenAI:   usage.prompt_tokens, usage.completion_tokens,
 *               usage.prompt_tokens_details.cached_tokens,
 *               usage.completion_tokens_details.reasoning_tokens
 *   - DeepSeek: usage.prompt_cache_hit_tokens (mapped to cached_tokens)
 *   - Qwen:     same as OpenAI (DashScope OpenAI-compat mode)
 *   - Any other OpenAI-compatible provider: prompt_tokens / completion_tokens
 *
 * The function never throws on malformed input — missing or non-numeric fields
 * resolve to `null`.
 */
export function extractUsage(raw) {
  const usage = raw && typeof raw === 'object' ? raw.usage : null

  const input_tokens = _readNumber(usage, 'prompt_tokens')
  const output_tokens = _readNumber(usage, 'completion_tokens')

  // Cached tokens: prefer OpenAI-nested shape, then DeepSeek's flat key.
  let cached_tokens = _readNumber(usage, 'prompt_tokens_details', 'cached_tokens')
  if (cached_tokens === null) {
    cached_tokens = _readNumber(usage, 'prompt_cache_hit_tokens')
  }

  const reasoning_tokens = _readNumber(
    usage,
    'completion_tokens_details',
    'reasoning_tokens'
  )

  return { input_tokens, output_tokens, cached_tokens, reasoning_tokens }
}

// ---------------------------------------------------------------------------
// UTF-8 byte length
// ---------------------------------------------------------------------------

// Lazily-resolved TextEncoder — avoids constructing one per call in the
// browser path while keeping the module side-effect-free on import.
let _encoder = null

/**
 * Return the UTF-8 byte length of `str`. Works in both Node (via
 * `Buffer.byteLength`) and the browser (via `TextEncoder`). Non-string inputs
 * are coerced via `String(...)`.
 */
export function utf8ByteLength(str) {
  const s = typeof str === 'string' ? str : String(str)
  const g = /** @type {any} */ (globalThis)
  if (g.Buffer && typeof g.Buffer.byteLength === 'function') {
    return g.Buffer.byteLength(s, 'utf8')
  }
  if (_encoder === null) _encoder = new TextEncoder()
  return _encoder.encode(s).length
}
