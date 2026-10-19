/**
 * 跨轮通知投递 —— 后台 subagent 在**没有 run 在跑**的时候 settle，它的完成通知
 * 必须还能到达模型。
 *
 * 这是 keep-alive 那套"把本轮撑住"的设计之外的另一半，也是更根本的一半：
 * `_drainPendingInjections()` 只在 `round > 0` 发生，而 `_signalEvent()` 只叫醒
 * 已经在 `nextEvent()` 上等着的人。于是空闲期到达的通知**没有任何投递路径** ——
 * 它入队成功，然后下一次 run 的 round 0 不看它，而那次 run 若只有一轮（模型直接
 * 给了最终回答），就再也不会有 round 1。通知永久搁浅。
 *
 * 解法是反过来的：不在轮内干等，而是**结束本轮、稍后叫醒** —— 空闲的父 agent
 * 走 `followup()`（开新一轮），正忙的父 agent 在当前轮的下一个轮边界排空。
 *
 * 本文件钉住三条不变量：
 *   - **round 0 也排空**。空闲期入队的通知出现在下一次 run 的第一个请求体里。
 *   - **合并为一条 user 消息**。通知与用户新消息相邻，两条连续的 user 会被部分
 *     供应商拒绝（与既有 `INJECTION_MERGE_THRESHOLD` 同一理由）。
 *   - **空闲时入队要发叫醒信号**。宿主无从推断"该再跑一轮了"，除非 SDK 说。
 */
import test from 'node:test'
import assert from 'node:assert'
import { Agent } from './agent.js'

const baseOpts = { provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o' }

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

const finalAnswer = text => ({ choices: [{ message: { content: text } }] })
const finalAnswerSse = text => [
  `data: {"choices":[{"delta":{"content":"${text}"}}]}`,
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
  'data: [DONE]',
]

/** 抓取每次 fetch 上线的请求体。 */
function captureBodies(stub) {
  const bodies = []
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body))
    return stub(url, init)
  }
  return bodies
}

const NOTICE = '<agent-notification agent="deck-builder" state="succeeded">课件已生成，共 12 页。</agent-notification>'

// ---- round 0 排空 ----

test('chat(): 空闲期入队的通知出现在下一次 run 的 round 0 请求体里', async () => {
  const originalFetch = globalThis.fetch
  try {
    const bodies = captureBodies(() => jsonResponse(finalAnswer('好的')))
    const agent = new Agent({ ...baseOpts, subagents: { keepAlive: false } })

    await agent.chat('第一轮')
    assert.strictEqual(bodies.length, 1, '第一轮只该有一次请求')

    // 模拟后台 agent 在**没有 run 在跑**时 settle
    agent.enqueueMessage({ role: 'user', content: NOTICE })
    assert.strictEqual(agent._pendingInjections.length, 1)

    await agent.chat('继续')

    const round0 = bodies[1]
    const text = JSON.stringify(round0.messages)
    assert.ok(text.includes('课件已生成'), 'round 0 必须看得见空闲期到达的通知')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('stream(): round 0 同样排空（两条路径同形）', async () => {
  const originalFetch = globalThis.fetch
  try {
    const bodies = captureBodies(() => sseResponse(finalAnswerSse('好的')))
    const agent = new Agent({ ...baseOpts, subagents: { keepAlive: false } })

    for await (const _ of agent.stream('第一轮')) { /* drain */ }
    agent.enqueueMessage({ role: 'user', content: NOTICE })
    for await (const _ of agent.stream('继续')) { /* drain */ }

    const text = JSON.stringify(bodies[1].messages)
    assert.ok(text.includes('课件已生成'), 'stream 路径的 round 0 也必须看得见通知')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('通知与用户新消息合并为一条 user 消息（不产生连续 user）', async () => {
  const originalFetch = globalThis.fetch
  try {
    const bodies = captureBodies(() => jsonResponse(finalAnswer('好的')))
    const agent = new Agent({ ...baseOpts, subagents: { keepAlive: false } })

    await agent.chat('第一轮')
    agent.enqueueMessage({ role: 'user', content: NOTICE })
    await agent.chat('继续')

    const messages = bodies[1].messages.filter(m => m.role === 'user')
    for (let i = 1; i < messages.length; i++) {
      // 允许历史里本来就有相邻 user（本用例没有），但本次注入不得新增一对
      assert.ok(messages[i - 1] !== messages[i])
    }
    const last = messages[messages.length - 1]
    assert.ok(last.content.includes('课件已生成'), '通知进了这条消息')
    assert.ok(last.content.includes('继续'), '用户的新消息也进了同一条')
    // 合并后总的 user 消息条数不该比不注入时多出一条
    assert.strictEqual(messages.length, 2, '第一轮的 user + 本轮合并后的一条')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('队列空时 round 0 排空是无副作用的（逐字节等同旧行为）', async () => {
  const originalFetch = globalThis.fetch
  try {
    const bodies = captureBodies(() => jsonResponse(finalAnswer('好的')))
    const agent = new Agent({ ...baseOpts, subagents: { keepAlive: false } })

    await agent.chat('第一轮')
    await agent.chat('第二轮')

    const users = bodies[1].messages.filter(m => m.role === 'user')
    assert.strictEqual(users[users.length - 1].content, '第二轮', '没有通知就不该改动用户消息')
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ---- 空闲叫醒信号 ----

test('空闲时入队会发 run.wakeup，宿主据此再跑一轮', async () => {
  const agent = new Agent({ ...baseOpts, subagents: { keepAlive: false } })
  const wakes = []
  agent.on('run.wakeup', (p) => wakes.push(p))

  agent.enqueueMessage({ role: 'user', content: NOTICE })

  assert.strictEqual(wakes.length, 1, '空闲期入队必须发一次叫醒')
  assert.strictEqual(wakes[0].pendingInjections, 1)
})

test('followup() 不开新 run 也能把积压通知跑掉', async () => {
  const originalFetch = globalThis.fetch
  try {
    const bodies = captureBodies(() => jsonResponse(finalAnswer('收到，课件已生成')))
    const agent = new Agent({ ...baseOpts, subagents: { keepAlive: false } })

    await agent.chat('第一轮')
    agent.enqueueMessage({ role: 'user', content: NOTICE })

    const answer = await agent.followup()

    assert.strictEqual(answer, '收到，课件已生成')
    const text = JSON.stringify(bodies[1].messages)
    assert.ok(text.includes('课件已生成'), 'followup 的请求体里带着通知')
    assert.strictEqual(agent._pendingInjections.length, 0, '队列已排空')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('followup() 在队列为空时不发请求（不空转烧 token）', async () => {
  const originalFetch = globalThis.fetch
  try {
    const bodies = captureBodies(() => jsonResponse(finalAnswer('好的')))
    const agent = new Agent({ ...baseOpts, subagents: { keepAlive: false } })

    const answer = await agent.followup()

    assert.strictEqual(bodies.length, 0, '没有任何待投递内容就不该调 LLM')
    assert.strictEqual(answer, null)
  } finally {
    globalThis.fetch = originalFetch
  }
})
