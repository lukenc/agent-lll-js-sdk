import test from 'node:test'
import assert from 'node:assert'
import { RuntimeHistory } from '../runtime-history.js'
import { AgentRegistry } from './registry.js'
import { ArtifactTrack } from './artifacts.js'
import {
  SubagentRunner, classifyFailure, RETRYABLE_KINDS, cancelHandle,
  SPAWN_TOOLS, GRAPH_TOOLS, FLOOR_TOOLS,
} from './runner.js'
import { SUBAGENT_TOOL_NAMES } from './tools.js'
import { resolveModelAliases } from './models.js'
import { getAgentType, registerAgentType, resetAgentTypes } from './types.js'

const parent = {
  _providerName: 'openai',
  model: 'gpt-4o', apiKey: 'sk-main', url: 'https://main/v1',
  simpleModel: 'gpt-4o-mini', simpleApiKey: 'sk-simple', simpleUrl: 'https://simple/v1',
  knowledgeBase: { entries: ['kb'] },
  tokenBudget: { totalTokens: 1000 },
  validateStreamCompletion: false,
  tools: [
    { name: 'read_file', description: 'r', parameters: {}, execute: async () => 'x' },
    { name: 'write_file', description: 'w', parameters: {}, execute: async () => 'x' },
    { name: 'agent', description: 'a', parameters: {}, execute: async () => 'x' },
  ],
  hooks: { beforeToolCall: () => true, afterToolCall: () => {} },
}

/** 造一个可控的假子 Agent。 */
function fakeAgentFactory(script) {
  const calls = []
  let i = 0
  const factory = (options) => {
    calls.push(options)
    const step = script[Math.min(i, script.length - 1)]
    i += 1
    return {
      options,
      lastStopReason: null,
      _bus: { on() {}, off() {} },
      on() { return this }, off() { return this },
      getLastRunMetrics: () => ({ totalRounds: 3, totalLlmCalls: 3, totalToolCalls: 1, usage: { input_tokens: 10, output_tokens: 5 }, wallClockMs: 12 }),
      async chat() {
        // `step.call(this, this)` 而非 `step(this)`：脚本里既有箭头函数（读第一个
        // 入参）也有普通函数（读 `this.options`）。ESM 恒为严格模式，`step(this)`
        // 会让普通函数里的 `this` 是 undefined。
        if (typeof step === 'function') return step.call(this, this)
        return step
      },
      async closeMCPClients() {},
    }
  }
  factory.calls = calls
  return factory
}

function makeRunner(script, opts = {}, parentOverride = parent) {
  const sharedHistory = new RuntimeHistory()
  const registry = new AgentRegistry({ maxConcurrent: 4 })
  const artifacts = new ArtifactTrack({ sharedHistory })
  const events = []
  const createAgent = fakeAgentFactory(script)
  const runner = new SubagentRunner({
    parent: parentOverride, registry, artifacts, sharedHistory,
    aliases: resolveModelAliases(parentOverride, undefined),
    // backoffMs: 0 —— 真实指数退避会让这个文件多睡 12 秒。退避策略本身是可注入的
    // 配置项，测试关心的是"重试发生了几次"，不是"睡了多久"。
    opts: { retry: { maxAttempts: 3, backoffMs: 0 }, maxDepth: 2, ...opts },
    emit: (type, payload) => events.push({ type, payload }),
    createAgent,
  })
  return { runner, registry, artifacts, sharedHistory, events, createAgent }
}

function makeHandle(registry, overrides = {}) {
  return registry.create({
    type: 'general-purpose', description: 'Audit auth flow',
    parentAgentId: 'main', depth: 1,
    model: { alias: 'fast', model: 'gpt-4o-mini', apiKey: 'sk-simple', url: 'https://simple/v1' },
    ...overrides,
  })
}

test('classifyFailure 覆盖各类错误', () => {
  const api429 = Object.assign(new Error('LLM API error 429'), { status: 429 })
  const api500 = Object.assign(new Error('LLM API error 503'), { status: 503 })
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
  const stream = Object.assign(new Error('stream cut'), { name: 'LlmStreamIncompleteError' })
  assert.strictEqual(classifyFailure(api429), 'rate_limited')
  assert.strictEqual(classifyFailure(api500), 'llm_error')
  assert.strictEqual(classifyFailure(abort), 'aborted')
  assert.strictEqual(classifyFailure(stream), 'llm_error')
  assert.strictEqual(classifyFailure(new TypeError('fetch failed')), 'network')
  assert.strictEqual(classifyFailure(new Error('Operation timed out after 5000ms')), 'timeout')
  assert.strictEqual(classifyFailure(new Error('something odd')), 'tool_error')
  assert.strictEqual(RETRYABLE_KINDS.has('tool_error'), false)
  assert.strictEqual(RETRYABLE_KINDS.has('rate_limited'), true)
})

