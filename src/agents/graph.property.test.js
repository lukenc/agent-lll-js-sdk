import test from 'node:test'
import assert from 'node:assert'
import fc from 'fast-check'
import { AgentGraph } from './graph.js'
import { AgentGraphError } from './errors.js'

/**
 * 生成一个必然无环的场景：节点 i 只能依赖 j < i（保证无环），但
 *
 *  - **声明顺序被打乱**（`declared`）—— 否则插入顺序天然就是拓扑序，
 *    "启动顺序满足拓扑序"会被白送，依赖闸门根本没被测到；
 *  - **结算顺序也由生成器决定**（`picks`）—— agent 不会按声明顺序干完，
 *    tick 必须能在任意结算交错下正确放行下游；
 *  - **on_ready 逐节点随机**：一半走 auto，一半走默认的 confirm 闸门。
 */
const scenarioArb = fc.integer({ min: 1, max: 12 }).chain((size) =>
  fc.record({
    deps: fc.tuple(...Array.from({ length: size }, (_, i) =>
      fc.subarray(Array.from({ length: i }, (_, j) => `n${j}`)))),
    autos: fc.array(fc.boolean(), { minLength: size, maxLength: size }),
    declareKeys: fc.array(fc.nat({ max: 1000 }), { minLength: size, maxLength: size }),
    picks: fc.array(fc.nat({ max: 1000 }), { minLength: size, maxLength: size }),
  }).map(({ deps, autos, declareKeys, picks }) => {
    const nodes = deps.map((dependsOn, i) => ({
      node_id: `n${i}`, depends_on: dependsOn, description: `t${i}`,
      ...(autos[i] ? { on_ready: 'auto', prompt: `p${i}` } : {}),
    }))
    const declared = nodes
      .map((node, i) => ({ node, key: declareKeys[i], i }))
      .sort((a, b) => (a.key - b.key) || (a.i - b.i))
      .map(entry => entry.node)
    return { nodes, declared, picks }
  }))

/**
 * 跑完一整张图：auto 节点由图自己启动，confirm 节点由"主 agent"看过就绪回调后
 * 调 `start()` 启动；在飞的节点按生成器给的顺序逐个成功。
 */
function drive({ declared, picks }) {
  const started = []
  const inflight = []
  const awaitingConfirm = []
  const graph = new AgentGraph({
    onReadyNode: (node) => awaitingConfirm.push(node.nodeId),
    onAutoStart: (node) => {
      started.push(node.nodeId)
      inflight.push(node.nodeId)
    },
  })
  graph.declare(declared)

  let cursor = 0
  const pick = (length) => {
    const index = picks[cursor % picks.length] % length
    cursor += 1
    return index
  }
  // 每轮要么把一个待确认节点启动，要么结掉一个在飞节点 —— 两者都在减少总工作量，
  // 所以循环必然收敛（总启动次数 = 节点数）。
  while (awaitingConfirm.length > 0 || inflight.length > 0) {
    if (awaitingConfirm.length > 0) {
      const nodeId = awaitingConfirm.splice(pick(awaitingConfirm.length), 1)[0]
      const result = graph.start(nodeId, { prompt: `final contract for ${nodeId}` })
      assert.strictEqual(result.ok, true, `start(${nodeId}) 应当成功，却是：${result.reason}`)
      started.push(nodeId)
      inflight.push(nodeId)
      continue
    }
    const nodeId = inflight.splice(pick(inflight.length), 1)[0]
    graph.onAgentSettled({ nodeId, state: 'succeeded', agentId: `agt_${nodeId}` })
  }
  return { graph, started }
}

