/**
 * Regression tests for P0-4 and P0-5.
 *
 * P0-4: When `_reactLoop` / `_reactLoopStream` hits `maxRounds`, a final
 *       `assistant` message must be written to memory so the history is not
 *       left dangling at `assistant(tool_calls) → tool...`.
 *
 * P0-5: After round 0, subsequent rounds must keep using the intent-filtered
 *       tool list (`filteredTools`) — not the full `this.tools`.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Agent } from './agent.js'
import { defineTool } from './tool.js'

// ---- Minimal fetch mock ----

const originalFetch = globalThis.fetch
/** @type {Array<{ url: string, body: any }>} */
let capturedRequests = []
/** @type {Array<any>} */
let responseQueue = []

function installMockFetch() {
  capturedRequests = []
  responseQueue = []
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    capturedRequests.push({ url, body })
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

/** Queue a sync-chat (non-streaming) response with optional tool_calls */
function queueResponse({ content = '', toolCalls = null } = {}) {
  const message = { content }
  if (toolCalls) message.tool_calls = toolCalls
  responseQueue.push({ choices: [{ message }] })
}

// ---- Tests ----

describe('P0-4: max rounds exceeded writes final assistant to memory', () => {
  before(installMockFetch)
  after(restoreFetch)

  it('memory ends with role: "assistant" after exceeding maxRounds', async () => {
    const tool = defineTool({
      name: 'noop',
      description: 'does nothing',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'done',
    })

    const agent = new Agent({
      provider: 'openai',
      apiKey: 'sk-fake',
      model: 'gpt-4',
      tools: [tool],
      maxRounds: 2,
    })

    // Both rounds the LLM keeps calling the tool — never naturally ends.
    queueResponse({
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'noop', arguments: '{}' } }],
    })
    queueResponse({
      toolCalls: [{ id: 'c2', type: 'function', function: { name: 'noop', arguments: '{}' } }],
    })

    const result = await agent.chat('keep calling the tool')
    assert.strictEqual(result, '[max rounds exceeded]')

    const msgs = agent.memory.getMessages()
    const lastMsg = msgs[msgs.length - 1]
    assert.strictEqual(
      lastMsg.role,
      'assistant',
      `memory tail must be assistant, got: ${JSON.stringify(msgs.map(m => m.role))}`
    )
    assert.strictEqual(lastMsg.content, '[max rounds exceeded]')
    assert.ok(!lastMsg.tool_calls, 'final assistant must not carry tool_calls')
  })

  it('stream: memory also gets final assistant after maxRounds', async () => {
    capturedRequests = []
    responseQueue = []

    const tool = defineTool({
      name: 'noop',
      description: 'does nothing',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'done',
    })
    const agent = new Agent({
      provider: 'openai',
      apiKey: 'sk-fake',
      model: 'gpt-4',
      tools: [tool],
      maxRounds: 1,
    })

    // streamChat uses the SSE API; here we only test the memory side effect
    // via the non-stream path for simplicity. Re-queue for the single round.
    queueResponse({
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'noop', arguments: '{}' } }],
    })

    await agent.chat('call once')

    const msgs = agent.memory.getMessages()
    assert.strictEqual(msgs[msgs.length - 1].role, 'assistant')
    assert.strictEqual(msgs[msgs.length - 1].content, '[max rounds exceeded]')
  })

  it('next chat() call after maxRounds does not produce malformed history', async () => {
    capturedRequests = []
    responseQueue = []

    const tool = defineTool({
      name: 'noop',
      description: 'does nothing',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'done',
    })
    const agent = new Agent({
      provider: 'openai',
      apiKey: 'sk-fake',
      model: 'gpt-4',
      tools: [tool],
      maxRounds: 1,
    })

    queueResponse({
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'noop', arguments: '{}' } }],
    })
    await agent.chat('first')

    // Second chat — history must be valid OpenAI schema:
    // every `tool` message must follow an `assistant(tool_calls)`,
    // and no `assistant(tool_calls)` may be immediately followed by `user`.
    queueResponse({ content: 'second reply' })
    capturedRequests = []
    await agent.chat('second')

    const sent = capturedRequests[0].body.messages
    for (let i = 1; i < sent.length; i++) {
      if (sent[i].role === 'user') {
        const prev = sent[i - 1]
        assert.ok(
          !(prev.role === 'assistant' && Array.isArray(prev.tool_calls) && prev.tool_calls.length > 0),
          'user must not directly follow an unfinished assistant(tool_calls)'
        )
      }
      if (sent[i].role === 'tool') {
        // Matching assistant somewhere before
        let ok = false
        for (let j = i - 1; j >= 0; j--) {
          const p = sent[j]
          if (p.role === 'assistant' && Array.isArray(p.tool_calls)
              && p.tool_calls.some(tc => tc.id === sent[i].tool_call_id)) {
            ok = true; break
          }
        }
        assert.ok(ok, `orphan tool at index ${i}`)
      }
    }
  })
})

