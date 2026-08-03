import test from 'node:test'
import assert from 'node:assert'
import { RuntimeHistory } from '../runtime-history.js'
import { createSubagentRuntime } from './runtime.js'
import { SUBAGENT_TOOL_NAMES } from './tools.js'
import { AGENT_GRAPH_DESCRIPTION } from './contract.js'
import { resetAgentTypes, registerAgentType } from './types.js'

function fakeParent(reply = '子 agent 报告') {
  const memory = { runtimeHistory: new RuntimeHistory(), add() {} }
  return {
    _providerName: 'openai',
    model: 'gpt-4o', apiKey: 'sk-main', url: 'https://main/v1',
    simpleModel: 'gpt-4o-mini', simpleApiKey: 'sk-simple', simpleUrl: 'https://simple/v1',
    tools: [{ name: 'read_file', description: 'r', parameters: {}, execute: async () => 'x' }],
    hooks: {}, knowledgeBase: null, tokenBudget: null, validateStreamCompletion: true,
    memory,
    _events: [],
    emit(type, payload) { this._events.push({ type, payload }) },
    // Task 11 起 _onBackgroundSettled 会调它 —— 现在就补上，免得那时回头改测试
    _injected: [],
    enqueueMessage(msg) { this._injected.push(msg) },
    _reply: reply,
  }
}

function makeRuntime(parent, extra = {}) {
  return createSubagentRuntime({
    parent,
    createAgent: () => ({
      lastStopReason: null,
      on() { return this }, off() { return this },
      getLastRunMetrics: () => ({ totalRounds: 1, totalLlmCalls: 1, totalToolCalls: 0, usage: { input_tokens: 1, output_tokens: 1 }, wallClockMs: 5 }),
      async chat() { return parent._reply },
    }),
    ...extra,
  })
}

const byName = (tools, name) => tools.find(t => t.name === name)

test.beforeEach(() => resetAgentTypes())

test('注入的工具名与 SUBAGENT_TOOL_NAMES 一致', () => {
  const rt = makeRuntime(fakeParent())
  assert.deepStrictEqual(rt.tools.map(t => t.name).sort(), [...SUBAGENT_TOOL_NAMES].sort())
  assert.ok(SUBAGENT_TOOL_NAMES.includes('agent'))
  assert.ok(SUBAGENT_TOOL_NAMES.includes('agent_status'))
})

test('agent 工具的 schema 严格对齐参考实现', () => {
  const tool = byName(makeRuntime(fakeParent()).tools, 'agent')
  const p = tool.parameters
  assert.strictEqual(p.additionalProperties, false)
  assert.deepStrictEqual(p.required, ['description', 'prompt'])
  assert.deepStrictEqual(Object.keys(p.properties).sort(),
    ['description', 'isolation', 'model', 'prompt', 'run_in_background', 'subagent_type'])
  assert.deepStrictEqual(p.properties.model.enum, ['fast', 'main'])
  assert.deepStrictEqual(p.properties.isolation.enum, ['worktree', 'remote'])
  assert.strictEqual(p.properties.run_in_background.type, 'boolean')
  assert.match(tool.description, /3-8 word/)
})

test('agent_graph 工具的 description 就是 AGENT_GRAPH_DESCRIPTION（无本地拷贝、不会漂移）', () => {
  const tool = byName(makeRuntime(fakeParent()).tools, 'agent_graph')
  assert.strictEqual(tool.description, AGENT_GRAPH_DESCRIPTION)
})

test('model enum 跟随主机别名表', () => {
  const rt = makeRuntime(fakeParent(), {
    modelAliases: { haiku: { model: 'claude-haiku-4-5' }, opus: { model: 'claude-opus-5' } },
  })
  assert.deepStrictEqual(byName(rt.tools, 'agent').parameters.properties.model.enum, ['haiku', 'opus'])
})

test('同步调用返回完整 Agent_Result', async () => {
  const rt = makeRuntime(fakeParent('审计结论：3 处越权'))
  const out = await byName(rt.tools, 'agent').execute({
    description: 'Audit auth flow', prompt: '检查越权', run_in_background: false,
  })
  assert.match(out, /^\[agent:general-purpose-1 succeeded\]/m)
  assert.ok(out.includes('审计结论：3 处越权'))
})

