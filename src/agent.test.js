/**
 * Regression tests for Agent._buildSimpleBody + async memory (P0-1)
 *
 * Before the fix: when using SummarizingMemory (whose getMessages is async),
 * subsequent ReAct rounds produced a body whose `messages` was a Promise,
 * which JSON.stringify serialized to `{}` and the LLM API rejected.
 *
 * After the fix: _buildSimpleBody awaits memory.getMessages and always
 * returns a plain array.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Agent } from './agent.js'
import { SlidingWindowMemory, SummarizingMemory, TokenAwareMemory } from './memory.js'

describe('Agent._buildSimpleBody: async memory compatibility (P0-1)', () => {
  it('SummarizingMemory (async getMessages) yields a plain Array, not a Promise', async () => {
    const memory = new SummarizingMemory({ summarizer: async () => 'sum' })
    const agent = new Agent({
      provider: 'openai',
      apiKey: 'sk-fake',
      model: 'gpt-4',
      memory,
    })
    const { body } = await agent._buildSimpleBody()

    assert.ok(Array.isArray(body.messages), 'body.messages must be an Array')
    assert.ok(!(body.messages instanceof Promise), 'body.messages must not be a Promise')

    // Critical: JSON.stringify must preserve messages (not collapse to {})
    const roundTripped = JSON.parse(JSON.stringify(body)).messages
    assert.ok(Array.isArray(roundTripped), 'serialized messages must remain an Array')
    assert.ok(roundTripped.length > 0, 'at least system prompt should be serialized')
  })

  it('SlidingWindowMemory (sync getMessages) still works unchanged', async () => {
    const memory = new SlidingWindowMemory(10)
    const agent = new Agent({
      provider: 'openai',
      apiKey: 'sk-fake',
      model: 'gpt-4',
      memory,
    })
    agent.memory.add({ role: 'user', content: 'hi' })
    const { body } = await agent._buildSimpleBody()

    assert.ok(Array.isArray(body.messages))
    assert.strictEqual(body.messages.at(-1).content, 'hi')
  })

  it('TokenAwareMemory (sync getMessages) still works unchanged', async () => {
    const memory = new TokenAwareMemory(1000)
    const agent = new Agent({
      provider: 'openai',
      apiKey: 'sk-fake',
      model: 'gpt-4',
      memory,
    })
    agent.memory.add({ role: 'user', content: 'hello' })
    const { body } = await agent._buildSimpleBody()

    assert.ok(Array.isArray(body.messages))
    assert.strictEqual(body.messages.at(-1).content, 'hello')
  })

  it('multi-round ReAct with SummarizingMemory does not pass Promise to fetch', async () => {
    // Simulate what _reactLoop does on round >= 1
    const memory = new SummarizingMemory({ summarizer: async () => 'sum' })
    const agent = new Agent({
      provider: 'openai',
      apiKey: 'sk-fake',
      model: 'gpt-4',
      memory,
      maxRounds: 3,
    })
    agent.memory.add({ role: 'user', content: 'q' })
    agent.memory.add({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{}' } }],
    })
    agent.memory.add({ role: 'tool', tool_call_id: 't1', name: 'f', content: 'result' })

    // Second-round body construction
    const { body } = await agent._buildSimpleBody()
    const serialized = JSON.stringify(body)
    assert.ok(
      serialized.includes('"messages":['),
      'serialized body must contain a messages array, not an empty object'
    )
    assert.ok(
      !serialized.includes('"messages":{}'),
      'serialized body must NOT contain an empty object as messages'
    )
  })
})


// ===========================================================================
// Task 5.3 — Round + tool.call emission integration tests
//
// Scope (from tasks.md):
//   - Two-round ReAct where round 0 requests a tool call and round 1 returns
//     final text; assert the full event sequence and identity invariants.
//   - Trigger each `errorKind`: `'not_found'`, `'rejected'`, `'truncated_args'`,
//     `'aborted'`, `'exception'`.
//   - Verify `bytes` matches `utf8ByteLength` of the appended memory message
//     for both ASCII and multi-byte cases.
//   - Backward-compat: zero listeners → `chat()` returns the same final text;
//     `hooks.afterToolCall` receives unchanged `(name, arguments, result)`.
//
// Validates: Requirements 3.1-3.8, 4.3, 4.4, 4.6, 4.7, 5.5, 5.6, 9.1, 9.2, 9.3
// ===========================================================================

import { beforeEach, afterEach } from 'node:test'
import { utf8ByteLength } from './telemetry.js'
import { defineTool } from './tool.js'

// ---- shared fetch stub helpers -------------------------------------------

const _prevFetch_53 = { f: null }

/** Minimal `Response`-shaped object returning a canned JSON body. */
function _mockJson(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body) },
  }
}

/**
 * Build a sync (non-streaming) OpenAI chat-completion response that either
 * triggers a tool call or returns final text.
 *
 * Passing `finishReason: 'length'` together with `tool_calls` simulates the
 * "truncated arguments" case the ReAct loop guards against.
 */
function _completionWithToolCall({
  callId = 't1',
  toolName,
  argumentsJson = '{}',
  finishReason = 'tool_calls',
  content = null,
  usage = { prompt_tokens: 10, completion_tokens: 5 },
} = {}) {
  return {
    model: 'gpt-4o-mini',
    choices: [{
      message: {
        content,
        tool_calls: [{
          id: callId,
          type: 'function',
          function: { name: toolName, arguments: argumentsJson },
        }],
      },
      finish_reason: finishReason,
    }],
    usage,
  }
}

function _completionWithText({
  content = 'final',
  usage = { prompt_tokens: 10, completion_tokens: 5 },
} = {}) {
  return {
    model: 'gpt-4o-mini',
    choices: [{
      message: { content },
      finish_reason: 'stop',
    }],
    usage,
  }
}

/** Build a fetch stub that returns each queued response on successive calls. */
function _stubFetchSequence(responses) {
  let i = 0
  globalThis.fetch = async () => {
    if (i >= responses.length) {
      throw new Error(`fetch stub exhausted (call #${i + 1})`)
    }
    return _mockJson(responses[i++])
  }
}

/** Build an Agent wired with SlidingWindowMemory (sync) to avoid the default
 *  SummarizingMemory's async summarizer reaching the stubbed fetch. */
function _buildAgent({ tools = [], hooks = {}, maxRounds = 2 } = {}) {
  return new Agent({
    provider: 'openai',
    apiKey: 'sk-test',
    model: 'gpt-4o-mini',
    memory: new SlidingWindowMemory(50),
    tools,
    hooks,
    maxRounds,
  })
}

/** Install a single listener that records `{ type, payload }` in order. */
function _captureAllEvents(agent, types) {
  const events = []
  for (const t of types) {
    agent.on(t, p => events.push({ type: t, payload: p }))
  }
  return events
}

const ALL_TELEMETRY_TYPES = [
  'session.start',
  'session.end',
  'round.start',
  'round.end',
  'llm.call',
  'tool.call',
]

