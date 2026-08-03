/**
 * 图的生命周期、弃图协议与节点重新激活。
 *
 * 三件事，一条主线：**图跟的是任务，而任务的边界只有模型看得见**。
 *
 *   1. 跨图的"还剩几个节点"（`pendingNodeCount`）—— keep-alive 超时时告知模型的
 *      那个数。决策一直是跨图的（`hasInFlight()`），告知曾经不是。
 *   2. `graph_close` 与弃图协议 —— 关一张仍有未完成节点的图之前必须先问用户。
 *      协议是 prompt 级的，只能是 prompt 级的：框架分不清"新消息是同一个任务的
 *      续集"还是"另一个任务"。
 *   3. `graph_reactivate` —— 缓存失效。已完成节点的产物是一份缓存，输入变了它就
 *      得重跑；而这里有一处 ABA：节点被激活后不再是终态，旧那一轮 agent 的迟到
 *      回报会穿过"是不是终态"那道守卫把陈旧结果复活。generation 令牌挡的是它。
 */
import test from 'node:test'
import assert from 'node:assert'
import { Agent } from '../agent.js'
import { RuntimeHistory } from '../runtime-history.js'
import { createSubagentRuntime } from './runtime.js'
import { AgentGraph } from './graph.js'
import { AGENT_GRAPH_DESCRIPTION } from './contract.js'
import { resetAgentTypes } from './types.js'

test.beforeEach(() => resetAgentTypes())

/**
 * @param {object} [opts]
 * @param {boolean} [opts.gate] true 时子 agent 的 chat 挂起，直到 `release()`
 *        —— 用来观察"agent 正在飞"这个中间态。挂起期间监听 abort，否则
 *        `close()` 的 drain 会等一个永不 settle 的 Promise。
 * @param {number} [opts.retainClosedGraphs]
 */
function makeRuntime({ gate = false, retainClosedGraphs } = {}) {
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
    ...(retainClosedGraphs != null ? { retainClosedGraphs } : {}),
    createAgent: () => {
      const id = ++seq
      return {
        lastStopReason: null, on() { return this }, off() { return this },
        getLastRunMetrics: () => ({ totalRounds: 1, totalLlmCalls: 1, totalToolCalls: 0, usage: {}, wallClockMs: 1 }),
        async chat(_message, { signal } = {}) {
          if (gate) {
            await new Promise((resolve, reject) => {
              gates.push(resolve)
              signal?.addEventListener('abort', () => {
                reject(signal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' }))
              }, { once: true })
            })
          }
          return `报告 ${id}`
        },
      }
    },
  })
  return {
    rt, injected, events,
    tool: (name) => rt.tools.find(t => t.name === name),
    async release() {
      for (const resolve of gates.splice(0)) resolve()
      await rt.drain()
    },
  }
}

/** 裸 AgentGraph，用来单测调度语义（不需要 runtime 那一整套）。 */
function makeGraph() {
  const events = []
  const graph = new AgentGraph({ emit: (type, payload) => events.push({ type, payload }) })
  return { graph, events }
}

const n = (nodeId, dependsOn) => ({ node_id: nodeId, description: `活 ${nodeId}`, depends_on: dependsOn })

// ---- 19-前置：跨图的待办节点数 ----

test('pendingNodeCount() 跨全部图聚合，切换活跃图不改变它', () => {
  const { rt } = makeRuntime()
  assert.strictEqual(rt.pendingNodeCount(), 0, '没有图时是 0，不是 undefined')

  const a = rt.newGraph({ label: 'task-a' })
  a.graph.declare([n('a1'), n('a2', ['a1'])])
  const b = rt.newGraph({ label: 'task-b' })
  b.graph.declare([n('b1')])

  assert.strictEqual(rt.pendingNodeCount(), 3)
  rt.activeGraphId = a.graphId
  assert.strictEqual(rt.pendingNodeCount(), 3, '活跃图换成 A，B 里的待办节点并没有消失')
  rt.activeGraphId = b.graphId
  assert.strictEqual(rt.pendingNodeCount(), 3, '反过来也一样')

  // closed 图同样要算：图被关掉不代表它里头的活干完了（与 hasInFlight 同一理由）。
  rt.closeGraph(a.graphId)
  assert.strictEqual(rt.pendingNodeCount(), 3)

  a.graph.cancel('a1', '算了')
  a.graph.cancel('a2', '算了')
  assert.strictEqual(rt.pendingNodeCount(), 1, '对照：真的终态之后才该少')
})

