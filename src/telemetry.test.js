/**
 * Unit tests for `src/telemetry.js` telemetry primitives.
 *
 * Scope: Task 1.2 of the observability-telemetry spec.
 *   - TelemetryBus semantics (on / off / emit / listenerCount).
 *   - Listener-throw isolation + `warn` emission + non-recursive warn path.
 *   - newTraceId / newSpanId format + uniqueness.
 *   - extractUsage across OpenAI, DeepSeek, Qwen shapes and edge cases.
 *   - utf8ByteLength across ASCII, multi-byte UTF-8, and empty string.
 *
 * Validates: Requirements 1.3, 1.4, 1.5, 1.6, 1.7, 4.1, 4.8, 10.3
 *
 * Testing framework: node:test + node:assert/strict (project convention).
 * Style: example-based (per design — no property-based tests in this feature).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  TelemetryBus,
  newTraceId,
  newSpanId,
  childContext,
  extractUsage,
  utf8ByteLength,
} from './telemetry.js'

// ---------------------------------------------------------------------------
// TelemetryBus — listener semantics
// ---------------------------------------------------------------------------

describe('TelemetryBus: listener registration and dispatch', () => {
  it('invokes listeners in registration order (Req 1.3)', () => {
    const bus = new TelemetryBus()
    const calls = []
    bus.on('evt', () => calls.push('a'))
    bus.on('evt', () => calls.push('b'))
    bus.on('evt', () => calls.push('c'))

    bus.emit('evt', { n: 1 })

    assert.deepStrictEqual(calls, ['a', 'b', 'c'])
  })

  it('passes the emitted payload to each listener (Req 1.3)', () => {
    const bus = new TelemetryBus()
    const received = []
    bus.on('evt', payload => received.push(payload))
    bus.on('evt', payload => received.push(payload))

    const payload = { foo: 'bar', n: 42 }
    bus.emit('evt', payload)

    assert.strictEqual(received.length, 2)
    assert.strictEqual(received[0], payload)
    assert.strictEqual(received[1], payload)
  })

  it('off() removes a previously registered listener (Req 1.3)', () => {
    const bus = new TelemetryBus()
    const calls = []
    const listenerA = () => calls.push('a')
    const listenerB = () => calls.push('b')
    bus.on('evt', listenerA)
    bus.on('evt', listenerB)

    bus.off('evt', listenerA)
    bus.emit('evt', null)

    assert.deepStrictEqual(calls, ['b'])
  })

  it('off() is a no-op for an unknown listener or event type', () => {
    const bus = new TelemetryBus()
    const calls = []
    bus.on('evt', () => calls.push('a'))

    // Neither call should throw.
    bus.off('evt', () => {})
    bus.off('missing', () => {})

    bus.emit('evt', null)
    assert.deepStrictEqual(calls, ['a'])
  })

  it('supports multiple independent listeners per event type (Req 1.5)', () => {
    const bus = new TelemetryBus()
    const calls = []
    for (let i = 0; i < 5; i++) {
      bus.on('evt', () => calls.push(i))
    }

    bus.emit('evt', null)
    assert.deepStrictEqual(calls, [0, 1, 2, 3, 4])
    assert.strictEqual(bus.listenerCount('evt'), 5)
  })

  it('invokes the same listener twice when registered twice (Req 1.7)', () => {
    const bus = new TelemetryBus()
    let count = 0
    const listener = () => { count++ }
    bus.on('evt', listener)
    bus.on('evt', listener)

    bus.emit('evt', null)

    assert.strictEqual(count, 2)
    assert.strictEqual(bus.listenerCount('evt'), 2)
  })

  it('off() removes only the first matching occurrence when listener is duplicated', () => {
    const bus = new TelemetryBus()
    let count = 0
    const listener = () => { count++ }
    bus.on('evt', listener)
    bus.on('evt', listener)

    bus.off('evt', listener)
    bus.emit('evt', null)

    assert.strictEqual(count, 1, 'remaining duplicate should still fire')
    assert.strictEqual(bus.listenerCount('evt'), 1)
  })

  it('never invokes a listener registered for a different event type (Req 1.6)', () => {
    const bus = new TelemetryBus()
    const aCalls = []
    const bCalls = []
    bus.on('a', () => aCalls.push(1))
    bus.on('b', () => bCalls.push(1))

    bus.emit('a', null)
    bus.emit('a', null)

    assert.strictEqual(aCalls.length, 2)
    assert.strictEqual(bCalls.length, 0)
  })

  it('emit on an event with no listeners is a silent no-op', () => {
    const bus = new TelemetryBus()
    // Must not throw.
    bus.emit('nobody-home', { foo: 'bar' })
    assert.strictEqual(bus.listenerCount('nobody-home'), 0)
  })

  it('on() throws TypeError when listener is not a function', () => {
    const bus = new TelemetryBus()
    assert.throws(() => bus.on('evt', 'not-a-fn'), TypeError)
    assert.throws(() => bus.on('evt', null), TypeError)
    assert.throws(() => bus.on('evt', undefined), TypeError)
  })

  it('on() / off() are chainable', () => {
    const bus = new TelemetryBus()
    const l = () => {}
    assert.strictEqual(bus.on('evt', l), bus)
    assert.strictEqual(bus.off('evt', l), bus)
  })

  it('listeners added during emit do not fire for the in-flight emission', () => {
    const bus = new TelemetryBus()
    const calls = []
    bus.on('evt', () => {
      calls.push('first')
      bus.on('evt', () => calls.push('added-during-emit'))
    })
    bus.on('evt', () => calls.push('second'))

    bus.emit('evt', null)
    assert.deepStrictEqual(calls, ['first', 'second'])

    // The newly added listener fires on the next emit.
    bus.emit('evt', null)
    // first + added-during-emit + second + second-emit's own newly-added...
    // We only care that 'added-during-emit' now fires at least once.
    assert.ok(calls.includes('added-during-emit'))
  })
})

// ---------------------------------------------------------------------------
// TelemetryBus — listener error isolation
// ---------------------------------------------------------------------------

describe('TelemetryBus: listener error isolation (Req 1.4)', () => {
  it('listener throw does not stop subsequent listeners', () => {
    const bus = new TelemetryBus()
    const calls = []
    // Silence the warn channel so we do not crash the test when the bus
    // reports the failure.
    bus.on('warn', () => {})
    bus.on('evt', () => calls.push('a'))
    bus.on('evt', () => { throw new Error('boom') })
    bus.on('evt', () => calls.push('c'))

    bus.emit('evt', null)
    assert.deepStrictEqual(calls, ['a', 'c'])
  })

  it('listener throw emits a single `warn` event with failure metadata', () => {
    const bus = new TelemetryBus()
    const warnings = []
    bus.on('warn', w => warnings.push(w))
    bus.on('evt', () => { throw new TypeError('bad arg') })

    bus.emit('evt', { p: 1 })

    assert.strictEqual(warnings.length, 1)
    const w = warnings[0]
    assert.strictEqual(w.source, 'listener')
    assert.strictEqual(w.eventType, 'evt')
    assert.strictEqual(w.error.type, 'TypeError')
    assert.strictEqual(w.error.message, 'bad arg')
  })

  it('emits exactly one `warn` per failing listener, not per emit', () => {
    const bus = new TelemetryBus()
    const warnings = []
    bus.on('warn', w => warnings.push(w))
    bus.on('evt', () => { throw new Error('one') })
    bus.on('evt', () => {}) // succeeds
    bus.on('evt', () => { throw new Error('two') })

    bus.emit('evt', null)

    assert.strictEqual(warnings.length, 2)
    assert.deepStrictEqual(
      warnings.map(w => w.error.message),
      ['one', 'two']
    )
  })

  it('a throwing `warn` listener does not recurse back into warn emission', () => {
    const bus = new TelemetryBus()
    // A warn listener that itself throws must not cause another warn to be
    // emitted (which would otherwise recurse forever). Per the implementation
    // contract, warn listeners are invoked UNWRAPPED — the throw therefore
    // escapes to the caller of `emit('warn')`. The framework's usage always
    // goes through `bus.emit('listener-event', ...)`, so the bus will try to
    // emit('warn', ...) from inside the try/catch around the listener-event.
    //
    // We simulate that by invoking emit('evt', ...) where the evt listener
    // throws — bus then emit('warn', ...) — the sole warn listener throws.
    // That second throw must propagate out of emit('evt'), NOT cause another
    // warn to be emitted.

    let warnInvocations = 0
    bus.on('warn', () => {
      warnInvocations++
      throw new Error('warn-listener-failed')
    })
    bus.on('evt', () => { throw new Error('listener-failed') })

    // The outer emit should ultimately throw the warn listener's error,
    // because warn listeners are unwrapped. The critical invariant is that
    // `warn` fires exactly once (no recursion).
    assert.throws(
      () => bus.emit('evt', null),
      /warn-listener-failed/
    )
    assert.strictEqual(
      warnInvocations,
      1,
      'warn listener must fire exactly once; no recursive warn emission'
    )
  })

  it('after a throwing listener the bus remains usable for subsequent emissions', () => {
    const bus = new TelemetryBus()
    const calls = []
    bus.on('warn', () => {})
    bus.on('evt', () => { throw new Error('boom') })
    bus.on('evt', () => calls.push('ok'))

    bus.emit('evt', null)
    bus.emit('evt', null)
    bus.emit('evt', null)

    assert.deepStrictEqual(calls, ['ok', 'ok', 'ok'])
  })
})

// ---------------------------------------------------------------------------
// Trace / Span ID generation
// ---------------------------------------------------------------------------

describe('newTraceId / newSpanId: format (Req 4.1, 4.8)', () => {
  it('newTraceId returns exactly 32 lowercase hex characters', () => {
    for (let i = 0; i < 20; i++) {
      const id = newTraceId()
      assert.strictEqual(typeof id, 'string')
      assert.strictEqual(id.length, 32, `expected 32 chars, got ${id.length}: ${id}`)
      assert.match(id, /^[0-9a-f]{32}$/, `expected lowercase hex, got ${id}`)
    }
  })

  it('newSpanId returns exactly 16 lowercase hex characters', () => {
    for (let i = 0; i < 20; i++) {
      const id = newSpanId()
      assert.strictEqual(typeof id, 'string')
      assert.strictEqual(id.length, 16, `expected 16 chars, got ${id.length}: ${id}`)
      assert.match(id, /^[0-9a-f]{16}$/, `expected lowercase hex, got ${id}`)
    }
  })

  it('newTraceId generates unique values across 1000 calls', () => {
    const seen = new Set()
    for (let i = 0; i < 1000; i++) seen.add(newTraceId())
    assert.strictEqual(seen.size, 1000, 'expected 1000 distinct trace ids')
  })

  it('newSpanId generates unique values across 1000 calls', () => {
    const seen = new Set()
    for (let i = 0; i < 1000; i++) seen.add(newSpanId())
    assert.strictEqual(seen.size, 1000, 'expected 1000 distinct span ids')
  })
})

// ---------------------------------------------------------------------------
// childContext (spot-check — not in task 1.2 but complements the bus tests)
// ---------------------------------------------------------------------------

describe('childContext: null propagation', () => {
  it('returns null for null / undefined parent (telemetry-disabled)', () => {
    assert.strictEqual(childContext(null, 'agent.chat'), null)
    assert.strictEqual(childContext(undefined, 'agent.chat'), null)
  })

  it('inherits traceId and bus; applies new operationName', () => {
    const bus = new TelemetryBus()
    const parent = {
      traceId: 'a'.repeat(32),
      parentSpanId: 'b'.repeat(16),
      operationName: 'agent.chat',
      bus,
    }
    const child = childContext(parent, 'agent.summarize')
    assert.strictEqual(child.traceId, parent.traceId)
    assert.strictEqual(child.bus, bus)
    assert.strictEqual(child.operationName, 'agent.summarize')
    assert.strictEqual(child.parentSpanId, parent.parentSpanId)
  })

  it('parentSpanOverride pins the parent span for the child', () => {
    const parent = {
      traceId: 'a'.repeat(32),
      parentSpanId: 'b'.repeat(16),
      operationName: 'agent.chat',
      bus: new TelemetryBus(),
    }
    const override = 'c'.repeat(16)
    const child = childContext(parent, 'plan.step', override)
    assert.strictEqual(child.parentSpanId, override)
  })
})

// ---------------------------------------------------------------------------
// extractUsage — provider-shape normalization
// ---------------------------------------------------------------------------

describe('extractUsage: provider-shape normalization (Req 10.3)', () => {
  it('OpenAI: maps prompt_tokens / completion_tokens plus nested details', () => {
    const raw = {
      usage: {
        prompt_tokens: 200,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 40 },
        completion_tokens_details: { reasoning_tokens: 12 },
      },
    }
    assert.deepStrictEqual(extractUsage(raw), {
      input_tokens: 200,
      output_tokens: 50,
      cached_tokens: 40,
      reasoning_tokens: 12,
    })
  })

  it('OpenAI with no nested details: cached/reasoning are null', () => {
    const raw = {
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    }
    assert.deepStrictEqual(extractUsage(raw), {
      input_tokens: 10,
      output_tokens: 20,
      cached_tokens: null,
      reasoning_tokens: null,
    })
  })

  it('DeepSeek: maps prompt_cache_hit_tokens → cached_tokens', () => {
    const raw = {
      usage: {
        prompt_tokens: 512,
        completion_tokens: 64,
        prompt_cache_hit_tokens: 128,
      },
    }
    assert.deepStrictEqual(extractUsage(raw), {
      input_tokens: 512,
      output_tokens: 64,
      cached_tokens: 128,
      reasoning_tokens: null,
    })
  })

  it('Qwen OpenAI-compat: same shape as OpenAI, cached via nested details', () => {
    const raw = {
      usage: {
        prompt_tokens: 300,
        completion_tokens: 80,
        prompt_tokens_details: { cached_tokens: 120 },
      },
    }
    assert.deepStrictEqual(extractUsage(raw), {
      input_tokens: 300,
      output_tokens: 80,
      cached_tokens: 120,
      reasoning_tokens: null,
    })
  })

  it('Qwen variant: bare prompt_tokens / completion_tokens, no details', () => {
    const raw = {
      usage: { prompt_tokens: 100, completion_tokens: 25 },
    }
    assert.deepStrictEqual(extractUsage(raw), {
      input_tokens: 100,
      output_tokens: 25,
      cached_tokens: null,
      reasoning_tokens: null,
    })
  })

  it('absent usage → all four fields are null', () => {
    assert.deepStrictEqual(extractUsage({}), {
      input_tokens: null,
      output_tokens: null,
      cached_tokens: null,
      reasoning_tokens: null,
    })
  })

  it('usage: null → all four fields are null', () => {
    assert.deepStrictEqual(extractUsage({ usage: null }), {
      input_tokens: null,
      output_tokens: null,
      cached_tokens: null,
      reasoning_tokens: null,
    })
  })

  it('null / undefined raw → all four fields are null', () => {
    assert.deepStrictEqual(extractUsage(null), {
      input_tokens: null,
      output_tokens: null,
      cached_tokens: null,
      reasoning_tokens: null,
    })
    assert.deepStrictEqual(extractUsage(undefined), {
      input_tokens: null,
      output_tokens: null,
      cached_tokens: null,
      reasoning_tokens: null,
    })
  })

  it('explicit cached_tokens: 0 stays 0 (distinguishes absent vs zero)', () => {
    const raw = {
      usage: {
        prompt_tokens: 50,
        completion_tokens: 10,
        prompt_tokens_details: { cached_tokens: 0 },
      },
    }
    const out = extractUsage(raw)
    assert.strictEqual(out.cached_tokens, 0, 'explicit 0 must survive as 0')
    assert.notStrictEqual(out.cached_tokens, null)
  })

  it('explicit reasoning_tokens: 0 stays 0', () => {
    const raw = {
      usage: {
        prompt_tokens: 50,
        completion_tokens: 10,
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    }
    const out = extractUsage(raw)
    assert.strictEqual(out.reasoning_tokens, 0)
  })

  it('explicit prompt_tokens / completion_tokens of 0 stay 0', () => {
    const raw = { usage: { prompt_tokens: 0, completion_tokens: 0 } }
    const out = extractUsage(raw)
    assert.strictEqual(out.input_tokens, 0)
    assert.strictEqual(out.output_tokens, 0)
  })

  it('non-numeric token values resolve to null (not NaN)', () => {
    const raw = {
      usage: {
        prompt_tokens: '200',             // string — invalid
        completion_tokens: Number.NaN,    // NaN — invalid
      },
    }
    const out = extractUsage(raw)
    assert.strictEqual(out.input_tokens, null)
    assert.strictEqual(out.output_tokens, null)
  })

  it('OpenAI cached takes precedence over DeepSeek when both are present', () => {
    const raw = {
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 77 },
        prompt_cache_hit_tokens: 99,
      },
    }
    assert.strictEqual(extractUsage(raw).cached_tokens, 77)
  })
})

// ---------------------------------------------------------------------------
// utf8ByteLength
// ---------------------------------------------------------------------------

describe('utf8ByteLength: UTF-8 byte counting', () => {
  it('empty string → 0', () => {
    assert.strictEqual(utf8ByteLength(''), 0)
  })

  it('ASCII: 1 byte per character', () => {
    assert.strictEqual(utf8ByteLength('a'), 1)
    assert.strictEqual(utf8ByteLength('hello'), 5)
    assert.strictEqual(utf8ByteLength('hello, world!'), 13)
  })

  it('2-byte UTF-8 (Latin-1 supplement)', () => {
    // 'é' encodes to 0xC3 0xA9 in UTF-8 → 2 bytes.
    assert.strictEqual(utf8ByteLength('é'), 2)
    assert.strictEqual(utf8ByteLength('café'), 5) // c(1)+a(1)+f(1)+é(2)
  })

  it('3-byte UTF-8 (CJK)', () => {
    // '中' and '文' each encode to 3 bytes in UTF-8.
    assert.strictEqual(utf8ByteLength('中'), 3)
    assert.strictEqual(utf8ByteLength('中文'), 6)
    assert.strictEqual(utf8ByteLength('你好'), 6)
  })

  it('4-byte UTF-8 (supplementary plane — emoji)', () => {
    // '😀' (U+1F600) encodes to 4 bytes in UTF-8.
    assert.strictEqual(utf8ByteLength('😀'), 4)
  })

  it('mixed ASCII + multi-byte', () => {
    // "a中" = 1 + 3 = 4
    assert.strictEqual(utf8ByteLength('a中'), 4)
    // "hello 世界" = 5 + 1 (space) + 3 + 3 = 12
    assert.strictEqual(utf8ByteLength('hello 世界'), 12)
  })

  it('coerces non-string inputs via String()', () => {
    assert.strictEqual(utf8ByteLength(12345), 5)
    assert.strictEqual(utf8ByteLength(null), 'null'.length)
    assert.strictEqual(utf8ByteLength(undefined), 'undefined'.length)
    assert.strictEqual(utf8ByteLength(true), 'true'.length)
  })
})


// ===========================================================================
// Task 2.2 — llm-client telemetry integration tests
//
// Scope:
//   - syncChat emits one `llm.call` event with the exact OTel GenAI-shaped
//     payload, non-negative duration, correct traceId / spanId / parentSpanId.
//   - syncChat error paths: non-retryable HTTP error → `'api_error'`;
//     AbortError → `'aborted'`; original error rethrown unchanged.
//   - streamChatIter yields a single `usage` event before `done`, populates
//     `done.response.usage`, and emits exactly one `llm.call`.
//   - streamChatIter with no provider usage chunk → no `usage` event and all
//     usage sub-fields `null` on both `done.response.usage` and the llm.call.
//   - `gen_ai.system` resolution + usage mapping per provider (OpenAI /
//     DeepSeek / Qwen).
//
// Implementation notes:
//   - Fetch is stubbed per-test via `beforeEach` / `afterEach` on
//     `globalThis.fetch` to keep isolation with the telemetry-primitive tests
//     above.
//   - 429 is deliberately avoided in the error-path test because the default
//     `withRetry` (3 retries × exponential backoff) would make the test slow.
//     The spec only requires that HTTP errors classify as `'api_error'`; a
//     400 is non-retryable and exercises the same classification path.
//   - SSE responses are emulated with a minimal getReader() shim returning
//     UTF-8 byte chunks — enough to satisfy the reader loop in streamChatIter.
//
// Validates: Requirements 2.1-2.15, 7.1-7.6, 9.4
// ===========================================================================

import { beforeEach, afterEach } from 'node:test'
import { syncChat, streamChatIter, LlmApiError } from './llm-client.js'

// ---- Shared fetch-stub helpers -------------------------------------------

const _originalFetch = globalThis.fetch

/** Build a minimal `Response`-shaped object returning a canned JSON body. */
function mockJsonResponse(bodyObj, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return bodyObj },
    async text() { return typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj) },
  }
}