test('后台调用立即返回 started 行，结果随后可查', async () => {
  const rt = makeRuntime(fakeParent())
  const out = await byName(rt.tools, 'agent').execute({ description: 'd', prompt: 'p' })
  assert.match(out, /^\[agent:general-purpose-1 started\]/m)
  assert.ok(out.includes('background'))
  await rt.drain()
  const status = await byName(rt.tools, 'agent_status').execute({ include_finished: true })
  assert.ok(status.includes('succeeded'))
})

test('未注册的 subagent_type 软失败并列出可用类型', async () => {
  const rt = makeRuntime(fakeParent())
  const out = await byName(rt.tools, 'agent').execute({
    description: 'd', prompt: 'p', subagent_type: 'nope', run_in_background: false,
  })
  assert.ok(out.toLowerCase().includes('unknown'))
  assert.ok(out.includes('general-purpose'))
  assert.ok(!out.includes('[agent:'), '不该真的起 agent')
})

test('未知 model 别名软失败', async () => {
  const rt = makeRuntime(fakeParent())
  const out = await byName(rt.tools, 'agent').execute({
    description: 'd', prompt: 'p', model: 'nope', run_in_background: false,
  })
  assert.ok(out.includes('fast'))
  assert.ok(out.includes('main'))
})

test('缺 prompt 时软失败而非抛异常', async () => {
  const rt = makeRuntime(fakeParent())
  const out = await byName(rt.tools, 'agent').execute({ description: 'd', run_in_background: false })
  assert.ok(/prompt/i.test(out))
})