test('成功路径：返回带头部的 Agent_Result，状态迁到 succeeded', async () => {
  const { runner, registry } = makeRunner(['子 agent 的最终报告'])
  const handle = makeHandle(registry)
  const out = await runner.run(handle, { prompt: '检查越权' })
  assert.match(out, /^\[agent:general-purpose-1 succeeded\]/m)
  assert.ok(out.includes('attempts=1'))
  assert.ok(out.includes('model=fast'))
  assert.ok(out.includes('子 agent 的最终报告'))
  assert.strictEqual(handle.state, 'succeeded')
  assert.strictEqual(handle.attempt, 1)
})

test('子 agent 继承 knowledgeBase / tokenBudget / hooks，但不继承 memory 与 systemPrompt', async () => {
  const { runner, registry, createAgent } = makeRunner(['ok'])
  await runner.run(makeHandle(registry), { prompt: 'p' })
  const [childOpts] = createAgent.calls
  assert.strictEqual(childOpts.knowledgeBase, parent.knowledgeBase)
  assert.strictEqual(childOpts.tokenBudget, parent.tokenBudget)
  assert.strictEqual(childOpts.validateStreamCompletion, false)
  assert.strictEqual(typeof childOpts.hooks.beforeToolCall, 'function')
  assert.strictEqual(childOpts.systemPrompt, getAgentType('general-purpose').systemPrompt)
  assert.strictEqual(childOpts.strategy, 'react')
  assert.ok(childOpts.memory, '必须显式传入镜像包装后的 memory')
  assert.strictEqual(childOpts.model, 'gpt-4o-mini')
  assert.strictEqual(childOpts.apiKey, 'sk-simple')
})

test('tools: "*" 继承父工具集但剔除 agent（canSpawn 为 false）', async () => {
  const { runner, registry, createAgent } = makeRunner(['ok'])
  await runner.run(makeHandle(registry), { prompt: 'p' })
  const names = createAgent.calls[0].tools.map(t => t.name)
  assert.ok(names.includes('read_file'))
  assert.ok(!names.includes('agent'), 'canSpawn=false 的类型不应拿到 agent 工具')
})

test('tools: "*" 且 canSpawn 为 true 时保留 spawn 工具', async () => {
  resetAgentTypes()
  registerAgentType({ name: 'spawner', description: 'd', systemPrompt: 's', canSpawn: true })
  const { runner, registry, createAgent } = makeRunner(['ok'])
  await runner.run(makeHandle(registry, { type: 'spawner' }), { prompt: 'p' })
  const names = createAgent.calls[0].tools.map(t => t.name)
  assert.ok(names.includes('agent'), 'canSpawn=true 的类型应该保留 agent 工具')
  resetAgentTypes()
})

// --- floor tools（followup 回归：显式 tools 数组不该关掉基础设施工具） -----

test('floor tools：显式窄数组仍然带上 artifact_write / history_search 等基础设施工具', async () => {
  resetAgentTypes()
  registerAgentType({ name: 'narrow', description: 'd', systemPrompt: 's', tools: ['read_file'] })
  const floorParent = {
    ...parent,
    tools: [
      ...parent.tools,
      { name: 'artifact_write', description: 'a', parameters: {}, execute: async () => 'x' },
      { name: 'history_search', description: 'h', parameters: {}, execute: async () => 'x' },
      { name: 'send_message', description: 'm', parameters: {}, execute: async () => 'x' },
    ],
  }
  const { runner, registry, createAgent } = makeRunner(['ok'], {}, floorParent)
  await runner.run(makeHandle(registry, { type: 'narrow' }), { prompt: 'p' })
  const names = createAgent.calls[0].tools.map(t => t.name)
  assert.ok(names.includes('read_file'), '数组里显式点名的工具要在')
  assert.ok(names.includes('artifact_write'), 'floor 工具不该被窄数组关掉')
  assert.ok(names.includes('history_search'), 'floor 工具不该被窄数组关掉')
  assert.ok(names.includes('send_message'), 'floor 工具不该被窄数组关掉')
  assert.ok(!names.includes('write_file'), '没点名且不是 floor 工具的仍应被过滤掉')
  resetAgentTypes()
})

