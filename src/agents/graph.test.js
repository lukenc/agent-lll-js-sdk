import test from 'node:test'
import assert from 'node:assert'
import { AgentGraph, detectCycle } from './graph.js'
import { AgentGraphError } from './errors.js'

function makeGraph() {
  const ready = []
  const auto = []
  const graph = new AgentGraph({
    onReadyNode: (node, upstream) => ready.push({ nodeId: node.nodeId, upstream }),
    onAutoStart: (node) => auto.push(node.nodeId),
  })
  return { graph, ready, auto }
}

const n = (nodeId, dependsOn = [], extra = {}) =>
  ({ node_id: nodeId, depends_on: dependsOn, description: `task ${nodeId}`, ...extra })

test('声明后无依赖的节点立即 ready，有依赖的保持 blocked', () => {
  const { graph, ready } = makeGraph()
  graph.declare([n('n1'), n('n2', ['n1'])])
  assert.strictEqual(graph.get('n1').state, 'awaiting_confirm')
  assert.strictEqual(graph.get('n2').state, 'blocked')
  assert.deepStrictEqual(ready.map(r => r.nodeId), ['n1'])
})

test('on_ready:auto 且有 prompt 的节点走自动启动', () => {
  const { graph, auto, ready } = makeGraph()
  graph.declare([n('n1', [], { on_ready: 'auto', prompt: '干活' })])
  assert.deepStrictEqual(auto, ['n1'])
  assert.strictEqual(ready.length, 0)
})

test('on_ready:auto 缺 prompt → 整批拒绝', () => {
  const { graph } = makeGraph()
  assert.throws(() => graph.declare([n('n1', [], { on_ready: 'auto' })]),
    (err) => err instanceof AgentGraphError && /prompt/.test(err.message))
  assert.strictEqual(graph.get('n1'), null, '拒绝必须是整批的，不能留下半个图')
})

test('环被检出且整批拒绝，错误里带环路径', () => {
  const { graph } = makeGraph()
  assert.throws(() => graph.declare([n('a', ['c']), n('b', ['a']), n('c', ['b'])]),
    (err) => err instanceof AgentGraphError && Array.isArray(err.cycle) && err.cycle.length >= 3)
  assert.strictEqual(graph.get('a'), null)
})

test('自环也被检出', () => {
  const { graph } = makeGraph()
  assert.throws(() => graph.declare([n('a', ['a'])]), AgentGraphError)
})

test('依赖未知节点 → 拒绝', () => {
  const { graph } = makeGraph()
  assert.throws(() => graph.declare([n('n1', ['ghost'])]),
    (err) => err instanceof AgentGraphError && /ghost/.test(err.message))
})

test('重复 node_id → 拒绝', () => {
  const { graph } = makeGraph()
  graph.declare([n('n1')])
  assert.throws(() => graph.declare([n('n1')]), AgentGraphError)
})

test('多批声明：新节点可依赖旧节点', () => {
  const { graph, ready } = makeGraph()
  graph.declare([n('n1')])
  graph.declare([n('n2', ['n1'])])
  assert.strictEqual(graph.get('n2').state, 'blocked')
  graph.start('n1', { prompt: 'p' })
  graph.onAgentSettled({ nodeId: 'n1', state: 'succeeded' })
  assert.strictEqual(graph.get('n2').state, 'awaiting_confirm')
  assert.deepStrictEqual(ready.map(r => r.nodeId), ['n1', 'n2'])
})

test('就绪回调带上上游结果，供主 agent 重定契约', () => {
  const { graph, ready } = makeGraph()
  graph.declare([n('n1'), n('n2', ['n1'])])
  graph.start('n1', { prompt: 'p' })
  graph.onAgentSettled({ nodeId: 'n1', state: 'succeeded', agentId: 'agt_1', result: '上游报告' })
  const n2Ready = ready.find(r => r.nodeId === 'n2')
  assert.strictEqual(n2Ready.upstream.length, 1)
  assert.strictEqual(n2Ready.upstream[0].nodeId, 'n1')
  assert.strictEqual(n2Ready.upstream[0].result, '上游报告')
})

