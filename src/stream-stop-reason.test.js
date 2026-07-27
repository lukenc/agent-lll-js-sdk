/**
 * 轮次耗尽的结构化呈现(对齐 Vercel finishReason / Claude SDK error_max_turns
 * 的"当数据"派):done 事件带 stopReason,消费方不再字符串匹配哨兵。
 * 哨兵字符串 '[max rounds exceeded]' 本身保留(向后兼容老消费方)。
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { Agent } from './agent.js'
import { SlidingWindowMemory } from './memory.js'
import { defineTool } from './tool.js'

const ORIGINAL_FETCH = globalThis.fetch

function sseBody(lines) {
  return new ReadableStream({
    start(c) {
      for (const l of lines) c.enqueue(new TextEncoder().encode(l + '\n'))
      c.close()
    },
  })
}

/** 每次 fetch 依次弹出一个响应;数组耗尽即抛。 */
function stubFetchStreams(lineArrays) {
  let i = 0
  globalThis.fetch = async () => {
    if (i >= lineArrays.length) throw new Error('fetch stub exhausted')
    return new Response(sseBody(lineArrays[i++]), { status: 200 })
  }
}

const TOOL_CALL_ROUND = [
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"noop","arguments":"{}"}}]}}]}',
  'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
  'data: [DONE]',
]
const TEXT_ROUND = [
  'data: {"choices":[{"delta":{"content":"完成"}}]}',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
  'data: [DONE]',
]

const noop = defineTool({
  name: 'noop',
  description: 'no-op',
  parameters: { type: 'object', properties: {} },
  execute: async () => 'ok',
})

function buildAgent(maxRounds) {
  return new Agent({
    provider: 'openai',
    apiKey: 'sk-test',
    model: 'gpt-4o-mini',
    memory: new SlidingWindowMemory(50),
    tools: [noop],
    maxRounds,
  })
}

async function lastDone(agent, msg) {
  let done = null
  for await (const ev of agent.stream(msg)) {
    if (ev.type === 'done') done = ev
  }
  return done
}

describe('agent.stream stopReason', () => {
  afterEach(() => { globalThis.fetch = ORIGINAL_FETCH })

  it("normal completion carries stopReason: 'completed'", async () => {
    stubFetchStreams([TEXT_ROUND])
    const agent = buildAgent(3)
    const done = await lastDone(agent, 'hi')
    assert.equal(done.stopReason, 'completed')
    assert.equal(done.content, '完成')
    assert.equal(agent.lastStopReason, 'completed')
  })

  it("round exhaustion carries stopReason: 'max_rounds' + rounds, sentinel preserved", async () => {
    stubFetchStreams([TOOL_CALL_ROUND, TOOL_CALL_ROUND])  // 每轮都要求调工具
    const agent = buildAgent(2)
    const done = await lastDone(agent, 'hi')
    assert.equal(done.stopReason, 'max_rounds')
    assert.equal(done.rounds, 2)
    assert.equal(done.content, '[max rounds exceeded]')   // 向后兼容哨兵
    assert.equal(agent.lastStopReason, 'max_rounds')
    // memory 里也保留哨兵(老行为)
    const msgs = await agent.memory.getMessages()
    assert.ok(msgs.some(m => m.role === 'assistant' && m.content === '[max rounds exceeded]'))
  })

  it('validateStreamCompletion: false is plumbed through to the LLM stream', async () => {
    stubFetchStreams([[ 'data: {"choices":[{"delta":{"content":"半截"}}]}' ]])  // 无 finish_reason
    const agent = new Agent({
      provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o-mini',
      memory: new SlidingWindowMemory(50), maxRounds: 2,
      validateStreamCompletion: false,
    })
    const done = await lastDone(agent, 'hi')
    assert.equal(done.content, '半截')  // 不抛,旧容忍行为
  })

  it('default (validation on): truncated stream rejects the run', async () => {
    stubFetchStreams([[ 'data: {"choices":[{"delta":{"content":"半截"}}]}' ]])
    const agent = buildAgent(2)
    await assert.rejects(
      lastDone(agent, 'hi'),
      (err) => err.name === 'LlmStreamIncompleteError',
    )
  })
})