test('floor tools：parent 本身没有的 floor 工具（如 ask_user）不会被凭空生造出来，也不报错', async () => {
  resetAgentTypes()
  registerAgentType({ name: 'narrow', description: 'd', systemPrompt: 's', tools: ['read_file'] })
  const { runner, registry, createAgent } = makeRunner(['ok'])
  await runner.run(makeHandle(registry, { type: 'narrow' }), { prompt: 'p' })
  const names = createAgent.calls[0].tools.map(t => t.name)
  assert.ok(!names.includes('ask_user'), 'parent 没有的 floor 工具不能凭空出现')
  resetAgentTypes()
})

// --- 编排工具永远不下发给子 agent（canSpawn 只管 `agent`） ------------------

/** 一个把五个元工具都带齐的 parent —— 子 agent 拿到什么全看过滤逻辑，不看 parent 缺什么。 */
const orchestratingParent = {
  ...parent,
  tools: [
    ...parent.tools,
    ...['agent_graph', 'graph_start', 'graph_close', 'graph_reactivate',
      'artifact_write', 'artifact_list', 'history_search', 'history_get', 'send_message', 'ask_user']
      .map(name => ({ name, description: name, parameters: {}, execute: async () => 'x' })),
  ],
}

test('canSpawn: true 只给 agent，四个图工具一个都不给', async () => {
  resetAgentTypes()
  registerAgentType({ name: 'spawner', description: 'd', systemPrompt: 's', canSpawn: true })
  const { runner, registry, createAgent } = makeRunner(['ok'], {}, orchestratingParent)
  await runner.run(makeHandle(registry, { type: 'spawner' }), { prompt: 'p' })
  const names = createAgent.calls[0].tools.map(t => t.name)
  assert.ok(names.includes('agent'), 'canSpawn=true 就是"可以再往下派 agent"')
  for (const graphTool of GRAPH_TOOLS) {
    assert.ok(!names.includes(graphTool),
      `图工具 ${graphTool} 作用于父 agent 的图容器，子 agent 无论如何拿不到`)
  }
  resetAgentTypes()
})

test('canSpawn: false 五个编排工具一个都不给', async () => {
  resetAgentTypes()
  registerAgentType({ name: 'worker', description: 'd', systemPrompt: 's' })
  const { runner, registry, createAgent } = makeRunner(['ok'], {}, orchestratingParent)
  await runner.run(makeHandle(registry, { type: 'worker' }), { prompt: 'p' })
  const names = createAgent.calls[0].tools.map(t => t.name)
  for (const orchestrationTool of ['agent', ...GRAPH_TOOLS]) {
    assert.ok(!names.includes(orchestrationTool), `${orchestrationTool} 不该下发给子 agent`)
  }
  resetAgentTypes()
})

test('图工具的剔除不牵连 floor 工具（canSpawn 两种取值都是）', async () => {
  resetAgentTypes()
  registerAgentType({ name: 'spawner', description: 'd', systemPrompt: 's', canSpawn: true })
  registerAgentType({ name: 'worker', description: 'd', systemPrompt: 's' })
  for (const type of ['spawner', 'worker']) {
    const { runner, registry, createAgent } = makeRunner(['ok'], {}, orchestratingParent)
    await runner.run(makeHandle(registry, { type }), { prompt: 'p' })
    const names = createAgent.calls[0].tools.map(t => t.name)
    for (const floor of FLOOR_TOOLS) {
      assert.ok(names.includes(floor), `${type}: floor 工具 ${floor} 不该被编排工具的剔除牵连`)
    }
  }
  resetAgentTypes()
})

// --- 手抄的工具名清单必须绑回唯一出处（N6：改名要吵，不能静默） --------------

