/**
 * keep-alive 的**等待预算** —— 取代原来那道一次性的粘性闸门。
 *
 * 原缺陷（客户端报告 §3）：`lastKeepAliveTimedOut` 在整个 run 内是粘性的，超时
 * 一次之后 `_keepAliveOnce()` 就恒定返回 `'idle'`，调用点把 `'idle'` 当成"模型
 * 说完了"，于是 run 在**仍有子 agent 在飞**时结束、对外报 `stopReason:'completed'`。
 * 模型说一句"任务重，我继续等通知"（这是它的合理推断，工具描述刚刚承诺过
 * "you will be notified when one completes"），整个 run 就地终止。
 *
 * dsh 里没有这道闸门 —— 搜遍全仓没有 `lastKeepAlive` / `alreadyWaited` /
 * `keep_alive_waiting` 之类。它的对应机制是**唤醒预算**：
 * `tool-jobs/src/index.ts:208-228, 292-298`
 *   - `maxConsecutiveWakes` 默认 3；
 *   - `if (!Number.isSafeInteger(wakeBudget)) throw`（**构造期**，不是调用期）；
 *   - `spent < wakeBudget` 才 `owner.followup(message)`，否则**降级为 `inject`**；
 *   - 只在 `agent/inbox/claimed` 且 `message.source.kind === 'user'` 时
 *     `spentWakes.delete(agent)` —— 注释写得很直白："a notice this plugin itself
 *     queued must not refill the budget it just spent"。
 *
 * 两边的差别正是缺陷所在：**dsh 的预算约束"再叫醒一次"，我们的闸门抑制"等待"
 * 本身**，而抑制等待的后果是通知无处投递、run 谎报完成。
 *
 * 本文件钉住五条不变量：
 *   - 预算是**计数**而非布尔：耗尽前每次超时都真的等满 `keepAliveTimeoutMs`。
 *   - 耗尽后不再替模型撑住本轮，但**发事件、留清单**，不是静默走人。
 *   - 用户亲手输入的新一轮补回预算；框架自己开的续跑轮（`followup`）不补。
 *   - 被事件唤醒（真有结果回来）不花预算 —— 花预算的是白等。
 *   - 预算耗尽**不取消**在飞的子 agent（dsh 同样只在 disposal 时取消）。它的结果
 *     仍会在下一次 user 轮的 round 0 或宿主调 `followup()` 时送达 —— 这是
 *     `agent-wakeup.test.js` 那条投递路径给的保证，也是本任务得以成立的前提：
 *     先有"结束本轮不再是弃置"，才谈得上把闸门换成预算。
 */
import test from 'node:test'
import assert from 'node:assert'
import { Agent } from './agent.js'
import { SlidingWindowMemory } from './memory.js'

const baseOpts = { provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o' }

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    async json() { return payload },
    async text() { return JSON.stringify(payload) },
  }
}

const finalAnswer = text => ({ choices: [{ message: { content: text } }] })

/** 造一个非终态 handle，让 `hasInFlight()` 为真。 */
function stuckAgent(agent, description = 'stuck') {
  return agent.subagents.registry
    .create({ type: 'general-purpose', description, depth: 1, model: null })
    .transition('queued')
}

/** 超时那一次会自己入队一条"请收尾"，不排空的话下一次命中的是 'injected'。 */
function drainKeepAliveNotice(agent) {
  assert.strictEqual(agent._pendingInjections.length, 1, '超时必须给模型留一句话')
  agent._drainPendingInjections()
}

// ---- 配置 ----

test('maxConsecutiveWakes 默认 3（与 dsh 同值）', () => {
  const agent = new Agent({ ...baseOpts, subagents: {} })
  assert.strictEqual(agent.subagents.maxConsecutiveWakes, 3)
})

test('maxConsecutiveWakes 可配置', () => {
  const agent = new Agent({ ...baseOpts, subagents: { maxConsecutiveWakes: 1 } })
  assert.strictEqual(agent.subagents.maxConsecutiveWakes, 1)
})