describe('Agent telemetry: round + tool.call emission (Task 5.3)', () => {
  beforeEach(() => { _prevFetch_53.f = globalThis.fetch })
  afterEach(() => { globalThis.fetch = _prevFetch_53.f })

  // -------------------------------------------------------------------------
  // Two-round ReAct event sequence
  // -------------------------------------------------------------------------

  it('emits session → round(0) → llm.call → tool.call → round.end(0) → round.start(1) → llm.call → round.end(1) → session.end in order (Req 3.1, 4.3, 4.4, 4.6, 5.5, 5.6)', async () => {
    const echo = defineTool({
      name: 'echo',
      description: 'Echo input',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      execute: async ({ text }) => `echoed:${text}`,
    })

    _stubFetchSequence([
      _completionWithToolCall({
        toolName: 'echo',
        argumentsJson: JSON.stringify({ text: 'hi' }),
      }),
      _completionWithText({ content: 'final-answer' }),
    ])

    const agent = _buildAgent({ tools: [echo] })
    const events = _captureAllEvents(agent, ALL_TELEMETRY_TYPES)

    const reply = await agent.chat('please echo hi')
    assert.strictEqual(reply, 'final-answer')

    // Assert the exact sequence of event types.
    const seq = events.map(e => e.type)
    assert.deepStrictEqual(seq, [
      'session.start',
      'round.start',
      'llm.call',
      'tool.call',
      'round.end',
      'round.start',
      'llm.call',
      'round.end',
      'session.end',
    ])

    // Extract by position.
    const [
      sessionStart,
      round0Start,
      llm0,
      toolCall,
      round0End,
      round1Start,
      llm1,
      round1End,
      sessionEnd,
    ] = events.map(e => e.payload)

    // Req 4.6: all events share the same traceId.
    const traceId = sessionStart.traceId
    assert.match(traceId, /^[0-9a-f]{32}$/)
    for (const p of [round0Start, llm0, toolCall, round0End, round1Start, llm1, round1End, sessionEnd]) {
      assert.strictEqual(p.traceId, traceId)
    }

    // Req 5.5, 5.6: round.start / round.end spanIds match, round indices are
    // zero-based and sequential.
    assert.strictEqual(round0Start.round, 0)
    assert.strictEqual(round0End.round, 0)
    assert.strictEqual(round0End.spanId, round0Start.spanId)
    assert.strictEqual(round1Start.round, 1)
    assert.strictEqual(round1End.round, 1)
    assert.strictEqual(round1End.spanId, round1Start.spanId)
    assert.notStrictEqual(round0Start.spanId, round1Start.spanId)

    // Req 4.3: each llm.call's parentSpanId points at its round's span.
    assert.strictEqual(llm0.parentSpanId, round0Start.spanId)
    assert.strictEqual(llm1.parentSpanId, round1Start.spanId)

    // Req 4.4: tool.call.parentSpanId equals the llm.call.spanId of the same
    // round.
    assert.strictEqual(toolCall.parentSpanId, llm0.spanId)

    // Req 4.7: span-tree root invariants — session root has null parent.
    assert.strictEqual(sessionStart.parentSpanId, null)
    assert.strictEqual(round0Start.parentSpanId, sessionStart.spanId)
    assert.strictEqual(round1Start.parentSpanId, sessionStart.spanId)

    // Req 3.1: exactly one tool.call for one execution.
    assert.strictEqual(events.filter(e => e.type === 'tool.call').length, 1)

    // Req 3.2, 3.3: name + parsed arguments.
    assert.strictEqual(toolCall.name, 'echo')
    assert.deepStrictEqual(toolCall.arguments, { text: 'hi' })

    // Req 3.6: ok:true on successful execution; no errorKind.
    assert.strictEqual(toolCall.ok, true)
    assert.strictEqual(toolCall.errorKind, undefined)

    // Req 3.4, 3.5: numeric fields.
    assert.strictEqual(typeof toolCall.durationMs, 'number')
    assert.ok(toolCall.durationMs >= 0)
    assert.strictEqual(toolCall.bytes, utf8ByteLength('echoed:hi'))

    // session.end carries Run_Metrics + ok:true.
    assert.strictEqual(sessionEnd.ok, true)
    assert.strictEqual(sessionEnd.totalLlmCalls, 2)
    assert.strictEqual(sessionEnd.totalToolCalls, 1)
    assert.strictEqual(sessionEnd.totalRounds, 2)
  })

  // -------------------------------------------------------------------------
  // errorKind classification — one mini-scenario per kind
  // -------------------------------------------------------------------------

  it('errorKind "not_found" when the LLM requests a tool that is not registered (Req 3.1, 3.6, 3.7)', async () => {
    _stubFetchSequence([
      _completionWithToolCall({ toolName: 'ghost', argumentsJson: '{}' }),
      _completionWithText({ content: 'done' }),
    ])

    const agent = _buildAgent({ tools: [] })
    const toolCalls = []
    agent.on('tool.call', e => toolCalls.push(e))

    const reply = await agent.chat('call missing')
    assert.strictEqual(reply, 'done')

    assert.strictEqual(toolCalls.length, 1)
    const t = toolCalls[0]
    assert.strictEqual(t.name, 'ghost')
    assert.strictEqual(t.ok, false)
    assert.strictEqual(t.errorKind, 'not_found')
    // arguments is the parsed object (parseToolCalls returns {} on empty JSON).
    assert.deepStrictEqual(t.arguments, {})
  })

  it('errorKind "rejected" when hooks.beforeToolCall returns false (Req 3.6, 3.7)', async () => {
    const echo = defineTool({
      name: 'echo',
      description: 'Echo input',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'should-not-run',
    })

    _stubFetchSequence([
      _completionWithToolCall({ toolName: 'echo', argumentsJson: '{}' }),
      _completionWithText({ content: 'done' }),
    ])

    let executeRan = false
    const agent = _buildAgent({
      tools: [defineTool({
        ...echo,
        execute: async () => { executeRan = true; return 'bad' },
      })],
      hooks: {
        beforeToolCall: () => false,
      },
    })
    const toolCalls = []
    agent.on('tool.call', e => toolCalls.push(e))

    const reply = await agent.chat('echo')
    assert.strictEqual(reply, 'done')
    assert.strictEqual(executeRan, false, 'rejected tools must not be executed')

    assert.strictEqual(toolCalls.length, 1)
    const t = toolCalls[0]
    assert.strictEqual(t.name, 'echo')
    assert.strictEqual(t.ok, false)
    assert.strictEqual(t.errorKind, 'rejected')
  })

  it('errorKind "truncated_args" when finish_reason=length and arguments JSON is unparseable (Req 3.6, 3.7)', async () => {
    const echo = defineTool({
      name: 'echo',
      description: 'Echo input',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'nope',
    })

    // Truncated JSON in arguments + finish_reason === 'length' → parseToolCalls
    // yields `_truncated: true, _parseError: <msg>`.
    _stubFetchSequence([
      _completionWithToolCall({
        toolName: 'echo',
        argumentsJson: '{"text": "hello',   // unterminated
        finishReason: 'length',
      }),
      _completionWithText({ content: 'done' }),
    ])

    const agent = _buildAgent({ tools: [echo] })
    const toolCalls = []
    agent.on('tool.call', e => toolCalls.push(e))

    const reply = await agent.chat('make a truncated call')
    assert.strictEqual(reply, 'done')

    assert.strictEqual(toolCalls.length, 1)
    const t = toolCalls[0]
    assert.strictEqual(t.name, 'echo')
    assert.strictEqual(t.ok, false)
    assert.strictEqual(t.errorKind, 'truncated_args')
  })

  it('errorKind "aborted" when tool execute throws an AbortError (Req 3.6, 3.7)', async () => {
    const abortive = defineTool({
      name: 'abortive',
      description: 'Throws abort',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        const err = new Error('The operation was aborted')
        err.name = 'AbortError'
        throw err
      },
    })

    _stubFetchSequence([
      _completionWithToolCall({ toolName: 'abortive', argumentsJson: '{}' }),
      _completionWithText({ content: 'done' }),
    ])

    const agent = _buildAgent({ tools: [abortive] })
    const toolCalls = []
    agent.on('tool.call', e => toolCalls.push(e))

    const reply = await agent.chat('abort please')
    assert.strictEqual(reply, 'done')

    assert.strictEqual(toolCalls.length, 1)
    const t = toolCalls[0]
    assert.strictEqual(t.name, 'abortive')
    assert.strictEqual(t.ok, false)
    assert.strictEqual(t.errorKind, 'aborted')
  })

  it('errorKind "exception" when tool execute throws a generic Error (Req 3.6, 3.7)', async () => {
    const boom = defineTool({
      name: 'boom',
      description: 'Throws',
      parameters: { type: 'object', properties: {} },
      execute: async () => { throw new Error('kapow') },
    })

    _stubFetchSequence([
      _completionWithToolCall({ toolName: 'boom', argumentsJson: '{}' }),
      _completionWithText({ content: 'done' }),
    ])

    const agent = _buildAgent({ tools: [boom] })
    const toolCalls = []
    agent.on('tool.call', e => toolCalls.push(e))

    const reply = await agent.chat('go boom')
    assert.strictEqual(reply, 'done')

    assert.strictEqual(toolCalls.length, 1)
    const t = toolCalls[0]
    assert.strictEqual(t.name, 'boom')
    assert.strictEqual(t.ok, false)
    assert.strictEqual(t.errorKind, 'exception')
  })

  // -------------------------------------------------------------------------
  // bytes = utf8ByteLength of the appended memory message
  // -------------------------------------------------------------------------

  it('bytes matches utf8ByteLength of the appended memory content for ASCII (Req 3.5)', async () => {
    const ascii = defineTool({
      name: 'ascii',
      description: 'ASCII result',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'hello, world!',
    })

    _stubFetchSequence([
      _completionWithToolCall({ toolName: 'ascii', argumentsJson: '{}' }),
      _completionWithText({ content: 'done' }),
    ])

    const agent = _buildAgent({ tools: [ascii] })
    const toolCalls = []
    agent.on('tool.call', e => toolCalls.push(e))

    await agent.chat('go')

    assert.strictEqual(toolCalls.length, 1)
    const t = toolCalls[0]
    // ASCII: one byte per character.
    assert.strictEqual(t.bytes, 13)
    assert.strictEqual(t.bytes, utf8ByteLength('hello, world!'))

    // The same string is the content of the tool message appended to memory.
    const msgs = await agent.memory.getMessages()
    const toolMsg = msgs.find(m => m.role === 'tool' && m.name === 'ascii')
    assert.ok(toolMsg, 'expected tool message in memory')
    assert.strictEqual(t.bytes, utf8ByteLength(toolMsg.content))
  })

  it('bytes matches utf8ByteLength of the appended memory content for multi-byte UTF-8 (Req 3.5)', async () => {
    // 中文 + emoji — all multi-byte: 3 + 3 + 4 = 10 bytes.
    const payload = '中文😀'
    const mb = defineTool({
      name: 'mb',
      description: 'Multi-byte result',
      parameters: { type: 'object', properties: {} },
      execute: async () => payload,
    })

    _stubFetchSequence([
      _completionWithToolCall({ toolName: 'mb', argumentsJson: '{}' }),
      _completionWithText({ content: 'done' }),
    ])

    const agent = _buildAgent({ tools: [mb] })
    const toolCalls = []
    agent.on('tool.call', e => toolCalls.push(e))

    await agent.chat('go')

    assert.strictEqual(toolCalls.length, 1)
    const t = toolCalls[0]
    assert.strictEqual(t.bytes, 10)
    assert.strictEqual(t.bytes, utf8ByteLength(payload))

    const msgs = await agent.memory.getMessages()
    const toolMsg = msgs.find(m => m.role === 'tool' && m.name === 'mb')
    assert.ok(toolMsg)
    assert.strictEqual(t.bytes, utf8ByteLength(toolMsg.content))
  })

  // -------------------------------------------------------------------------
  // Backward compatibility — zero listeners
  // -------------------------------------------------------------------------

  it('backward-compat: chat() returns the same string with zero listeners; afterToolCall receives unchanged (name, arguments, result) (Req 9.1, 9.2, 9.3)', async () => {
    const echo = defineTool({
      name: 'echo',
      description: 'Echo input',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      execute: async ({ text }) => `echoed:${text}`,
    })

    // Run 1 — no telemetry listeners, capture the baseline return string and
    // afterToolCall arguments.
    _stubFetchSequence([
      _completionWithToolCall({
        toolName: 'echo',
        argumentsJson: JSON.stringify({ text: 'hi' }),
      }),
      _completionWithText({ content: 'canonical-reply' }),
    ])
    const afterCalls1 = []
    const agent1 = _buildAgent({
      tools: [echo],
      hooks: {
        afterToolCall: (name, args, result) => afterCalls1.push({ name, args, result }),
      },
    })
    const reply1 = await agent1.chat('echo hi')

    // Run 2 — register listeners for every framework event type; expect an
    // identical return string and identical afterToolCall invocations.
    _stubFetchSequence([
      _completionWithToolCall({
        toolName: 'echo',
        argumentsJson: JSON.stringify({ text: 'hi' }),
      }),
      _completionWithText({ content: 'canonical-reply' }),
    ])
    const afterCalls2 = []
    const agent2 = _buildAgent({
      tools: [echo],
      hooks: {
        afterToolCall: (name, args, result) => afterCalls2.push({ name, args, result }),
      },
    })
    for (const t of ALL_TELEMETRY_TYPES) agent2.on(t, () => {})
    const reply2 = await agent2.chat('echo hi')

    // Req 9.1: identical final string.
    assert.strictEqual(reply1, 'canonical-reply')
    assert.strictEqual(reply2, reply1)

    // Req 9.3: afterToolCall receives unchanged (name, arguments, result).
    assert.strictEqual(afterCalls1.length, 1)
    assert.strictEqual(afterCalls2.length, 1)
    assert.deepStrictEqual(afterCalls1[0], {
      name: 'echo',
      args: { text: 'hi' },
      result: 'echoed:hi',
    })
    assert.deepStrictEqual(afterCalls2[0], afterCalls1[0])
  })
})