test('SPAWN_TOOLS / GRAPH_TOOLS / FLOOR_TOOLS 与 SUBAGENT_TOOL_NAMES 严格对账', () => {
  const declared = new Set(SUBAGENT_TOOL_NAMES)
  // 每个手抄的名字都必须真的是一个元工具 —— `tools.js` 里一次改名若没同步到
  // 这里，剔除逻辑会静默失效（子 agent 白拿一个 spawn 工具），floor 则会静默
  // 少一件基础设施工具。两种失败都不报错。
  for (const name of [...SPAWN_TOOLS, ...GRAPH_TOOLS]) {
    assert.ok(declared.has(name), `${name} 不在 SUBAGENT_TOOL_NAMES 里 —— 元工具改名了？`)
  }
  for (const name of FLOOR_TOOLS) {
    assert.ok(declared.has(name) || name === 'ask_user',
      `${name} 既不是元工具也不是 ask_user —— floor 抄错了名字？`)
  }
  // 三个集合互斥。
  assert.strictEqual([...SPAWN_TOOLS].filter(n => GRAPH_TOOLS.has(n)).length, 0)
  assert.strictEqual([...FLOOR_TOOLS].filter(n => SPAWN_TOOLS.has(n) || GRAPH_TOOLS.has(n)).length, 0)
  // 并集覆盖到位：新增一个元工具必须在这里做出"给不给子 agent"的决定，
  // 而不是靠默认继承悄悄下发。
  const classified = new Set([...SPAWN_TOOLS, ...GRAPH_TOOLS, ...FLOOR_TOOLS])
  const unclassified = SUBAGENT_TOOL_NAMES.filter(n => !classified.has(n))
  assert.deepStrictEqual(unclassified.sort(), ['agent_cancel', 'agent_status'],
    '新增元工具时请在 runner.js 里明确它归哪一类，再更新这条断言')
})

test('可重试失败：重试到成功，每次都是全新实例', async () => {
  const rateLimited = () => { throw Object.assign(new Error('LLM API error 429'), { status: 429 }) }
  const { runner, registry, createAgent, events } = makeRunner([rateLimited, rateLimited, '第三次成功'])
  const handle = makeHandle(registry)
  const out = await runner.run(handle, { prompt: 'p' })
  assert.ok(out.includes('succeeded'))
  assert.ok(out.includes('attempts=3'))
  assert.strictEqual(createAgent.calls.length, 3, '每次重试都要新建实例，不复用被污染的上下文')
  assert.strictEqual(events.filter(e => e.type === 'agent.retry').length, 2)
})

test('重试用尽：返回结构化失败结果，不抛异常', async () => {
  const rateLimited = () => { throw Object.assign(new Error('429 Too Many Requests'), { status: 429 }) }
  const { runner, registry, events } = makeRunner([rateLimited])
  const handle = makeHandle(registry)
  const out = await runner.run(handle, { prompt: 'p' })
  assert.match(out, /^\[agent:general-purpose-1 failed\]/m)
  assert.ok(out.includes('failureKind=rate_limited'))
  assert.ok(out.includes('attempts=3'))
  assert.ok(out.includes('429 Too Many Requests'))
  assert.strictEqual(handle.state, 'failed')
  assert.strictEqual(events.filter(e => e.type === 'agent.failed').length, 1)
})

test('退避期间被取消：仍然返回结构化结果，不把 AbortError 抛给父 agent', async () => {
  // 回归测试：`await sleep(delayMs, signal)` 曾直接放在 catch 块里，signal 在
  // 退避中途 abort 时 sleep 的 rejection 会穿透 run()，违反"run() 永不 throw"
  // 的契约 —— 而退避正是系统看起来卡住、用户最可能按取消的时刻。
  const rateLimited = () => { throw Object.assign(new Error('429 Too Many Requests'), { status: 429 }) }
  const { runner, registry } = makeRunner([rateLimited], { retry: { maxAttempts: 3, backoffMs: () => 50 } })
  const handle = makeHandle(registry)
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 10)
  const out = await runner.run(handle, { prompt: 'p', signal: ac.signal })
  assert.match(out, /^\[agent:general-purpose-1 failed\]/m)
  assert.ok(out.includes('failureKind=aborted'), '退避中途取消应归类为 aborted')
  assert.strictEqual(handle.state, 'failed')
})

test('不可重试失败：只跑一次', async () => {
  const boom = () => { throw new Error('tool blew up') }
  const { runner, registry, createAgent } = makeRunner([boom])
  const out = await runner.run(makeHandle(registry), { prompt: 'p' })
  assert.ok(out.includes('failureKind=tool_error'))
  assert.ok(out.includes('attempts=1'))
  assert.strictEqual(createAgent.calls.length, 1)
})

test('超轮：识别为 max_rounds 且不重试', async () => {
  const { runner, registry, createAgent } = makeRunner([
    (child) => { child.lastStopReason = 'max_rounds'; return '[max rounds exceeded]' },
  ])
  const out = await runner.run(makeHandle(registry), { prompt: 'p' })
  assert.ok(out.includes('failureKind=max_rounds'))
  assert.strictEqual(createAgent.calls.length, 1)
})