/** Build a minimal `Response`-shaped object with a streaming `body`. */
function mockSseResponse(sseChunks) {
  const encoder = new TextEncoder()
  let idx = 0
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        let released = false
        return {
          async read() {
            if (released || idx >= sseChunks.length) {
              return { done: true, value: undefined }
            }
            return { done: false, value: encoder.encode(sseChunks[idx++]) }
          },
          releaseLock() { released = true },
        }
      },
    },
    async text() { return '' },
    async json() { return {} },
  }
}

// ---------------------------------------------------------------------------
// syncChat telemetry
// ---------------------------------------------------------------------------

describe('llm-client: syncChat telemetry (Req 2.1-2.15, 9.4)', () => {
  let bus, events, traceId, parentSpanId, ctx

  beforeEach(() => {
    bus = new TelemetryBus()
    events = []
    bus.on('llm.call', e => events.push(e))
    traceId = newTraceId()
    parentSpanId = newSpanId()
    ctx = { traceId, parentSpanId, operationName: 'agent.chat', bus }
  })

  afterEach(() => {
    globalThis.fetch = _originalFetch
  })

  it('emits one llm.call with the exact OTel field shape on success (OpenAI)', async () => {
    globalThis.fetch = async () => mockJsonResponse({
      model: 'gpt-4o-mini-2024-07-18',
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 3 },
        completion_tokens_details: { reasoning_tokens: 2 },
      },
    })

    const raw = await syncChat({
      url: 'https://api.openai.com/v1/chat/completions',
      apiKey: 'sk-test',
      body: { model: 'gpt-4o-mini', messages: [] },
      telemetry: { ctx },
    })

    // Response passthrough is unchanged (Req 9.4).
    assert.strictEqual(raw.choices[0].message.content, 'hi')

    // Exactly one llm.call event (Req 2.1).
    assert.strictEqual(events.length, 1)
    const e = events[0]

    // OTel GenAI field names + values (Req 2.3–2.12).
    assert.strictEqual(e['gen_ai.system'], 'openai')
    assert.strictEqual(e['gen_ai.request.model'], 'gpt-4o-mini')
    assert.strictEqual(e['gen_ai.response.model'], 'gpt-4o-mini-2024-07-18')
    assert.deepStrictEqual(e['gen_ai.response.finish_reasons'], ['stop'])
    assert.strictEqual(e['gen_ai.usage.input_tokens'], 10)
    assert.strictEqual(e['gen_ai.usage.output_tokens'], 5)
    assert.strictEqual(e['gen_ai.usage.cached_tokens'], 3)
    assert.strictEqual(e['gen_ai.usage.reasoning_tokens'], 2)
    assert.strictEqual(typeof e['gen_ai.client.operation.duration'], 'number')
    assert.ok(e['gen_ai.client.operation.duration'] >= 0,
      `duration must be non-negative, got ${e['gen_ai.client.operation.duration']}`)
    assert.strictEqual(e['gen_ai.operation.name'], 'agent.chat')

    // ok + identity (Req 2.13, 2.15, 4.1, 4.8).
    assert.strictEqual(e.ok, true)
    assert.strictEqual(e.error, undefined)
    assert.strictEqual(e.traceId, traceId)
    assert.strictEqual(e.parentSpanId, parentSpanId)
    assert.match(e.spanId, /^[0-9a-f]{16}$/)
    assert.notStrictEqual(e.spanId, parentSpanId, 'spanId must be a fresh id, not the parent')
  })

  it('non-retryable HTTP 400 → llm.call ok:false, error.type "api_error", rethrows LlmApiError (Req 2.2, 2.14)', async () => {
    globalThis.fetch = async () => mockJsonResponse('bad request body', { status: 400 })

    await assert.rejects(
      () => syncChat({
        url: 'https://api.openai.com/v1/chat/completions',
        apiKey: 'sk-test',
        body: { model: 'gpt-4o-mini', messages: [] },
        telemetry: { ctx },
      }),
      (err) => {
        // Original exception rethrown unchanged (Req 9.4).
        assert.ok(err instanceof LlmApiError, 'expected LlmApiError')
        assert.strictEqual(err.status, 400)
        return true
      }
    )

    assert.strictEqual(events.length, 1)
    const e = events[0]
    assert.strictEqual(e.ok, false)
    assert.strictEqual(e.error.type, 'api_error')
    assert.strictEqual(typeof e.error.message, 'string')
    assert.ok(e.error.message.length > 0)
    // Usage fields are null on failure.
    assert.strictEqual(e['gen_ai.usage.input_tokens'], null)
    assert.strictEqual(e['gen_ai.usage.output_tokens'], null)
    assert.strictEqual(e['gen_ai.usage.cached_tokens'], null)
    assert.strictEqual(e['gen_ai.usage.reasoning_tokens'], null)
    // Identity + duration still populated.
    assert.strictEqual(e.traceId, traceId)
    assert.strictEqual(e.parentSpanId, parentSpanId)
    assert.match(e.spanId, /^[0-9a-f]{16}$/)
    assert.ok(e['gen_ai.client.operation.duration'] >= 0)
    assert.strictEqual(e['gen_ai.operation.name'], 'agent.chat')
  })

  it('AbortError from fetch → llm.call error.type "aborted", rethrows original (Req 2.2, 2.14)', async () => {
    globalThis.fetch = async () => {
      const err = new Error('The operation was aborted')
      err.name = 'AbortError'
      throw err
    }

    await assert.rejects(
      () => syncChat({
        url: 'https://api.openai.com/v1/chat/completions',
        apiKey: 'sk-test',
        body: { model: 'gpt-4o-mini', messages: [] },
        telemetry: { ctx },
      }),
      (err) => {
        assert.strictEqual(err.name, 'AbortError')
        return true
      }
    )

    assert.strictEqual(events.length, 1)
    const e = events[0]
    assert.strictEqual(e.ok, false)
    assert.strictEqual(e.error.type, 'aborted')
    assert.strictEqual(e.error.message, 'The operation was aborted')
  })

  it('gen_ai.system resolves to "deepseek" and usage maps prompt_cache_hit_tokens', async () => {
    globalThis.fetch = async () => mockJsonResponse({
      model: 'deepseek-chat',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 512,
        completion_tokens: 64,
        prompt_cache_hit_tokens: 128,
      },
    })

    await syncChat({
      url: 'https://api.deepseek.com/v1/chat/completions',
      apiKey: 'sk-ds',
      body: { model: 'deepseek-chat', messages: [] },
      telemetry: { ctx },
    })

    assert.strictEqual(events.length, 1)
    const e = events[0]
    assert.strictEqual(e['gen_ai.system'], 'deepseek')
    assert.strictEqual(e['gen_ai.usage.input_tokens'], 512)
    assert.strictEqual(e['gen_ai.usage.output_tokens'], 64)
    assert.strictEqual(e['gen_ai.usage.cached_tokens'], 128)
    assert.strictEqual(e['gen_ai.usage.reasoning_tokens'], null)
  })

  it('gen_ai.system resolves to "qwen" for dashscope URLs with OpenAI-compat usage shape', async () => {
    globalThis.fetch = async () => mockJsonResponse({
      model: 'qwen-plus',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 200,
        completion_tokens: 80,
        prompt_tokens_details: { cached_tokens: 90 },
      },
    })

    await syncChat({
      url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      apiKey: 'sk-qw',
      body: { model: 'qwen-plus', messages: [] },
      telemetry: { ctx },
    })

    assert.strictEqual(events.length, 1)
    const e = events[0]
    assert.strictEqual(e['gen_ai.system'], 'qwen')
    assert.strictEqual(e['gen_ai.usage.input_tokens'], 200)
    assert.strictEqual(e['gen_ai.usage.output_tokens'], 80)
    assert.strictEqual(e['gen_ai.usage.cached_tokens'], 90)
    assert.strictEqual(e['gen_ai.usage.reasoning_tokens'], null)
  })

  it('onLlmSpanStart is invoked with the same spanId emitted on the llm.call event', async () => {
    globalThis.fetch = async () => mockJsonResponse({
      model: 'x', choices: [{ message: { content: '' }, finish_reason: 'stop' }],
    })

    let spanFromCallback = null
    await syncChat({
      url: 'https://api.openai.com/v1/chat/completions',
      apiKey: 'sk',
      body: { model: 'x', messages: [] },
      telemetry: { ctx, onLlmSpanStart: (id) => { spanFromCallback = id } },
    })

    assert.strictEqual(events.length, 1)
    assert.strictEqual(spanFromCallback, events[0].spanId)
    assert.match(spanFromCallback, /^[0-9a-f]{16}$/)
  })

  it('zero-telemetry path: no ctx → no events emitted, response unchanged (Req 9.4)', async () => {
    globalThis.fetch = async () => mockJsonResponse({
      model: 'x',
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
    })

    const raw = await syncChat({
      url: 'https://api.openai.com/v1/chat/completions',
      apiKey: 'sk',
      body: { model: 'x', messages: [] },
      // no telemetry
    })
    assert.strictEqual(raw.choices[0].message.content, 'hi')
    assert.strictEqual(events.length, 0)
  })

  it('finish_reasons is derived from every choice that carries one', async () => {
    globalThis.fetch = async () => mockJsonResponse({
      model: 'x',
      choices: [
        { message: { content: 'a' }, finish_reason: 'stop' },
        { message: { content: 'b' }, finish_reason: 'length' },
        { message: { content: 'c' } }, // no finish_reason — filtered out
      ],
    })

    await syncChat({
      url: 'https://api.openai.com/v1/chat/completions',
      apiKey: 'sk',
      body: { model: 'x', messages: [] },
      telemetry: { ctx },
    })

    assert.deepStrictEqual(events[0]['gen_ai.response.finish_reasons'], ['stop', 'length'])
  })
})

