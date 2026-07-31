/**
 * Agent ↔ subagent 系统的接线测试。
 *
 * 关注点只有一个：`opts.subagents` 未配置时 `Agent` 的行为与旧版本逐字节一致，
 * 配置后才多出元工具 / 类型清单 / 工具 ctx 归属字段。
 */
import test from 'node:test'
import assert from 'node:assert'
import { Agent } from './agent.js'
import { SUBAGENT_TOOL_NAMES } from './agents/tools.js'
import { BASE_TOOLS, resetBaseTools } from './tool-filter.js'
import { resetAgentTypes } from './agents/types.js'

const baseOpts = { provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o' }

test.beforeEach(() => { resetAgentTypes(); resetBaseTools() })
test.after(() => { resetAgentTypes(); resetBaseTools() })

// ---- 最小 fetch mock（与 tool-error-resilience.test.js 同款） ----

const originalFetch = globalThis.fetch
/** @type {Array<any>} */
let responseQueue = []

function installMockFetch() {
  responseQueue = []
  globalThis.fetch = async () => {
    const next = responseQueue.shift()
    if (!next) throw new Error('mock fetch: response queue empty')
    return {
      ok: true,
      status: 200,
      async json() { return next },
      async text() { return JSON.stringify(next) },
    }
  }
}

function restoreFetch() {
  globalThis.fetch = originalFetch
}

function queueResponse({ content = '', toolCalls = null } = {}) {
  const message = { content }
  if (toolCalls) message.tool_calls = toolCalls
  responseQueue.push({ choices: [{ message }] })
}

test('未配置 subagents 时行为不变：无新工具、subagents 为 null', () => {
  const agent = new Agent({ ...baseOpts })
  assert.strictEqual(agent.subagents, null)
  for (const name of SUBAGENT_TOOL_NAMES) {
    assert.ok(!agent.getTools().some(t => t.name === name), `不该注入 ${name}`)
    assert.ok(!BASE_TOOLS.has(name), `${name} 不该被注册为 base tool`)
  }
})

test('配置后注入全部元工具并注册为 base tool', () => {
  const agent = new Agent({ ...baseOpts, subagents: {} })
  const names = agent.getTools().map(t => t.name)
  for (const name of SUBAGENT_TOOL_NAMES) {
    assert.ok(names.includes(name), `缺少工具 ${name}`)
    assert.ok(BASE_TOOLS.has(name), `${name} 未注册为 base tool，开启意图识别后会被过滤掉`)
  }
})

test('_providerName 被记住，供子 agent 构造用', () => {
  assert.strictEqual(new Agent({ ...baseOpts, subagents: {} })._providerName, 'openai')
})

test('类型清单被合并进 system 消息', () => {
  const agent = new Agent({
    ...baseOpts,
    subagents: { types: [{ name: 'explorer', description: '只读检索', systemPrompt: 's' }] },
  })
  const messages = agent._withSubagentTypesNote([
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'hi' },
  ])
  assert.strictEqual(messages.length, 2)
  assert.ok(messages[0].content.includes('You are helpful.'))
  assert.ok(messages[0].content.includes('Available agent types'))
  assert.ok(messages[0].content.includes('explorer'))
  assert.ok(messages[0].content.includes('general-purpose'))
  assert.strictEqual(messages[1].content, 'hi')
})

test('无 system 消息时类型清单不丢失', () => {
  const agent = new Agent({ ...baseOpts, subagents: {} })
  const messages = agent._withSubagentTypesNote([{ role: 'user', content: 'hi' }])
  assert.strictEqual(messages[0].role, 'system')
  assert.ok(messages[0].content.includes('Available agent types'))
})

test('未配置 subagents 时 _withSubagentTypesNote 原样返回', () => {
  const agent = new Agent({ ...baseOpts })
  const input = [{ role: 'system', content: 'sys' }]
  assert.deepStrictEqual(agent._withSubagentTypesNote(input), input)
})

