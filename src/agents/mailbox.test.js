import test from 'node:test'
import assert from 'node:assert'
import { Mailbox } from './mailbox.js'
import { RuntimeHistory } from '../runtime-history.js'
import { createSubagentRuntime } from './runtime.js'
import { resetAgentTypes } from './types.js'
import { Agent } from '../agent.js'

const envelope = (to, body, from = { agentId: 'agt_1', name: 'planner-1' }) => ({
  jsonrpc: '2.0', id: `env_${body}`, method: 'message/send',
  params: { from, to: { agentId: to }, kind: 'message', correlationId: null, body, meta: {} },
})

test('投递后可按 agentId 排空，FIFO', () => {
  const mb = new Mailbox()
  mb.deliver(envelope('agt_2', 'first'))
  mb.deliver(envelope('agt_2', 'second'))
  assert.strictEqual(mb.size('agt_2'), 2)
  const drained = mb.drain('agt_2')
  assert.deepStrictEqual(drained.map(e => e.params.body), ['first', 'second'])
  assert.strictEqual(mb.size('agt_2'), 0)
  assert.deepStrictEqual(mb.drain('agt_2'), [])
})

test('收件箱按 agent 隔离', () => {
  const mb = new Mailbox()
  mb.deliver(envelope('agt_2', 'for-2'))
  mb.deliver(envelope('agt_3', 'for-3'))
  assert.strictEqual(mb.drain('agt_2').length, 1)
  assert.strictEqual(mb.drain('agt_3')[0].params.body, 'for-3')
})

test('注入文本点名发信人', () => {
  const mb = new Mailbox()
  const text = mb.formatForInjection(envelope('agt_2', '上游产物在 docs/x.md'))
  assert.ok(text.includes('planner-1'))
  assert.ok(text.includes('上游产物在 docs/x.md'))
  assert.ok(text.includes('agent-message'))
})

test('main 也能收件', () => {
  const mb = new Mailbox()
  mb.deliver(envelope('main', 'to parent'))
  assert.strictEqual(mb.drain('main').length, 1)
})

// ---- send_message 的三条投递路径 ----

test.beforeEach(() => resetAgentTypes())

function fakeParent() {
  return {
    _providerName: 'openai', model: 'm', apiKey: 'k', url: 'u',
    simpleModel: 'm', simpleApiKey: 'k', simpleUrl: 'u',
    tools: [], hooks: {}, knowledgeBase: null, tokenBudget: null, validateStreamCompletion: true,
    memory: { runtimeHistory: new RuntimeHistory(), add() {} },
    _events: [],
    emit(type, payload) { this._events.push({ type, payload }) },
    _injected: [],
    enqueueMessage(msg) { this._injected.push(msg) },
  }
}

/**
 * 造一个可控的假子 Agent 工厂。
 * - `block(message)` 为真 → 那次 `chat()` 一直挂着，模拟"正在跑一个长工具"，
 *   由 `child.release()` 放行或由 abort 打断；
 * - `roundBoundary()` → 手动触发一次 `hooks.onRoundStart`，模拟 ReAct 轮边界。
 */