// ===========================================================================
// Task 7.4 — Sidecar `operation.name` tagging integration tests
//
// Scope (from tasks.md):
//   - Stubbed run with `enableIntentRecognition: true` → one llm.call tagged
//     `agent.intent` sharing the session's traceId.
//   - Stubbed run with `SummarizingMemory` triggered → an llm.call tagged
//     `agent.summarize`, same traceId.
//   - Stubbed `plan_and_execute` run exercising planner / step / synthesizer
//     → llm.call events tagged `plan.planner`, `plan.step`, `plan.synthesizer`
//     in order, all sharing the session's traceId.
//   - Stubbed replan path → `plan.replan` emitted.
//
// Validates: Requirements 6.2, 6.3, 6.4, 6.5, 6.6, 6.7
// ===========================================================================

const _prevFetch_74 = { f: null }

describe('Agent sidecar operation.name tagging (Task 7.4)', () => {
  beforeEach(() => { _prevFetch_74.f = globalThis.fetch })
  afterEach(() => { globalThis.fetch = _prevFetch_74.f })

  // -------------------------------------------------------------------------
  // 6.2 — IntentRecognizer emits `agent.intent`
  // -------------------------------------------------------------------------

  it('emits an llm.call with operation.name "agent.intent" when enableIntentRecognition=true, sharing the session traceId (Req 6.2)', async () => {
    // IntentRecognizer parses JSON from message.content. Anything matching the
    // shape is accepted; parse failures fall back to a default result but still
    // emit the llm.call — we only care about the event tagging here.
    const intentJson = JSON.stringify({
      clarity: 'CLEAR',
      complexity: 'SIMPLE',
      recommendedStrategy: 'react',
      reasoning: 'test',
      filteredToolNames: [],
    })

    _stubFetchSequence([
      // First fetch: IntentRecognizer sidecar call.
      _completionWithText({ content: intentJson }),
      // Second fetch: main ReAct round 0 (returns final text, no tool calls).
      _completionWithText({ content: 'final' }),
    ])

    const agent = new Agent({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      memory: new SlidingWindowMemory(50),
      tools: [],
      maxRounds: 2,
      enableIntentRecognition: true,
    })

    const sessionStarts = []
    const llmCalls = []
    const roundStarts = []
    agent.on('session.start', p => sessionStarts.push(p))
    agent.on('llm.call', p => llmCalls.push(p))
    agent.on('round.start', p => roundStarts.push(p))

    const reply = await agent.chat('hello')
    assert.strictEqual(reply, 'final')

    // Req 6.2: at least one llm.call tagged 'agent.intent'.
    const intentCalls = llmCalls.filter(e => e['gen_ai.operation.name'] === 'agent.intent')
    assert.strictEqual(intentCalls.length, 1, 'exactly one agent.intent llm.call expected')

    // Same traceId as session.start.
    assert.strictEqual(sessionStarts.length, 1)
    const traceId = sessionStarts[0].traceId
    assert.strictEqual(intentCalls[0].traceId, traceId)

    // The intent call must be emitted BEFORE the main `agent.chat` call for
    // the same round (the intent is produced inside _runPipeline which
    // precedes the main syncChat within the round body).
    const intentIdx = llmCalls.findIndex(e => e['gen_ai.operation.name'] === 'agent.intent')
    const chatIdx = llmCalls.findIndex(e => e['gen_ai.operation.name'] === 'agent.chat')
    assert.ok(intentIdx >= 0 && chatIdx >= 0, 'both agent.intent and agent.chat llm.calls expected')
    assert.ok(intentIdx < chatIdx, 'agent.intent must precede agent.chat')

    // Sanity: round.start was emitted and carries the same traceId.
    assert.ok(roundStarts.length >= 1)
    assert.strictEqual(roundStarts[0].traceId, traceId)
  })

  // -------------------------------------------------------------------------
  // 6.3 — SummarizingMemory summarizer emits `agent.summarize`
  // -------------------------------------------------------------------------

  it('emits an llm.call with operation.name "agent.summarize" when SummarizingMemory compresses history mid-chat (Req 6.3)', async () => {
    // When no `memory` is provided, the Agent constructs a default
    // SummarizingMemory whose summarizer is wired to emit telemetry via the
    // current run's root TelemetryContext. Setting a low threshold ensures
    // the first `getMessages()` call inside `_runPipeline` triggers the
    // summarizer before the main chat dispatch.
    //
    // Fetch order inside chat():
    //   1. Summarizer sidecar call (via memory.getMessages → _maybeSummarize)
    //   2. Main ReAct round 0 call (returns final text)
    _stubFetchSequence([
      _completionWithText({ content: 'brief summary' }),
      _completionWithText({ content: 'final' }),
    ])

    const agent = new Agent({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      memoryOpts: { threshold: 2, keepRecent: 1 },
      tools: [],
      maxRounds: 2,
    })

    // Pre-populate the memory with enough non-system messages so the first
    // getMessages() inside chat() exceeds `threshold: 2`. After chat() adds
    // its own user message, the non-system count is 4 (>2) → summarize fires.
    agent.memory.add({ role: 'user', content: 'a' })
    agent.memory.add({ role: 'assistant', content: 'b' })
    agent.memory.add({ role: 'user', content: 'c' })

    const sessionStarts = []
    const llmCalls = []
    agent.on('session.start', p => sessionStarts.push(p))
    agent.on('llm.call', p => llmCalls.push(p))

    const reply = await agent.chat('next question')
    assert.strictEqual(reply, 'final')

    // Req 6.3: at least one llm.call tagged 'agent.summarize'.
    const summarizeCalls = llmCalls.filter(e => e['gen_ai.operation.name'] === 'agent.summarize')
    assert.strictEqual(summarizeCalls.length, 1, 'exactly one agent.summarize llm.call expected')

    // Same traceId as session.start.
    assert.strictEqual(sessionStarts.length, 1)
    const traceId = sessionStarts[0].traceId
    assert.strictEqual(summarizeCalls[0].traceId, traceId)

    // Summarize call precedes the main chat call — it runs inside
    // _getMessages before the main syncChat dispatch.
    const summarizeIdx = llmCalls.findIndex(e => e['gen_ai.operation.name'] === 'agent.summarize')
    const chatIdx = llmCalls.findIndex(e => e['gen_ai.operation.name'] === 'agent.chat')
    assert.ok(summarizeIdx >= 0 && chatIdx >= 0, 'both agent.summarize and agent.chat llm.calls expected')
    assert.ok(summarizeIdx < chatIdx, 'agent.summarize must precede agent.chat')
  })

  // -------------------------------------------------------------------------
  // 6.4 / 6.5 / 6.7 — plan_and_execute planner / step / synthesizer tagging
  // -------------------------------------------------------------------------

  it('emits llm.call events tagged plan.planner → plan.step → plan.synthesizer (in order) when strategy=plan_and_execute with a multi-step plan (Req 6.4, 6.5, 6.7)', async () => {
    // 2-step plan forces the synthesizer to run (single-step plans short-
    // circuit in _synthesizeResults). Each step uses the inner _reactLoop
    // which returns immediately when the response has no tool_calls — so we
    // only need one `plan.step` call per step.
    //
    // Fetch order:
    //   1. planner (JSON array)
    //   2. step 0 (content, no tool_calls → returns content)
    //   3. step 1 (content, no tool_calls → returns content)
    //   4. synthesizer (content)
    const planJson = JSON.stringify([
      { step: 1, description: 'first' },
      { step: 2, description: 'second' },
    ])

    _stubFetchSequence([
      _completionWithText({ content: planJson }),
      _completionWithText({ content: 'step-0-done' }),
      _completionWithText({ content: 'step-1-done' }),
      _completionWithText({ content: 'final-synth' }),
    ])

    const agent = new Agent({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      memory: new SlidingWindowMemory(50),
      tools: [],
      maxRounds: 2,
      strategy: 'plan_and_execute',
    })

    const sessionStarts = []
    const llmCalls = []
    agent.on('session.start', p => sessionStarts.push(p))
    agent.on('llm.call', p => llmCalls.push(p))

    const reply = await agent.chat('do two things')
    assert.strictEqual(reply, 'final-synth')

    // All llm.calls succeeded (ok:true) and share one traceId.
    assert.strictEqual(sessionStarts.length, 1)
    const traceId = sessionStarts[0].traceId
    for (const e of llmCalls) {
      assert.strictEqual(e.traceId, traceId)
      assert.strictEqual(e.ok, true)
    }

    // Extract the operation.name sequence in emission order.
    const opNames = llmCalls.map(e => e['gen_ai.operation.name'])

    // Req 6.4: planner tagged 'plan.planner', exactly once.
    assert.strictEqual(
      opNames.filter(n => n === 'plan.planner').length,
      1,
      'exactly one plan.planner llm.call expected',
    )
    // Req 6.7: each plan step tagged 'plan.step' (one per executed step).
    assert.strictEqual(
      opNames.filter(n => n === 'plan.step').length,
      2,
      'expected two plan.step llm.calls for a 2-step plan',
    )
    // Req 6.5: synthesizer tagged 'plan.synthesizer', exactly once.
    assert.strictEqual(
      opNames.filter(n => n === 'plan.synthesizer').length,
      1,
      'exactly one plan.synthesizer llm.call expected',
    )

    // Ordering: planner → step → step → synthesizer.
    assert.deepStrictEqual(opNames, [
      'plan.planner',
      'plan.step',
      'plan.step',
      'plan.synthesizer',
    ])
  })

  // -------------------------------------------------------------------------
  // 6.6 — plan_and_execute replan path emits `plan.replan`
  // -------------------------------------------------------------------------

  it('emits an llm.call with operation.name "plan.replan" when a step fails and the strategy replans (Req 6.6)', async () => {
    // Strategy: 2-step plan. Step 0's inner _reactLoop throws
    // "Empty LLM response" because the stubbed response's `choices` is empty
    // (no `message`). That fires one plan.step llm.call (ok:true — the HTTP
    // call succeeded; the error is raised post-emission) and propagates up
    // to `execute`, which calls `_attemptReplan`. The replan stubs return a
    // 1-step revised plan; the revised step runs successfully and the
    // synthesizer wraps up.
    //
    // Fetch order:
    //   1. planner              → plan.planner
    //   2. step 0 (malformed)   → plan.step (ok:true, but parses to no-msg
    //                              which throws inside _reactLoop)
    //   3. replan               → plan.replan
    //   4. revised step         → plan.step
    //   5. synthesizer          → plan.synthesizer
    const planJson = JSON.stringify([
      { step: 1, description: 'first' },
      { step: 2, description: 'second' },
    ])
    const revisedJson = JSON.stringify([
      { step: 1, description: 'recovered' },
    ])

    // A response with empty `choices` makes `message` undefined, which
    // _reactLoop rejects with "Empty LLM response". The fetch itself still
    // returns 200 OK so llm.call fires with ok:true before the throw.
    const malformedStepResponse = {
      model: 'gpt-4o-mini',
      choices: [],
    }

    _stubFetchSequence([
      _completionWithText({ content: planJson }),
      malformedStepResponse,
      _completionWithText({ content: revisedJson }),
      _completionWithText({ content: 'revised-done' }),
      _completionWithText({ content: 'final-after-replan' }),
    ])

    const agent = new Agent({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      memory: new SlidingWindowMemory(50),
      tools: [],
      maxRounds: 2,
      strategy: 'plan_and_execute',
      // Default maxReplanAttempts=2, so one replan is always allowed.
    })

    const sessionStarts = []
    const llmCalls = []
    agent.on('session.start', p => sessionStarts.push(p))
    agent.on('llm.call', p => llmCalls.push(p))

    const reply = await agent.chat('do two things')
    assert.strictEqual(reply, 'final-after-replan')

    assert.strictEqual(sessionStarts.length, 1)
    const traceId = sessionStarts[0].traceId

    // Req 6.6: at least one llm.call tagged 'plan.replan', sharing traceId.
    const replanCalls = llmCalls.filter(e => e['gen_ai.operation.name'] === 'plan.replan')
    assert.strictEqual(replanCalls.length, 1, 'exactly one plan.replan llm.call expected')
    assert.strictEqual(replanCalls[0].traceId, traceId)

    // Replan must come AFTER the planner and AFTER at least one plan.step.
    const firstReplanIdx = llmCalls.findIndex(e => e['gen_ai.operation.name'] === 'plan.replan')
    const plannerIdx = llmCalls.findIndex(e => e['gen_ai.operation.name'] === 'plan.planner')
    const firstStepIdx = llmCalls.findIndex(e => e['gen_ai.operation.name'] === 'plan.step')
    assert.ok(plannerIdx >= 0 && firstStepIdx >= 0, 'planner and step llm.calls expected')
    assert.ok(plannerIdx < firstReplanIdx, 'plan.planner must precede plan.replan')
    assert.ok(firstStepIdx < firstReplanIdx, 'at least one plan.step must precede plan.replan')
  })
})