/** 生成器覆盖度统计 —— 防止"随机图"其实只有单节点、性质空过。 */
function coverage() {
  return { runs: 0, maxNodes: 0, maxEdges: 0, withEdges: 0, declaredBeforeDep: 0 }
}
function record(cov, { nodes, declared }) {
  const edges = nodes.reduce((sum, node) => sum + node.depends_on.length, 0)
  cov.runs += 1
  cov.maxNodes = Math.max(cov.maxNodes, nodes.length)
  cov.maxEdges = Math.max(cov.maxEdges, edges)
  if (edges > 0) cov.withEdges += 1
  if (declared) {
    const position = new Map(declared.map((node, i) => [node.node_id, i]))
    const inverted = declared.some(node =>
      node.depends_on.some(dep => position.get(dep) > position.get(node.node_id)))
    if (inverted) cov.declaredBeforeDep += 1
  }
}
function assertNonTrivial(cov, { needsInvertedOrder = false } = {}) {
  assert.ok(cov.maxNodes >= 5, `生成器只产出了 ≤${cov.maxNodes} 个节点的图，性质是空过的`)
  assert.ok(cov.maxEdges >= 3, `生成器最多只产出 ${cov.maxEdges} 条边，性质是空过的`)
  assert.ok(cov.withEdges > cov.runs / 10, `只有 ${cov.withEdges}/${cov.runs} 个图带边`)
  if (needsInvertedOrder) {
    // 这一条是关键：必须真的出现"节点声明在它的依赖之前"的图，否则插入顺序
    // 就等于拓扑序，拓扑序性质是白送的。
    assert.ok(cov.declaredBeforeDep > cov.runs / 10,
      `只有 ${cov.declaredBeforeDep}/${cov.runs} 个图的声明顺序违反拓扑序`)
  }
}

test('性质：无环图的启动顺序恒满足拓扑序', () => {
  const cov = coverage()
  fc.assert(fc.property(scenarioArb, (scenario) => {
    record(cov, scenario)
    const { started } = drive(scenario)
    const position = new Map(started.map((nodeId, i) => [nodeId, i]))
    for (const node of scenario.nodes) {
      assert.ok(position.has(node.node_id), `${node.node_id} 从未启动`)
      for (const dep of node.depends_on) {
        assert.ok(position.get(dep) < position.get(node.node_id),
          `${dep} 必须先于 ${node.node_id} 启动`)
      }
    }
  }), { numRuns: 200 })
  assertNonTrivial(cov, { needsInvertedOrder: true })
})

test('性质：无环图最终全部到达终态', () => {
  const cov = coverage()
  fc.assert(fc.property(scenarioArb, (scenario) => {
    record(cov, scenario)
    const { graph } = drive(scenario)
    assert.strictEqual(graph.hasPending(), false)
    for (const node of scenario.nodes) {
      assert.strictEqual(graph.get(node.node_id).state, 'succeeded')
    }
  }), { numRuns: 200 })
  assertNonTrivial(cov, { needsInvertedOrder: true })
})

/**
 * 含环的声明：一个首尾相接的环，外加若干无环节点 —— 环藏在更大的图里，
 * 而不只是"整张图就是一个环"这种最容易检出的形状。
 */
const cyclicArb = fc.tuple(fc.integer({ min: 2, max: 8 }), fc.nat({ max: 4 }))
  .chain(([ringSize, padSize]) => {
    const padDepsArb = padSize === 0
      ? fc.constant([])
      : fc.tuple(...Array.from({ length: padSize }, (_, i) =>
        fc.subarray(Array.from({ length: i }, (_, j) => `p${j}`))))
    return padDepsArb.map((padDeps) => {
      const pads = padDeps.map((dependsOn, i) => ({
        node_id: `p${i}`, depends_on: dependsOn, description: `pad${i}`,
        on_ready: 'auto', prompt: `pp${i}`,
      }))
      const ring = Array.from({ length: ringSize }, (_, i) => ({
        node_id: `n${i}`,
        // 首尾相接 = 必然成环；i === 0 时再挂一条指向无环区的边，环仍然是环
        depends_on: [`n${(i + 1) % ringSize}`, ...(i === 0 && pads.length > 0 ? ['p0'] : [])],
        description: `t${i}`, on_ready: 'auto', prompt: `p${i}`,
      }))
      return { nodes: [...pads, ...ring] }
    })
  })

test('性质：任何含环的声明都被拒绝，且不留下部分状态', () => {
  const cov = coverage()
  fc.assert(fc.property(cyclicArb, ({ nodes }) => {
    record(cov, { nodes })
    const graph = new AgentGraph({ onReadyNode: () => {}, onAutoStart: () => {} })
    assert.throws(() => graph.declare(nodes), (err) =>
      err instanceof AgentGraphError && Array.isArray(err.cycle) && err.cycle.length >= 2)
    for (const node of nodes) assert.strictEqual(graph.get(node.node_id), null)
    assert.strictEqual(graph.hasPending(), false)
  }), { numRuns: 100 })
  assertNonTrivial(cov)
})
