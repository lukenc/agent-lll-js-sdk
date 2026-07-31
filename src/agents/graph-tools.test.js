/**
 * 图工具接入 runtime 的行为测试。
 *
 * 贯穿全文的一条线：**声明 ≠ 创建**。`agent_graph` 只声明与排队，`graph_start`
 * 才是父 agent 看过上游产出之后写下最终契约的那道闸门。
 */
import test from 'node:test'
import assert from 'node:assert'
import { RuntimeHistory } from '../runtime-history.js'
import { createSubagentRuntime } from './runtime.js'
import { resetAgentTypes } from './types.js'

test.beforeEach(() => resetAgentTypes())

/**
 * @param {Record<number, string>} [replies] 第 n 个子 agent 的报告正文
 * @param {{ gate?: boolean }} [opts] gate:true 时子 agent 的 chat 挂起，
 *        直到调用返回的 `release()` —— 用来观察"agent 正在飞"这个中间态。
 */
function makeRuntime(replies = {}, { gate = false } = {}) {
  const injected = []
  const events = []
  const parent = {
    _providerName: 'openai', model: 'm', apiKey: 'k', url: 'u',
    simpleModel: 'm', simpleApiKey: 'k', simpleUrl: 'u',
    tools: [], hooks: {}, knowledgeBase: null, tokenBudget: null, validateStreamCompletion: true,
    memory: { runtimeHistory: new RuntimeHistory(), add() {} },
    emit(type, payload) { events.push({ type, payload }) },
    enqueueMessage(msg) { injected.push(msg) },
  }
  let seq = 0
  const gates = []
  const rt = createSubagentRuntime({
    parent,
    createAgent: () => {
      const id = ++seq
      return {
        lastStopReason: null, on() { return this }, off() { return this },
        getLastRunMetrics: () => ({ totalRounds: 1, totalLlmCalls: 1, totalToolCalls: 0, usage: {}, wallClockMs: 1 }),
        async chat() {
          if (gate) await new Promise((resolve) => { gates.push(resolve) })
          return replies[id] ?? `报告 ${id}`
        },
      }
    },
  })
  return {
    rt, injected, events,
    tool: (name) => rt.tools.find(t => t.name === name),
    /** 放开全部挂起的子 agent，并等后台任务收尾。 */
    async release() {
      for (const resolve of gates.splice(0)) resolve()
      await rt.drain()
    },
  }
}

// ---- 声明阶段 ----

test('agent_graph 声明后不创建任何 agent', async () => {
  const { rt, tool } = makeRuntime()
  const out = await tool('agent_graph').execute({
    nodes: [
      { node_id: 'n1', description: 'explore' },
      { node_id: 'n2', depends_on: ['n1'], description: 'write' },
    ],
  })
  assert.ok(out.includes('n1'))
  assert.ok(out.includes('n2'))
  assert.strictEqual(rt.registry.list({ includeFinished: true }).length, 0,
    '声明阶段不该创建任何 agent 实例')
})

test('无依赖节点就绪后通知主 agent 而不是直接启动', async () => {
  const { tool, injected, rt } = makeRuntime()
  await tool('agent_graph').execute({ nodes: [{ node_id: 'n1', description: 'explore' }] })
  assert.strictEqual(rt.graph.get('n1').state, 'awaiting_confirm')
  assert.ok(injected.some(m => m.content.includes('n1') && m.content.includes('graph-node-ready')))
})

// ---- 确认闸门 ----

test('graph_start 用最终契约启动就绪节点', async () => {
  const { tool, rt } = makeRuntime({ 1: '探索结论' })
  await tool('agent_graph').execute({ nodes: [{ node_id: 'n1', description: 'explore' }] })
  const out = await tool('graph_start').execute({ node_id: 'n1', prompt: '最终确定的任务描述', run_in_background: false })
  assert.ok(out.includes('探索结论'))
  assert.strictEqual(rt.graph.get('n1').state, 'succeeded')
})

test('上游完成后下游转 awaiting_confirm，通知里带上游结果', async () => {
  const { tool, injected } = makeRuntime({ 1: '上游产出：3 个接口' })
  await tool('agent_graph').execute({
    nodes: [
      { node_id: 'n1', description: 'explore' },
      { node_id: 'n2', depends_on: ['n1'], description: 'write' },
    ],
  })
  await tool('graph_start').execute({ node_id: 'n1', prompt: 'p', run_in_background: false })
  const readyNote = injected.find(m => m.content.includes('n2'))
  assert.ok(readyNote, '下游就绪必须通知主 agent')
  assert.ok(readyNote.content.includes('上游产出：3 个接口'))
})

test('on_ready:auto 的节点上游一好就自己跑', async () => {
  const { tool, rt } = makeRuntime()
  await tool('agent_graph').execute({
    nodes: [
      { node_id: 'n1', description: 'explore' },
      { node_id: 'n2', depends_on: ['n1'], description: 'write', on_ready: 'auto', prompt: '自动执行' },
    ],
  })
  await tool('graph_start').execute({ node_id: 'n1', prompt: 'p', run_in_background: false })
  await rt.drain()
  assert.strictEqual(rt.graph.get('n2').state, 'succeeded')
})

// ---- 软失败 ----