// ===========================================================================
// Task 9.1 — Session lifecycle invariants + backward-compat integration
//
// Scope (from tasks.md, filling gaps left by Task 3.3 and Task 5.3):
//   - Session ordering: `session.start` first, `session.end` last; every
//     intermediate event shares the run's traceId.
//   - Round pairing: each `round.start` has exactly one matching `round.end`
//     with the same spanId.
//   - Tool-call parent-span invariant: every `tool.call.parentSpanId`
//     references an `llm.call.spanId` emitted earlier in the same run.
//   - Span-tree invariant (Req 4.7): every non-root `parentSpanId` in the
//     event stream references a `spanId` that appeared earlier in that
//     stream.
//   - Abort path: `signal.abort()` mid-tool-execution → `session.end` still
//     fires last with `ok:false`; `Run_Metrics.toolCalls` contains the
//     partial execution history.
//   - Backward compat — `stream()`: yields the same non-telemetry event
//     shapes (`delta`, `tool_call`, `tool_start`, `tool_end`, `done`) whether
//     or not telemetry listeners are registered; final accumulated string
//     and `hooks.afterToolCall` args are identical.
//   - `getLastRunMetrics()` / `getSessionMetrics()` totals match sums
//     derived from captured events.
//
// Avoids duplicating Task 3.3 / 5.3 coverage — those already validate the
// two-round tool-execution sequence, single-round session ordering, and
// individual errorKind classification.
//
// Validates: Requirements 4.6, 4.7, 5.1, 5.2, 5.7, 8.1, 8.2, 8.3, 9.1, 9.2, 9.3
// ===========================================================================