test('非法的 maxConsecutiveWakes 在构造期抛（不留到调用期）', () => {
  // dsh 同款校验（`tool-jobs/src/index.ts:219-221`）。留到调用期抛的话，一次
  // 本来成功的 keep-alive 会变成 run 报错 —— 配置错误应当让初始化失败。
  for (const bad of [0, -1, 2.5, Number.POSITIVE_INFINITY, Number.NaN, '3', null]) {
    assert.throws(
      () => new Agent({ ...baseOpts, subagents: { maxConsecutiveWakes: bad } }),
      /maxConsecutiveWakes/,
      `应当拒绝 ${String(bad)}`,
    )
  }
  // Infinity 是"不设界"的直觉写法，但它正是这个字段存在的理由所要防的，必须点名拒。
  assert.throws(
    () => new Agent({ ...baseOpts, subagents: { maxConsecutiveWakes: Number.POSITIVE_INFINITY } }),
    /whole number/,
  )
})

// ---- 预算是计数，不是布尔 ----

test('预算耗尽前，每一次超时都真的等满 keepAliveTimeoutMs', async () => {
  const agent = new Agent({
    ...baseOpts,
    subagents: { keepAliveTimeoutMs: 40, maxConsecutiveWakes: 3 },
  })
  stuckAgent(agent)
  const timeouts = []
  agent.on('run.keep_alive.timeout', p => timeouts.push(p))

  for (let i = 1; i <= 3; i++) {
    const startedAt = performance.now()
    assert.strictEqual(await agent._keepAliveOnce(), 'timeout', `第 ${i} 次仍该等`)
    const waited = performance.now() - startedAt
    assert.ok(waited >= 35, `第 ${i} 次必须等满，实际 ${Math.round(waited)}ms`)
    drainKeepAliveNotice(agent)
  }
  assert.strictEqual(timeouts.length, 3, '粘性闸门下这里只会是 1')

  // 第 4 次：预算耗尽，立刻收尾，不再等一个完整超时。
  const startedAt = performance.now()
  assert.strictEqual(await agent._keepAliveOnce(), 'idle')
  assert.ok(performance.now() - startedAt < 20, '耗尽后不该再等')
  assert.strictEqual(timeouts.length, 3, '耗尽后不再产生超时事件')
  assert.strictEqual(agent.subagents.hasInFlight(), true, '子 agent 没被取消，只是在飞')
})

test('预算耗尽时发 run.keep_alive.gave_up，并带上被留下的在飞清单', async () => {
  const agent = new Agent({
    ...baseOpts,
    subagents: { keepAliveTimeoutMs: 10, maxConsecutiveWakes: 1 },
  })
  const handle = stuckAgent(agent, '做课件')
  const gaveUp = []
  agent.on('run.keep_alive.gave_up', p => gaveUp.push(p))

  assert.strictEqual(await agent._keepAliveOnce(), 'timeout')
  drainKeepAliveNotice(agent)
  assert.strictEqual(gaveUp.length, 0, '预算还在，不该发放弃事件')

  assert.strictEqual(await agent._keepAliveOnce(), 'idle')
  assert.strictEqual(gaveUp.length, 1, '耗尽的那一刻必须说一声')
  assert.strictEqual(gaveUp[0].spent, 1)
  assert.strictEqual(gaveUp[0].budget, 1)
  assert.strictEqual(gaveUp[0].pendingAgents, 1)
  assert.strictEqual(gaveUp[0].pendingNodes, 0)
  // 清单是宿主决定"要不要关、要不要告诉用户"的唯一依据（报告 §5）。
  assert.deepStrictEqual(
    gaveUp[0].inFlight.map(a => ({ name: a.name, state: a.state })),
    [{ name: handle.name, state: 'queued' }],
  )
  assert.strictEqual(gaveUp[0].inFlight[0].agentId, handle.agentId)
})