function makeRuntime({ block = () => false, reply = () => '结果', ...extra } = {}) {
  const parent = fakeParent()
  const state = { children: [], chats: [] }
  const rt = createSubagentRuntime({
    parent,
    createAgent: (options) => {
      const child = {
        options,
        lastStopReason: null,
        injected: [],
        on() { return this }, off() { return this },
        getLastRunMetrics: () => ({ totalRounds: 1, totalLlmCalls: 1, totalToolCalls: 0, usage: {}, wallClockMs: 1 }),
        enqueueMessage(msg) { child.injected.push(msg); return child },
        roundBoundary() { options.hooks.onRoundStart?.(1) },
        async chat(message, { signal } = {}) {
          state.chats.push(message)
          if (!block(message)) return reply(message)
          // abort 感知的挂起 —— 否则 runtime.close() 取消它之后 drain() 会永远等下去
          // （真实的 fetch 也是以 signal.reason 原样 reject）。
          return new Promise((resolve, reject) => {
            child.release = resolve
            if (signal?.aborted) reject(signal.reason)
            else signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
        },
      }
      state.children.push(child)
      return child
    },
    ...extra,
  })
  return { rt, state, parent, send: rt.tools.find(t => t.name === 'send_message') }
}

const tick = () => new Promise(resolve => setImmediate(resolve))
const MAIN_CTX = { agentId: 'main', agentName: 'main' }

test('给在跑的 agent 发信：不打断它，信在下一个轮边界才进它的上下文', async () => {
  const { rt, state, parent, send } = makeRuntime({ block: () => true })
  await rt.spawn({ description: 'd', prompt: 'p' })
  await tick()
  const [handle] = rt.registry.list()

  const out = await send.execute({ to: handle.name, message: '上游产物在 docs/x.md' }, MAIN_CTX)
  assert.match(out, /next round boundary/)

  const [child] = state.children
  assert.strictEqual(child.injected.length, 0, '发信不能打断收信方手上的工具调用')
  assert.strictEqual(rt.mailbox.size(handle.agentId), 1, '信应当先躺在收件箱里')

  child.roundBoundary()
  assert.strictEqual(child.injected.length, 1)
  assert.strictEqual(child.injected[0].role, 'user', 'enqueueMessage 只接受 user / system')
  assert.ok(child.injected[0].content.includes('上游产物在 docs/x.md'))
  assert.ok(child.injected[0].content.includes('<agent-message'))
  assert.strictEqual(rt.mailbox.size(handle.agentId), 0)

  assert.ok(parent._events.some(e => e.type === 'a2a.delivered'
    && e.payload.to === handle.agentId && e.payload.from === 'main'))

  child.release('收到')
  await rt.drain()
})

test('给已完成的 agent 发信：用它保留的上下文续跑，返回新的 Agent_Result', async () => {
  const { rt, state, send } = makeRuntime({
    reply: (msg) => (msg.includes('<agent-message') ? '已按新信息修正：改用 JWT' : '初版报告'),
  })
  const first = await rt.spawn({ description: 'd', prompt: 'p', background: false })
  assert.ok(first.includes('初版报告'))
  const [handle] = rt.registry.list({ includeFinished: true })
  assert.strictEqual(handle.state, 'succeeded')

  const out = await send.execute({ to: handle.name, message: '需求变了：换成 JWT' }, MAIN_CTX)

  assert.match(out, /^\[agent:general-purpose-1 succeeded\]/m)
  assert.ok(out.includes('已按新信息修正：改用 JWT'))
  assert.ok(state.chats[1].includes('需求变了：换成 JWT'), '续跑的输入就是那封信')
  assert.strictEqual(rt.mailbox.size(handle.agentId), 0)
  assert.strictEqual(handle.state, 'succeeded')
  assert.ok(handle.endedAt > 0, '续跑收尾必须重新盖上 endedAt')
})

test('续跑失败按失败类型收尾，而不是笼统的 llm_error', async () => {
  const { rt, send } = makeRuntime({
    reply: (msg) => {
      if (!msg.includes('<agent-message')) return '初版报告'
      throw new Error('fetch failed')
    },
  })
  await rt.spawn({ description: 'd', prompt: 'p', background: false })
  const [handle] = rt.registry.list({ includeFinished: true })

  const out = await send.execute({ to: handle.name, message: '再核对一遍' }, MAIN_CTX)
  assert.match(out, /^\[agent:general-purpose-1 failed\]/m)
  assert.strictEqual(handle.state, 'failed')
  assert.strictEqual(handle.result.failureKind, 'network')
})

test('续跑期间被 agent_cancel：落在 cancelled，不被续跑结果覆盖成 succeeded', async () => {
  const { rt, send } = makeRuntime({
    block: (msg) => msg.includes('<agent-message'),
    reply: () => '初版报告',
  })
  await rt.spawn({ description: 'd', prompt: 'p', background: false })
  const [handle] = rt.registry.list({ includeFinished: true })

  const resumed = send.execute({ to: handle.name, message: '再想想' }, MAIN_CTX)
  await tick()
  assert.strictEqual(handle.state, 'running', '续跑期间应当重新回到 running，才能被取消')

  await rt.tools.find(t => t.name === 'agent_cancel').execute({ agent_id: handle.name, reason: '不用做了' })
  const out = await resumed

  assert.match(out, /^\[agent:general-purpose-1 cancelled\]/m)
  assert.ok(out.includes('不用做了'))
  assert.strictEqual(handle.result.status, 'cancelled')
})

test('上下文已被淘汰的 agent：软失败并让模型另起一个，信不留在收件箱里', async () => {
  const { rt, send } = makeRuntime({ retainCompleted: 0 })
  await rt.spawn({ description: 'd', prompt: 'p', background: false })
  const [handle] = rt.registry.list({ includeFinished: true })
  assert.ok(rt.registry.evicted(handle.agentId))

  const out = await send.execute({ to: handle.name, message: '再补一段' }, MAIN_CTX)
  assert.ok(/evicted/.test(out) && /Start a new agent/.test(out))
  assert.strictEqual(rt.mailbox.size(handle.agentId), 0, '没人会读的收件箱不该越积越多')
})

test('未知收信人与空消息都软失败，不抛异常', async () => {
  const { send } = makeRuntime()
  assert.match(await send.execute({ to: 'nope', message: 'x' }, MAIN_CTX), /not found/)
  assert.match(await send.execute({ to: 'main', message: '  ' }, MAIN_CTX), /^Error: `message`/)
  assert.match(await send.execute({ message: 'x' }, MAIN_CTX), /^Error: `to`/)
})

test('发给 main 的信立刻排进父的待注入队列', async () => {
  const { rt, parent, send } = makeRuntime()
  const out = await send.execute({ to: 'main', message: '第 3 步卡住了，需要决策' },
    { agentId: 'agt_x', agentName: 'planner-1' })
  assert.match(out, /delivered to main/)
  assert.strictEqual(parent._injected.length, 1)
  assert.strictEqual(parent._injected[0].role, 'user')
  assert.ok(parent._injected[0].content.includes('planner-1'))
  assert.ok(parent._injected[0].content.includes('第 3 步卡住了'))
  assert.strictEqual(rt.mailbox.size('main'), 0)
})

test('"parent" 指发信人自己的上级，不越级到 main', async () => {
  const { rt, send } = makeRuntime({ block: () => true })
  await rt.spawn({ description: 'lead', prompt: 'p' })
  await tick()
  const [lead] = rt.registry.list()
  await rt.spawn({ description: 'worker', prompt: 'p', depth: 2, parentAgentId: lead.agentId })
  await tick()
  const worker = rt.registry.list().find(h => h.agentId !== lead.agentId)

  const out = await send.execute({ to: 'parent', message: '子任务完成' },
    { agentId: worker.agentId, agentName: worker.name })
  assert.ok(out.includes(lead.name), `depth 2 的 "parent" 应当是 ${lead.name}，实际：${out}`)
  assert.strictEqual(rt.mailbox.size(lead.agentId), 1)
  assert.strictEqual(rt.mailbox.size('main'), 0)

  // depth 1 的 agent 说 "parent" 时才等价于 main。
  const toMain = await send.execute({ to: 'parent', message: '进度汇报' },
    { agentId: lead.agentId, agentName: lead.name })
  assert.match(toMain, /delivered to main/)

  // 两个 agent 都还挂在 chat() 上，close() 负责 abort 它们。
  await rt.close()
})

test('后台 agent 完成后，通知进了父的待注入队列', async () => {
  const { rt, parent } = makeRuntime({ reply: () => '后台任务完成' })
  await rt.spawn({ description: 'd', prompt: 'p' })
  await rt.drain()
  assert.strictEqual(parent._injected.length, 1)
  assert.ok(parent._injected[0].content.includes('agent-notification'))
  assert.ok(parent._injected[0].content.includes('后台任务完成'))
  // enqueueMessage 只接受 user / system —— 一条 role:'assistant' 的通知会被静默丢弃。
  assert.strictEqual(parent._injected[0].role, 'user')
})

/**
 * 端到端：假子 agent 只能证明"信进了 enqueueMessage"。这个测试用**真的 Agent**
 * 当子 agent，断言那封信真的出现在它下一轮上线的请求体里 —— 中间任何一环
 * （onRoundStart 的调用时机、role 白名单、_drainPendingInjections 的 round > 0 门槛）
 * 断掉都会在这里暴露。
 */
test('端到端：真实子 Agent 在下一轮的请求体里读到那封信', async () => {
  const originalFetch = globalThis.fetch
  const bodies = []
  const rounds = [
    { choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'probe', arguments: '{}' } }] } }] },
    { choices: [{ message: { content: '收到并已处理' } }] },
  ]
  let i = 0
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body))
    const payload = rounds[Math.min(i++, rounds.length - 1)]
    return { ok: true, status: 200, async json() { return payload }, async text() { return JSON.stringify(payload) } }
  }
  try {
    let agent
    const probe = {
      name: 'probe',
      description: 'probe',
      parameters: { type: 'object', properties: {} },
      // 子 agent 正跑在这个工具里时，主 agent 给它发信。
      execute: async (_args, ctx) => agent.subagents.sendMessage({
        to: ctx.agentName, body: '补充要求：优先修 P0', from: { agentId: 'main', name: 'main' },
      }),
    }
    agent = new Agent({ provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o', subagents: {}, tools: [probe] })
    const out = await agent.subagents.spawn({ description: 'd', prompt: 'p', background: false })

    assert.ok(out.includes('收到并已处理'), `子 agent 应正常收尾，实际：${out}`)
    assert.strictEqual(bodies.length, 2, '子 agent 应当跑了两轮')
    const secondRound = bodies[1].messages.map(m => String(m.content)).join('\n')
    assert.ok(secondRound.includes('<agent-message'), '第二轮上线的请求体里必须带上那封信')
    assert.ok(secondRound.includes('补充要求：优先修 P0'))
    assert.ok(!bodies[0].messages.some(m => String(m.content).includes('<agent-message')),
      '第一轮请求体里不该有 —— 信是在第一轮的工具执行期间才发出的')
  } finally {
    globalThis.fetch = originalFetch
  }
})