test('环被拒绝且工具软失败（不抛）', async () => {
  const { tool } = makeRuntime()
  const out = await tool('agent_graph').execute({
    nodes: [
      { node_id: 'a', depends_on: ['b'], description: 'x' },
      { node_id: 'b', depends_on: ['a'], description: 'y' },
    ],
  })
  assert.ok(/cycle/i.test(out))
  assert.ok(out.includes('->'))
})

test('graph_start 打未就绪节点时软失败', async () => {
  const { tool } = makeRuntime()
  await tool('agent_graph').execute({
    nodes: [{ node_id: 'n1', description: 'x' }, { node_id: 'n2', depends_on: ['n1'], description: 'y' }],
  })
  const out = await tool('graph_start').execute({ node_id: 'n2', prompt: 'p' })
  assert.ok(/blocked/i.test(out))
})

// ---- 状态可见性 ----

test('agent_status include_graph 输出节点表', async () => {
  const { tool } = makeRuntime()
  await tool('agent_graph').execute({ nodes: [{ node_id: 'n1', description: 'explore' }] })
  const out = await tool('agent_status').execute({ include_graph: true })
  assert.ok(out.includes('n1'))
  assert.ok(out.includes('awaiting_confirm'))
})

test('上游失败时下游停在 blocked 并在状态里说明', async () => {
  const { tool, rt } = makeRuntime()
  await tool('agent_graph').execute({
    nodes: [{ node_id: 'n1', description: 'x' }, { node_id: 'n2', depends_on: ['n1'], description: 'y' }],
  })
  rt.graph.start('n1', { prompt: 'p' })
  rt.graph.onAgentSettled({ nodeId: 'n1', state: 'failed' })
  const out = await tool('agent_status').execute({ include_graph: true })
  assert.ok(out.includes('upstream_failed'))
})

// ---- 启动回报与取消（Task 13 的契约要求） ----

test('节点在 agent 起飞时就被回报成 running，而不是留在 queued', async () => {
  const { tool, rt, release } = makeRuntime({}, { gate: true })
  await tool('agent_graph').execute({ nodes: [{ node_id: 'n1', description: 'x' }] })
  await tool('graph_start').execute({ node_id: 'n1', prompt: 'p' })
  // 停在 queued 就意味着图分不清"根本没起来"和"起来了正在跑"——
  // 见 graph.js 里 launch_failed 的判定。
  const running = rt.graph.get('n1')
  assert.strictEqual(running.state, 'running')
  assert.ok(running.agentId, 'running 的节点必须带上 agentId')
  await release()
  assert.strictEqual(rt.graph.get('n1').state, 'succeeded')
})

test('agent 被取消时节点落到 cancelled，下游不被放行', async () => {
  const { tool, rt, release } = makeRuntime({}, { gate: true })
  await tool('agent_graph').execute({
    nodes: [{ node_id: 'n1', description: 'x' }, { node_id: 'n2', depends_on: ['n1'], description: 'y' }],
  })
  await tool('graph_start').execute({ node_id: 'n1', prompt: 'p' })
  const agentId = rt.graph.get('n1').agentId
  await tool('agent_cancel').execute({ agent_id: agentId, reason: '不需要了' })
  await release()
  // 渲染出的结果是 `[agent:x cancelled]`，里头没有 ' failed]'——靠结果字符串
  // 猜状态的写法会把这次取消读成 succeeded，进而把 n2 从一条已被放弃的分支上
  // 放出来。状态必须以 handle 为准。
  assert.strictEqual(rt.graph.get('n1').state, 'cancelled')
  assert.strictEqual(rt.graph.get('n2').state, 'blocked')
  assert.strictEqual(rt.graph.get('n2').blockedReason, 'upstream_cancelled')
})

test('agent_cancel 用 node_id 时连节点的活 agent 一起结掉', async () => {
  const { tool, rt, release } = makeRuntime({}, { gate: true })
  assert.match(await tool('agent_cancel').execute({}), /agent_id/,
    '两个 id 都不给时要软失败')
  await tool('agent_graph').execute({ nodes: [{ node_id: 'n1', description: 'x' }] })
  await tool('graph_start').execute({ node_id: 'n1', prompt: 'p' })
  const agentId = rt.graph.get('n1').agentId
  const out = await tool('agent_cancel').execute({ node_id: 'n1', reason: '换方案' })
  assert.ok(out.includes('n1'))
  assert.strictEqual(rt.graph.get('n1').state, 'cancelled')
  // 只改图状态不动 handle 的话，这个 agent 还在跑（卡在 ask_user 上时更是
  // 永远叫不停）—— 必须走 cancelHandle。
  assert.strictEqual(rt.registry.get(agentId).state, 'cancelled')
  await release()
})

test('hasInFlight 不把等主 agent 确认的节点算成在飞的活', async () => {
  const { tool, rt } = makeRuntime()
  await tool('agent_graph').execute({
    nodes: [{ node_id: 'n1', description: 'x' }, { node_id: 'n2', depends_on: ['n1'], description: 'y' }],
  })
  // 图没走完 —— 但没有任何后台任务在跑，也不会再有任何事件到来：keep-alive
  // 若拿 hasPending() 当判据就会干等到超时。
  assert.strictEqual(rt.hasPending(), true)
  assert.strictEqual(rt.hasInFlight(), false)
})