// ---------------------------------------------------------------------------
// streamChatIter telemetry
// ---------------------------------------------------------------------------

describe('llm-client: streamChatIter telemetry (Req 7.1-7.6, 2.1-2.15)', () => {
  let bus, events, traceId, parentSpanId, ctx

  beforeEach(() => {
    bus = new TelemetryBus()
    events = []
    bus.on('llm.call', e => events.push(e))
    traceId = newTraceId()
    parentSpanId = newSpanId()
    ctx = { traceId, parentSpanId, operationName: 'agent.chat', bus }
  })

  afterEach(() => {
    globalThis.fetch = _originalFetch
  })

  it('SSE stream with content + usage chunk + [DONE]: usage yielded before done; one usage event; one llm.call', async () => {
    const deltaChunk = 'data: ' + JSON.stringify({
      model: 'gpt-4o-mini',
      choices: [{ index: 0, delta: { content: 'hello' } }],
    }) + '\n'
    const usageChunk = 'data: ' + JSON.stringify({
      model: 'gpt-4o-mini',
      choices: [],
      usage: {
        prompt_tokens: 20,
        completion_tokens: 10,
        prompt_tokens_details: { cached_tokens: 5 },
        completion_tokens_details: { reasoning_tokens: 1 },
      },
    }) + '\n'
    const finishChunk = 'data: ' + JSON.stringify({
      model: 'gpt-4o-mini',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    }) + '\n'
    const doneChunk = 'data: [DONE]\n'

    globalThis.fetch = async () =>
      mockSseResponse([deltaChunk, usageChunk, finishChunk, doneChunk])

    const yielded = []
    for await (const evt of streamChatIter({
      url: 'https://api.openai.com/v1/chat/completions',
      apiKey: 'sk',
      body: { model: 'gpt-4o-mini', messages: [] },
      telemetry: { ctx },
    })) {
      yielded.push(evt)
    }

    // Req 7.5, 7.6: exactly one `usage` event, and it precedes `done`.
    const usageIdx = yielded.findIndex(e => e.type === 'usage')
    const doneIdx = yielded.findIndex(e => e.type === 'done')
    assert.notStrictEqual(usageIdx, -1, 'expected a usage event')
    assert.notStrictEqual(doneIdx, -1, 'expected a done event')
    assert.ok(usageIdx < doneIdx, 'usage must be yielded before done')
    assert.strictEqual(
      yielded.filter(e => e.type === 'usage').length,
      1,
      'exactly one usage event per stream (Req 7.6)'
    )

    // Req 7.1, 7.2: usage object shape.
    const expectedUsage = {
      input_tokens: 20, output_tokens: 10,
      cached_tokens: 5, reasoning_tokens: 1,
    }
    assert.deepStrictEqual(yielded[usageIdx].usage, expectedUsage)

    // Req 7.1, 7.4: done.response.usage matches.
    assert.deepStrictEqual(yielded[doneIdx].response.usage, expectedUsage)

    // Exactly one llm.call emitted (Req 2.1, 6.8).
    assert.strictEqual(events.length, 1)
    const e = events[0]
    assert.strictEqual(e.ok, true)
    assert.strictEqual(e['gen_ai.system'], 'openai')
    assert.strictEqual(e['gen_ai.request.model'], 'gpt-4o-mini')
    assert.strictEqual(e['gen_ai.response.model'], 'gpt-4o-mini')
    assert.deepStrictEqual(e['gen_ai.response.finish_reasons'], ['stop'])
    assert.strictEqual(e['gen_ai.usage.input_tokens'], 20)
    assert.strictEqual(e['gen_ai.usage.output_tokens'], 10)
    assert.strictEqual(e['gen_ai.usage.cached_tokens'], 5)
    assert.strictEqual(e['gen_ai.usage.reasoning_tokens'], 1)
    assert.strictEqual(e['gen_ai.operation.name'], 'agent.chat')
    assert.ok(e['gen_ai.client.operation.duration'] >= 0)
    assert.strictEqual(e.traceId, traceId)
    assert.strictEqual(e.parentSpanId, parentSpanId)
    assert.match(e.spanId, /^[0-9a-f]{16}$/)
  })

  it('SSE stream with no usage chunk: no usage event; done.response.usage all null; llm.call usage all null (Req 7.3)', async () => {
    const deltaChunk = 'data: ' + JSON.stringify({
      model: 'gpt-4o-mini',
      choices: [{ index: 0, delta: { content: 'hello' } }],
    }) + '\n'
    const finishChunk = 'data: ' + JSON.stringify({
      model: 'gpt-4o-mini',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    }) + '\n'
    const doneChunk = 'data: [DONE]\n'

    globalThis.fetch = async () =>
      mockSseResponse([deltaChunk, finishChunk, doneChunk])

    const yielded = []
    for await (const evt of streamChatIter({
      url: 'https://api.openai.com/v1/chat/completions',
      apiKey: 'sk',
      body: { model: 'gpt-4o-mini', messages: [] },
      telemetry: { ctx },
    })) {
      yielded.push(evt)
    }

    // No usage event.
    assert.strictEqual(
      yielded.filter(e => e.type === 'usage').length,
      0,
      'no usage event when provider sent no usage chunk'
    )

    // done.response.usage has all four fields null (Req 7.3, 7.4).
    const doneEvt = yielded.find(e => e.type === 'done')
    assert.ok(doneEvt, 'expected a done event')
    assert.deepStrictEqual(doneEvt.response.usage, {
      input_tokens: null,
      output_tokens: null,
      cached_tokens: null,
      reasoning_tokens: null,
    })

    // llm.call usage fields all null.
    assert.strictEqual(events.length, 1)
    const e = events[0]
    assert.strictEqual(e.ok, true)
    assert.strictEqual(e['gen_ai.usage.input_tokens'], null)
    assert.strictEqual(e['gen_ai.usage.output_tokens'], null)
    assert.strictEqual(e['gen_ai.usage.cached_tokens'], null)
    assert.strictEqual(e['gen_ai.usage.reasoning_tokens'], null)
  })

  it('SSE DeepSeek: gen_ai.system is "deepseek", cached_tokens from prompt_cache_hit_tokens', async () => {
    const delta = 'data: ' + JSON.stringify({
      model: 'deepseek-chat',
      choices: [{ index: 0, delta: { content: 'hi' } }],
    }) + '\n'
    const usage = 'data: ' + JSON.stringify({
      model: 'deepseek-chat',
      choices: [],
      usage: {
        prompt_tokens: 50,
        completion_tokens: 20,
        prompt_cache_hit_tokens: 30,
      },
    }) + '\n'
    const finish = 'data: ' + JSON.stringify({
      model: 'deepseek-chat',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    }) + '\n'
    const done = 'data: [DONE]\n'

    globalThis.fetch = async () => mockSseResponse([delta, usage, finish, done])

    for await (const _ of streamChatIter({
      url: 'https://api.deepseek.com/chat/completions',
      apiKey: 'sk',
      body: { model: 'deepseek-chat', messages: [] },
      telemetry: { ctx },
    })) { /* drain */ }

    assert.strictEqual(events.length, 1)
    const e = events[0]
    assert.strictEqual(e['gen_ai.system'], 'deepseek')
    assert.strictEqual(e['gen_ai.usage.input_tokens'], 50)
    assert.strictEqual(e['gen_ai.usage.output_tokens'], 20)
    assert.strictEqual(e['gen_ai.usage.cached_tokens'], 30)
    assert.strictEqual(e['gen_ai.usage.reasoning_tokens'], null)
  })

  it('SSE Qwen: gen_ai.system is "qwen", cached_tokens from nested prompt_tokens_details', async () => {
    const delta = 'data: ' + JSON.stringify({
      model: 'qwen-plus',
      choices: [{ index: 0, delta: { content: 'hi' } }],
    }) + '\n'
    const usage = 'data: ' + JSON.stringify({
      model: 'qwen-plus',
      choices: [],
      usage: {
        prompt_tokens: 77,
        completion_tokens: 33,
        prompt_tokens_details: { cached_tokens: 22 },
      },
    }) + '\n'
    const finish = 'data: ' + JSON.stringify({
      model: 'qwen-plus',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    }) + '\n'
    const done = 'data: [DONE]\n'

    globalThis.fetch = async () => mockSseResponse([delta, usage, finish, done])

    for await (const _ of streamChatIter({
      url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      apiKey: 'sk',
      body: { model: 'qwen-plus', messages: [] },
      telemetry: { ctx },
    })) { /* drain */ }

    assert.strictEqual(events.length, 1)
    const e = events[0]
    assert.strictEqual(e['gen_ai.system'], 'qwen')
    assert.strictEqual(e['gen_ai.usage.input_tokens'], 77)
    assert.strictEqual(e['gen_ai.usage.output_tokens'], 33)
    assert.strictEqual(e['gen_ai.usage.cached_tokens'], 22)
  })

  it('stream initialization failure (non-retryable 400): one llm.call ok:false with api_error', async () => {
    globalThis.fetch = async () => mockJsonResponse('bad stream request', { status: 400 })

    await assert.rejects(async () => {
      for await (const _ of streamChatIter({
        url: 'https://api.openai.com/v1/chat/completions',
        apiKey: 'sk',
        body: { model: 'gpt-4o-mini', messages: [] },
        telemetry: { ctx },
      })) { /* drain */ }
    }, (err) => {
      assert.ok(err instanceof LlmApiError, 'expected LlmApiError')
      assert.strictEqual(err.status, 400)
      return true
    })

    assert.strictEqual(events.length, 1)
    const e = events[0]
    assert.strictEqual(e.ok, false)
    assert.strictEqual(e.error.type, 'api_error')
    assert.strictEqual(e.traceId, traceId)
    assert.strictEqual(e.parentSpanId, parentSpanId)
    assert.match(e.spanId, /^[0-9a-f]{16}$/)
  })
})


