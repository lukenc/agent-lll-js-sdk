/**
 * 多图容器。
 *
 * 图跟的是**任务**：同一个任务同一张可变图，一个 agent 可以同时持有好几张。
 * 由此收窄掉两个缺陷：`node_id` 的唯一性从会话级降到图级（第二个任务重用
 * `n1` 不再让整批声明被拒），以及 `statusTable()` 不再无界增长。
 *
 * 文件里有两条**回归**测试，对应两处会静默坏掉的地方：
 *   - `hasInFlight()` 必须跨全部图（含 closed）聚合；
 *   - 每张图的回调闭包必须回报到自己那张图。
 * 它们的失败形态都是"不报错，节点永远停在 running"，所以只能靠测试守。
 */
import test from 'node:test'
import assert from 'node:assert'
import { RuntimeHistory } from '../runtime-history.js'
import { createSubagentRuntime } from './runtime.js'
import { resetAgentTypes } from './types.js'

test.beforeEach(() => resetAgentTypes())

/**
 * @param {object} [opts]
 * @param {boolean} [opts.gate] true 时子 agent 的 chat 挂起，直到 `release()`
 *        —— 用来观察"agent 正在飞"这个中间态。挂起期间**监听 abort**，否则
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

// ---- 容器与 id ----

test('不给 graph_id 时首次 agent_graph 新建一张图并置为活跃', async () => {
  const { rt, tool } = makeRuntime()
  assert.strictEqual(rt.activeGraphId, null, '构造时不预先开图')
  assert.strictEqual(rt.graphs.size, 0)

  const out = await tool('agent_graph').execute({ nodes: [{ node_id: 'n1', description: 'explore' }] })

  assert.strictEqual(rt.graphs.size, 1)
  const [entry] = [...rt.graphs.values()]
  assert.strictEqual(rt.activeGraphId, entry.graphId)
  assert.strictEqual(entry.state, 'open')
  assert.strictEqual(entry.graph, rt.graph, 'runtime.graph 指向活跃图')
  assert.ok(out.includes(entry.graphId),
    '返回里必须带 graph_id —— 模型之后要靠它定位这张图')
})

test('graphId 是纯单调计数器，不混时间位', () => {
  // 与 `newAgentId` / `newEnvelopeId` 同一理由，本项目已经在那两处各踩过一次：
  // 混时间位只给计数器留几位，同一毫秒内建的第 N 张图会撞上第 1 张的 id，而
  // `graphs.set` 是静默覆盖 —— 前一张图连它记录的节点归属一起消失。
  const { rt } = makeRuntime()
  const ids = []
  for (let i = 0; i < 300; i += 1) ids.push(rt.newGraph().graphId)
  for (const id of ids) assert.match(id, /^gph_[0-9a-f]{8}$/)
  assert.strictEqual(new Set(ids).size, 300, '同一毫秒内建的 300 张图必须各有各的 id')
  const nums = ids.map(id => parseInt(id.slice(4), 16))
  for (let i = 1; i < nums.length; i += 1) {
    assert.ok(nums[i] > nums[i - 1], 'id 必须严格递增')
  }
})

test('同一 node_id 可在两张不同图里共存，互不干扰', async () => {
  const { rt, tool } = makeRuntime()
  const a = rt.newGraph({ label: 'task-a' })
  await tool('agent_graph').execute({ graph_id: a.graphId, nodes: [{ node_id: 'n1', description: 'A 的活' }] })
  const b = rt.newGraph({ label: 'task-b' })
  const out = await tool('agent_graph').execute({ graph_id: b.graphId, nodes: [{ node_id: 'n1', description: 'B 的活' }] })

  assert.ok(!/duplicate/i.test(out), `同名 node_id 跨图不该被拒：${out}`)
  assert.strictEqual(a.graph.get('n1').description, 'A 的活')
  assert.strictEqual(b.graph.get('n1').description, 'B 的活')

  await tool('graph_start').execute({
    graph_id: a.graphId, node_id: 'n1', prompt: 'p', run_in_background: false,
  })
  assert.strictEqual(a.graph.get('n1').state, 'succeeded')
  assert.strictEqual(b.graph.get('n1').state, 'awaiting_confirm', 'B 的同名节点不受影响')
})

test('graph_start 打到非活跃图的 node_id 时软失败，提示里含那张图的 graph_id', async () => {
  const { rt, tool } = makeRuntime()
  await tool('agent_graph').execute({ nodes: [{ node_id: 'n1', description: 'A 的活' }] })
  const a = rt.graphs.get(rt.activeGraphId)
  const b = rt.newGraph({ label: 'task-b' })

  const out = await tool('graph_start').execute({ node_id: 'n1', prompt: 'p' })

  assert.ok(out.startsWith('Error:'), `必须软失败而不是抛：${out}`)
  assert.ok(out.includes(a.graphId), `提示必须点名含这个 node_id 的图：${out}`)
  assert.ok(out.includes('graph_id'), '并且告诉模型怎么纠正')
  assert.strictEqual(a.graph.get('n1').state, 'awaiting_confirm', '不该顺手启动别的图的节点')
  assert.strictEqual(b.graph.nodes.size, 0)
})

test('agent_status 默认只列活跃图，graph_id "all" 列出全部（含 closed）', async () => {
  const { rt, tool } = makeRuntime()
  await tool('agent_graph').execute({ nodes: [{ node_id: 'alpha', description: '旧任务' }] })
  const a = rt.graphs.get(rt.activeGraphId)
  rt.closeGraph(a.graphId)
  const b = rt.newGraph()
  await tool('agent_graph').execute({ graph_id: b.graphId, nodes: [{ node_id: 'beta', description: '新任务' }] })

  const activeOnly = await tool('agent_status').execute({ include_graph: true })
  assert.ok(activeOnly.includes('beta'))
  assert.ok(!activeOnly.includes('alpha'),
    '默认只列活跃图 —— 否则 statusTable 又变成整个会话的无界累积')

  const all = await tool('agent_status').execute({ graph_id: 'all' })
  assert.ok(all.includes('alpha'), 'all 必须包含 closed 图')
  assert.ok(all.includes('beta'))
  assert.ok(all.includes(a.graphId))
  assert.ok(all.includes(b.graphId))

  const unknown = await tool('agent_status').execute({ graph_id: 'gph_deadbeef' })
  assert.ok(/not found/i.test(unknown), `未知 graph_id 要软失败：${unknown}`)
})

// ---- 回归 1：hasInFlight 跨图聚合 ----

test('回归：一张图有在飞节点时，切换活跃图后 hasInFlight() 仍为 true', () => {
  // 只查活跃图的话，主 agent 一换图就不再等旧图里还在跑的 agent，那些结果没人
  // 接。这里**不起真 agent**：inflight 集合与 registry 都是空的，`hasInFlight()`
  // 为真只能来自图 —— 否则这条测试会在有 bug 时照样通过。
  const { rt } = makeRuntime()
  const a = rt.newGraph({ label: 'task-a' })
  a.graph.declare([{ node_id: 'n1', description: 'x' }])
  a.graph.onAgentSettled({ nodeId: 'n1', state: 'running', agentId: 'agt_fake' })

  assert.strictEqual(rt.registry.list().length, 0, '前提：注册表里没有 agent')
  assert.strictEqual(rt.hasInFlight(), true)

  const b = rt.newGraph({ label: 'task-b' })
  assert.strictEqual(rt.activeGraphId, b.graphId)
  assert.strictEqual(rt.hasInFlight(), true, '活跃图换了，A 图里在飞的活并没有消失')

  // closed 更是不能漏：图被关掉不代表它里头的 agent 停了。
  rt.closeGraph(a.graphId)
  assert.strictEqual(rt.hasInFlight(), true, 'closed 图里在飞的活同样要算')

  a.graph.onAgentSettled({ nodeId: 'n1', state: 'succeeded' })
  assert.strictEqual(rt.hasInFlight(), false, '对照：节点走到终态后才该为假')
})

// ---- 回归 2：settle 落回自己那张图 ----

test('回归：在飞节点的 settle 落回它自己那张图，不落到活跃图', async () => {
  // 回调闭包若读活跃图 getter，A 图节点的终态回报会落到 B 图上。而
  // `onAgentSettled` 对未知 nodeId 是静默 return（graph.js:397）—— 所以这个错
  // **不报任何异常**，只是让 A 的节点永远停在 running。两张图都放一个叫 n1 的
  // 节点，误投的方向也就一并守住了。
  const { rt, tool, release } = makeRuntime({ gate: true })
  await tool('agent_graph').execute({ nodes: [{ node_id: 'n1', description: 'A 的活' }] })
  const a = rt.graphs.get(rt.activeGraphId)
  await tool('graph_start').execute({ node_id: 'n1', prompt: 'p' })
  assert.strictEqual(a.graph.get('n1').state, 'running')

  const b = rt.newGraph({ label: 'task-b' })
  await tool('agent_graph').execute({ graph_id: b.graphId, nodes: [{ node_id: 'n1', description: 'B 的活' }] })
  assert.strictEqual(rt.activeGraphId, b.graphId, '前提：活跃图已经换成 B')

  await release()

  assert.strictEqual(a.graph.get('n1').state, 'succeeded', 'A 的节点必须自己走到终态')
  assert.strictEqual(b.graph.get('n1').state, 'awaiting_confirm', 'B 的同名节点不该被误投的回报改写')
})

// ---- 保留与淘汰 ----

test('retainClosedGraphs 超限时最旧的 closed 图被整张淘汰，有在飞节点的不被淘汰', () => {
  const { rt } = makeRuntime({ retainClosedGraphs: 2 })
  const g1 = rt.newGraph({ label: 'g1' })
  g1.graph.declare([{ node_id: 'n1', description: 'x' }])
  g1.graph.onAgentSettled({ nodeId: 'n1', state: 'running', agentId: 'agt_fake' })
  const g2 = rt.newGraph({ label: 'g2' })
  const g3 = rt.newGraph({ label: 'g3' })
  const g4 = rt.newGraph({ label: 'g4' })

  for (const g of [g1, g2, g3, g4]) rt.closeGraph(g.graphId)

  // 4 张 closed、上限 2 → 淘汰 2 张。g1 最旧，但它还有在飞的节点：淘汰它就把
  // 一个还在跑的 agent 的归属丢了，所以跳过它，往后再找两张。
  assert.ok(rt.graphs.has(g1.graphId), '有在飞节点的图不被淘汰')
  assert.ok(!rt.graphs.has(g2.graphId))
  assert.ok(!rt.graphs.has(g3.graphId))
  assert.ok(rt.graphs.has(g4.graphId))
  assert.strictEqual(rt.graphs.size, 2)
})

// ---- 关停 ----

test('close() 取消全部图的未终态节点，不只是活跃图', async () => {
  const { rt, tool, release } = makeRuntime({ gate: true })
  await tool('agent_graph').execute({ nodes: [{ node_id: 'n1', description: 'A 的活' }] })
  const a = rt.graphs.get(rt.activeGraphId)
  await tool('graph_start').execute({ node_id: 'n1', prompt: 'p' })
  const agentId = a.graph.get('n1').agentId

  const b = rt.newGraph({ label: 'task-b' })
  await tool('agent_graph').execute({ graph_id: b.graphId, nodes: [{ node_id: 'm1', description: 'B 的活' }] })

  await rt.close()

  assert.strictEqual(a.graph.get('n1').state, 'cancelled', '非活跃图里在跑的节点也要取消')
  assert.strictEqual(rt.registry.get(agentId).state, 'cancelled')
  assert.strictEqual(b.graph.get('m1').state, 'cancelled')
  await release()
})

test('runtime.graph 在无活跃图时返回 null 而不抛', () => {
  const { rt } = makeRuntime()
  assert.strictEqual(rt.graph, null)
  assert.strictEqual(rt.statusTable(), 'no graph declared')

  const g = rt.newGraph()
  assert.strictEqual(rt.graph, g.graph)

  // 关掉活跃图 = 没有活跃图了，getter 仍然只是 null。
  rt.closeGraph(g.graphId)
  assert.strictEqual(rt.activeGraphId, null)
  assert.strictEqual(rt.graph, null)
  assert.doesNotThrow(() => rt.statusTable())
})
