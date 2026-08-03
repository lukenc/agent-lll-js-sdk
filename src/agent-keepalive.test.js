/**
 * keep-alive —— 还有后台 subagent / 图节点在飞时，一次"无工具调用的最终回答"
 * 不再收尾本轮。
 *
 * 它补的是一个真实的洞：编排者派出三个后台 agent 并说"我等它们回来"，而 ReAct
 * 循环在这句话之后立刻返回 —— 结果回来时已经没人读了。
 *
 * 全文的两条不变量：
 *   - **待注入消息先于在飞判断**。已经跑完的后台 agent 让 `hasInFlight()` 为
 *     假，而它的完成通知还躺在队列里；先判在飞就会收尾走人，通知要等到未来某
 *     轮跑到 round 1 才被排空（drain 只在 `round > 0` 发生）。
 *   - **`lastStopReason` 的取值不扩张**（跨包契约）。超时经 `lastKeepAliveTimedOut`
 *     与 `run.keep_alive.timeout` 事件浮出来。
 */
import test from 'node:test'
import assert from 'node:assert'
import { getEventListeners } from 'node:events'
import { Agent } from './agent.js'
import { SlidingWindowMemory } from './memory.js'

const baseOpts = { provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o' }

/** 造一个非终态的 handle，让 `hasInFlight()` 为真。 */
function stuckAgent(agent, description = 'stuck') {
  return agent.subagents.registry
    .create({ type: 'general-purpose', description, depth: 1, model: null })
    .transition('queued')
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

const finalAnswer = text => ({ choices: [{ message: { content: text } }] })
const finalAnswerSse = text => [
  `data: {"choices":[{"delta":{"content":"${text}"}}]}`,
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
  'data: [DONE]',
]

// ---- runtime.nextEvent ----

test('nextEvent 在后台事件到来时唤醒（而不是等到超时）', async () => {
  const agent = new Agent({ ...baseOpts, subagents: {} })
  const rt = agent.subagents
  let resolved = false
  const startedAt = performance.now()
  // 超时定得远大于事件到来的时间：结果为 'event' 才说明是被唤醒的。
  const waiting = rt.nextEvent({ timeoutMs: 5000 }).then((r) => { resolved = true; return r })
  await new Promise(resolve => setImmediate(resolve))
  assert.strictEqual(resolved, false, '没有事件时必须挂着')

  rt._signalEvent()
  assert.strictEqual(await waiting, 'event')
  assert.ok(performance.now() - startedAt < 5000, '必须是被事件唤醒，不是等到超时')
})

test('nextEvent 超时返回 timeout 而不是挂死', async () => {
  const agent = new Agent({ ...baseOpts, subagents: {} })
  assert.strictEqual(await agent.subagents.nextEvent({ timeoutMs: 20 }), 'timeout')
})

test('nextEvent 支持 abort', async () => {
  const agent = new Agent({ ...baseOpts, subagents: {} })
  const ac = new AbortController()
  const waiting = agent.subagents.nextEvent({ timeoutMs: 5000, signal: ac.signal })
  ac.abort()
  assert.strictEqual(await waiting, 'aborted')

  // 已经 abort 的 signal 直接返回，不注册任何等待方。
  assert.strictEqual(await agent.subagents.nextEvent({ timeoutMs: 5000, signal: ac.signal }), 'aborted')
})

test('nextEvent 不在 signal 上堆积 abort 监听器', async () => {
  // 回归测试：`addEventListener('abort', …, { once: true })` 只在**真的 abort**
  // 时才自摘。走 event / timeout 收尾的那些监听器会一直挂在调用方的 signal 上，
  // 而 keep-alive 每轮都等一次、用的是同一个 signal —— 十轮之后就是
  // MaxListenersExceededWarning。
  const agent = new Agent({ ...baseOpts, subagents: {} })
  const rt = agent.subagents
  const ac = new AbortController()

  for (let i = 0; i < 4; i++) {
    assert.strictEqual(await rt.nextEvent({ timeoutMs: 1, signal: ac.signal }), 'timeout')
  }
  for (let i = 0; i < 4; i++) {
    const waiting = rt.nextEvent({ timeoutMs: 5000, signal: ac.signal })
    rt._signalEvent()
    assert.strictEqual(await waiting, 'event')
  }
  assert.strictEqual(getEventListeners(ac.signal, 'abort').length, 0, 'signal 上不该留下监听器')
})

// ---- _keepAliveOnce 的四种去向 ----

test('未配置 subagents 时 keep-alive 是恒定的 idle', async () => {
  const agent = new Agent({ ...baseOpts })
  assert.strictEqual(agent.subagents, null)
  assert.strictEqual(agent.lastKeepAliveTimedOut, false)
  assert.strictEqual(await agent._keepAliveOnce(), 'idle')
})

test('无待办时最终回答直接结束本轮', async () => {
  const agent = new Agent({ ...baseOpts, subagents: {} })
  assert.strictEqual(agent.subagents.hasInFlight(), false)
  assert.strictEqual(agent.lastKeepAliveTimedOut, false)
  assert.strictEqual(await agent._keepAliveOnce(), 'idle')
})

test('keepAlive: false 时即使还有 agent 在飞也直接收尾', async () => {
  const agent = new Agent({ ...baseOpts, subagents: { keepAlive: false } })
  assert.strictEqual(agent.subagents.keepAlive, false)
  stuckAgent(agent)
  assert.strictEqual(agent.subagents.hasInFlight(), true)
  assert.strictEqual(await agent._keepAliveOnce(), 'idle')
})

test('已完成的后台 agent 留下的通知不会被漏读（顺序回归）', async () => {
  // 回归测试：`_keepAliveOnce` 曾先查在飞状态再查 `_pendingInjections`。
  // 后台 agent 跑完后没有任何东西在飞，于是 return 'idle'、本轮收尾，
  // 而它的完成通知还在队列里 —— "跑完就通知你"直接失效。
  const agent = new Agent({ ...baseOpts, subagents: {} })
  assert.strictEqual(agent.subagents.hasInFlight(), false, '前置条件：没有在飞的 agent')
  agent.enqueueMessage({ role: 'user', content: '<agent-notification>done</agent-notification>' })
  assert.strictEqual(await agent._keepAliveOnce(), 'injected')
})

test('keep-alive 被后台完成通知唤醒后返回 event', async () => {
  const agent = new Agent({ ...baseOpts, subagents: { keepAliveTimeoutMs: 5000 } })
  const handle = stuckAgent(agent)
  const waiting = agent._keepAliveOnce()
  await new Promise(resolve => setTimeout(resolve, 5))
  handle.transition('running').transition('succeeded')
  agent.subagents._onBackgroundSettled(handle, 'bg done')

  assert.strictEqual(await waiting, 'event')
  assert.strictEqual(agent.lastKeepAliveTimedOut, false, 'event 路径不该置超时标记')
  assert.strictEqual(agent._pendingInjections.length, 1, '完成通知已入队，等轮边界排空')
})

test('subagent 给 main 发消息能立刻叫醒停在 keep-alive 里的父 agent', async () => {
  // 回归：`sendMessage` 的 to:'main' 分支只 enqueue、不 `_signalEvent()` —— 父
  // agent 会在 nextEvent 里一直停到超时（生产默认 10 分钟）才读到这条信。而
  // keep-alive 每轮对话只等一次，那一停之后这轮就收尾了。子 agent 跑到一半回头
  // 找父 agent 要个决策，正是 A2A 存在的理由，却拿到了全系统最差的延迟。
  const agent = new Agent({ ...baseOpts, subagents: { keepAliveTimeoutMs: 3000 } })
  const rt = agent.subagents
  const child = rt.registry
    .create({ type: 'general-purpose', description: '在跑', depth: 1, model: null })
  child.transition('queued').transition('running')

  const startedAt = performance.now()
  const waiting = agent._keepAliveOnce()
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.strictEqual(agent._pendingInjections.length, 0, '前置条件：父 agent 确实停在等待里')

  const sendMessage = rt.tools.find(t => t.name === 'send_message')
  const ack = await sendMessage.execute(
    { to: 'main', message: '第二个仓库要不要一起查？' },
    { agentId: child.agentId, agentName: child.name },
  )
  assert.match(ack, /delivered to main/)

  // 超时是 3000ms，断言的是**取值**与"远早于超时" —— 靠超时是过不了的。
  assert.strictEqual(await waiting, 'event', '必须是被这条消息唤醒')
  const elapsed = performance.now() - startedAt
  assert.ok(elapsed < 1000, `应当立刻唤醒，实际等了 ${Math.round(elapsed)}ms`)
  assert.strictEqual(agent._pendingInjections.length, 1)
  assert.match(agent._pendingInjections[0].content, /第二个仓库/)
})

test('keep-alive 超时置 lastKeepAliveTimedOut 且 lastStopReason 仍是 completed', async () => {
  const agent = new Agent({ ...baseOpts, subagents: { keepAliveTimeoutMs: 10 } })
  const events = []
  agent.on('run.keep_alive.timeout', p => events.push(p))

  stuckAgent(agent)
  assert.strictEqual(agent.subagents.hasInFlight(), true)

  const outcome = await agent._keepAliveOnce()
  assert.strictEqual(outcome, 'timeout')
  assert.strictEqual(agent.lastKeepAliveTimedOut, true)
  assert.strictEqual(events.length, 1)
  assert.strictEqual(events[0].pendingAgents, 1)
  assert.strictEqual(events[0].pendingNodes, 0)
  assert.ok(events[0].waitedMs >= 0)
  // 超时也要给模型一条能读的交代，否则它下一轮不知道发生了什么。
  assert.strictEqual(agent._pendingInjections.length, 1)
  assert.ok(agent._pendingInjections[0].content.includes('agent_cancel'))
})

test('lastStopReason 的取值集合没有扩张', () => {
  const agent = new Agent({ ...baseOpts, subagents: {} })
  assert.ok([null, 'completed', 'max_rounds'].includes(agent.lastStopReason))
})

// ---- 超时之后：不再二次等待，但迟到的投递照旧 ----

test('超时后不再等第二次，但迟到的通知仍会被投递', async () => {
  // `maxRounds` 默认 300：不设这道闸，一个卡死的 subagent 能把一轮对话拖成
  // 300 × keepAliveTimeoutMs（默认 10 分钟）≈ 50 小时，并发 300 次超时事件。
  // 抑制的是第二次**等待**，不是第二次**投递** —— 所以待注入判断仍在最前面。
  const agent = new Agent({ ...baseOpts, subagents: { keepAliveTimeoutMs: 50 } })
  const events = []
  agent.on('run.keep_alive.timeout', p => events.push(p))
  const handle = stuckAgent(agent)

  assert.strictEqual(await agent._keepAliveOnce(), 'timeout')
  // 超时提示自己就是一条待注入消息，先被读走。
  assert.strictEqual(await agent._keepAliveOnce(), 'injected')
  agent._drainPendingInjections()

  // 队列空了、agent 仍在飞 —— 这一次必须立刻收尾，不能再等一个完整超时。
  assert.strictEqual(agent.subagents.hasInFlight(), true)
  const startedAt = performance.now()
  assert.strictEqual(await agent._keepAliveOnce(), 'idle')
  assert.ok(performance.now() - startedAt < 25, '不该再等一个完整超时')
  assert.strictEqual(events.length, 1, '超时事件每轮对话只发一次')

  // 但迟到的完成通知照样投递。
  agent.subagents._onBackgroundSettled(handle, 'late but real')
  assert.strictEqual(await agent._keepAliveOnce(), 'injected')
})

test('lastKeepAliveTimedOut 每轮对话重置（不跨会话粘连）', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => jsonResponse(finalAnswer('ok'))
    const agent = new Agent({ ...baseOpts, subagents: {} })
    agent.lastKeepAliveTimedOut = true
    assert.strictEqual(await agent.chat('go'), 'ok')
    assert.strictEqual(agent.lastKeepAliveTimedOut, false, 'chat 入口必须重置')

    globalThis.fetch = async () => sseResponse(finalAnswerSse('ok'))
    agent.lastKeepAliveTimedOut = true
    for await (const _ of agent.stream('go')) { /* drain */ }
    assert.strictEqual(agent.lastKeepAliveTimedOut, false, 'stream 入口必须重置')
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ---- 图节点 ----

test('等待确认的节点：先命中待注入，模型不接手则干净收尾', async () => {
  // 节点走到 awaiting_confirm 时 `onReadyNode` 已经把就绪通知入了队，所以
  // 待注入判断先命中，模型拿到一轮去处理它。模型若不接手，`hasInFlight()`
  // 为假（awaiting_confirm 等的是主 agent，不是后台任务）—— 收尾，不空转。
  const agent = new Agent({ ...baseOpts, subagents: {} })
  // 图是惰性的（多图容器构造时不预先开图），所以先显式开一张 —— 走工具的话
  // `agent_graph` 会替你开。
  agent.subagents.newGraph()
  agent.subagents.graph.declare([{ node_id: 'a', description: '第一步' }])

  assert.strictEqual(agent.subagents.graph.get('a').state, 'awaiting_confirm')
  assert.strictEqual(agent.subagents.hasPending(), true, 'hasPending 把它算成"还有活"')
  assert.strictEqual(agent.subagents.hasInFlight(), false, '但没有任何东西在飞')

  assert.strictEqual(await agent._keepAliveOnce(), 'injected', '就绪通知先被读走')
  agent._drainPendingInjections()

  const startedAt = performance.now()
  assert.strictEqual(await agent._keepAliveOnce(), 'idle', '模型不接手就收尾')
  assert.ok(performance.now() - startedAt < 100, '不该等到 keep-alive 超时')
})

test('超时事件里的 pendingNodes 覆盖 waiting_input 节点', async () => {
  // 回归：手写的状态清单曾经含一个不存在的 'ready'、却漏了 waiting_input ——
  // 一个卡在向用户提问上的节点会被报成"没有待办节点"。计数走图自己的
  // GRAPH_PENDING_STATES，不在第二个文件里重列一份状态。
  const agent = new Agent({ ...baseOpts, subagents: { keepAliveTimeoutMs: 10 } })
  const events = []
  agent.on('run.keep_alive.timeout', p => events.push(p))

  agent.subagents.newGraph()
  agent.subagents.graph.declare([
    { node_id: 'a', description: '在提问' },
    { node_id: 'b', description: '等 a', depends_on: ['a'] },
  ])
  agent.subagents.graph.onAgentSettled({ nodeId: 'a', state: 'waiting_input', agentId: 'ag-1' })
  // a 就绪时入队的那条通知先读掉，否则命中的是 'injected' 而不是等待路径。
  agent._drainPendingInjections()

  assert.strictEqual(await agent._keepAliveOnce(), 'timeout')
  // a: waiting_input（在飞）、b: blocked（等 a）—— 两个都算未完成。
  assert.strictEqual(events[0].pendingNodes, 2)
  assert.strictEqual(events[0].pendingAgents, 0)
})

// ---- 循环级：这才是本任务真正要的行为 ----

test('非流式：有后台 agent 在飞时最终回答不收尾，等结果回来再问一轮', async () => {
  const originalFetch = globalThis.fetch
  try {
    const agent = new Agent({
      ...baseOpts, maxRounds: 5, memory: new SlidingWindowMemory(50),
      subagents: { keepAliveTimeoutMs: 5000 },
    })
    const handle = stuckAgent(agent, '后台调研')

    /** @type {object[]} */
    const bodies = []
    let calls = 0
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(init.body))
      calls += 1
      if (calls === 1) {
        // 第一轮的"我等它们回来"之后，后台 agent 才真的跑完。
        setTimeout(() => {
          handle.transition('running').transition('succeeded')
          agent.subagents._onBackgroundSettled(handle, '调研结论：可行')
        }, 5)
      }
      return jsonResponse(finalAnswer(calls === 1 ? '我等后台结果回来' : '结论：可行'))
    }

    assert.strictEqual(await agent.chat('去调研'), '结论：可行')
    assert.strictEqual(calls, 2, 'keep-alive 必须让模型多拿到一轮')
    assert.strictEqual(agent.lastStopReason, 'completed')
    assert.strictEqual(agent.lastKeepAliveTimedOut, false, '必须是被事件唤醒，不是超时')
    // 后台结论真的上线给了模型。
    const wire = bodies[1].messages.map(m => String(m.content)).join('\n')
    assert.ok(wire.includes('调研结论：可行'), '完成通知必须出现在第二轮请求体里')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('流式：keep-alive 续轮不把注入内容当 chunk 吐给消费方', async () => {
  const originalFetch = globalThis.fetch
  try {
    const agent = new Agent({
      ...baseOpts, maxRounds: 5, memory: new SlidingWindowMemory(50),
      subagents: { keepAliveTimeoutMs: 5000 },
    })
    const handle = stuckAgent(agent, '后台调研')

    let calls = 0
    globalThis.fetch = async () => {
      calls += 1
      if (calls === 1) {
        setTimeout(() => {
          handle.transition('running').transition('succeeded')
          agent.subagents._onBackgroundSettled(handle, '调研结论：可行')
        }, 5)
      }
      return sseResponse(finalAnswerSse(calls === 1 ? '我等后台结果回来' : '结论：可行'))
    }

    const events = []
    for await (const ev of agent.stream('去调研')) events.push(ev)

    assert.strictEqual(calls, 2)
    const done = events.filter(e => e.type === 'done')
    assert.strictEqual(done.length, 1, '只能有一个 done —— 第一轮的最终回答被 keep-alive 接住了')
    assert.strictEqual(done[0].content, '结论：可行')
    assert.strictEqual(done[0].stopReason, 'completed')
    const deltas = events.filter(e => e.type === 'delta').map(e => e.content).join('')
    assert.ok(!deltas.includes('agent-notification'), '注入内容不该作为 chunk 吐出去')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('keep-alive 不制造无界循环：轮次仍受 maxRounds 约束', async () => {
  const originalFetch = globalThis.fetch
  try {
    const agent = new Agent({
      ...baseOpts, maxRounds: 3, memory: new SlidingWindowMemory(50),
      subagents: { keepAliveTimeoutMs: 5000 },
    })
    stuckAgent(agent)

    let calls = 0
    globalThis.fetch = async () => {
      calls += 1
      // 每轮都有新事件唤醒 keep-alive，模型每轮都只给最终回答 —— 没有 maxRounds
      // 这道闸，这就是一个永动机。
      setTimeout(() => agent.subagents._signalEvent(), 5)
      return jsonResponse(finalAnswer('还在等'))
    }

    assert.strictEqual(await agent.chat('go'), '[max rounds exceeded]')
    assert.strictEqual(calls, 3)
    assert.strictEqual(agent.lastStopReason, 'max_rounds')
    assert.strictEqual(agent.lastKeepAliveTimedOut, false, '应当次次被事件唤醒，而非超时')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('未配置 subagents 时循环行为逐字节不变', async () => {
  const originalFetch = globalThis.fetch
  try {
    let calls = 0
    globalThis.fetch = async () => { calls += 1; return jsonResponse(finalAnswer('final')) }
    const agent = new Agent({ ...baseOpts, maxRounds: 5 })
    assert.strictEqual(await agent.chat('go'), 'final')
    assert.strictEqual(calls, 1, '最终回答就该立刻收尾')
    assert.strictEqual(agent.lastStopReason, 'completed')
  } finally {
    globalThis.fetch = originalFetch
  }
})