test('keep-alive 超时告知模型的图节点数跨全部图', async () => {
  // 决策一直是对的（`hasInFlight()` 跨图），错的是告知：待办节点在非活跃图里时，
  // 模型会在它决定要不要停下来的那一刻被告知"0 个图节点未完成"。
  const agent = new Agent({
    provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o',
    subagents: { keepAliveTimeoutMs: 10 },
  })
  const events = []
  agent.on('run.keep_alive.timeout', p => events.push(p))

  const a = agent.subagents.newGraph({ label: 'task-a' })
  a.graph.declare([n('a1'), n('a2', ['a1'])])
  const b = agent.subagents.newGraph({ label: 'task-b' })
  b.graph.declare([n('b1')])
  // 让 hasInFlight() 为真，才走得到超时那条路（图里全是等主 agent 的节点）。
  agent.subagents.registry
    .create({ type: 'general-purpose', description: 'stuck', depth: 1, model: null })
    .transition('queued')
  // 就绪通知先读掉，否则命中的是 'injected' 而不是等待路径。
  agent._drainPendingInjections()

  assert.strictEqual(await agent._keepAliveOnce(), 'timeout')
  assert.strictEqual(events[0].pendingNodes, 3, 'B 是活跃图，但 A 的两个节点一样没干完')
  const notice = agent._pendingInjections.at(-1).content
  assert.ok(notice.includes('3 个图节点'), `注入给模型的收尾提示也得是这个数：${notice}`)
})

// ---- 19a：关闭与弃图协议 ----

test('graph_close cancel_outstanding 取消每个未终态节点，连它在跑的 agent 一起', async () => {
  const { rt, tool, release } = makeRuntime({ gate: true })
  await tool('agent_graph').execute({ nodes: [n('n1'), n('n2', ['n1']), n('n3')] })
  const entry = rt.graphs.get(rt.activeGraphId)
  await tool('graph_start').execute({ node_id: 'n1', prompt: 'p' })
  const agentId = entry.graph.get('n1').agentId
  assert.strictEqual(entry.graph.get('n1').state, 'running')

  const out = await tool('graph_close').execute({
    graph_id: entry.graphId, disposition: 'cancel_outstanding', reason: '任务换了',
  })

  assert.ok(!out.startsWith('Error:'), out)
  assert.strictEqual(entry.state, 'closed')
  assert.strictEqual(entry.graph.get('n1').state, 'cancelled')
  assert.strictEqual(entry.graph.get('n2').state, 'cancelled')
  assert.strictEqual(entry.graph.get('n3').state, 'cancelled')
  assert.strictEqual(rt.registry.get(agentId).state, 'cancelled',
    '光改图状态的话那个 agent 还在烧 token')
  assert.strictEqual(rt.activeGraphId, null, '关掉活跃图之后就没有活跃图了')
  assert.ok(out.includes('3'), `要告诉模型取消了几个节点：${out}`)
  assert.ok(out.includes('1 running agent'),
    `节点数不能当 agent 数报（只有 n1 起了 agent）：${out}`)
  await release()
})

test('graph_close cancel_outstanding 结算掉节点 agent 挂着的提问', async () => {
  // 阻塞在 ask_user 里的 agent 看不见 abort signal —— 不连它挂起的提问一起结掉，
  // 这次关闭就只是改了个状态，而 drain 会等一个永不 settle 的 Promise。
  const { rt, tool } = makeRuntime({ gate: true })
  await tool('agent_graph').execute({ nodes: [n('n1')] })
  const entry = rt.graphs.get(rt.activeGraphId)
  await tool('graph_start').execute({ node_id: 'n1', prompt: 'p' })
  const agentId = entry.graph.get('n1').agentId
  const pending = rt.ask.ask({ question: '要不要继续？', agentId, agentName: 'n1-agent' })

  await tool('graph_close').execute({ graph_id: entry.graphId, disposition: 'cancel_outstanding' })

  const answer = await pending
  assert.match(answer, /Question cancelled/, '挂起的提问必须被结算，等待方拿到取消说明')
  assert.strictEqual(rt.ask.pending().length, 0)
})