// ===========================================================================
// Task 3.3 — Agent session lifecycle + aggregates
//
// Scope:
//   - Two successive chat() runs emit session.start / session.end in order
//     and update Session_Metrics totals correctly (counts + null-safe usage
//     sum).
//   - reset() clears getLastRunMetrics() to null and zeroes
//     getSessionMetrics().
//   - With NO listeners registered, getLastRunMetrics() /
//     getSessionMetrics() still populate (Requirement 9.5).
//   - session.end fires on thrown error with ok:false and Run_Metrics
//     reflecting partial progress (Requirement 5.7).
//   - totalLlmCalls / totalToolCalls count only ok:true events; usage is
//     the null-safe sum across all emitted llm.call events.
//
// Validates: Requirements 5.7, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9,
//            9.5, 9.6
// ===========================================================================

import { Agent } from './agent.js'
import { SlidingWindowMemory } from './memory.js'

/**
 * Build an OpenAI-shaped non-streaming chat completion response. Caller can
 * override usage and content.
 */
function mockChatCompletion({
  content = 'hello',
  usage = { prompt_tokens: 10, completion_tokens: 5 },
  model = 'gpt-4o-mini-2024-07-18',
} = {}) {
  return {
    model,
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage,
  }
}

/** Construct a fresh agent wired to a sliding-window memory (sync). */
function buildTestAgent() {
  return new Agent({
    provider: 'openai',
    apiKey: 'sk-test',
    model: 'gpt-4o-mini',
    // Use sync memory so test assertions about synchronous flow are not
    // confused by the default SummarizingMemory's async summarizer (which
    // would also hit the stubbed fetch).
    memory: new SlidingWindowMemory(50),
    maxRounds: 1,
  })
}

