/**
 * Regression tests for the simple-model routing.
 *
 * 背景：Agent 支持双模型配置 —— 主模型用于 ReAct 主循环（思考模型），
 * simpleModel/simpleApiKey 用于意图识别、难度判断、工具筛选、记忆摘要等
 * sidecar 调用。未配置简单模型时全部回退主模型。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Agent } from './agent.js'
import { SlidingWindowMemory } from './memory.js'

// ---- Mock fetch — 按 Authorization 头捕获每次请求，便于断言模型/密钥走向 ----

const originalFetch = globalThis.fetch
/** @type {Array<{ url: string, apiKey: string, model: string, body: any }>} */
let capturedRequests = []
/** @type {Array<any>} */
let responseQueue = []

function installMockFetch() {
  capturedRequests = []
  responseQueue = []
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    const auth = init.headers?.['Authorization'] ?? ''
    const apiKey = auth.replace(/^Bearer\s+/, '')
    capturedRequests.push({ url, apiKey, model: body.model, body })
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

/** IntentRecognizer 期待一段 JSON content — 用作意图识别响应 */
function queueIntentResponse(intent) {
  responseQueue.push({
    choices: [{ message: { content: JSON.stringify(intent) } }],
  })
}

// ---- Tests ----

describe('Agent: simple-model routing', () => {
  before(installMockFetch)
  after(restoreFetch)

  it('IntentRecognizer uses simpleModel/simpleApiKey; main loop uses main model/apiKey', async () => {
    capturedRequests = []
    responseQueue = []

    const agent = new Agent({
      provider: 'openai',
      apiKey: 'sk-main',
      model: 'gpt-5-thinking',
      simpleApiKey: 'sk-simple',
      simpleModel: 'gpt-5-nano',
      enableIntentRecognition: true,
      memory: new SlidingWindowMemory(),
    })

    // Round 0: intent recognition call (simple model), then main ReAct call (main model)
    queueIntentResponse({
      clarity: 'CLEAR',
      complexity: 'SIMPLE',
      recommendedStrategy: 'react',
      reasoning: 't',
      filteredToolNames: [],
    })
    queueResponse({ content: 'hello' })

    await agent.chat('hi')

    assert.strictEqual(capturedRequests.length, 2, 'should make 2 requests')

    const intentReq = capturedRequests[0]
    assert.strictEqual(intentReq.model, 'gpt-5-nano', 'intent call must use simpleModel')
    assert.strictEqual(intentReq.apiKey, 'sk-simple', 'intent call must use simpleApiKey')

    const mainReq = capturedRequests[1]
    assert.strictEqual(mainReq.model, 'gpt-5-thinking', 'main ReAct call must use main model')
    assert.strictEqual(mainReq.apiKey, 'sk-main', 'main ReAct call must use main apiKey')
  })

  it('unset simple config: IntentRecognizer falls back to main model/apiKey', async () => {
    capturedRequests = []
    responseQueue = []

    const agent = new Agent({
      provider: 'openai',
      apiKey: 'sk-main',
      model: 'gpt-5-thinking',
      enableIntentRecognition: true,
      memory: new SlidingWindowMemory(),
    })

    queueIntentResponse({
      clarity: 'CLEAR',
      complexity: 'SIMPLE',
      recommendedStrategy: 'react',
      reasoning: 't',
      filteredToolNames: [],
    })
    queueResponse({ content: 'hi' })

    await agent.chat('hi')

    assert.strictEqual(capturedRequests[0].model, 'gpt-5-thinking')
    assert.strictEqual(capturedRequests[0].apiKey, 'sk-main')
  })

  it('partial simple config: only simpleModel set — reuses main apiKey+url', async () => {
    capturedRequests = []
    responseQueue = []

    const agent = new Agent({
      provider: 'openai',
      apiKey: 'sk-main',
      model: 'gpt-5-thinking',
      simpleModel: 'gpt-5-nano', // apiKey not provided — should fall back
      enableIntentRecognition: true,
      memory: new SlidingWindowMemory(),
    })

    queueIntentResponse({
      clarity: 'CLEAR',
      complexity: 'SIMPLE',
      recommendedStrategy: 'react',
      reasoning: 't',
      filteredToolNames: [],
    })
    queueResponse({ content: 'hi' })

    await agent.chat('hi')

    const intentReq = capturedRequests[0]
    assert.strictEqual(intentReq.model, 'gpt-5-nano', 'uses simpleModel')
    assert.strictEqual(intentReq.apiKey, 'sk-main', 'falls back to main apiKey')
  })

  it('simpleProvider supplies a different URL for sidecar calls', async () => {
    capturedRequests = []
    responseQueue = []

    const agent = new Agent({
      provider: 'openai',
      apiKey: 'sk-main',
      model: 'gpt-5-thinking',
      simpleProvider: 'deepseek',
      simpleApiKey: 'sk-ds',
      simpleModel: 'deepseek-chat',
      enableIntentRecognition: true,
      memory: new SlidingWindowMemory(),
    })

    queueIntentResponse({
      clarity: 'CLEAR',
      complexity: 'SIMPLE',
      recommendedStrategy: 'react',
      reasoning: 't',
      filteredToolNames: [],
    })
    queueResponse({ content: 'hi' })

    await agent.chat('hi')

    assert.ok(
      capturedRequests[0].url.includes('deepseek.com'),
      'intent call must hit deepseek endpoint when simpleProvider is set',
    )
    assert.ok(
      capturedRequests[1].url.includes('openai.com'),
      'main ReAct call must still hit openai endpoint',
    )
  })

  it('intentModel opt still wins over simpleModel for IntentRecognizer (backward compat)', async () => {
    capturedRequests = []
    responseQueue = []

    const agent = new Agent({
      provider: 'openai',
      apiKey: 'sk-main',
      model: 'gpt-5-thinking',
      simpleModel: 'gpt-5-nano',
      simpleApiKey: 'sk-simple',
      intentModel: 'gpt-4o-mini',
      enableIntentRecognition: true,
      memory: new SlidingWindowMemory(),
    })

    queueIntentResponse({
      clarity: 'CLEAR',
      complexity: 'SIMPLE',
      recommendedStrategy: 'react',
      reasoning: 't',
      filteredToolNames: [],
    })
    queueResponse({ content: 'hi' })

    await agent.chat('hi')

    assert.strictEqual(
      capturedRequests[0].model,
      'gpt-4o-mini',
      'intentModel (explicit) must win over simpleModel',
    )
  })
})
