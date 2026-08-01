import test from 'node:test'
import assert from 'node:assert'
import { RuntimeHistory } from '../runtime-history.js'
import { createSubagentRuntime } from './runtime.js'
import { registerAgentType, resetAgentTypes } from './types.js'

/**
 * Followup regression: `Agent_Type.maxAttempts` 曾经不可达 ——
 * `runtime.js` 一直往 `opts.retry.maxAttempts` 里填一个 eager 默认值 `3`，
 * 于是 `runner.js` 那条 `this.opts.retry?.maxAttempts ?? type.maxAttempts ?? 3`
 * 回退链里，`?? type.maxAttempts` 永远轮不到（`opts.retry.maxAttempts` 恒非
 * undefined）。这里通过 `createSubagentRuntime`（而不是直接构造
 * `SubagentRunner`）复现——绕过 runtime.js 直接测 runner.js 看不出这个缺陷，
 * 因为 runner.js 自己的回退链一直是对的。
 */

function fakeParent() {
  const memory = { runtimeHistory: new RuntimeHistory(), add() {} }
  return {
    _providerName: 'openai',
    model: 'gpt-4o', apiKey: 'sk-main', url: 'https://main/v1',
    simpleModel: 'gpt-4o-mini', simpleApiKey: 'sk-simple', simpleUrl: 'https://simple/v1',
    tools: [{ name: 'read_file', description: 'r', parameters: {}, execute: async () => 'x' }],
    hooks: {}, knowledgeBase: null, tokenBudget: null, validateStreamCompletion: true,
    memory,
    emit() {},
    enqueueMessage() {},
  }
}

/** 造一个"永远 429"的假子 agent 工厂——每次 createAgent 调用即一次 attempt。 */
function scriptedAgent(script) {
  let i = 0
  return () => {
    const step = script[Math.min(i, script.length - 1)]
    i += 1
    return {
      lastStopReason: null,
      on() { return this }, off() { return this },
      getLastRunMetrics: () => ({ totalRounds: 1, totalLlmCalls: 1, totalToolCalls: 0, usage: {}, wallClockMs: 1 }),
      async chat() {
        if (typeof step === 'function') return step()
        return step
      },
    }
  }
}

const byName = (tools, name) => tools.find(t => t.name === name)
const boom = () => { throw Object.assign(new Error('LLM API error 429'), { status: 429 }) }

test.beforeEach(() => resetAgentTypes())
test.afterEach(() => resetAgentTypes())

test('maxAttempts 优先级 1/3：都不配置时回退到默认 3', async () => {
  const rt = createSubagentRuntime({
    parent: fakeParent(), createAgent: scriptedAgent([boom, boom, boom]),
    retry: { backoffMs: 0 },
  })
  const out = await byName(rt.tools, 'agent').execute({
    description: 'd', prompt: 'p', subagent_type: 'general-purpose', run_in_background: false,
  })
  assert.match(out, /^\[agent:general-purpose-1 failed\]/m)
  assert.ok(out.includes('attempts=3'), `expected 3 attempts, got: ${out}`)
})

test('maxAttempts 优先级 2/3：host 未指定时 Agent_Type.maxAttempts 生效（曾经的缺陷）', async () => {
  registerAgentType({ name: 'five-tries', description: 'd', systemPrompt: 's', maxAttempts: 5 })
  const rt = createSubagentRuntime({
    parent: fakeParent(), createAgent: scriptedAgent([boom, boom, boom, boom, boom]),
    retry: { backoffMs: 0 },
  })
  const out = await byName(rt.tools, 'agent').execute({
    description: 'd', prompt: 'p', subagent_type: 'five-tries', run_in_background: false,
  })
  assert.match(out, /^\[agent:five-tries-1 failed\]/m)
  assert.ok(out.includes('attempts=5'), `Agent_Type.maxAttempts should take effect, got: ${out}`)
})

test('maxAttempts 优先级 3/3：host 显式值覆盖 Agent_Type', async () => {
  registerAgentType({ name: 'five-tries', description: 'd', systemPrompt: 's', maxAttempts: 5 })
  const rt = createSubagentRuntime({
    parent: fakeParent(), createAgent: scriptedAgent([boom, boom]),
    retry: { maxAttempts: 2, backoffMs: 0 },
  })
  const out = await byName(rt.tools, 'agent').execute({
    description: 'd', prompt: 'p', subagent_type: 'five-tries', run_in_background: false,
  })
  assert.match(out, /^\[agent:five-tries-1 failed\]/m)
  assert.ok(out.includes('attempts=2'), `host retry.maxAttempts should win over Agent_Type, got: ${out}`)
})

test('opts.subagents.retry 缺省字段（如 backoffMs）不再被 runtime.js 静默吞掉', async () => {
  // 曾经的 runtime.js 只挑 maxAttempts / attemptTimeoutMs 两个键重建 retry 对象，
  // host 传的其余 retry 配置（比如 backoffMs）压根传不到 runner。这里用一个大
  // backoffMs 会拖慢重试；传 0 应该让重试立即发生 —— 断言里用一个短 timeout 的
  // race 来证明 backoffMs 确实生效而不是被吞掉退回了指数退避。
  const rt = createSubagentRuntime({
    parent: fakeParent(), createAgent: scriptedAgent([boom, 'ok on retry']),
    retry: { backoffMs: 0 },
  })
  const start = Date.now()
  const out = await byName(rt.tools, 'agent').execute({
    description: 'd', prompt: 'p', subagent_type: 'general-purpose', run_in_background: false,
  })
  const elapsed = Date.now() - start
  assert.match(out, /^\[agent:general-purpose-1 succeeded\]/m)
  assert.ok(elapsed < 1000, `backoffMs: 0 should skip the exponential backoff wait, took ${elapsed}ms`)
})