test('depth 超限：直接失败，不构造任何实例', async () => {
  const { runner, registry, createAgent } = makeRunner(['ok'], { maxDepth: 1 })
  const handle = makeHandle(registry, { depth: 2 })
  const out = await runner.run(handle, { prompt: 'p' })
  assert.ok(out.includes('failureKind=depth_exceeded'))
  assert.strictEqual(createAgent.calls.length, 0)
})

test('产物出现在结果尾部并记进 handle', async () => {
  const { runner, registry, artifacts } = makeRunner([
    function () {
      artifacts.write({
        agentId: this.options._agentId, agentName: this.options._agentName, attempt: 1,
        key: 'docs/x.md', kind: 'file', summary: 's', content: 'body',
      })
      return '报告正文'
    },
  ])
  const handle = makeHandle(registry)
  const out = await runner.run(handle, { prompt: 'p' })
  assert.ok(out.includes('--- artifacts (1) ---'))
  assert.ok(out.includes('docs/x.md'))
  assert.deepStrictEqual(handle.artifactKeys, ['docs/x.md'])
})

test('失败结果里带上已产出的部分产物', async () => {
  const { runner, registry, artifacts } = makeRunner([
    function () {
      artifacts.write({
        agentId: this.options._agentId, agentName: this.options._agentName, attempt: 1,
        key: 'docs/partial.md', kind: 'file', summary: 's', content: 'half',
      })
      throw new Error('gave up')
    },
  ])
  const out = await runner.run(makeHandle(registry), { prompt: 'p' })
  assert.ok(out.includes('--- partial artifacts (1) ---'))
  assert.ok(out.includes('docs/partial.md'))
})

test('emit 了 spawn / state / succeeded 事件且带归属', async () => {
  const { runner, registry, events } = makeRunner(['ok'])
  const handle = makeHandle(registry)
  await runner.run(handle, { prompt: 'p' })
  const spawn = events.find(e => e.type === 'agent.spawn')
  assert.strictEqual(spawn.payload.agentId, handle.agentId)
  assert.strictEqual(spawn.payload.parentAgentId, 'main')
  assert.strictEqual(spawn.payload.type, 'general-purpose')
  assert.ok(!JSON.stringify(events).includes('sk-simple'), '事件里不能出现 apiKey')
  assert.ok(events.some(e => e.type === 'agent.succeeded'))
})

test('子 agent 首条消息是渲染后的契约（含标题行与 prompt 原文）', async () => {
  let received = null
  const { runner, registry, createAgent } = makeRunner(['ok'])
  const handle = makeHandle(registry)
  await runner.run(handle, { prompt: '检查 src/auth 的越权风险' })
  received = createAgent.calls[0]._contract
  assert.ok(received.includes('# Task: Audit auth flow'))
  assert.ok(received.includes('检查 src/auth 的越权风险'))
  assert.strictEqual(runner.lastRenderedContract, received)
})

// --- 取消是一等结果，不是失败的一种（followup 回归） -----------------------

test('cancelHandle：带 reason 与裸 abort 两条路径都归类为 aborted，不再有一个滑落成 tool_error', () => {
  const { registry } = makeRunner(['ok'])
  const withReason = makeHandle(registry)
  withReason._abort = new AbortController()
  let caughtWithReason
  withReason._abort.signal.addEventListener('abort', () => { caughtWithReason = withReason._abort.signal.reason })
  cancelHandle(withReason, { reason: '人工取消，缩小范围重新分派' })
  assert.strictEqual(classifyFailure(caughtWithReason), 'aborted')

  const bare = makeHandle(registry)
  bare._abort = new AbortController()
  let caughtBare
  bare._abort.signal.addEventListener('abort', () => { caughtBare = bare._abort.signal.reason })
  cancelHandle(bare, {})
  assert.strictEqual(classifyFailure(caughtBare), 'aborted')
})

test('cancelHandle 让 handle 立刻落在 cancelled，且已经是终态的 handle 上再调用是无操作', () => {
  const { registry, events } = makeRunner(['ok'])
  const handle = makeHandle(registry)
  handle.transition('queued'); handle.transition('running')
  const ok = cancelHandle(handle, { reason: 'r', emit: (t, p) => events.push({ type: t, payload: p }) })
  assert.strictEqual(ok, true)
  assert.strictEqual(handle.state, 'cancelled')
  assert.ok(events.some(e => e.type === 'agent.cancelled' && e.payload.reason === 'r'))

  const again = cancelHandle(handle, { reason: 'late', emit: () => { throw new Error('不该再 emit') } })
  assert.strictEqual(again, false, '已经终态的 handle 上再取消必须是无操作')
})