describe('Agent session lifecycle + aggregates (Task 3.3)', () => {
  let _prevFetch

  beforeEach(() => {
    _prevFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = _prevFetch
  })

  it('two successive chat() runs: totalRuns === 2, usage is null-safe sum, totalLlmCalls counts ok:true only (Req 8.5, 8.6, 8.7, 8.8)', async () => {
    // Two distinct token counts so we can verify summation.
    const responses = [
      mockChatCompletion({
        content: 'first',
        usage: { prompt_tokens: 200, completion_tokens: 50 },
      }),
      mockChatCompletion({
        content: 'second',
        usage: { prompt_tokens: 100, completion_tokens: 30 },
      }),
    ]
    let callIdx = 0
    globalThis.fetch = async () => mockJsonResponse(responses[callIdx++])

    const agent = buildTestAgent()
    const sessionStarts = []
    const sessionEnds = []
    const llmCalls = []
    agent.on('session.start', e => sessionStarts.push(e))
    agent.on('session.end', e => sessionEnds.push(e))
    agent.on('llm.call', e => llmCalls.push(e))

    const r1 = await agent.chat('one')
    const r2 = await agent.chat('two')

    assert.strictEqual(r1, 'first')
    assert.strictEqual(r2, 'second')

    // Two session lifecycles, two llm.call events.
    assert.strictEqual(sessionStarts.length, 2)
    assert.strictEqual(sessionEnds.length, 2)
    assert.strictEqual(llmCalls.length, 2)

    // Each session has a distinct traceId; start/end share the same one
    // within a run (Requirement 4.6).
    assert.notStrictEqual(sessionStarts[0].traceId, sessionStarts[1].traceId)
    assert.strictEqual(sessionStarts[0].traceId, sessionEnds[0].traceId)
    assert.strictEqual(sessionStarts[1].traceId, sessionEnds[1].traceId)

    // session.end ok === true on successful completion.
    assert.strictEqual(sessionEnds[0].ok, true)
    assert.strictEqual(sessionEnds[1].ok, true)

    // Session_Metrics aggregation (Requirement 8.5).
    const sm = agent.getSessionMetrics()
    assert.strictEqual(sm.totalRuns, 2)
    // Requirement 8.8: only ok:true llm.call events count.
    assert.strictEqual(sm.totalLlmCalls, 2)
    // Requirement 8.9: only ok:true tool.call events count (zero here).
    assert.strictEqual(sm.totalToolCalls, 0)
    // Requirements 8.6, 8.7: null-safe sum across runs.
    assert.strictEqual(sm.usage.input_tokens, 300)
    assert.strictEqual(sm.usage.output_tokens, 80)

    // getLastRunMetrics returns the SECOND run's metrics (Requirement 8.1).
    const last = agent.getLastRunMetrics()
    assert.ok(last !== null)
    assert.strictEqual(last.traceId, sessionStarts[1].traceId)
    assert.strictEqual(last.totalLlmCalls, 1)
    assert.strictEqual(last.usage.input_tokens, 100)
    assert.strictEqual(last.usage.output_tokens, 30)
    // wallClockMs is a non-negative number.
    assert.strictEqual(typeof last.wallClockMs, 'number')
    assert.ok(last.wallClockMs >= 0)
  })

  it('null-safe usage aggregation: null fields contribute 0 to the sum (Req 8.6, 8.7)', async () => {
    // First call returns usage; second call returns no usage at all.
    const responses = [
      mockChatCompletion({
        content: 'a',
        usage: { prompt_tokens: 100, completion_tokens: 40 },
      }),
      // No `usage` field at all — extractUsage returns all null.
      {
        model: 'gpt-4o-mini',
        choices: [{ message: { content: 'b' }, finish_reason: 'stop' }],
      },
    ]
    let idx = 0
    globalThis.fetch = async () => mockJsonResponse(responses[idx++])

    const agent = buildTestAgent()
    await agent.chat('x')
    await agent.chat('y')

    const sm = agent.getSessionMetrics()
    // null contributes 0; total equals whatever the first call reported.
    assert.strictEqual(sm.usage.input_tokens, 100)
    assert.strictEqual(sm.usage.output_tokens, 40)
    // cached/reasoning were null in both → sum is 0 (not null) in
    // Session_Metrics because _zeroSessionMetrics initializes counters to 0.
    assert.strictEqual(sm.usage.cached_tokens, 0)
    assert.strictEqual(sm.usage.reasoning_tokens, 0)
  })

  it('reset() clears getLastRunMetrics() to null and zeroes getSessionMetrics() (Req 8.4)', async () => {
    globalThis.fetch = async () => mockJsonResponse(
      mockChatCompletion({ usage: { prompt_tokens: 77, completion_tokens: 11 } })
    )

    const agent = buildTestAgent()
    await agent.chat('hi')

    assert.notStrictEqual(agent.getLastRunMetrics(), null)
    const smBefore = agent.getSessionMetrics()
    assert.strictEqual(smBefore.totalRuns, 1)
    assert.strictEqual(smBefore.totalLlmCalls, 1)
    assert.strictEqual(smBefore.usage.input_tokens, 77)

    agent.reset()

    assert.strictEqual(agent.getLastRunMetrics(), null)
    const smAfter = agent.getSessionMetrics()
    assert.deepStrictEqual(smAfter, {
      totalRuns: 0,
      totalRounds: 0,
      totalLlmCalls: 0,
      totalToolCalls: 0,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cached_tokens: 0,
        reasoning_tokens: 0,
      },
      wallClockMs: 0,
    })
  })

  it('with NO listeners registered, metrics accessors still populate (Req 9.5)', async () => {
    globalThis.fetch = async () => mockJsonResponse(
      mockChatCompletion({ usage: { prompt_tokens: 123, completion_tokens: 45 } })
    )

    const agent = buildTestAgent()
    // Intentionally register NO listeners on the bus.
    assert.strictEqual(agent._bus.listenerCount('session.start'), 0)
    assert.strictEqual(agent._bus.listenerCount('session.end'), 0)
    // The internal aggregation listeners ARE registered transiently during
    // the run, but there should be nothing leaking before the call.
    assert.strictEqual(agent._bus.listenerCount('llm.call'), 0)
    assert.strictEqual(agent._bus.listenerCount('tool.call'), 0)

    await agent.chat('hi')

    // The run populated both accessors despite zero external subscriptions.
    const last = agent.getLastRunMetrics()
    assert.ok(last !== null, 'getLastRunMetrics must populate with no listeners')
    assert.strictEqual(last.totalLlmCalls, 1)
    assert.strictEqual(last.usage.input_tokens, 123)
    assert.strictEqual(last.usage.output_tokens, 45)

    const sm = agent.getSessionMetrics()
    assert.strictEqual(sm.totalRuns, 1)
    assert.strictEqual(sm.totalLlmCalls, 1)
    assert.strictEqual(sm.usage.input_tokens, 123)

    // Internal listeners were unregistered after the run (no leaks).
    assert.strictEqual(agent._bus.listenerCount('llm.call'), 0)
    assert.strictEqual(agent._bus.listenerCount('tool.call'), 0)
  })

  it('session.end fires on thrown error with ok:false and Run_Metrics reflecting partial progress (Req 5.7, 9.6)', async () => {
    // First network call succeeds, second throws — but since maxRounds=1 and
    // the first response finish_reason is "stop", we would complete without a
    // second call. To force an error path, make the FIRST fetch reject.
    globalThis.fetch = async () => {
      throw new Error('network down')
    }

    const agent = buildTestAgent()
    const sessionStarts = []
    const sessionEnds = []
    const llmCalls = []
    agent.on('session.start', e => sessionStarts.push(e))
    agent.on('session.end', e => sessionEnds.push(e))
    agent.on('llm.call', e => llmCalls.push(e))

    await assert.rejects(
      () => agent.chat('boom'),
      (err) => {
        // Original exception must propagate unchanged (Req 9.6).
        assert.strictEqual(err.message, 'network down')
        return true
      }
    )

    // Lifecycle events still fired in the right order.
    assert.strictEqual(sessionStarts.length, 1)
    assert.strictEqual(sessionEnds.length, 1)

    const endEvt = sessionEnds[0]
    // Requirement 5.7: session.end fires even when the strategy throws; ok is
    // false.
    assert.strictEqual(endEvt.ok, false)
    assert.strictEqual(endEvt.traceId, sessionStarts[0].traceId)

    // The LLM call that failed should have been emitted as ok:false and
    // counted in Run_Metrics.llmCalls but NOT in totalLlmCalls.
    assert.strictEqual(llmCalls.length, 1)
    assert.strictEqual(llmCalls[0].ok, false)

    // Run_Metrics inspection (Req 5.7 — reflects partial progress).
    assert.strictEqual(endEvt.totalLlmCalls, 0, 'ok:false excluded from totalLlmCalls')
    assert.strictEqual(endEvt.totalToolCalls, 0)
    assert.strictEqual(endEvt.llmCalls.length, 1, 'failed llm.call still recorded')
    assert.strictEqual(endEvt.llmCalls[0].ok, false)
    assert.strictEqual(typeof endEvt.wallClockMs, 'number')
    assert.ok(endEvt.wallClockMs >= 0)

    // Session aggregates also reflect the failed run.
    const sm = agent.getSessionMetrics()
    assert.strictEqual(sm.totalRuns, 1, 'failed run still counts toward totalRuns')
    assert.strictEqual(sm.totalLlmCalls, 0, 'ok:false llm.call does not bump totalLlmCalls')

    // getLastRunMetrics reflects the failed run.
    const last = agent.getLastRunMetrics()
    assert.ok(last !== null)
    assert.strictEqual(last.llmCalls.length, 1)
    assert.strictEqual(last.llmCalls[0].ok, false)
  })

  it('session lifecycle ordering: session.start precedes llm.call precedes session.end; shared traceId', async () => {
    globalThis.fetch = async () => mockJsonResponse(
      mockChatCompletion({ usage: { prompt_tokens: 1, completion_tokens: 1 } })
    )

    const agent = buildTestAgent()
    const events = []
    agent.on('session.start', e => events.push({ type: 'session.start', e }))
    agent.on('session.end', e => events.push({ type: 'session.end', e }))
    agent.on('llm.call', e => events.push({ type: 'llm.call', e }))

    await agent.chat('hi')

    // Ordering: start → llm.call (≥1) → end.
    assert.strictEqual(events[0].type, 'session.start')
    assert.strictEqual(events[events.length - 1].type, 'session.end')
    const llmIdx = events.findIndex(x => x.type === 'llm.call')
    assert.ok(llmIdx > 0 && llmIdx < events.length - 1, 'llm.call must land between start and end')

    // All events share one traceId (Req 4.6).
    const traceIds = new Set(events.map(x => x.e.traceId))
    assert.strictEqual(traceIds.size, 1)
  })

  it('successful chat() returns the same string whether or not listeners are registered (Req 9.1)', async () => {
    globalThis.fetch = async () => mockJsonResponse(
      mockChatCompletion({ content: 'canonical reply', usage: { prompt_tokens: 1, completion_tokens: 1 } })
    )

    // Run 1 — no listeners.
    const a1 = buildTestAgent()
    const r1 = await a1.chat('hi')

    // Run 2 — listeners for every framework event type.
    const a2 = buildTestAgent()
    a2.on('session.start', () => {})
    a2.on('session.end', () => {})
    a2.on('llm.call', () => {})
    a2.on('tool.call', () => {})
    const r2 = await a2.chat('hi')

    assert.strictEqual(r1, 'canonical reply')
    assert.strictEqual(r2, r1)
  })
})


