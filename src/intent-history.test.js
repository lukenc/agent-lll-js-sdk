/**
 * Regression tests for intent recognition carrying conversation history.
 *
 * 背景：意图识别不能只看当前这一句话 —— 「继续」「上个结果」这类短回复，
 * 必须结合历史才能正确判定 CLEAR/AMBIGUOUS。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Agent } from './agent.js'
import { IntentRecognizer } from './intent-recognizer.js'
import { SlidingWindowMemory } from './memory.js'

// ---- Mock fetch — 记录每次请求，把第一条（意图调用）挑出来断言 ----

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

function queueIntentResponse(intent) {
  responseQueue.push({
    choices: [{ message: { content: JSON.stringify(intent) } }],
  })
}

function queueResponse({ content = '', toolCalls = null } = {}) {
  const message = { content }
  if (toolCalls) message.tool_calls = toolCalls
  responseQueue.push({ choices: [{ message }] })
}

// ---- Agent-level integration tests ----

describe('Agent: intent recognition carries history', () => {
  before(installMockFetch)
  after(restoreFetch)

  it('second turn: intent call includes prior user+assistant turns', async () => {
    capturedRequests = []
    responseQueue = []

    const agent = new Agent({
      provider: 'openai',
      apiKey: 'sk-main',
      model: 'gpt-4',
      enableIntentRecognition: true,
      memory: new SlidingWindowMemory(),
    })

    // Turn 1
    queueIntentResponse({ clarity: 'CLEAR', complexity: 'SIMPLE', recommendedStrategy: 'react', reasoning: 't', filteredToolNames: [] })
    queueResponse({ content: '北京今天 25 度' })
    await agent.chat('北京天气怎么样')

    // Turn 2 — intent call should see turn-1 history
    capturedRequests = []
    queueIntentResponse({ clarity: 'CLEAR', complexity: 'SIMPLE', recommendedStrategy: 'react', reasoning: 'refers to Beijing', filteredToolNames: [] })
    queueResponse({ content: '明天会降温' })
    await agent.chat('明天呢？')

    const intentReq = capturedRequests[0].body
    const msgs = intentReq.messages
    // Expect: [system, user(t1), assistant(t1), user(t2)]
    assert.strictEqual(msgs[0].role, 'system', 'first message is intent system prompt')
    const nonSystem = msgs.filter(m => m.role !== 'system')
    assert.deepStrictEqual(
      nonSystem,
      [
        { role: 'user', content: '北京天气怎么样' },
        { role: 'assistant', content: '北京今天 25 度' },
        { role: 'user', content: '明天呢？' },
      ],
      'intent call must carry prior turn as context + current user message',
    )
  })

  it('current userMessage is not duplicated when memory already contains it', async () => {
    capturedRequests = []
    responseQueue = []

    const agent = new Agent({
      provider: 'openai',
      apiKey: 'sk-main',
      model: 'gpt-4',
      enableIntentRecognition: true,
      memory: new SlidingWindowMemory(),
    })

    queueIntentResponse({ clarity: 'CLEAR', complexity: 'SIMPLE', recommendedStrategy: 'react', reasoning: 't', filteredToolNames: [] })
    queueResponse({ content: 'ok' })

    await agent.chat('hi there')

    const msgs = capturedRequests[0].body.messages
    const userMsgs = msgs.filter(m => m.role === 'user')
    assert.strictEqual(userMsgs.length, 1, 'intent call should have exactly one user message')
    assert.strictEqual(userMsgs[0].content, 'hi there')
  })

  it('tool messages and assistant(tool_calls) are stripped from intent history', async () => {
    capturedRequests = []
    responseQueue = []

    const agent = new Agent({
      provider: 'openai',
      apiKey: 'sk-main',
      model: 'gpt-4',
      enableIntentRecognition: true,
      memory: new SlidingWindowMemory(),
    })

    // Pre-seed memory with a tool-call turn (simulating a ReAct cycle)
    agent.memory.add({ role: 'user', content: '查北京天气' })
    agent.memory.add({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }],
    })
    agent.memory.add({ role: 'tool', tool_call_id: 'c1', name: 'get_weather', content: '北京：晴' })
    agent.memory.add({ role: 'assistant', content: '北京今天晴天' })

    queueIntentResponse({ clarity: 'CLEAR', complexity: 'SIMPLE', recommendedStrategy: 'react', reasoning: 't', filteredToolNames: [] })
    queueResponse({ content: 'ok' })

    await agent.chat('明天呢？')

    const msgs = capturedRequests[0].body.messages
    const nonSystem = msgs.filter(m => m.role !== 'system')
    // Expect only plain user/assistant text messages — no tool, no assistant(tool_calls)
    for (const m of nonSystem) {
      assert.ok(m.role === 'user' || m.role === 'assistant', `unexpected role in intent history: ${m.role}`)
      assert.ok(!m.tool_calls, 'intent history must strip tool_calls messages')
      assert.strictEqual(typeof m.content, 'string', 'intent history must have string content')
    }
    // Specifically: the deterministic expected ordering
    assert.deepStrictEqual(nonSystem, [
      { role: 'user', content: '查北京天气' },
      { role: 'assistant', content: '北京今天晴天' },
      { role: 'user', content: '明天呢？' },
    ])
  })

  it('long conversation: intent history is capped at maxHistoryMessages (default 12)', async () => {
    capturedRequests = []
    responseQueue = []

    const agent = new Agent({
      provider: 'openai',
      apiKey: 'sk-main',
      model: 'gpt-4',
      enableIntentRecognition: true,
      memory: new SlidingWindowMemory(100),
    })

    // Pre-seed 20 user/assistant pairs = 40 messages
    for (let i = 0; i < 20; i++) {
      agent.memory.add({ role: 'user', content: 'u' + i })
      agent.memory.add({ role: 'assistant', content: 'a' + i })
    }

    queueIntentResponse({ clarity: 'CLEAR', complexity: 'SIMPLE', recommendedStrategy: 'react', reasoning: 't', filteredToolNames: [] })
    queueResponse({ content: 'ok' })

    await agent.chat('current question')

    const msgs = capturedRequests[0].body.messages
    const nonSystem = msgs.filter(m => m.role !== 'system')
    // Should be at most 12 history + 1 current = 13
    assert.ok(nonSystem.length <= 13, `intent should cap history; got ${nonSystem.length} messages`)
    // Final message must be the current user question
    assert.deepStrictEqual(nonSystem[nonSystem.length - 1], { role: 'user', content: 'current question' })
    // Kept history should be the MOST RECENT tail (ending with assistant 'a19')
    assert.strictEqual(nonSystem[nonSystem.length - 2].content, 'a19', 'kept history is the tail, not the head')
  })
})

// ---- Unit: IntentRecognizer.analyze signature ----

describe('IntentRecognizer.analyze: history option', () => {
  before(installMockFetch)
  after(restoreFetch)

  it('honors explicit history option without an Agent wrapper', async () => {
    capturedRequests = []
    responseQueue = []

    const rec = new IntentRecognizer({ url: 'https://x/y', apiKey: 'sk', model: 'gpt-4' })

    queueIntentResponse({ clarity: 'CLEAR', complexity: 'SIMPLE', recommendedStrategy: 'react', reasoning: 't', filteredToolNames: [] })

    await rec.analyze('follow up', ['toolA'], {
      history: [
        { role: 'user', content: 'original question' },
        { role: 'assistant', content: 'original answer' },
      ],
    })

    const msgs = capturedRequests[0].body.messages
    assert.deepStrictEqual(
      msgs.filter(m => m.role !== 'system'),
      [
        { role: 'user', content: 'original question' },
        { role: 'assistant', content: 'original answer' },
        { role: 'user', content: 'follow up' },
      ],
    )
  })
})