test('惰性：blocked / awaiting_confirm 的节点没有 agentId', () => {
  const { graph } = makeGraph()
  graph.declare([n('n1'), n('n2', ['n1'])])
  assert.strictEqual(graph.get('n1').agentId, null)
  assert.strictEqual(graph.get('n2').agentId, null)
})

test('start 只在 ready / awaiting_confirm 状态可用', () => {
  const { graph } = makeGraph()
  graph.declare([n('n1'), n('n2', ['n1'])])
  assert.strictEqual(graph.start('n1', { prompt: 'p' }).ok, true)
  assert.strictEqual(graph.start('n1', { prompt: 'p' }).ok, false, '已启动的不能再启动')
  const blocked = graph.start('n2', { prompt: 'p' })
  assert.strictEqual(blocked.ok, false)
  assert.match(blocked.reason, /blocked/)
})

test('start 时的 patch 覆盖声明期的类型与模型', () => {
  const { graph } = makeGraph()
  graph.declare([n('n1', [], { subagent_type: 'general-purpose', model: 'main' })])
  const started = graph.start('n1', { prompt: '最终契约', subagent_type: 'explorer', model: 'fast' })
  assert.strictEqual(started.node.prompt, '最终契约')
  assert.strictEqual(started.node.subagentType, 'explorer')
  assert.strictEqual(started.node.model, 'fast')
})

test('start 被拒时不留下半个 patch', () => {
  const { graph } = makeGraph()
  graph.declare([n('n1', [], { subagent_type: 'general-purpose' })])
  const rejected = graph.start('n1', { subagent_type: 'explorer' })
  assert.strictEqual(rejected.ok, false)
  assert.match(rejected.reason, /prompt/)
  assert.strictEqual(graph.get('n1').subagentType, 'general-purpose')
  assert.strictEqual(graph.get('n1').state, 'awaiting_confirm', '被拒的启动不该改状态')
})

test('上游失败：默认 block，下游停在 blocked 并标注原因', () => {
  const { graph, ready } = makeGraph()
  graph.declare([n('n1'), n('n2', ['n1'])])
  graph.start('n1', { prompt: 'p' })
  graph.onAgentSettled({ nodeId: 'n1', state: 'failed' })
  assert.strictEqual(graph.get('n2').state, 'blocked')
  assert.strictEqual(graph.get('n2').blockedReason, 'upstream_failed')
  assert.ok(!ready.some(r => r.nodeId === 'n2'), '上游失败不应触发就绪回调')
})

test('上游失败 + on_upstream_failure:skip → 下游 skipped 并继续传播', () => {
  const { graph } = makeGraph()
  graph.declare([n('n1'), n('n2', ['n1'], { on_upstream_failure: 'skip' }), n('n3', ['n2'], { on_upstream_failure: 'skip' })])
  graph.start('n1', { prompt: 'p' })
  graph.onAgentSettled({ nodeId: 'n1', state: 'failed' })
  assert.strictEqual(graph.get('n2').state, 'skipped')
  assert.strictEqual(graph.get('n3').state, 'skipped')
})

test('cancel 未启动的节点', () => {
  const { graph } = makeGraph()
  graph.declare([n('n1')])
  assert.strictEqual(graph.cancel('n1', '不需要了').ok, true)
  assert.strictEqual(graph.get('n1').state, 'cancelled')
  const again = graph.cancel('n1', '再来一次')
  assert.strictEqual(again.ok, false, '终态节点不能被二次取消')
  assert.match(again.reason, /already cancelled/)
  assert.strictEqual(graph.cancel('nope').ok, false)
})

test('hasPending 反映是否还有活', () => {
  const { graph } = makeGraph()
  assert.strictEqual(graph.hasPending(), false)
  graph.declare([n('n1')])
  assert.strictEqual(graph.hasPending(), true)
  graph.start('n1', { prompt: 'p' })
  graph.onAgentSettled({ nodeId: 'n1', state: 'succeeded' })
  assert.strictEqual(graph.hasPending(), false)
})

