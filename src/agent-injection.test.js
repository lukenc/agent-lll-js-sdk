/**
 * 轮边界注入机制。
 *
 * `enqueueMessage()` 只入队；队列在 ReAct 轮边界（上一轮的 assistant(tool_calls)
 * 与全部 tool 结果都已成对落盘之后、本轮请求体构建之前）排空。轮中间插消息会
 * 切断这个配对，`memory-policy.js` 的裁剪逻辑依赖该不变量。
 *
 * 后台 subagent 完成通知、A2A 投递、图节点就绪通知三者共用这一个机制。
 */
import test from 'node:test'
import assert from 'node:assert'
import { Agent } from './agent.js'
import { SlidingWindowMemory } from './memory.js'
import { defineTool } from './tool.js'

const baseOpts = { provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o' }

test('enqueueMessage 入队但不立即进 memory', async () => {
  const agent = new Agent({ ...baseOpts })
  agent.enqueueMessage({ role: 'user', content: '<agent-notification>done</agent-notification>' })
  assert.strictEqual(agent._pendingInjections.length, 1)
  const history = await agent.getHistory('model')
  assert.ok(!history.some(m => String(m.content).includes('agent-notification')))
})

test('_drainPendingInjections 写入 memory 并清空队列', async () => {
  const agent = new Agent({ ...baseOpts })
  agent.enqueueMessage({ role: 'user', content: 'first' })
  agent.enqueueMessage({ role: 'user', content: 'second' })
  assert.strictEqual(agent._drainPendingInjections(), 2)
  assert.strictEqual(agent._pendingInjections.length, 0)
  const history = await agent.getHistory('model')
  const contents = history.map(m => String(m.content))
  assert.ok(contents.includes('first'))
  assert.ok(contents.includes('second'))
})

test('队列为空时 drain 是无副作用的 0', async () => {
  const agent = new Agent({ ...baseOpts })
  const before = (await agent.getHistory('model')).length
  assert.strictEqual(agent._drainPendingInjections(), 0)
  assert.strictEqual((await agent.getHistory('model')).length, before)
})

test('超过 5 条时合并为单条消息', async () => {
  const agent = new Agent({ ...baseOpts })
  for (let i = 0; i < 7; i++) agent.enqueueMessage({ role: 'user', content: `note ${i}` })
  assert.strictEqual(agent._drainPendingInjections(), 1)
  const history = await agent.getHistory('model')
  const merged = history[history.length - 1]
  assert.strictEqual(merged.role, 'user')
  for (let i = 0; i < 7; i++) assert.ok(String(merged.content).includes(`note ${i}`))
})

// ---- 真实 ReAct 轮的配对不变量 ----
//
// 手搓 message 数组证明不了任何事：drain 落在哪里是循环的性质，不是数组的性质。
// 下面两个路径都跑一整轮真实工具调用 —— 通知在**工具执行期间**入队（正是后台
// subagent 完成的时机），然后断言 memory 与下一轮**上线的请求体**里，tool 结果
// 都紧跟其 assistant 消息，注入消息落在整组之后。

/** 抓取每次 fetch 的请求体，供断言"上线"的消息序列。 */
function captureBodies(stub) {
  /** @type {object[]} */
  const bodies = []
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body))
    return stub(url, init)
  }
  return bodies
}

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    async json() { return payload },
    async text() { return JSON.stringify(payload) },
  }
}

function sseResponse(lines) {
  const body = new ReadableStream({
    start(c) {
      for (const l of lines) c.enqueue(new TextEncoder().encode(l + '\n'))
      c.close()
    },
  })
  return new Response(body, { status: 200 })
}

const TOOL_CALL = { id: 'c1', type: 'function', function: { name: 'probe', arguments: '{}' } }

const SYNC_ROUNDS = [
  { choices: [{ message: { content: null, tool_calls: [TOOL_CALL] } }] },
  { choices: [{ message: { content: 'final' } }] },
]

const STREAM_ROUNDS = [
  [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"probe","arguments":"{}"}}]}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
  ],
  [
    'data: {"choices":[{"delta":{"content":"final"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    'data: [DONE]',
  ],
]

/** 断言一条消息序列里 tool 结果紧跟 assistant，且注入落在整组之后。 */
function assertInjectionAfterToolGroup(messages, label) {
  const toolCallIndex = messages.findIndex(m => Array.isArray(m.tool_calls))
  const toolResultIndex = messages.findIndex(m => m.role === 'tool')
  const injectedIndex = messages.findIndex(m => m.content === 'notification')
  assert.ok(toolCallIndex >= 0, `${label}: 应有 assistant(tool_calls) 消息`)
  assert.ok(injectedIndex >= 0, `${label}: 注入消息应已落盘`)
  assert.strictEqual(toolResultIndex, toolCallIndex + 1, `${label}: tool 结果必须紧跟其 assistant 消息`)
  assert.ok(injectedIndex > toolResultIndex, `${label}: 注入必须落在整组工具调用之后`)
}