test('graph_close keep_running 关图但在飞的 agent 继续跑，hasInFlight() 仍算它们', async () => {
  const { rt, tool, release } = makeRuntime({ gate: true })
  await tool('agent_graph').execute({ nodes: [n('n1')] })
  const entry = rt.graphs.get(rt.activeGraphId)
  await tool('graph_start').execute({ node_id: 'n1', prompt: 'p' })

  const out = await tool('graph_close').execute({ graph_id: entry.graphId, disposition: 'keep_running' })

  assert.ok(!out.startsWith('Error:'), out)
  assert.strictEqual(entry.state, 'closed')
  assert.strictEqual(entry.graph.get('n1').state, 'running', 'keep_running 不动节点')
  assert.strictEqual(rt.hasInFlight(), true,
    '一个在飞的 agent 不因为它所属的图被关掉就停止存在')
  assert.ok(out.includes('in flight'), `真在飞的节点要这么说：${out}`)
  assert.ok(/keep running|completion notices/.test(out), `要说清楚它的 agent 还在跑：${out}`)

  await release()
  assert.strictEqual(entry.graph.get('n1').state, 'succeeded', '它自己走到终态，结果照样有人接')
})

test('graph_close keep_running 面对只有 awaiting_confirm / blocked 的图，不能说它们在飞或会被通知', async () => {
  // 回归：defect 1 —— outstanding 只按"非终态"分类，把 blocked / awaiting_confirm
  // 也算进"left running ... will still be notified ... work in flight"，而这三句话
  // 对它们全是假的：agentId 是 null（agents/handle.js），hasInFlight() 不算它们
  // （graph.js GRAPH_IN_FLIGHT_STATES），awaiting_confirm 是在等模型自己调
  // graph_start，不是在等事件；blocked 等的上游现在可能永远不会跑完。
  const { rt, tool } = makeRuntime()
  await tool('agent_graph').execute({ nodes: [n('n1'), n('n2', ['n1'])] })
  const entry = rt.graphs.get(rt.activeGraphId)
  assert.strictEqual(entry.graph.get('n1').state, 'awaiting_confirm', '前提：n1 没有依赖，声明后直接就绪')
  assert.strictEqual(entry.graph.get('n2').state, 'blocked', '前提：n2 依赖 n1，n1 还没跑完')
  assert.strictEqual(rt.hasInFlight(), false, '前提：这张图里没有真在飞的 agent')

  const out = await tool('graph_close').execute({ graph_id: entry.graphId, disposition: 'keep_running' })

  assert.ok(!out.startsWith('Error:'), out)
  assert.ok(!/left running/i.test(out), `没有节点在跑，不能这么说：${out}`)
  assert.ok(!/will still be notified/i.test(out), `没有事件会来，不能这么说：${out}`)
  assert.ok(!/\bin flight\b/i.test(out), `hasInFlight() 不算它们，不能这么说：${out}`)
  assert.ok(out.includes('n1') && out.includes('awaiting_confirm'),
    `awaiting_confirm 节点要点名，且要说清楚在等模型自己调 graph_start：${out}`)
  assert.ok(out.includes('n2') && out.includes('blocked'),
    `blocked 节点要点名，且要说清楚在等上游：${out}`)
})

test('graph_close keep_running 混合场景下，真在飞 / awaiting_confirm / blocked 三组分别报告', async () => {
  const { rt, tool, release } = makeRuntime({ gate: true })
  await tool('agent_graph').execute({ nodes: [n('n1'), n('n2'), n('n3', ['n2'])] })
  const entry = rt.graphs.get(rt.activeGraphId)
  await tool('graph_start').execute({ node_id: 'n1', prompt: 'p' })
  assert.strictEqual(entry.graph.get('n1').state, 'running')
  assert.strictEqual(entry.graph.get('n2').state, 'awaiting_confirm')
  assert.strictEqual(entry.graph.get('n3').state, 'blocked')

  const out = await tool('graph_close').execute({ graph_id: entry.graphId, disposition: 'keep_running' })

  assert.ok(!out.startsWith('Error:'), out)
  const inFlightLine = out.split('\n').find(l => l.includes('n1'))
  const confirmLine = out.split('\n').find(l => l.includes('n2'))
  const blockedLine = out.split('\n').find(l => l.includes('n3'))
  assert.ok(inFlightLine && /in flight/i.test(inFlightLine), `n1 那一行要说它在飞：${out}`)
  assert.ok(confirmLine && confirmLine !== inFlightLine && /awaiting_confirm/.test(confirmLine),
    `n2 要单独一行，且不能混进"在飞"那句：${out}`)
  assert.ok(blockedLine && blockedLine !== inFlightLine && blockedLine !== confirmLine
    && /blocked/.test(blockedLine), `n3 要单独一行，且不能混进另外两句：${out}`)
  assert.ok(!/left running/i.test(out), `旧措辞不能残留：${out}`)

  await release()
})