test('工具执行 ctx 带上 agentId / depth，且不影响既有工具', async () => {
  installMockFetch()
  try {
    /** @type {any} */
    let seenCtx = null
    const agent = new Agent({
      ...baseOpts,
      maxRounds: 3,
      subagents: {},
      tools: [{
        name: 'probe', description: 'p', parameters: { type: 'object', properties: {} },
        execute: async (_args, ctx) => { seenCtx = ctx; return 'ok' },
      }],
    })
    // 真跑一轮 ReAct：断言的是 `_reactLoop` 的 tool.execute 调用点，
    // 而不是测试自己拼出来的 ctx。
    queueResponse({
      content: null,
      toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'probe', arguments: '{}' } }],
    })
    queueResponse({ content: 'done' })
    const reply = await agent.chat('go')

    assert.strictEqual(reply, 'done')
    assert.ok(seenCtx, 'probe 应被调用')
    assert.strictEqual(seenCtx.agentId, 'main')
    assert.strictEqual(seenCtx.agentName, 'main')
    assert.strictEqual(seenCtx.depth, 0)
    assert.strictEqual(seenCtx.cwd, null)
    assert.ok('signal' in seenCtx, '既有的 signal 字段不能被归属字段挤掉')
  } finally {
    restoreFetch()
  }
})

test('closeSubagents 取消未完成 agent 且可重复调用', async () => {
  const agent = new Agent({ ...baseOpts, subagents: {} })
  await agent.closeSubagents()
  await agent.closeSubagents()
  assert.ok(true)
})

test('getArtifacts 支持 agentId 过滤', async () => {
  const agent = new Agent({ ...baseOpts, subagents: {} })
  agent.subagents.artifacts.write({
    agentId: 'agt_1', agentName: 'a-1', key: 'k1', kind: 'text', summary: 's', content: 'x',
  })
  agent.subagents.artifacts.write({
    agentId: 'agt_2', agentName: 'a-2', key: 'k2', kind: 'text', summary: 's', content: 'y',
  })
  assert.strictEqual((await agent.getArtifacts()).length, 2)
  assert.strictEqual((await agent.getArtifacts({ agentId: 'agt_1' })).length, 1)
})

test('closeSubagents 真的中止在跑的后台 subagent（不只是打个 cancelled 标记）', async () => {
  let observedAbort = false
  const agent = new Agent({
    ...baseOpts,
    subagents: {
      // 这个假子 agent 只有被 abort 才会结束。若 close() 只打标记不 abort，
      // 它内部的 drain() 就会永远等下去。
      createAgent: () => ({
        lastStopReason: null,
        on() { return this }, off() { return this },
        getLastRunMetrics: () => null,
        chat(_message, { signal } = {}) {
          return new Promise((_resolve, reject) => {
            const stop = () => {
              observedAbort = true
              const err = new Error('aborted')
              err.name = 'AbortError'
              reject(err)
            }
            if (signal?.aborted) stop()
            else signal?.addEventListener('abort', stop, { once: true })
          })
        },
      }),
    },
  })

  const spawnTool = agent.getTools().find(t => t.name === 'agent')
  const started = await spawnTool.execute(
    { description: 'long job', prompt: 'run forever' },
    { ...agent._toolContextExtra },
  )
  assert.match(started, /started/, `期望后台启动行，实际：${started}`)

  // 让 acquireSlot / transition 的微任务跑完，确认它真的进了 running。
  await new Promise(resolve => setImmediate(resolve))
  const [handle] = agent.subagents.registry.list()
  assert.strictEqual(handle.state, 'running')

  const outcome = await Promise.race([
    agent.closeSubagents().then(() => 'closed'),
    new Promise(resolve => setTimeout(() => resolve('hung'), 500)),
  ])
  assert.strictEqual(outcome, 'closed', 'close() 必须 abort 在跑的 subagent，而不是等它自然结束')
  assert.ok(observedAbort, '子 agent 应当收到 abort 信号')
  assert.strictEqual(handle.state, 'cancelled')
  assert.strictEqual(handle.result?.failureKind, 'aborted',
    '中止收尾应记为 aborted，而不是 illegal-transition 造成的 tool_error')
})