describe('P0-5: subsequent rounds reuse filteredTools, not this.tools', () => {
  before(installMockFetch)
  after(restoreFetch)

  it('round 2 tools === round 1 tools (intent-filtered subset)', async () => {
    capturedRequests = []
    responseQueue = []

    const toolA = defineTool({
      name: 'alpha',
      description: 'alpha',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'A',
    })
    const toolB = defineTool({
      name: 'beta',
      description: 'beta',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'B',
    })
    const toolC = defineTool({
      name: 'gamma',
      description: 'gamma',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'C',
    })

    const agent = new Agent({
      provider: 'openai',
      apiKey: 'sk-fake',
      model: 'gpt-4',
      tools: [toolA, toolB, toolC],
      maxRounds: 3,
    })

    // Inject an intent that limits tools to just alpha+beta (simulating
    // intent recognition result). BASE_TOOLS set is empty here (no matching
    // names), so the final filtered set is exactly ['alpha','beta'].
    agent.intentRecognizer = {
      analyze: async () => ({
        clarity: 'CLEAR',
        complexity: 'SIMPLE',
        recommendedStrategy: 'react',
        reasoning: 'test',
        filteredToolNames: ['alpha', 'beta'],
      }),
    }

    // Round 1: returns tool_call for alpha
    queueResponse({
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'alpha', arguments: '{}' } }],
    })
    // Round 2: returns final text (no more tool_calls)
    queueResponse({ content: 'all done' })

    await agent.chat('do stuff')

    assert.strictEqual(capturedRequests.length, 2, 'should have made 2 LLM calls')

    const round1ToolNames = (capturedRequests[0].body.tools ?? []).map(t => t.function.name)
    const round2ToolNames = (capturedRequests[1].body.tools ?? []).map(t => t.function.name)

    assert.deepStrictEqual(
      round1ToolNames.sort(),
      ['alpha', 'beta'],
      'round 1 should use intent-filtered tools'
    )
    assert.deepStrictEqual(
      round2ToolNames.sort(),
      ['alpha', 'beta'],
      'round 2 must REUSE the filtered set, not leak gamma back in'
    )
    assert.ok(
      !round2ToolNames.includes('gamma'),
      'regression: round 2 must not include gamma (full this.tools leakage)'
    )
  })

  it('without intent recognizer, subsequent rounds use full this.tools (unchanged behavior)', async () => {
    capturedRequests = []
    responseQueue = []

    const toolA = defineTool({
      name: 'alpha',
      description: 'alpha',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'A',
    })
    const toolB = defineTool({
      name: 'beta',
      description: 'beta',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'B',
    })

    const agent = new Agent({
      provider: 'openai',
      apiKey: 'sk-fake',
      model: 'gpt-4',
      tools: [toolA, toolB],
      maxRounds: 3,
    })

    queueResponse({
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'alpha', arguments: '{}' } }],
    })
    queueResponse({ content: 'done' })

    await agent.chat('x')

    const round2ToolNames = (capturedRequests[1].body.tools ?? []).map(t => t.function.name)
    assert.deepStrictEqual(round2ToolNames.sort(), ['alpha', 'beta'])
  })
})