test('关掉活跃图后，下一次不带 graph_id 的 agent_graph 新建一张', async () => {
  const { rt, tool } = makeRuntime()
  await tool('agent_graph').execute({ nodes: [n('n1')] })
  const first = rt.graphs.get(rt.activeGraphId)
  await tool('graph_close').execute({ graph_id: first.graphId, disposition: 'cancel_outstanding' })

  // 同名 node_id 正是"任务换了"的常见形态 —— 新图有自己的 node_id 命名空间。
  const out = await tool('agent_graph').execute({ nodes: [n('n1')] })
  assert.ok(!/duplicate/i.test(out), out)
  assert.notStrictEqual(rt.activeGraphId, first.graphId)
  assert.strictEqual(rt.graphs.size, 2)
})

test('graph_close 的失败路径全部软失败', async () => {
  const { rt, tool } = makeRuntime()
  await tool('agent_graph').execute({ nodes: [n('n1')] })
  const entry = rt.graphs.get(rt.activeGraphId)

  const noDisposition = await tool('graph_close').execute({ graph_id: entry.graphId })
  assert.ok(noDisposition.startsWith('Error:'), noDisposition)
  assert.ok(noDisposition.includes('cancel_outstanding') && noDisposition.includes('keep_running'),
    `必须把两个可选值摆出来：${noDisposition}`)

  const badDisposition = await tool('graph_close').execute({
    graph_id: entry.graphId, disposition: 'whatever',
  })
  assert.ok(badDisposition.startsWith('Error:'), badDisposition)
  assert.strictEqual(entry.state, 'open', '拼错的 disposition 不能顺手把图关了')

  const unknown = await tool('graph_close').execute({
    graph_id: 'gph_deadbeef', disposition: 'keep_running',
  })
  assert.ok(/not found/i.test(unknown), unknown)

  await tool('graph_close').execute({ graph_id: entry.graphId, disposition: 'keep_running' })
  const again = await tool('graph_close').execute({ graph_id: entry.graphId, disposition: 'keep_running' })
  assert.ok(/already closed/i.test(again), again)

  const noGraph = await tool('graph_close').execute({ disposition: 'keep_running' })
  assert.ok(noGraph.startsWith('Error:'), `没有活跃图时也要软失败：${noGraph}`)
})

test('graph_close 的返回值不说一张刚被淘汰的图"还查得到"', async () => {
  // `closeGraph` 末尾跑 FIFO 淘汰，所以关掉的这一张有可能当场就被整张淘汰掉
  // （`retainClosedGraphs: 0` 是这条路径最直接的形态）。
  const { rt, tool } = makeRuntime({ retainClosedGraphs: 0 })
  await tool('agent_graph').execute({ nodes: [n('n1')] })
  const doomed = rt.graphs.get(rt.activeGraphId)

  const out = await tool('graph_close').execute({
    graph_id: doomed.graphId, disposition: 'cancel_outstanding',
  })

  assert.ok(!rt.graphs.has(doomed.graphId), '前提：这张图当场被淘汰了')
  assert.ok(!/still be inspected/.test(out), `不能告诉模型一件已经不成立的事：${out}`)
  assert.ok(out.includes('no longer be inspected'), out)
})