test('statusTable 可读且含全部节点', () => {
  const { graph } = makeGraph()
  graph.declare([n('n1'), n('n2', ['n1'])])
  const table = graph.statusTable()
  assert.ok(table.includes('n1'))
  assert.ok(table.includes('n2'))
  assert.ok(table.includes('blocked'))
})

test('detectCycle 直接可用', () => {
  assert.strictEqual(detectCycle([{ nodeId: 'a', dependsOn: [] }], new Map()), null)
  const cycle = detectCycle(
    [{ nodeId: 'a', dependsOn: ['b'] }, { nodeId: 'b', dependsOn: ['a'] }], new Map())
  assert.ok(Array.isArray(cycle) && cycle.length >= 2)
})

test('detectCycle 把已声明的旧节点一起算进来', () => {
  // 走 declare 时这条边造不出来：依赖必须已经存在，所以边只会指向更早声明的
  // 节点，环只可能落在同一批里。但 detectCycle 的契约是连 existing 一起算 ——
  // 哪天依赖变得可改写，这就是唯一的兜底。
  const existing = new Map([['old', { dependsOn: ['fresh'] }]])
  const cycle = detectCycle([{ nodeId: 'fresh', dependsOn: ['old'] }], existing)
  assert.ok(Array.isArray(cycle), '旧节点指回新节点也是环')
  assert.ok(cycle.includes('old') && cycle.includes('fresh'))
})

// —— 以下 3 个是 brief 之外补的，各自守住一个真实缺陷 ——

test('waiting_input 算“还在跑”：既不解锁下游，也不让 hasPending 变 false', () => {
  const { graph, ready } = makeGraph()
  graph.declare([n('n1'), n('n2', ['n1'])])
  graph.start('n1', { prompt: 'p' })
  graph.onAgentSettled({ nodeId: 'n1', state: 'waiting_input', agentId: 'agt_1' })
  assert.strictEqual(graph.get('n2').state, 'blocked')
  assert.ok(!ready.some(r => r.nodeId === 'n2'))

  // 上面那张图里 n2 本来就 blocked，hasPending 天然为 true —— 想真正测到
  // "waiting_input 不是终态"，得让它成为图里唯一的非终态节点。
  const solo = makeGraph().graph
  solo.declare([n('only')])
  solo.start('only', { prompt: 'p' })
  solo.onAgentSettled({ nodeId: 'only', state: 'waiting_input', agentId: 'agt_2' })
  assert.strictEqual(solo.hasPending(), true, '在等用户回答的 agent 没有干完')
})

test('cancel 交回 agentId 与前一状态，供调用方走 cancelHandle', () => {
  const { graph } = makeGraph()
  graph.declare([n('n1')])
  graph.start('n1', { prompt: 'p' })
  graph.onAgentSettled({ nodeId: 'n1', state: 'running', agentId: 'agt_1' })
  const res = graph.cancel('n1', '不需要了')
  assert.strictEqual(res.ok, true)
  assert.strictEqual(res.agentId, 'agt_1', '没有 agentId 调用方就没法取消真正在跑的 agent')
  assert.strictEqual(res.previousState, 'running')
  assert.strictEqual(graph.get('n1').state, 'cancelled')
})

test('终态节点不会被迟到的 settle 复活', () => {
  const { graph } = makeGraph()
  graph.declare([n('n1'), n('n2', ['n1'])])
  graph.start('n1', { prompt: 'p' })
  graph.cancel('n1', '算了')
  // 被取消的 agent 收尾时 runner 仍会报一次终态 —— 不能让它把 cancelled 覆盖成
  // succeeded，否则下游会从一条已取消的分支上启动。
  graph.onAgentSettled({ nodeId: 'n1', state: 'succeeded', result: '迟到的结果' })
  assert.strictEqual(graph.get('n1').state, 'cancelled')
  assert.strictEqual(graph.get('n2').state, 'blocked')
  assert.strictEqual(graph.get('n2').blockedReason, 'upstream_cancelled')
})