test('注入发生在轮边界：不破坏 assistant(tool_calls) → tool 的配对', async () => {
  const originalFetch = globalThis.fetch
  try {
    // ---- 非流式路径 ----
    {
      let agent
      const probe = defineTool({
        name: 'probe',
        description: 'probe',
        parameters: { type: 'object', properties: {} },
        // 工具执行期间入队：模拟后台 subagent 在一轮中间完成。
        execute: async () => {
          agent.enqueueMessage({ role: 'user', content: 'notification' })
          return 'result'
        },
      })
      agent = new Agent({ ...baseOpts, maxRounds: 3, memory: new SlidingWindowMemory(50), tools: [probe] })
      let i = 0
      const bodies = captureBodies(async () => jsonResponse(SYNC_ROUNDS[i++]))

      assert.strictEqual(await agent.chat('go'), 'final')
      assert.strictEqual(agent._pendingInjections.length, 0, '轮边界应已排空队列')
      assertInjectionAfterToolGroup(await agent.getHistory('model'), 'sync memory')
      // 第二轮真正上线的请求体里也必须成对且有序。
      assert.strictEqual(bodies.length, 2)
      assertInjectionAfterToolGroup(bodies[1].messages, 'sync wire body')
    }

    // ---- 流式路径 ----
    {
      let agent
      const probe = defineTool({
        name: 'probe',
        description: 'probe',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
          agent.enqueueMessage({ role: 'user', content: 'notification' })
          return 'result'
        },
      })
      agent = new Agent({ ...baseOpts, maxRounds: 3, memory: new SlidingWindowMemory(50), tools: [probe] })
      let i = 0
      const bodies = captureBodies(async () => sseResponse(STREAM_ROUNDS[i++]))

      let done = null
      for await (const ev of agent.stream('go')) {
        if (ev.type === 'done') done = ev
      }
      assert.strictEqual(done.content, 'final')
      assert.strictEqual(agent._pendingInjections.length, 0, '轮边界应已排空队列')
      assertInjectionAfterToolGroup(await agent.getHistory('model'), 'stream memory')
      assert.strictEqual(bodies.length, 2)
      assertInjectionAfterToolGroup(bodies[1].messages, 'stream wire body')
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('非法入参被忽略而不是抛异常', () => {
  const agent = new Agent({ ...baseOpts })
  agent.enqueueMessage(null)
  agent.enqueueMessage('not an object')
  agent.enqueueMessage({ role: 'user' })
  assert.strictEqual(agent._pendingInjections.length, 0)
})

test('role 白名单：tool / assistant 被拒，不会写出孤儿 tool 消息', () => {
  // 回归测试：`role: message.role ?? 'user'` 只挡 null/undefined。显式传 'tool'
  // 会被原样入队，drain 时直接 memory.add，产生一条没有 tool_call_id 的孤儿
  // tool 消息 —— 正是本机制存在的理由所要防的那类破坏。
  const agent = new Agent({ ...baseOpts })
  agent.enqueueMessage({ role: 'tool', content: 'orphan' })
  agent.enqueueMessage({ role: 'assistant', content: 'fake turn' })
  assert.strictEqual(agent._pendingInjections.length, 0, 'tool / assistant 必须被拒')

  agent.enqueueMessage({ role: 'user', content: 'ok' })
  agent.enqueueMessage({ role: 'system', content: 'also ok' })
  assert.deepStrictEqual(agent._pendingInjections.map(m => m.role), ['user', 'system'])
})

test('合并阈值边界：恰好 5 条不合并，6 条合并', async () => {
  const five = new Agent({ ...baseOpts })
  for (let i = 0; i < 5; i++) five.enqueueMessage({ role: 'user', content: `m${i}` })
  assert.strictEqual(five._drainPendingInjections(), 5, '恰好 5 条应逐条写入')

  const six = new Agent({ ...baseOpts })
  for (let i = 0; i < 6; i++) six.enqueueMessage({ role: 'user', content: `m${i}` })
  assert.strictEqual(six._drainPendingInjections(), 1, '6 条应合并为 1 条')
  const history = await six.getHistory('model')
  const merged = history[history.length - 1]
  for (let i = 0; i < 6; i++) assert.ok(String(merged.content).includes(`m${i}`))
})

test('reset() 清空待注入队列，旧会话的通知不漏进新会话', () => {
  const agent = new Agent({ ...baseOpts })
  agent.enqueueMessage({ role: 'user', content: '<agent-notification>stale</agent-notification>' })
  agent.reset()
  assert.strictEqual(agent._pendingInjections.length, 0)
})