test('agent_status 列出在跑的 agent；已完成的默认不列，include_finished 才出现', async () => {
  const parent = fakeParent()
  /** @type {Array<(value: string) => void>} */
  const gates = []
  const rt = createSubagentRuntime({
    parent,
    createAgent: () => ({
      lastStopReason: null,
      on() { return this }, off() { return this },
      getLastRunMetrics: () => ({ totalRounds: 1, totalLlmCalls: 1, totalToolCalls: 0, usage: {}, wallClockMs: 1 }),
      // 挂起到 `release()`，这样"agent 正在飞"这个中间态才观察得到 —— 不挂起的话
      // 子 agent 在断言之前就已经终态了，这条测试就退化成只在查空列表。
      chat(_contract, { signal } = {}) {
        return new Promise((resolve, reject) => {
          gates.push(resolve)
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
    }),
  })
  const status = byName(rt.tools, 'agent_status')
  assert.strictEqual(await status.execute({}), 'no active agents (0 running, 0 queued)')

  const started = await byName(rt.tools, 'agent').execute({ description: 'dig into auth', prompt: 'p' })
  assert.match(started, /started/)
  await new Promise(resolve => setImmediate(resolve))

  const running = await status.execute({})
  assert.match(running, /^1 agent\(s\):/m)
  assert.match(running, /general-purpose-1 \[running\] type=general-purpose/)
  assert.ok(running.includes('dig into auth'), '列表要带上任务标签，否则模型分不清是哪一个')

  for (const resolve of gates.splice(0)) resolve('报告')
  await rt.drain()

  assert.strictEqual(await status.execute({}), 'no active agents (0 running, 0 queued)',
    '终态 agent 默认不该继续占着"活跃"列表')
  assert.match(await status.execute({ include_finished: true }),
    /general-purpose-1 \[succeeded\]/)
})

test('agent_cancel 未知 id 软失败', async () => {
  const rt = makeRuntime(fakeParent())
  const out = await byName(rt.tools, 'agent_cancel').execute({ agent_id: 'nope' })
  assert.ok(/not found|unknown/i.test(out))
})

/** 一个只在 signal abort 时才会 reject 的假子 agent —— 模拟真实 fetch 的行为：
 * abort 时以 `signal.reason` 原样 reject（而不是自己另造一个 AbortError）。 */
function makeAbortAwareRuntime(parent, extra = {}) {
  return createSubagentRuntime({
    parent,
    createAgent: () => ({
      lastStopReason: null,
      on() { return this }, off() { return this },
      getLastRunMetrics: () => ({ totalRounds: 1, totalLlmCalls: 1, totalToolCalls: 0, usage: null, wallClockMs: 1 }),
      async chat(_contract, { signal } = {}) {
        return new Promise((_resolve, reject) => {
          if (signal?.aborted) { reject(signal.reason); return }
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
    }),
    ...extra,
  })
}

test('agent_cancel 让运行中的 agent 落在 cancelled（不是 failed），failureKind=aborted', async () => {
  const parent = fakeParent()
  const rt = makeAbortAwareRuntime(parent)
  const started = await byName(rt.tools, 'agent').execute({ description: 'd', prompt: 'p' })
  const name = started.match(/\[agent:(\S+) started\]/)[1]
  const handle = rt.registry.get(name)

  const cancelOut = await byName(rt.tools, 'agent_cancel').execute({ agent_id: name, reason: '人工取消' })
  assert.ok(/cancel/i.test(cancelOut))
  // agent_cancel 的 description 承诺 "reports as cancelled" —— 必须立刻兑现，
  // 不能等子 agent 那头的 abort 传导完才转态。
  assert.strictEqual(handle.state, 'cancelled')

  await rt.drain()
  assert.strictEqual(handle.result.status, 'cancelled')
  assert.notStrictEqual(handle.result.status, 'failed')
  assert.strictEqual(handle.result.failureKind, 'aborted')

  const status = JSON.parse(await byName(rt.tools, 'agent_status').execute({ agent_id: name }))
  assert.strictEqual(status.state, 'cancelled')
  assert.ok(parent._events.some(e => e.type === 'agent.cancelled' && e.payload.reason === '人工取消'))
  assert.ok(!parent._events.some(e => e.type === 'agent.failed'), '取消不应该也 emit agent.failed')
})

test('runtime.close() 取消在跑的 agent：同样落在 cancelled / aborted，不是 failed', async () => {
  const parent = fakeParent()
  const rt = makeAbortAwareRuntime(parent)
  const started = await byName(rt.tools, 'agent').execute({ description: 'd', prompt: 'p' })
  const name = started.match(/\[agent:(\S+) started\]/)[1]
  const handle = rt.registry.get(name)

  await rt.close()

  assert.strictEqual(handle.state, 'cancelled')
  assert.strictEqual(handle.result.status, 'cancelled')
  assert.strictEqual(handle.result.failureKind, 'aborted')
  assert.ok(parent._events.some(e => e.type === 'agent.cancelled' && e.payload.reason === 'runtime closed'))
})

test('artifact_write 记账并在冲突时告警', async () => {
  const rt = makeRuntime(fakeParent())
  const write = byName(rt.tools, 'artifact_write')
  const first = await write.execute(
    { key: 'docs/x.md', kind: 'file', summary: 's', content: 'v1' },
    { agentId: 'agt_a', agentName: 'writer-1' },
  )
  assert.ok(first.includes('recorded'))
  const second = await write.execute(
    { key: 'docs/x.md', kind: 'file', summary: 's', content: 'v2' },
    { agentId: 'agt_b', agentName: 'writer-2' },
  )
  assert.ok(second.includes('writer-1'), '必须点名上一版的归属者')
  const listed = await byName(rt.tools, 'artifact_list').execute({ key: 'docs/x.md' })
  assert.ok(listed.includes('writer-1') && listed.includes('writer-2'))
})

test('history_search / history_get 走通', async () => {
  const parent = fakeParent()
  parent.memory.runtimeHistory.appendMessage({ role: 'user', content: '早期决定：用 JWT' })
  const rt = makeRuntime(parent)
  const hits = await byName(rt.tools, 'history_search').execute({ query: 'JWT' })
  assert.ok(hits.includes('JWT'))
  const eventId = parent.memory.runtimeHistory.getEvents('all')[0].id
  const got = await byName(rt.tools, 'history_get').execute({ event_id: eventId })
  assert.ok(got.includes('JWT'))
  const miss = await byName(rt.tools, 'history_search').execute({ query: 'zzz-not-present' })
  assert.ok(/no match/i.test(miss))
})

test('canSpawn 的类型出现在类型清单里，供模型选型', () => {
  registerAgentType({ name: 'lead', description: 'd', systemPrompt: 's', canSpawn: true })
  const rt = makeRuntime(fakeParent())
  assert.ok(rt.typesNote().includes('lead'))
  assert.ok(rt.typesNote().includes('general-purpose'))
  assert.ok(rt.typesNote().includes('Available agent types'))
})