test('预算耗尽不取消在飞的子 agent（signal 不被 abort）', async () => {
  // dsh 只在 disposal 时取消（`continuation.ts:1528-1544`），run 结束不取消。
  // 报告 §10 #7 建议"run 结束时自动 closeSubagents()"，那恰好会杀掉它自己
  // §7 最想要的"派慢任务、下轮收结果"。
  const agent = new Agent({
    ...baseOpts,
    subagents: { keepAliveTimeoutMs: 10, maxConsecutiveWakes: 1 },
  })
  stuckAgent(agent)
  const cancelled = []
  agent.on('agent.cancelled', p => cancelled.push(p))

  await agent._keepAliveOnce()
  drainKeepAliveNotice(agent)
  await agent._keepAliveOnce()

  assert.strictEqual(agent.subagents.hasInFlight(), true)
  assert.strictEqual(cancelled.length, 0, '放弃等待 ≠ 取消工作')
})

// ---- 谁补回预算 ----
//
// 三条用例都**数超时事件**而不是读 `_spentKeepAliveWakes`：预算为 1 时，一次
// refill 之后再花掉一次，计数同样是 1 —— 单看那个字段区分不出"补回了"和"没补"。
// 事件数才是可观测的后果，也正是要钉住的行为。

test('用户亲手输入的新一轮补回预算', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => jsonResponse(finalAnswer('ok'))
    const agent = new Agent({
      ...baseOpts, memory: new SlidingWindowMemory(50),
      subagents: { keepAliveTimeoutMs: 5, maxConsecutiveWakes: 2 },
    })
    stuckAgent(agent)
    const timeouts = []
    agent.on('run.keep_alive.timeout', p => timeouts.push(p))

    await agent.chat('第一轮')
    assert.strictEqual(timeouts.length, 2, '第一轮把预算花光')
    assert.strictEqual(agent._spentKeepAliveWakes, 2)

    // 用户又说话了 —— dsh 的 refill 条件是 `message.source.kind === 'user'`。
    // 补回之后这一轮又能等满整个预算；不补的话它会一次都不等、直接 gave_up。
    await agent.chat('继续')
    assert.strictEqual(timeouts.length, 4, 'chat 入口必须补回，第二轮同样等满预算')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('followup() 不补回预算（框架自己开的轮次不能 refill 它刚花掉的预算）', async () => {
  // dsh 原话：a notice this plugin itself queued must not refill the budget it
  // just spent。少了这条，`followup` → `chat` 会把预算立刻充满，闸门等于不存在，
  // 自激链（被叫醒的一轮又派一个后台任务、它的完成又叫醒同一轮）重新无界。
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => jsonResponse(finalAnswer('ok'))
    const agent = new Agent({
      ...baseOpts, memory: new SlidingWindowMemory(50),
      subagents: { keepAliveTimeoutMs: 5, maxConsecutiveWakes: 2 },
    })
    stuckAgent(agent)
    const timeouts = []
    agent.on('run.keep_alive.timeout', p => timeouts.push(p))

    await agent.chat('第一轮')
    assert.strictEqual(timeouts.length, 2, '第一轮把预算花光')

    agent.enqueueMessage({ role: 'user', content: '<agent-notification>done</agent-notification>' })
    const answer = await agent.followup()
    assert.strictEqual(answer, 'ok')
    assert.strictEqual(timeouts.length, 2, 'followup 不得 refill：这一轮一次都不该再等')
    assert.strictEqual(agent._spentKeepAliveWakes, 2, '花费原样保留')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('stream() 入口同样补回预算（两条路径同形）', async () => {
  const originalFetch = globalThis.fetch
  try {
    const sse = text => new Response(new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(`data: {"choices":[{"delta":{"content":"${text}"}}]}\n`))
        c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n'))
        c.enqueue(new TextEncoder().encode('data: [DONE]\n'))
        c.close()
      },
    }), { status: 200 })
    globalThis.fetch = async () => sse('ok')

    const agent = new Agent({
      ...baseOpts, memory: new SlidingWindowMemory(50),
      subagents: { keepAliveTimeoutMs: 5, maxConsecutiveWakes: 2 },
    })
    stuckAgent(agent)
    const timeouts = []
    agent.on('run.keep_alive.timeout', p => timeouts.push(p))

    for await (const _ of agent.stream('第一轮')) { /* drain */ }
    assert.strictEqual(timeouts.length, 2)
    for await (const _ of agent.stream('继续')) { /* drain */ }
    assert.strictEqual(timeouts.length, 4, 'stream 入口同样补回')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('reset() 清空预算（新会话不继承上一会话的花费）', async () => {
  const agent = new Agent({
    ...baseOpts, subagents: { keepAliveTimeoutMs: 10, maxConsecutiveWakes: 2 },
  })
  agent._spentKeepAliveWakes = 2
  agent.reset()
  assert.strictEqual(agent._spentKeepAliveWakes, 0)
})

// ---- 什么算花预算 ----

test('被事件唤醒不花预算（花预算的是白等，不是有结果的等）', async () => {
  const agent = new Agent({
    ...baseOpts,
    subagents: { keepAliveTimeoutMs: 5000, maxConsecutiveWakes: 1 },
  })
  const handle = stuckAgent(agent)

  const waiting = agent._keepAliveOnce()
  await new Promise(r => setTimeout(r, 5))
  handle.transition('running').transition('succeeded')
  agent.subagents._onBackgroundSettled(handle, '结果回来了')

  assert.strictEqual(await waiting, 'event')
  assert.strictEqual(agent._spentKeepAliveWakes, 0, 'event 路径不花预算')

  // 预算仍是满的：下一次白等照样等满一个超时，而不是直接放弃。
  const h2 = stuckAgent(agent, '第二个')
  const startedAt = performance.now()
  const agent2 = new Agent({
    ...baseOpts, subagents: { keepAliveTimeoutMs: 40, maxConsecutiveWakes: 1 },
  })
  stuckAgent(agent2)
  assert.strictEqual(await agent2._keepAliveOnce(), 'timeout')
  assert.ok(performance.now() - startedAt >= 35)
  assert.ok(h2)
})

test('事件唤醒也不 refill 预算（与 dsh 一致：只有用户输入 refill）', async () => {
  // 若事件也 refill，一个不断 settle 的流就能让"白等"计数永远归零，
  // 交错出现的挂死子 agent 于是把 run 拖到 maxRounds 耗尽。
  const agent = new Agent({
    ...baseOpts,
    subagents: { keepAliveTimeoutMs: 10, maxConsecutiveWakes: 2 },
  })
  const h1 = stuckAgent(agent, '第一个')
  h1.transition('running').transition('succeeded')
  agent.subagents._onBackgroundSettled(h1, 'done')
  agent._drainPendingInjections()

  const h2 = stuckAgent(agent, '第二个，挂死')
  assert.strictEqual(await agent._keepAliveOnce(), 'timeout')
  assert.strictEqual(agent._spentKeepAliveWakes, 1)
  drainKeepAliveNotice(agent)
  assert.strictEqual(await agent._keepAliveOnce(), 'timeout', '预算还剩一次')
  assert.strictEqual(agent._spentKeepAliveWakes, 2)
  drainKeepAliveNotice(agent)
  assert.strictEqual(await agent._keepAliveOnce(), 'idle', '现在才耗尽')
  assert.strictEqual(agent.subagents.hasInFlight(), true)
  assert.ok(h2)
})

// ---- lastKeepAliveTimedOut 的既有契约不变 ----

test('lastKeepAliveTimedOut 仍在第一次超时时置位（跨包契约不动）', async () => {
  const agent = new Agent({
    ...baseOpts,
    subagents: { keepAliveTimeoutMs: 10, maxConsecutiveWakes: 3 },
  })
  stuckAgent(agent)
  assert.strictEqual(agent.lastKeepAliveTimedOut, false)
  await agent._keepAliveOnce()
  assert.strictEqual(agent.lastKeepAliveTimedOut, true, '第一次超时就置位，语义与旧版一致')
})

test('lastStopReason 的取值集合仍未扩张', () => {
  const agent = new Agent({ ...baseOpts, subagents: {} })
  assert.ok([null, 'completed', 'max_rounds'].includes(agent.lastStopReason))
})

// ---- 端到端：这才是报告 §3 + §4 要的行为 ----

test('预算耗尽结束 run 之后，子 agent 的结果仍能送达（不再静默弃置）', async () => {
  // 报告的最小复现（附录 A）在旧版止于："run 结束、hasInFlight() 为真、
  // 零个终态事件、signal 从未 abort、800ms 后队列仍是 0" —— 结果永久无处可去。
  // 修好之后同一条时间线必须是：run 结束 → 子 agent 空闲期 settle →
  // run.wakeup → followup() 把结果跑成一轮。
  const originalFetch = globalThis.fetch
  try {
    let releaseChild = null
    const childGate = new Promise(r => { releaseChild = r })
    let mainRound = 0
    const bodies = []

    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body)
      bodies.push(body)
      const isMain = String(body.messages[0]?.content ?? '').includes('MAIN')
      if (!isMain) {
        await childGate                      // 子 agent 的请求挂住，直到我们放行
        return jsonResponse(finalAnswer('CHILD RESULT: 课件共 12 页'))
      }
      const message = mainRound++ === 0
        ? {
            content: '',
            tool_calls: [{
              id: 'c1', type: 'function',
              function: {
                name: 'agent',
                arguments: JSON.stringify({ description: 'slow task', prompt: 'generate a large document' }),
              },
            }],
          }
        : { content: `第 ${mainRound} 轮：子 agent 还在跑，我继续等它的通知。` }
      return jsonResponse({ choices: [{ message }] })
    }

    const agent = new Agent({
      ...baseOpts, url: 'http://mock/v1/chat/completions',
      systemPrompt: 'MAIN agent', tools: [], maxRounds: 20,
      memory: new SlidingWindowMemory(50),
      subagents: { keepAliveTimeoutMs: 40, maxConsecutiveWakes: 2 },
    })

    const gaveUp = []
    agent.on('run.keep_alive.gave_up', p => gaveUp.push(p))
    const wakes = []
    agent.on('run.wakeup', p => wakes.push(p))
    const terminal = []
    for (const t of ['agent.succeeded', 'agent.failed', 'agent.cancelled']) {
      agent.on(t, p => terminal.push({ event: t, ...p }))
    }

    await agent.chat('请并行处理这件事')

    // 预算耗尽而收尾，但**说清楚了**：发过放弃事件、带着在飞清单。
    assert.strictEqual(gaveUp.length, 1, '必须发一次 gave_up')
    assert.strictEqual(gaveUp[0].inFlight.length, 1)
    assert.strictEqual(agent.subagents.hasInFlight(), true, '子 agent 还在跑（没被取消）')
    assert.strictEqual(terminal.length, 0, '还没有终态 —— 它真的还在跑')

    // 放行子 agent：它在**没有 run 在跑**的时候 settle。
    releaseChild()
    await new Promise(r => setTimeout(r, 200))

    assert.strictEqual(terminal.filter(e => e.event === 'agent.succeeded').length, 1,
      '子 agent 跑完了，终态事件必须发出来（旧版这里是 0）')
    assert.strictEqual(wakes.length, 1, '空闲期入队必须叫醒宿主')
    assert.strictEqual(agent._pendingInjections.length, 1)
    assert.ok(agent._pendingInjections[0].content.includes('CHILD RESULT'),
      '结果就躺在队列里，等着被投递')

    // 宿主收到 run.wakeup 后续跑一轮 —— 结果进了模型。
    const answer = await agent.followup()
    assert.strictEqual(agent._pendingInjections.length, 0, '队列已排空')
    const wire = JSON.stringify(bodies[bodies.length - 1].messages)
    assert.ok(wire.includes('CHILD RESULT'), '完成通知必须出现在续跑轮的请求体里')
    assert.ok(typeof answer === 'string' && answer.length > 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})