// ===========================================================================
// Task 8.2 — aggregation math for Run_Metrics / Session_Metrics
//
// Scope (complementary to Task 3.3 — no pure duplication):
//   - Three llm.call records inside ONE run (usages {200,50}, {100,30},
//     all-null) → run-level aggregate math `{input_tokens:300, output_tokens:80}`.
//   - Mixed ok:true / ok:false llm.call records in a single run → failed
//     calls are excluded from `totalLlmCalls` but retained in
//     `Run_Metrics.llmCalls`.
//   - Aborted run via `AbortController.abort()` → `Run_Metrics` reflects
//     partial work; `session.end` fires with `ok:false`.
//
// Tests (1) and (2) use the direct `_currentRun` + `_finalizeRun` path
// (white-box) per the task description's suggestion — this isolates the
// aggregation math from the round-driving machinery and keeps the test
// focused. Test (3) exercises the real `chat()` path with an
// `AbortController` so we validate the end-to-end abort handling.
//
// Validates: Requirements 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9
// ===========================================================================

/**
 * Build a minimal `LlmCallRecord`-shaped object. Callers supply only the
 * fields that matter for the assertion; the rest default to null so
 * `_sumUsage` treats them as non-contributing.
 */
function mkLlmRecord({
  ok = true,
  input_tokens = null,
  output_tokens = null,
  cached_tokens = null,
  reasoning_tokens = null,
  error,
} = {}) {
  const rec = {
    ok,
    'gen_ai.system': 'openai',
    'gen_ai.request.model': 'gpt-4o-mini',
    'gen_ai.response.model': 'gpt-4o-mini',
    'gen_ai.response.finish_reasons': ['stop'],
    'gen_ai.usage.input_tokens': input_tokens,
    'gen_ai.usage.output_tokens': output_tokens,
    'gen_ai.usage.cached_tokens': cached_tokens,
    'gen_ai.usage.reasoning_tokens': reasoning_tokens,
    'gen_ai.client.operation.duration': 1,
    'gen_ai.operation.name': 'agent.chat',
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    parentSpanId: 'c'.repeat(16),
  }
  if (error) rec.error = error
  return rec
}

