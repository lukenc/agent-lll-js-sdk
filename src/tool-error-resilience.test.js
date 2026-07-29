/**
 * Regression tests: tool-call errors and application hooks must never
 * interrupt the agent main loop.
 *
 * 1. `formatToolResult` — `JSON.stringify` throws on circular refs / BigInt.
 *    It is called OUTSIDE the per-tool try/catch, so before the fix a tool
 *    returning such a value aborted the whole run. Now it degrades:
 *    JSON.stringify → String(result) → '[unserializable tool result]'.
 *
 * 2. Fire-and-forget hooks (`onRoundStart` / `afterToolCall` / `onError`)
 *    and PlanAndExecute callbacks (`onPhase` / `onStepStart` / ...) were
 *    called bare; a throwing hook broke the loop. Now they are routed
 *    through `Agent._safeHook` / `safeCallback`: sync throws are swallowed
 *    and returned promises get a no-op rejection handler.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Agent } from './agent.js'
import { defineTool, formatToolResult } from './tool.js'
import { PlanAndExecuteStrategy } from './plan-and-execute.js'

// ---- Minimal fetch mock (same pattern as p0-4-5.test.js) ----

const originalFetch = globalThis.fetch
/** @type {Array<any>} */
let responseQueue = []

function installMockFetch() {
  responseQueue = []
  globalThis.fetch = async (url, init) => {
    const next = responseQueue.shift()
    if (!next) throw new Error('mock fetch: response queue empty')
    return {
      ok: true,
      status: 200,
      async json() { return next },
      async text() { return JSON.stringify(next) },
    }
  }
}

function restoreFetch() {
  globalThis.fetch = originalFetch
}

function queueResponse({ content = '', toolCalls = null } = {}) {
  const message = { content }
  if (toolCalls) message.tool_calls = toolCalls
  responseQueue.push({ choices: [{ message }] })
}

function queueToolCallRound(toolName, args = '{}') {
  queueResponse({
    content: null,
    toolCalls: [{ id: 'call_1', type: 'function', function: { name: toolName, arguments: args } }],
  })
}

function makeAgent(extra = {}) {
  return new Agent({
    provider: 'openai',
    apiKey: 'sk-fake',
    model: 'gpt-4',
    maxRounds: 3,
    ...extra,
  })
}

// ---- 1. formatToolResult degradation ----

describe('formatToolResult: never throws on unserializable results', () => {
  it('keeps strings verbatim and JSON-serializes plain objects (unchanged behavior)', () => {
    assert.strictEqual(formatToolResult('c1', 't', 'plain').content, 'plain')
    assert.strictEqual(formatToolResult('c1', 't', { a: 1 }).content, '{"a":1}')
  })

  it('circular structure falls back to String(result)', () => {
    const circular = {}
    circular.self = circular
    const msg = formatToolResult('c1', 't', circular)
    assert.strictEqual(msg.content, String(circular))
  })

  it('BigInt value falls back to String(result)', () => {
    const msg = formatToolResult('c1', 't', { n: 1n })
    assert.strictEqual(typeof msg.content, 'string')
  })

  it('undefined / function results (JSON.stringify → undefined) fall back to String', () => {
    assert.strictEqual(formatToolResult('c1', 't', undefined).content, 'undefined')
    assert.strictEqual(typeof formatToolResult('c1', 't', () => {}).content, 'string')
  })

  it('result whose toJSON AND toString both throw yields the placeholder', () => {
    const hostile = {
      toJSON() { throw new Error('no json') },
      toString() { throw new Error('no string') },
    }
    const msg = formatToolResult('c1', 't', hostile)
    assert.strictEqual(msg.content, '[unserializable tool result]')
  })
})

describe('ReAct loop survives a tool returning a circular object', () => {
  before(installMockFetch)
  after(restoreFetch)

  it('chat() completes and the tool message is a string', async () => {
    const circular = {}
    circular.self = circular
    const tool = defineTool({
      name: 'circ',
      description: 'returns circular',
      parameters: { type: 'object', properties: {} },
      execute: async () => circular,
    })
    const agent = makeAgent({ tools: [tool] })
    queueToolCallRound('circ')
    queueResponse({ content: 'final answer' })

    const out = await agent.chat('go')
    assert.strictEqual(out, 'final answer')
    const messages = agent.memory.messages
    const toolEntry = messages.find(m => m.role === 'tool')
    assert.ok(toolEntry, 'tool result must be in memory')
    assert.strictEqual(typeof toolEntry.content, 'string')
  })
})

// ---- 2. Hook safety in the Agent loops ----

describe('non-Error throws (throw null / throw string) do not interrupt the loop', () => {
  before(installMockFetch)
  after(restoreFetch)

  function throwingTool(value) {
    return defineTool({
      name: 't',
      description: 'throws a non-Error value',
      parameters: { type: 'object', properties: {} },
      execute: async () => { throw value },
    })
  }

  it('tool that does `throw null` — run completes, observation says "null"', async () => {
    const agent = makeAgent({ tools: [throwingTool(null)] })
    queueToolCallRound('t')
    queueResponse({ content: 'final' })
    assert.strictEqual(await agent.chat('go'), 'final')
    const toolEntry = agent.memory.messages.find(m => m.role === 'tool')
    assert.strictEqual(toolEntry.content, 'Error executing t: null')
  })

  it('tool that throws a raw string — the string reaches the observation', async () => {
    const agent = makeAgent({ tools: [throwingTool('raw boom')] })
    queueToolCallRound('t')
    queueResponse({ content: 'final' })
    assert.strictEqual(await agent.chat('go'), 'final')
    const toolEntry = agent.memory.messages.find(m => m.role === 'tool')
    assert.match(toolEntry.content, /raw boom/)
  })

  it('normal Error message stays byte-for-byte unchanged', async () => {
    const agent = makeAgent({ tools: [throwingTool(new Error('plain error'))] })
    queueToolCallRound('t')
    queueResponse({ content: 'final' })
    assert.strictEqual(await agent.chat('go'), 'final')
    const toolEntry = agent.memory.messages.find(m => m.role === 'tool')
    assert.strictEqual(toolEntry.content, 'Error executing t: plain error')
  })
})

