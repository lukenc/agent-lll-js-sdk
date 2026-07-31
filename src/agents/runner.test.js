import test from 'node:test'
import assert from 'node:assert'
import { RuntimeHistory } from '../runtime-history.js'
import { AgentRegistry } from './registry.js'
import { ArtifactTrack } from './artifacts.js'
import { SubagentRunner, classifyFailure, RETRYABLE_KINDS } from './runner.js'
import { resolveModelAliases } from './models.js'
import { getAgentType } from './types.js'

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

function makeRunner(script, opts = {}) {
  const sharedHistory = new RuntimeHistory()
  const registry = new AgentRegistry({ maxConcurrent: 4 })
  const artifacts = new ArtifactTrack({ sharedHistory })
  const events = []
  const createAgent = fakeAgentFactory(script)
  const runner = new SubagentRunner({
    parent, registry, artifacts, sharedHistory,
    aliases: resolveModelAliases(parent, undefined),
    // backoffMs: 0 —— 真实指数退避会让这个文件多睡 12 秒。退避策略本身是可注入的
    // 配置项，测试关心的是"重试发生了几次"，不是"睡了多久"。
    opts: { retry: { maxAttempts: 3, attemptTimeoutMs: 5000, backoffMs: 0 }, maxDepth: 2, ...opts },
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