test('取消发生在子 agent 跑的过程中：落在 cancelled，result.status 不是 failed', async () => {
  let handle
  const events2 = []
  const { runner, registry, events } = makeRunner([
    function () {
      // 模拟 agent_cancel 在子 agent 跑的中途介入：先转态，abort 传导进子 agent
      // 内部变成一次标准 AbortError（真实场景里这是 fetch 看到 signal.reason 后
      // 抛出来的那个值——cancelHandle 保证它 name=AbortError）。
      const reason = cancelHandle(handle, { reason: '人工取消', emit: (t, p) => events2.push({ type: t, payload: p }) })
      assert.ok(reason)
      const err = new Error('人工取消')
      err.name = 'AbortError'
      throw err
    },
  ])
  handle = makeHandle(registry)
  const out = await runner.run(handle, { prompt: 'p' })

  assert.match(out, /^\[agent:general-purpose-1 cancelled\]/m)
  assert.ok(!/\bfailed\b/.test(out), '取消不该被渲染成 failed')
  assert.ok(out.includes('failureKind=aborted'))
  assert.strictEqual(handle.state, 'cancelled')
  assert.strictEqual(handle.result.status, 'cancelled')
  assert.notStrictEqual(handle.result.status, 'failed')
  assert.ok(!events.some(e => e.type === 'agent.failed'), '取消不应该也 emit agent.failed')
})

test('formatResult：cancelled 渲染独立于 failed，机器可读头部一致，且不建议重试', () => {
  const { runner, registry } = makeRunner(['ok'])
  const handle = makeHandle(registry)
  handle.transition('queued'); handle.transition('running')
  handle.beginAttempt()
  handle.endAttempt({ failureKind: 'aborted', error: '人工取消' })
  handle.transition('cancelled')
  handle.result = { status: 'cancelled', failureKind: 'aborted', lastError: '人工取消' }

  const out = runner.formatResult(handle)
  assert.match(out, /^\[agent:general-purpose-1 cancelled\]/m)
  assert.ok(out.includes('failureKind=aborted'))
  assert.ok(out.includes('人工取消'))
  assert.ok(!/\bfailed\b/.test(out))
  assert.ok(!out.includes('重试') && !out.includes('重发'), 'cancelled 结果不该包含失败分支那句重试建议')
})

// --- 工具 ctx 的 nodeId / attempt（N2：文档里写着、实际恒为 null / 1） --------

test('工具 ctx 带上 handle 的 nodeId 与当前 attempt', async () => {
  const seen = []
  const record = function () { seen.push({ ...this._toolContextExtra }) }
  const rateLimited = function () {
    record.call(this)
    throw Object.assign(new Error('429'), { status: 429 })
  }
  const { runner, registry } = makeRunner([rateLimited, function () { record.call(this); return '好了' }])
  await runner.run(makeHandle(registry, { nodeId: 'n1' }), { prompt: 'p' })

  assert.strictEqual(seen.length, 2)
  assert.strictEqual(seen[0].nodeId, 'n1', '图节点起的 agent，产物要能归到节点上')
  assert.strictEqual(seen[0].attempt, 1)
  assert.strictEqual(seen[1].attempt, 2, '重试后的产物必须能与上一次的区分开')
})

test('重试写同一个 key 的产物：两条记录靠 attempt 区分，并渲染进结果', async () => {
  const write = function () {
    this._artifacts.write({
      key: 'report.md', kind: 'text', summary: 's', content: `attempt ${this._toolContextExtra.attempt}`,
      agentId: this._toolContextExtra.agentId, agentName: this._toolContextExtra.agentName,
      nodeId: this._toolContextExtra.nodeId, attempt: this._toolContextExtra.attempt,
    })
  }
  const { runner, registry, artifacts } = makeRunner([
    function () { this._artifacts = artifacts; write.call(this); throw Object.assign(new Error('429'), { status: 429 }) },
    function () { this._artifacts = artifacts; write.call(this); return '好了' },
  ])
  const out = await runner.run(makeHandle(registry, { nodeId: 'n1' }), { prompt: 'p' })

  const rows = artifacts.list({ key: 'report.md' })
  assert.deepStrictEqual(rows.map(r => r.attempt), [1, 2], '两次尝试的记录必须可区分')
  assert.deepStrictEqual(rows.map(r => r.nodeId), ['n1', 'n1'])
  assert.match(out, /attempt=2/, 'formatResult 里 attempt>1 的标注不该是死代码')
})