describe('throwing hooks do not interrupt the ReAct loop', () => {
  before(installMockFetch)
  after(restoreFetch)

  const okTool = () => defineTool({
    name: 'ok',
    description: 'ok',
    parameters: { type: 'object', properties: {} },
    execute: async () => 'done',
  })

  const badTool = () => defineTool({
    name: 'bad',
    description: 'throws',
    parameters: { type: 'object', properties: {} },
    execute: async () => { throw new Error('tool boom') },
  })

  it('onRoundStart throwing (sync chat)', async () => {
    const agent = makeAgent({
      tools: [okTool()],
      hooks: { onRoundStart: () => { throw new Error('hook boom') } },
    })
    queueToolCallRound('ok')
    queueResponse({ content: 'final' })
    assert.strictEqual(await agent.chat('go'), 'final')
  })

  it('afterToolCall throwing (sync chat)', async () => {
    const agent = makeAgent({
      tools: [okTool()],
      hooks: { afterToolCall: () => { throw new Error('hook boom') } },
    })
    queueToolCallRound('ok')
    queueResponse({ content: 'final' })
    assert.strictEqual(await agent.chat('go'), 'final')
  })

  it('async afterToolCall rejecting does not become an unhandled rejection', async () => {
    let unhandled = null
    const onUnhandled = (reason) => { unhandled = reason }
    process.on('unhandledRejection', onUnhandled)
    try {
      const agent = makeAgent({
        tools: [okTool()],
        hooks: { afterToolCall: async () => { throw new Error('async hook boom') } },
      })
      queueToolCallRound('ok')
      queueResponse({ content: 'final' })
      assert.strictEqual(await agent.chat('go'), 'final')
      // Let the microtask queue drain so a leaked rejection would fire.
      await new Promise(r => setImmediate(r))
      assert.strictEqual(unhandled, null)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('onError throwing while the tool itself threw (sync chat)', async () => {
    const agent = makeAgent({
      tools: [badTool()],
      hooks: { onError: () => { throw new Error('onError boom') } },
    })
    queueToolCallRound('bad')
    queueResponse({ content: 'final' })
    assert.strictEqual(await agent.chat('go'), 'final')
    // The original tool error must still reach the LLM as an observation.
    const toolEntry = agent.memory.messages.find(m => m.role === 'tool')
    assert.match(toolEntry.content, /tool boom/)
  })

  it('throwing hooks in the streaming loop', async () => {
    // stream() uses streamChat (SSE); mock a non-streaming JSON body is not
    // compatible, so exercise the stream path via the internal generator with
    // syncChat-shaped mocks is not possible — instead verify _safeHook directly.
    const agent = makeAgent({
      hooks: { afterToolCall: () => { throw new Error('boom') } },
    })
    assert.doesNotThrow(() => agent._safeHook('afterToolCall', 'n', {}, 'r'))
    assert.doesNotThrow(() => agent._safeHook('onRoundStart', 0))
    assert.doesNotThrow(() => agent._safeHook('nonexistentHook', 1, 2))
  })
})

// ---- 3. PlanAndExecute callback safety ----

describe('PlanAndExecute callbacks are wrapped by safeCallback', () => {
  function makeStrategy(callbacks) {
    return new PlanAndExecuteStrategy({
      url: 'https://example.invalid/v1/chat/completions',
      apiKey: 'sk-fake',
      model: 'gpt-4',
      tools: [],
      ...callbacks,
    })
  }

  it('sync throw in every callback is swallowed', () => {
    const boom = () => { throw new Error('cb boom') }
    const s = makeStrategy({
      onPhase: boom,
      onPlanGenerated: boom,
      onStepStart: boom,
      onStepComplete: boom,
      onPlanRevised: boom,
    })
    assert.doesNotThrow(() => s.onPhase('executing', 'msg'))
    assert.doesNotThrow(() => s.onPlanGenerated([]))
    assert.doesNotThrow(() => s.onStepStart(0, 'desc', {}))
    assert.doesNotThrow(() => s.onStepComplete(0, true, 'r', {}))
    assert.doesNotThrow(() => s.onPlanRevised([]))
  })

  it('async rejection in a callback is absorbed', async () => {
    let unhandled = null
    const onUnhandled = (reason) => { unhandled = reason }
    process.on('unhandledRejection', onUnhandled)
    try {
      const s = makeStrategy({
        onStepComplete: async () => { throw new Error('async cb boom') },
      })
      assert.doesNotThrow(() => s.onStepComplete(0, true, 'r', {}))
      await new Promise(r => setImmediate(r))
      assert.strictEqual(unhandled, null)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('default (omitted) callbacks remain callable no-ops', () => {
    const s = makeStrategy({})
    assert.doesNotThrow(() => s.onPhase('planning', 'msg'))
    assert.doesNotThrow(() => s.onStepStart(0, 'desc', {}))
  })
})