const _prevFetch_91 = { f: null }

/** Minimal SSE `Response` shim — mirrors the helper in telemetry.test.js. */
function _mockSse_91(chunks) {
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
            if (released || idx >= chunks.length) {
              return { done: true, value: undefined }
            }
            return { done: false, value: encoder.encode(chunks[idx++]) }
          },
          releaseLock() { released = true },
        }
      },
    },
    async text() { return '' },
    async json() { return {} },
  }
}

/** Build an SSE chunk stream for a single round that either returns text
 *  only or emits one tool_call + text. The LLM client yields `delta` and
 *  `tool_call` events then a terminal `done` on [DONE]. */
function _sseText(content, { model = 'gpt-4o-mini' } = {}) {
  const delta = 'data: ' + JSON.stringify({
    model, choices: [{ index: 0, delta: { content } }],
  }) + '\n'
  const finish = 'data: ' + JSON.stringify({
    model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  }) + '\n'
  return [delta, finish, 'data: [DONE]\n']
}

function _sseToolCall({ callId = 't1', toolName, argumentsJson = '{}', model = 'gpt-4o-mini' }) {
  // Open a tool_call (id + name), send the arguments in a second delta,
  // then finish_reason=tool_calls + [DONE]. This matches the accumulator
  // loop in `streamChatIter`.
  const open = 'data: ' + JSON.stringify({
    model,
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0, id: callId, type: 'function',
          function: { name: toolName, arguments: '' },
        }],
      },
    }],
  }) + '\n'
  const args = 'data: ' + JSON.stringify({
    model,
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{ index: 0, function: { arguments: argumentsJson } }],
      },
    }],
  }) + '\n'
  const finish = 'data: ' + JSON.stringify({
    model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
  }) + '\n'
  return [open, args, finish, 'data: [DONE]\n']
}