/** Install a fresh `_currentRun` scaffold on the agent for finalize tests. */
function _seedCurrentRun(agent, { llmCalls = [], toolCalls = [], totalRounds = 0 } = {}) {
  agent._currentRun = {
    traceId: newTraceId(),
    rootSpanId: newSpanId(),
    startedAt: Date.now(),
    startedPerfNow: performance.now(),
    llmCalls,
    toolCalls,
    totalRounds,
    currentLlmSpanId: null,
    rootCtx: null,
  }
}

describe('Run_Metrics / Session_Metrics aggregation math (Task 8.2)', () => {
  it('three llm.call records in one run aggregate to input=300, output=80 (Req 8.3, 8.6, 8.7)', () => {
    const agent = buildTestAgent()
    _seedCurrentRun(agent, {
      totalRounds: 3,
      llmCalls: [
        mkLlmRecord({ input_tokens: 200, output_tokens: 50 }),
        mkLlmRecord({ input_tokens: 100, output_tokens: 30 }),
        mkLlmRecord(), // all-null usage
      ],
    })

    const endEvents = []
    agent.on('session.end', e => endEvents.push(e))

    agent._finalizeRun({ ok: true })

    // Run_Metrics exposes the per-run aggregate.
    const last = agent.getLastRunMetrics()
    assert.ok(last !== null)
    assert.strictEqual(last.totalLlmCalls, 3, 'three ok:true records')
    assert.strictEqual(last.totalRounds, 3)
    // Req 8.6 / 8.7: null contributes 0, non-null values are summed.
    assert.strictEqual(last.usage.input_tokens, 300)
    assert.strictEqual(last.usage.output_tokens, 80)
    // Every record had `cached_tokens`/`reasoning_tokens` null → run-level
    // field stays null (no provider ever reported it).
    assert.strictEqual(last.usage.cached_tokens, null)
    assert.strictEqual(last.usage.reasoning_tokens, null)
    // All three records preserved on the run payload.
    assert.strictEqual(last.llmCalls.length, 3)

    // session.end carries the same Run_Metrics plus endedAt + ok (Req 5.4).
    assert.strictEqual(endEvents.length, 1)
    const end = endEvents[0]
    assert.strictEqual(end.ok, true)
    assert.strictEqual(end.totalLlmCalls, 3)
    assert.strictEqual(end.usage.input_tokens, 300)
    assert.strictEqual(end.usage.output_tokens, 80)
    assert.strictEqual(typeof end.endedAt, 'number')

    // Session_Metrics folds the run; null sub-fields contribute 0 per 8.6/8.7.
    const sm = agent.getSessionMetrics()
    assert.strictEqual(sm.totalRuns, 1)
    assert.strictEqual(sm.totalLlmCalls, 3)
    assert.strictEqual(sm.totalRounds, 3)
    assert.strictEqual(sm.usage.input_tokens, 300)
    assert.strictEqual(sm.usage.output_tokens, 80)
    assert.strictEqual(sm.usage.cached_tokens, 0)
    assert.strictEqual(sm.usage.reasoning_tokens, 0)
  })

  it('mixed ok:true / ok:false llm.calls: failures excluded from totalLlmCalls, retained in llmCalls (Req 8.3, 8.8)', () => {
    const agent = buildTestAgent()
    _seedCurrentRun(agent, {
      totalRounds: 3,
      llmCalls: [
        mkLlmRecord({ input_tokens: 50, output_tokens: 10 }),
        mkLlmRecord({
          ok: false,
          error: { type: 'api_error', message: 'boom' },
        }),
        mkLlmRecord({ input_tokens: 20, output_tokens: 5 }),
      ],
    })

    agent._finalizeRun({ ok: true })

    const last = agent.getLastRunMetrics()
    // Req 8.8: ok:false record is not counted.
    assert.strictEqual(last.totalLlmCalls, 2)
    // Req 8.3: all records (including ok:false) land on Run_Metrics.llmCalls.
    assert.strictEqual(last.llmCalls.length, 3)
    assert.strictEqual(last.llmCalls[1].ok, false)
    assert.strictEqual(last.llmCalls[1].error.type, 'api_error')
    // Usage is summed across ALL records (the failed record had null usages
    // so it contributes 0 per Req 8.6 / 8.7).
    assert.strictEqual(last.usage.input_tokens, 70)
    assert.strictEqual(last.usage.output_tokens, 15)

    // Session_Metrics reflects the same counts.
    const sm = agent.getSessionMetrics()
    assert.strictEqual(sm.totalRuns, 1)
    assert.strictEqual(sm.totalLlmCalls, 2)
    assert.strictEqual(sm.usage.input_tokens, 70)
    assert.strictEqual(sm.usage.output_tokens, 15)
  })

  it('tool.call ok:false is excluded from totalToolCalls but retained in Run_Metrics.toolCalls (Req 8.3, 8.9)', () => {
    const agent = buildTestAgent()
    _seedCurrentRun(agent, {
      totalRounds: 1,
      toolCalls: [
        { name: 'shell_exec', arguments: {}, ok: true,  durationMs: 1, bytes: 10, traceId: 'x', spanId: 'a'.repeat(16), parentSpanId: null },
        { name: 'unknown',    arguments: {}, ok: false, errorKind: 'not_found', durationMs: 1, bytes: 5, traceId: 'x', spanId: 'b'.repeat(16), parentSpanId: null },
      ],
    })

    agent._finalizeRun({ ok: true })

    const last = agent.getLastRunMetrics()
    assert.strictEqual(last.totalToolCalls, 1, 'Req 8.9: ok:false tool.call excluded from count')
    assert.strictEqual(last.toolCalls.length, 2, 'Req 8.3: both retained on toolCalls array')
    assert.strictEqual(last.toolCalls[1].errorKind, 'not_found')

    const sm = agent.getSessionMetrics()
    assert.strictEqual(sm.totalToolCalls, 1)
  })

  it('aborted chat() via AbortSignal: session.end ok:false, Run_Metrics reflects partial work (Req 5.7, 8.3)', async () => {
    // fetch stub that hangs until the abort signal fires, then rejects with
    // AbortError (llm-client classifies this as error.type === 'aborted').
    globalThis.fetch = (_url, opts) => new Promise((_resolve, reject) => {
      const signal = opts?.signal
      const rejectAborted = () => {
        const err = new Error('The operation was aborted')
        err.name = 'AbortError'
        reject(err)
      }
      if (signal?.aborted) {
        rejectAborted()
        return
      }
      signal?.addEventListener('abort', rejectAborted, { once: true })
    })

    const agent = buildTestAgent()
    const sessionStarts = []
    const sessionEnds = []
    const llmCalls = []
    agent.on('session.start', e => sessionStarts.push(e))
    agent.on('session.end', e => sessionEnds.push(e))
    agent.on('llm.call', e => llmCalls.push(e))

    const controller = new AbortController()
    const p = agent.chat('do work', { signal: controller.signal })
    // Abort on the next microtask so the fetch-stub has time to register
    // its abort listener before we fire.
    queueMicrotask(() => controller.abort())

    await assert.rejects(p, (err) => {
      // Requirement 9.6: original abort exception propagates unchanged.
      assert.strictEqual(err?.name, 'AbortError')
      return true
    })

    // Requirement 5.7: session.end still fires exactly once, with ok:false.
    assert.strictEqual(sessionStarts.length, 1)
    assert.strictEqual(sessionEnds.length, 1)
    const end = sessionEnds[0]
    assert.strictEqual(end.ok, false)
    assert.strictEqual(end.traceId, sessionStarts[0].traceId)

    // The single llm.call was aborted → ok:false with aborted classification.
    assert.strictEqual(llmCalls.length, 1)
    assert.strictEqual(llmCalls[0].ok, false)
    assert.strictEqual(llmCalls[0].error.type, 'aborted')

    // Run_Metrics reflects partial progress: one round was started, one
    // failed llm.call recorded, totalLlmCalls/totalToolCalls are 0.
    assert.strictEqual(end.totalLlmCalls, 0)
    assert.strictEqual(end.totalToolCalls, 0)
    assert.strictEqual(end.llmCalls.length, 1)
    assert.strictEqual(end.llmCalls[0].ok, false)
    assert.strictEqual(end.totalRounds, 1, 'round counter incremented before the call failed')
    assert.strictEqual(typeof end.wallClockMs, 'number')
    assert.ok(end.wallClockMs >= 0)

    // Session_Metrics rolls in the aborted run: totalRuns +1, no ok:true
    // counts, null usage aggregates to 0.
    const sm = agent.getSessionMetrics()
    assert.strictEqual(sm.totalRuns, 1)
    assert.strictEqual(sm.totalLlmCalls, 0)
    assert.strictEqual(sm.totalToolCalls, 0)
    assert.strictEqual(sm.usage.input_tokens, 0)
    assert.strictEqual(sm.usage.output_tokens, 0)

    // getLastRunMetrics mirrors the session.end payload (Req 8.1 / 8.3).
    const last = agent.getLastRunMetrics()
    assert.ok(last !== null)
    assert.strictEqual(last.llmCalls.length, 1)
    assert.strictEqual(last.llmCalls[0].ok, false)
  })
})