test('弃图协议写在模型唯一读得到的地方：两段 Tool_Def.description', () => {
  const { tool } = makeRuntime()
  const close = tool('graph_close').description
  // 框架分不清任务有没有结束，这个判断只能由模型做 —— 所以判据必须写给它。
  assert.match(close, /topic change|changes topic|the topic changes/i)
  // 而后果（取消别人跑了一半的活）只能由用户决定。
  assert.match(close, /ask_user/)
  assert.match(close, /outstanding/i)
  assert.match(close, /cancel_outstanding/)
  assert.match(close, /keep_running/)
  assert.match(close, /^##\s/m, '与其余长描述同一寄存器：Markdown 小标题分节')

  // agent_graph 是模型进入图这套东西的入口，协议也得在那儿露一次。
  assert.match(AGENT_GRAPH_DESCRIPTION, /graph_close/)
  assert.match(AGENT_GRAPH_DESCRIPTION, /one task|per task/i)
})

// ---- 19b：generation 与迟到回报 ----

test('回归：重新激活之后，旧那一轮 agent 的迟到回报不能把节点复活', () => {
  // 典型 ABA。守卫若只看"当前是不是终态"，节点一被激活就不再是终态，于是旧那轮
  // 的迟到回报直接穿过去，把节点改回 succeeded、把陈旧结果写回去，并据此放行本该
  // 重跑的下游 —— 全程不报任何错。
  const { graph } = makeGraph()
  graph.declare([n('n1'), n('n2', ['n1'])])
  graph.start('n1', { prompt: 'p' })
  const launched = graph.get('n1').generation
  graph.onAgentSettled({ nodeId: 'n1', state: 'running', agentId: 'agt_1', generation: launched })
  // 主 agent 放弃了这个节点（agent 还在跑，它的终态回报稍后才到）……
  graph.cancel('n1', '算了')
  // ……然后用户提了个局部修改，正好命中它，于是重新激活。
  graph.reactivate(['n1'])
  assert.strictEqual(graph.get('n1').state, 'awaiting_confirm')
  assert.notStrictEqual(graph.get('n1').generation, launched, 'generation 必须已经变了')

  // 上一轮那个 agent 现在才 settle。
  graph.onAgentSettled({
    nodeId: 'n1', state: 'succeeded', agentId: 'agt_1', result: '陈旧结果', generation: launched,
  })

  assert.strictEqual(graph.get('n1').state, 'awaiting_confirm', '迟到回报不能改写状态')
  assert.strictEqual(graph.get('n1').result, null, '更不能把陈旧结果写回去')
  assert.strictEqual(graph.get('n2').state, 'blocked',
    '下游必须继续等新一轮的结果，而不是从一份陈旧产物上被放行')
})

test('回归：被丢弃的迟到回报也不能覆写 agentId', () => {
  // agentId 是身份不是状态，但一份不该被采信的回报里的身份同样不该被采信 ——
  // 否则节点会指向一个属于上一轮的 agent，取消 / 查状态全打到错的对象上。
  const { graph } = makeGraph()
  graph.declare([n('n1')])
  graph.start('n1', { prompt: 'p' })
  const launched = graph.get('n1').generation
  graph.onAgentSettled({ nodeId: 'n1', state: 'running', agentId: 'agt_1', generation: launched })
  graph.cancel('n1', '算了')
  graph.reactivate(['n1'])
  graph.start('n1', { prompt: 'p2' })
  graph.onAgentSettled({ nodeId: 'n1', state: 'running', agentId: 'agt_2' })

  graph.onAgentSettled({ nodeId: 'n1', state: 'failed', agentId: 'agt_1', generation: launched })
  assert.strictEqual(graph.get('n1').agentId, 'agt_2')

  // 终态节点上的迟到回报同样不该改 agentId。
  graph.cancel('n1', '又算了')
  graph.onAgentSettled({ nodeId: 'n1', state: 'failed', agentId: 'agt_3' })
  assert.strictEqual(graph.get('n1').agentId, 'agt_2')
  assert.strictEqual(graph.get('n1').state, 'cancelled')
})

test('不带 generation 的回报照旧被采信（既有调用点不受影响）', () => {
  const { graph } = makeGraph()
  graph.declare([n('n1')])
  graph.start('n1', { prompt: 'p' })
  graph.onAgentSettled({ nodeId: 'n1', state: 'succeeded', agentId: 'agt_1', result: 'r' })
  assert.strictEqual(graph.get('n1').state, 'succeeded')
  assert.strictEqual(graph.get('n1').result, 'r')
})

test('reactivate 把节点送回 blocked，清空上一轮的痕迹并自增 generation', () => {
  const { graph, events } = makeGraph()
  graph.declare([n('n1')])
  graph.start('n1', { prompt: 'p' })
  const before = graph.get('n1').generation
  graph.onAgentSettled({ nodeId: 'n1', state: 'succeeded', agentId: 'agt_1', result: '产出' })

  const out = graph.reactivate(['n1'])

  assert.deepStrictEqual(out.reactivated, ['n1'])
  assert.deepStrictEqual(out.skipped, [])
  const node = graph.get('n1')
  assert.strictEqual(node.generation, before + 1)
  assert.strictEqual(node.agentId, null)
  assert.strictEqual(node.result, null)
  assert.strictEqual(node.error, null)
  assert.strictEqual(node.blockedReason, null)
  // 依赖已满足（没有依赖），tick 立刻把它推到 awaiting_confirm 等新契约。
  assert.strictEqual(node.state, 'awaiting_confirm')
  assert.strictEqual(node.prompt, 'p', 'prompt 留着当默认值，graph_start 可以改写')
  assert.ok(events.some(e => e.type === 'graph.node.reactivated'))
})

test('reactivate 只送回点名的节点，不自动扩散到下游', () => {
  // 失效范围由模型决定 —— 框架自动扩散会把"模型以为还有效的"一并铲掉。
  const { graph } = makeGraph()
  graph.declare([n('n1'), n('n2', ['n1']), n('n3', ['n2'])])
  for (const id of ['n1', 'n2', 'n3']) {
    graph.start(id, { prompt: 'p' })
    graph.onAgentSettled({ nodeId: id, state: 'succeeded', agentId: `agt_${id}`, result: `r-${id}` })
  }

  graph.reactivate(['n1'])

  assert.strictEqual(graph.get('n1').state, 'awaiting_confirm')
  assert.strictEqual(graph.get('n2').state, 'succeeded', '下游不被自动铲掉')
  assert.strictEqual(graph.get('n3').state, 'succeeded')
  assert.strictEqual(graph.get('n2').result, 'r-n2', '它的产物也还在')
})

test('reactivate 拒绝非终态节点与未知节点，逐个给理由，不抛', () => {
  const { graph } = makeGraph()
  graph.declare([n('n1'), n('n2')])
  graph.start('n1', { prompt: 'p' })
  graph.onAgentSettled({ nodeId: 'n1', state: 'running', agentId: 'agt_1' })

  const out = graph.reactivate(['n1', 'n2', 'ghost'])

  assert.deepStrictEqual(out.reactivated, [])
  assert.strictEqual(out.skipped.length, 3)
  assert.ok(out.skipped.every(s => typeof s.reason === 'string' && s.reason.length > 0))
  assert.match(out.skipped.find(s => s.nodeId === 'n1').reason, /running/)
  assert.match(out.skipped.find(s => s.nodeId === 'n2').reason, /blocked|awaiting_confirm/)
  assert.match(out.skipped.find(s => s.nodeId === 'ghost').reason, /not found/i)
  assert.strictEqual(graph.get('n1').state, 'running', '被拒的节点一点没动')
})

test('reactivate 入参形状不对时抛 AgentGraphError（与 declare 同一约定）', () => {
  const { graph } = makeGraph()
  graph.declare([n('n1')])
  assert.throws(() => graph.reactivate([]), /node_ids/)
  assert.throws(() => graph.reactivate('n1'), /node_ids/)
  assert.throws(() => graph.reactivate([1]), /node_ids/)
})

test('reactivate 清掉下游那条已经作废的 blockedReason', () => {
  // 上游被取消时下游记了 `upstream_cancelled`；上游一被激活，那句话就成了假话，
  // 而 statusTable 是模型看图的唯一窗口。
  const { graph } = makeGraph()
  graph.declare([n('n1'), n('n2', ['n1'])])
  graph.start('n1', { prompt: 'p' })
  graph.cancel('n1', '算了')
  assert.strictEqual(graph.get('n2').blockedReason, 'upstream_cancelled')

  graph.reactivate(['n1'])

  assert.strictEqual(graph.get('n2').state, 'blocked')
  assert.strictEqual(graph.get('n2').blockedReason, null)
  assert.ok(!graph.statusTable().includes('upstream_cancelled'))
})

// ---- 19b：graph_reactivate 工具 ----

test('graph_reactivate 让已关闭的图重新 open，并成为在用的那张', async () => {
  // 这正是用例本身：任务收尾之后又来了一个局部修改。
  const { rt, tool } = makeRuntime()
  await tool('agent_graph').execute({ nodes: [n('n1')] })
  const entry = rt.graphs.get(rt.activeGraphId)
  await tool('graph_start').execute({ node_id: 'n1', prompt: 'p', run_in_background: false })
  assert.strictEqual(entry.graph.get('n1').state, 'succeeded')
  await tool('graph_close').execute({ graph_id: entry.graphId, disposition: 'keep_running' })
  rt.newGraph({ label: '别的任务' })

  const out = await tool('graph_reactivate').execute({
    graph_id: entry.graphId, node_ids: ['n1'], reason: '需求改了',
  })

  assert.ok(!out.startsWith('Error:'), out)
  assert.strictEqual(entry.state, 'open', '激活会把这张图重新置为 open')
  assert.strictEqual(entry.closedAt, null)
  assert.strictEqual(rt.activeGraphId, entry.graphId, '接下来的 graph_start 该落在这张图上')
  assert.strictEqual(entry.graph.get('n1').state, 'awaiting_confirm')
  // 重新激活后必须能重新走一遍完整流程。
  const restarted = await tool('graph_start').execute({
    graph_id: entry.graphId, node_id: 'n1', prompt: 'p2', run_in_background: false,
  })
  assert.ok(!restarted.startsWith('Error:'), restarted)
  assert.strictEqual(entry.graph.get('n1').state, 'succeeded')
})

test('graph_reactivate 的返回值点名"下游里没被一起激活的那些"', async () => {
  const { rt, tool } = makeRuntime()
  await tool('agent_graph').execute({
    nodes: [n('schema'), n('api', ['schema']), n('docs', ['schema']), n('e2e', ['api'])],
  })
  const entry = rt.graphs.get(rt.activeGraphId)
  for (const id of ['schema', 'api', 'docs', 'e2e']) {
    await tool('graph_start').execute({ node_id: id, prompt: `做 ${id}`, run_in_background: false })
  }
  // schema 记了一份产物，api 读过它。
  const schemaAgentId = entry.graph.get('schema').agentId
  await tool('artifact_write').execute(
    { key: 'db/schema.sql', summary: '表结构' },
    { agentId: schemaAgentId, agentName: 'schema-agent' },
  )

  const out = await tool('graph_reactivate').execute({ node_ids: ['schema', 'docs'] })

  // 拓扑下游：api / docs / e2e。docs 已一起激活，api / e2e 没有。
  assert.ok(out.includes('api'), `下游必须点名：${out}`)
  assert.ok(out.includes('e2e'), `传递下游也要点名（它站在 api 的结论上）：${out}`)
  assert.ok(out.includes('db/schema.sql'), `被宣告过期的产物 key 要出现：${out}`)
  // "没被列进来"必须读起来是一个待确认的选择。
  assert.match(out, /not reactivated|did not reactivate|no[t]? named/i)
  assert.match(out, /decide|decision/i)
  // 已经一起激活的那个不该被算成"漏了"。
  const notNamedLine = out.split('\n').find(l => /still to decide|not reactivated:/i.test(l))
  assert.ok(notNamedLine, `要有一句把漏掉的节点收拢起来：\n${out}`)
  assert.ok(!notNamedLine.includes('docs'), `docs 已一起激活，不该被算成漏掉：${notNamedLine}`)
  assert.ok(notNamedLine.includes('api') && notNamedLine.includes('e2e'), notNamedLine)
})

test('graph_reactivate 在没有下游时不编造下游', async () => {
  const { rt, tool } = makeRuntime()
  await tool('agent_graph').execute({ nodes: [n('solo')] })
  const entry = rt.graphs.get(rt.activeGraphId)
  await tool('graph_start').execute({ node_id: 'solo', prompt: 'p', run_in_background: false })

  const out = await tool('graph_reactivate').execute({ node_ids: ['solo'] })
  assert.ok(!out.startsWith('Error:'), out)
  assert.match(out, /no( other)? downstream|nothing downstream/i, out)
  assert.strictEqual(entry.graph.get('solo').state, 'awaiting_confirm')
})

test('graph_reactivate 的失败路径全部软失败', async () => {
  const { rt, tool } = makeRuntime()
  await tool('agent_graph').execute({ nodes: [n('n1')] })
  const entry = rt.graphs.get(rt.activeGraphId)

  const empty = await tool('graph_reactivate').execute({ node_ids: [] })
  assert.ok(empty.startsWith('Error:'), empty)
  const notArray = await tool('graph_reactivate').execute({ node_ids: 'n1' })
  assert.ok(notArray.startsWith('Error:'), notArray)

  const unknownGraph = await tool('graph_reactivate').execute({
    graph_id: 'gph_deadbeef', node_ids: ['n1'],
  })
  assert.ok(/not found/i.test(unknownGraph), unknownGraph)

  // n1 还在 awaiting_confirm —— 不是终态，没有"过期的产物"可言。
  const notTerminal = await tool('graph_reactivate').execute({ node_ids: ['n1'] })
  assert.ok(notTerminal.startsWith('Error:'), notTerminal)
  assert.match(notTerminal, /awaiting_confirm/)
  assert.strictEqual(entry.graph.get('n1').state, 'awaiting_confirm')

  // 跨图重名之后，"不在这张图里"必须点名到底哪张图有它。
  const other = rt.newGraph({ label: '别的任务' })
  const elsewhere = await tool('graph_reactivate').execute({
    graph_id: other.graphId, node_ids: ['n1'],
  })
  assert.ok(elsewhere.startsWith('Error:'), elsewhere)
  assert.ok(elsewhere.includes(entry.graphId), `要点名 n1 在哪张图里：${elsewhere}`)
})

test('graph_reactivate 的 Tool_Def.description 说清"不一起激活就是拿着过期认知继续跑"', () => {
  const { tool } = makeRuntime()
  const d = tool('graph_reactivate').description
  assert.match(d, /stale/i)
  assert.match(d, /downstream/i)
  assert.match(d, /terminal state|succeeded/i)
  assert.match(d, /^##\s/m)
})

test('对照：新一轮的回报必须被收下 —— on_ready "auto" 的节点激活后自己重新起飞', async () => {
  // generation 守卫**往严的方向**也会坏：`_startNode` 若捕获了错的 generation，新
  // 一轮的回报会被当成陈旧回报丢掉，节点从此停在 running 且不报任何错。这条与上面
  // 那条回归互为两个方向。
  const { rt, tool } = makeRuntime()
  await tool('agent_graph').execute({
    nodes: [{ node_id: 'a1', description: '事先定死的活', prompt: '干活', on_ready: 'auto' }],
  })
  const entry = rt.graphs.get(rt.activeGraphId)
  await rt.drain()
  assert.strictEqual(entry.graph.get('a1').state, 'succeeded')
  const generation = entry.graph.get('a1').generation

  await tool('graph_reactivate').execute({ node_ids: ['a1'], reason: '输入变了' })
  await rt.drain()

  const node = entry.graph.get('a1')
  assert.strictEqual(node.generation, generation + 1)
  assert.strictEqual(node.state, 'succeeded', '新一轮的回报不能被当成陈旧回报丢掉')
  assert.ok(node.result, '重跑的结果必须落在节点上')
})

test('端到端回归：激活一个刚被放弃的节点，在跑的旧 agent 回来时不能复活它', async () => {  // 这条走的是全套真实路径（工具 → runtime → 图 → 真 subagent 的 settle），
  // 与上面那条纯图单测互为两层。`graph.cancel` 只改图状态、故意不 cancelHandle，
  // 于是旧 agent 继续跑到成功 —— 那份成功正是不该被采信的东西。
  const { rt, tool, release } = makeRuntime({ gate: true })
  await tool('agent_graph').execute({ nodes: [n('n1'), n('n2', ['n1'])] })
  const entry = rt.graphs.get(rt.activeGraphId)
  await tool('graph_start').execute({ node_id: 'n1', prompt: 'p' })
  assert.strictEqual(entry.graph.get('n1').state, 'running')

  entry.graph.cancel('n1', '主 agent 放弃了它')
  const out = await tool('graph_reactivate').execute({ node_ids: ['n1'] })
  assert.ok(!out.startsWith('Error:'), out)
  assert.strictEqual(entry.graph.get('n1').state, 'awaiting_confirm')

  await release()

  assert.strictEqual(entry.graph.get('n1').state, 'awaiting_confirm',
    '上一轮 agent 的成功回报属于上一个 generation，必须丢弃')
  assert.strictEqual(entry.graph.get('n1').result, null)
  assert.strictEqual(entry.graph.get('n2').state, 'blocked',
    '下游不能被一份陈旧产物放行')
})