/** Build a fetch stub that serves a sequence of responses in order. Each
 *  entry is either `{ json: <object> }` for the non-streaming path or
 *  `{ sse: <string[]> }` for the streaming path. */
function _stubFetchMixed(responses) {
  let i = 0
  globalThis.fetch = async () => {
    if (i >= responses.length) {
      throw new Error(`fetch stub exhausted (call #${i + 1})`)
    }
    const r = responses[i++]
    if (r.sse) return _mockSse_91(r.sse)
    return _mockJson(r.json)
  }
}

describe('Agent telemetry: end-to-end invariants (Task 9.1)', () => {
  beforeEach(() => { _prevFetch_91.f = globalThis.fetch })
  afterEach(() => { globalThis.fetch = _prevFetch_91.f })

  // -------------------------------------------------------------------------
  // Session ordering + traceId propagation across the full event stream
  // -------------------------------------------------------------------------

  it('session.start is first, session.end is last, and every intermediate event shares the run traceId (Req 4.6, 5.1, 5.2)', async () => {
    const echo = defineTool({
      name: 'echo',
      description: 'Echo',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
      execute: async ({ text }) => `echoed:${text}`,
    })

    _stubFetchSequence([
      _completionWithToolCall({ toolName: 'echo', argumentsJson: JSON.stringify({ text: 'hi' }) }),
      _completionWithText({ content: 'done' }),
    ])

    const agent = _buildAgent({ tools: [echo] })
    const events = _captureAllEvents(agent, ALL_TELEMETRY_TYPES)

    const reply = await agent.chat('echo hi')
    assert.strictEqual(reply, 'done')

    // Req 5.1: session.start is first.
    assert.strictEqual(events[0].type, 'session.start')
    // Req 5.2: session.end is last.
    assert.strictEqual(events[events.length - 1].type, 'session.end')
    // Exactly one session.start and one session.end.
    assert.strictEqual(events.filter(e => e.type === 'session.start').length, 1)
    assert.strictEqual(events.filter(e => e.type === 'session.end').length, 1)

    // Req 4.6: every event carries the same traceId.
    const traceId = events[0].payload.traceId
    assert.match(traceId, /^[0-9a-f]{32}$/)
    for (const e of events) {
      assert.strictEqual(e.payload.traceId, traceId,
        `event ${e.type} carries a different traceId`)
    }
  })

  // -------------------------------------------------------------------------
  // Round pairing across multiple rounds
  // -------------------------------------------------------------------------

  it('each round.start has exactly one matching round.end with the same spanId, across multi-round runs (Req 5.5, 5.6)', async () => {
    const t = defineTool({
      name: 't',
      description: 'noop',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'r',
    })

    // Three rounds: two tool calls then final text.
    _stubFetchSequence([
      _completionWithToolCall({ toolName: 't', argumentsJson: '{}', callId: 'c0' }),
      _completionWithToolCall({ toolName: 't', argumentsJson: '{}', callId: 'c1' }),
      _completionWithText({ content: 'done' }),
    ])

    const agent = _buildAgent({ tools: [t], maxRounds: 5 })
    const events = _captureAllEvents(agent, ['round.start', 'round.end'])

    const reply = await agent.chat('go')
    assert.strictEqual(reply, 'done')

    const starts = events.filter(e => e.type === 'round.start').map(e => e.payload)
    const ends = events.filter(e => e.type === 'round.end').map(e => e.payload)

    assert.strictEqual(starts.length, 3)
    assert.strictEqual(ends.length, 3)

    // Pair each round.start with exactly one round.end sharing the same
    // spanId. Also verify the `round` index is consistent between the pair.
    for (const s of starts) {
      const matched = ends.filter(e => e.spanId === s.spanId)
      assert.strictEqual(matched.length, 1,
        `round.start(spanId=${s.spanId}) must have exactly one matching round.end`)
      assert.strictEqual(matched[0].round, s.round,
        'paired round.start and round.end must share the same `round` index')
    }

    // Round indices are 0, 1, 2 in emission order.
    assert.deepStrictEqual(starts.map(s => s.round), [0, 1, 2])

    // spanIds across rounds are distinct.
    const spanIds = starts.map(s => s.spanId)
    assert.strictEqual(new Set(spanIds).size, spanIds.length)
  })

  // -------------------------------------------------------------------------
  // Span-tree well-formedness invariant (Req 4.7)
  // -------------------------------------------------------------------------

  it('every non-root parentSpanId in the event stream references a spanId that appeared earlier (Req 4.7)', async () => {
    // Same two-round scenario as Task 5.3 but with the structural invariant
    // asserted across the entire event stream instead of by-position.
    const echo = defineTool({
      name: 'echo',
      description: 'Echo',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
      execute: async ({ text }) => `echoed:${text}`,
    })

    _stubFetchSequence([
      _completionWithToolCall({ toolName: 'echo', argumentsJson: JSON.stringify({ text: 'a' }) }),
      _completionWithText({ content: 'final' }),
    ])

    const agent = _buildAgent({ tools: [echo] })
    const events = _captureAllEvents(agent, ALL_TELEMETRY_TYPES)

    await agent.chat('echo a')

    // Walk the stream and verify every event that DECLARES a `parentSpanId`
    // references a spanId that was emitted earlier. `round.end` and
    // `session.end` omit `parentSpanId` entirely because they close a span
    // already opened by the matching `round.start` / `session.start`; those
    // close-events don't introduce a new parent edge to check.
    const seen = new Set()
    const declaresParent = (ev) => 'parentSpanId' in ev.payload

    for (const ev of events) {
      if (declaresParent(ev)) {
        const { parentSpanId } = ev.payload
        if (parentSpanId === null) {
          // Only session.start (the trace root) may declare a null parent.
          assert.strictEqual(ev.type, 'session.start',
            `only session.start may declare a null parentSpanId; got ${ev.type}`)
        } else {
          assert.ok(
            seen.has(parentSpanId),
            `event ${ev.type} referenced parentSpanId=${parentSpanId} which was not emitted earlier`,
          )
        }
      }
      if (ev.payload.spanId != null) seen.add(ev.payload.spanId)
    }

    // Sanity: every span span-opening event type was observed with a
    // parentSpanId field (this guards against the underlying emit site
    // silently dropping the field in the future).
    for (const ev of events.filter(e => ['session.start', 'round.start', 'llm.call', 'tool.call'].includes(e.type))) {
      assert.ok(declaresParent(ev), `${ev.type} must declare a parentSpanId field`)
    }

    // Cross-check tool-call parent invariant: every tool.call.parentSpanId
    // equals an llm.call.spanId emitted earlier in the same run.
    const llmSpansByOrder = []
    for (const ev of events) {
      if (ev.type === 'llm.call') llmSpansByOrder.push(ev.payload.spanId)
      if (ev.type === 'tool.call') {
        assert.ok(
          llmSpansByOrder.includes(ev.payload.parentSpanId),
          `tool.call.parentSpanId=${ev.payload.parentSpanId} must reference an earlier llm.call.spanId`,
        )
      }
    }
  })

  // -------------------------------------------------------------------------
  // Abort mid-tool-execution: session.end still last with ok:false
  // -------------------------------------------------------------------------

  it('signal.abort() mid-tool-execution: session.end fires last with ok:false; Run_Metrics.toolCalls contains partial history (Req 5.7, 8.3)', async () => {
    // Two-tool round: first tool completes cleanly, second tool hangs until
    // the abort fires, then throws AbortError. Expected:
    //   - tool 0 emits `tool.call` with ok:true
    //   - tool 1 emits `tool.call` with ok:false, errorKind:'aborted'
    //   - round.end and session.end still fire; session.end.ok === false
    //   - Run_Metrics.toolCalls has BOTH entries
    const controller = new AbortController()

    const fast = defineTool({
      name: 'fast',
      description: 'Returns quickly',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'ok-fast',
    })
    const slow = defineTool({
      name: 'slow',
      description: 'Hangs until abort',
      parameters: { type: 'object', properties: {} },
      execute: async (_args, { signal } = {}) => {
        // Trigger abort from inside the tool so we exercise the mid-round
        // abort path. Wait on the signal and then throw AbortError — this
        // is how long-running tools are expected to cooperate with abort.
        await new Promise((resolve, reject) => {
          const onAbort = () => {
            const err = new Error('The operation was aborted')
            err.name = 'AbortError'
            reject(err)
          }
          if (signal?.aborted) return onAbort()
          signal?.addEventListener('abort', onAbort, { once: true })
          // Schedule the abort on the next microtask so the listener has
          // been registered.
          queueMicrotask(() => controller.abort())
        })
        return 'never'
      },
    })

    // Single round with two tool calls in its response. parseToolCalls
    // returns them in order; the _reactLoop for-loop runs them sequentially.
    const twoToolResponse = {
      model: 'gpt-4o-mini',
      choices: [{
        message: {
          content: null,
          tool_calls: [
            { id: 't0', type: 'function', function: { name: 'fast', arguments: '{}' } },
            { id: 't1', type: 'function', function: { name: 'slow', arguments: '{}' } },
          ],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }

    _stubFetchSequence([twoToolResponse])

    const agent = _buildAgent({ tools: [fast, slow], maxRounds: 3 })
    const events = _captureAllEvents(agent, ALL_TELEMETRY_TYPES)

    await assert.rejects(
      () => agent.chat('go', { signal: controller.signal }),
      (err) => {
        // Abort propagates as-is (no transformation by telemetry path).
        assert.strictEqual(err?.name, 'AbortError')
        return true
      },
    )

    // Req 5.2 / 5.7: session.end is emitted and is the LAST event.
    assert.strictEqual(events[events.length - 1].type, 'session.end')
    const sessionEnd = events[events.length - 1].payload
    assert.strictEqual(sessionEnd.ok, false)

    // Req 8.3: Run_Metrics.toolCalls on the session.end payload carries the
    // partial tool-execution history.
    assert.strictEqual(sessionEnd.toolCalls.length, 2,
      'both tool.call records (successful + aborted) are retained in Run_Metrics')
    assert.strictEqual(sessionEnd.toolCalls[0].name, 'fast')
    assert.strictEqual(sessionEnd.toolCalls[0].ok, true)
    assert.strictEqual(sessionEnd.toolCalls[1].name, 'slow')
    assert.strictEqual(sessionEnd.toolCalls[1].ok, false)
    assert.strictEqual(sessionEnd.toolCalls[1].errorKind, 'aborted')

    // Only the successful tool.call counts toward totalToolCalls (Req 8.9).
    assert.strictEqual(sessionEnd.totalToolCalls, 1)

    // getLastRunMetrics mirrors the session.end payload (Req 8.1).
    const last = agent.getLastRunMetrics()
    assert.ok(last !== null)
    assert.strictEqual(last.toolCalls.length, 2)
    assert.strictEqual(last.totalToolCalls, 1)
  })

  // -------------------------------------------------------------------------
  // getLastRunMetrics / getSessionMetrics totals match event sums
  // -------------------------------------------------------------------------

  it('getLastRunMetrics() and getSessionMetrics() numeric totals match sums derived from captured events (Req 8.1, 8.2, 8.3)', async () => {
    const echo = defineTool({
      name: 'echo',
      description: 'Echo',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
      execute: async ({ text }) => `echoed:${text}`,
    })

    // Run A: two rounds, one tool call, two llm.calls with explicit usage.
    // Run B: one round, zero tool calls, one llm.call with different usage.
    _stubFetchSequence([
      // ---- Run A ----
      _completionWithToolCall({
        toolName: 'echo',
        argumentsJson: JSON.stringify({ text: 'A' }),
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }),
      _completionWithText({
        content: 'finalA',
        usage: { prompt_tokens: 50, completion_tokens: 10 },
      }),
      // ---- Run B ----
      _completionWithText({
        content: 'finalB',
        usage: { prompt_tokens: 30, completion_tokens: 7 },
      }),
    ])

    const agent = _buildAgent({ tools: [echo] })
    const llmEvents = []
    const toolEvents = []
    const roundStarts = []
    const sessionEnds = []
    agent.on('llm.call', e => llmEvents.push(e))
    agent.on('tool.call', e => toolEvents.push(e))
    agent.on('round.start', e => roundStarts.push(e))
    agent.on('session.end', e => sessionEnds.push(e))

    const a = await agent.chat('A')
    assert.strictEqual(a, 'finalA')

    // Snapshot after run A for getLastRunMetrics assertions.
    const lastA = agent.getLastRunMetrics()
    assert.ok(lastA !== null)

    // Derive run-A totals from captured events.
    const runAll = llmEvents.slice()
    const runATool = toolEvents.slice()
    const runARounds = roundStarts.slice()

    // Req 8.3: totalLlmCalls === count of llm.call with ok:true.
    assert.strictEqual(
      lastA.totalLlmCalls,
      runAll.filter(e => e.ok).length,
      'Run_Metrics.totalLlmCalls must equal ok:true llm.call count',
    )
    // Req 8.3: totalToolCalls === count of tool.call with ok:true.
    assert.strictEqual(
      lastA.totalToolCalls,
      runATool.filter(e => e.ok).length,
      'Run_Metrics.totalToolCalls must equal ok:true tool.call count',
    )
    // totalRounds === count of round.start events observed.
    assert.strictEqual(lastA.totalRounds, runARounds.length)
    // usage sums match the sum of every llm.call (null contributes 0 but
    // all events in this run reported explicit integers).
    const expectedInputA = runAll.reduce((n, e) => n + (e['gen_ai.usage.input_tokens'] ?? 0), 0)
    const expectedOutputA = runAll.reduce((n, e) => n + (e['gen_ai.usage.output_tokens'] ?? 0), 0)
    assert.strictEqual(lastA.usage.input_tokens, expectedInputA)
    assert.strictEqual(lastA.usage.output_tokens, expectedOutputA)
    // Run_Metrics.llmCalls and .toolCalls contain every captured event (Req
    // 8.3): retention is complete whether ok:true or ok:false.
    assert.strictEqual(lastA.llmCalls.length, runAll.length)
    assert.strictEqual(lastA.toolCalls.length, runATool.length)

    // ---- Run B ----
    const b = await agent.chat('B')
    assert.strictEqual(b, 'finalB')

    // getLastRunMetrics now reflects run B only.
    const lastB = agent.getLastRunMetrics()
    const runBLlm = llmEvents.slice(runAll.length)
    const runBTool = toolEvents.slice(runATool.length)
    assert.strictEqual(lastB.totalLlmCalls, runBLlm.filter(e => e.ok).length)
    assert.strictEqual(lastB.totalToolCalls, runBTool.filter(e => e.ok).length)
    assert.strictEqual(lastB.usage.input_tokens,
      runBLlm.reduce((n, e) => n + (e['gen_ai.usage.input_tokens'] ?? 0), 0))

    // Session metrics roll up both runs. Sum across ALL captured events.
    const sm = agent.getSessionMetrics()
    assert.strictEqual(sm.totalRuns, 2)
    assert.strictEqual(
      sm.totalLlmCalls,
      llmEvents.filter(e => e.ok).length,
    )
    assert.strictEqual(
      sm.totalToolCalls,
      toolEvents.filter(e => e.ok).length,
    )
    assert.strictEqual(
      sm.usage.input_tokens,
      llmEvents.reduce((n, e) => n + (e['gen_ai.usage.input_tokens'] ?? 0), 0),
    )
    assert.strictEqual(
      sm.usage.output_tokens,
      llmEvents.reduce((n, e) => n + (e['gen_ai.usage.output_tokens'] ?? 0), 0),
    )
    // totalRounds across session equals sum across sessionEnd payloads.
    assert.strictEqual(
      sm.totalRounds,
      sessionEnds.reduce((n, e) => n + e.totalRounds, 0),
    )
  })

  // -------------------------------------------------------------------------
  // Backward compat — stream() yields the same non-telemetry event shapes
  // whether or not telemetry listeners are registered
  // -------------------------------------------------------------------------

  it('stream(): non-telemetry event shapes (delta, tool_call, tool_start, tool_end, done) are identical with and without telemetry listeners (Req 9.1, 9.2)', async () => {
    const echo = defineTool({
      name: 'echo',
      description: 'Echo',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
      execute: async ({ text }) => `echoed:${text}`,
    })

    const makeResponses = () => [
      { sse: _sseToolCall({ toolName: 'echo', argumentsJson: JSON.stringify({ text: 'x' }) }) },
      { sse: _sseText('stream-final') },
    ]

    // ---- Run 1: no telemetry listeners ----
    _stubFetchMixed(makeResponses())
    const afterCalls1 = []
    const agent1 = _buildAgent({
      tools: [echo],
      hooks: {
        afterToolCall: (name, args, result) => afterCalls1.push({ name, args, result }),
      },
    })
    const yielded1 = []
    for await (const evt of agent1.stream('echo x')) {
      yielded1.push(evt)
    }

    // ---- Run 2: listeners registered for every telemetry event ----
    _stubFetchMixed(makeResponses())
    const afterCalls2 = []
    const agent2 = _buildAgent({
      tools: [echo],
      hooks: {
        afterToolCall: (name, args, result) => afterCalls2.push({ name, args, result }),
      },
    })
    for (const t of ALL_TELEMETRY_TYPES) agent2.on(t, () => {})
    const yielded2 = []
    for await (const evt of agent2.stream('echo x')) {
      yielded2.push(evt)
    }

    // Req 9.2: yielded events are byte-for-byte identical between the two
    // runs. No telemetry events ever escape into the stream() yield path.
    assert.deepStrictEqual(yielded2, yielded1)

    // None of the yielded events are telemetry events.
    const telemetryTypes = new Set(ALL_TELEMETRY_TYPES)
    for (const ev of yielded1) {
      assert.ok(!telemetryTypes.has(ev.type),
        `stream() must not yield telemetry event type: ${ev.type}`)
    }

    // Every yielded event has one of the documented shapes (Req 9.2).
    const allowed = new Set(['delta', 'reasoning', 'tool_call', 'tool_start', 'tool_end', 'intent', 'done'])
    for (const ev of yielded1) {
      assert.ok(allowed.has(ev.type), `unexpected stream() event type: ${ev.type}`)
    }

    // At least one delta, one tool_call, one tool_start, one tool_end, and
    // a terminal done.
    const types = yielded1.map(e => e.type)
    assert.ok(types.includes('delta'), 'expected at least one delta event from stream()')
    assert.ok(types.includes('tool_call'), 'expected at least one tool_call event from stream()')
    assert.ok(types.includes('tool_start'), 'expected a tool_start event')
    assert.ok(types.includes('tool_end'), 'expected a tool_end event')
    assert.strictEqual(types[types.length - 1], 'done', 'final yielded event must be done')

    // Per-event shape checks on representative events.
    const delta = yielded1.find(e => e.type === 'delta')
    assert.strictEqual(typeof delta.content, 'string')

    const toolCallEvt = yielded1.find(e => e.type === 'tool_call')
    assert.strictEqual(typeof toolCallEvt.index, 'number')
    assert.ok(toolCallEvt.toolCall && typeof toolCallEvt.toolCall === 'object')
    assert.strictEqual(toolCallEvt.toolCall.type, 'function')

    const toolStart = yielded1.find(e => e.type === 'tool_start')
    assert.strictEqual(toolStart.name, 'echo')
    assert.deepStrictEqual(toolStart.arguments, { text: 'x' })

    const toolEnd = yielded1.find(e => e.type === 'tool_end')
    assert.strictEqual(toolEnd.name, 'echo')
    assert.strictEqual(toolEnd.result, 'echoed:x')

    const done = yielded1[yielded1.length - 1]
    assert.strictEqual(done.content, 'stream-final')

    // Req 9.3: hooks.afterToolCall receives unchanged (name, arguments, result)
    // regardless of telemetry subscription state.
    assert.deepStrictEqual(afterCalls2, afterCalls1)
    assert.strictEqual(afterCalls1.length, 1)
    assert.deepStrictEqual(afterCalls1[0], {
      name: 'echo',
      args: { text: 'x' },
      result: 'echoed:x',
    })
  })

  // -------------------------------------------------------------------------
  // Backward compat — stream() final accumulated content matches with and
  // without listeners
  // -------------------------------------------------------------------------

  it('stream(): final accumulated content is identical with and without telemetry listeners (Req 9.1)', async () => {
    const echo = defineTool({
      name: 'echo',
      description: 'Echo',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
      execute: async ({ text }) => `echoed:${text}`,
    })

    const makeResponses = () => [
      { sse: _sseToolCall({ toolName: 'echo', argumentsJson: JSON.stringify({ text: 'q' }) }) },
      { sse: _sseText('canonical-stream-reply') },
    ]

    const runOnce = async (withListeners) => {
      _stubFetchMixed(makeResponses())
      const agent = _buildAgent({ tools: [echo] })
      if (withListeners) {
        for (const t of ALL_TELEMETRY_TYPES) agent.on(t, () => {})
      }
      let content = ''
      let done = null
      for await (const evt of agent.stream('echo q')) {
        if (evt.type === 'delta') content += evt.content
        if (evt.type === 'done') done = evt
      }
      return { content, done }
    }

    const a = await runOnce(false)
    const b = await runOnce(true)

    assert.strictEqual(a.done?.content, 'canonical-stream-reply')
    assert.strictEqual(b.done?.content, a.done?.content)
    assert.strictEqual(b.content, a.content)
  })
})
