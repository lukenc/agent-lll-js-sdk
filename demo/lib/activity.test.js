import test from 'node:test'
import assert from 'node:assert'
import { createActivityLedger } from './activity.js'

test('主 agent 的事件不带 agentId，归到 main', () => {
  const led = createActivityLedger()
  led.onToolCall({ name: 'calculate', ok: true, durationMs: 12 })
  assert.deepStrictEqual(led.snapshot('main'), { rounds: 0, tools: [{ name: 'calculate', ok: true, ms: 12 }], truncated: 0 })
})

test('转发来的子 agent 事件按 agentId 分账', () => {
  const led = createActivityLedger()
  led.onRoundStart({ agentId: 'agt_1', round: 0 })
  led.onToolCall({ agentId: 'agt_1', name: 'read_note', ok: true, durationMs: 200 })
  led.onToolCall({ agentId: 'agt_2', name: 'read_note', ok: true, durationMs: 300 })
  assert.strictEqual(led.snapshot('agt_1').tools.length, 1)
  assert.strictEqual(led.snapshot('agt_2').tools.length, 1)
  assert.strictEqual(led.snapshot('agt_1').rounds, 1)
  assert.strictEqual(led.snapshot('agt_2').rounds, 0)
})

test('rounds 取 round 字段的最大值 + 1，不是事件计数', () => {
  // 重试会让 round 从 0 重新开始；用计数会把两次尝试加起来虚报
  const led = createActivityLedger()
  led.onRoundStart({ agentId: 'a', round: 0 })
  led.onRoundStart({ agentId: 'a', round: 1 })
  led.onRoundStart({ agentId: 'a', round: 0 })
  assert.strictEqual(led.snapshot('a').rounds, 2)
})

test('工具流水超过 maxTools 时丢最旧的并计数', () => {
  const led = createActivityLedger({ maxTools: 3 })
  for (let i = 0; i < 5; i++) led.onToolCall({ agentId: 'a', name: `t${i}`, ok: true, durationMs: 1 })
  const s = led.snapshot('a')
  assert.deepStrictEqual(s.tools.map(t => t.name), ['t2', 't3', 't4'])
  assert.strictEqual(s.truncated, 2)
})

test('失败的工具调用记 ok:false', () => {
  const led = createActivityLedger()
  led.onToolCall({ agentId: 'a', name: 'boom', ok: false, durationMs: 5, errorKind: 'exception' })
  assert.deepStrictEqual(led.snapshot('a').tools, [{ name: 'boom', ok: false, ms: 5 }])
})

test('agent 数超过 maxAgents 时按插入顺序淘汰最旧的终态 agent', () => {
  const led = createActivityLedger({ maxAgents: 2 })
  led.onToolCall({ agentId: 'a', name: 'x', ok: true, durationMs: 1 })
  led.onToolCall({ agentId: 'b', name: 'x', ok: true, durationMs: 1 })
  led.markTerminal('a')
  led.onToolCall({ agentId: 'c', name: 'x', ok: true, durationMs: 1 })
  assert.strictEqual(led.snapshot('a'), null)
  assert.ok(led.snapshot('b'))
  assert.ok(led.snapshot('c'))
})

test('非终态 agent 永不淘汰:更旧的非终态条目在过了 maxAgents 后依然存活,反而淘汰更旧的终态条目', () => {
  const led = createActivityLedger({ maxAgents: 2 })
  led.onToolCall({ agentId: 'main', name: 'x', ok: true, durationMs: 1 }) // 非终态,永不淘汰
  led.onToolCall({ agentId: 'b', name: 'x', ok: true, durationMs: 1 })
  led.markTerminal('b') // b 是终态,比 main 晚插入但是唯一的淘汰候选
  led.onToolCall({ agentId: 'c', name: 'x', ok: true, durationMs: 1 })
  assert.ok(led.snapshot('main'), 'main 是非终态,即便是插入顺序里最旧的也不该被淘汰')
  assert.strictEqual(led.snapshot('b'), null, 'b 是唯一的终态条目,该被淘汰')
  assert.ok(led.snapshot('c'))
})

test('全部条目都是非终态时,超过 maxAgents 也不淘汰任何条目', () => {
  const led = createActivityLedger({ maxAgents: 2 })
  led.onToolCall({ agentId: 'a', name: 'x', ok: true, durationMs: 1 })
  led.onToolCall({ agentId: 'b', name: 'x', ok: true, durationMs: 1 })
  led.onToolCall({ agentId: 'c', name: 'x', ok: true, durationMs: 1 })
  assert.ok(led.snapshot('a'), '没有终态候选时账本允许暂时超过 maxAgents')
  assert.ok(led.snapshot('b'))
  assert.ok(led.snapshot('c'))
})

test('markTerminal 对未知 agentId 是无害 no-op,不会创建条目', () => {
  const led = createActivityLedger()
  led.markTerminal('ghost')
  assert.strictEqual(led.snapshot('ghost'), null)
})

test('markTerminal 不影响已有条目的 rounds/tools/truncated', () => {
  const led = createActivityLedger({ maxTools: 3 })
  led.onRoundStart({ agentId: 'a', round: 1 })
  led.onToolCall({ agentId: 'a', name: 'x', ok: true, durationMs: 1 })
  const before = led.snapshot('a')
  led.markTerminal('a')
  const after = led.snapshot('a')
  assert.deepStrictEqual(after, before)
})

test('未知 agentId 返回 null，不返回空壳', () => {
  assert.strictEqual(createActivityLedger().snapshot('nope'), null)
})

test('clear 清空全部', () => {
  const led = createActivityLedger()
  led.onToolCall({ agentId: 'a', name: 'x', ok: true, durationMs: 1 })
  led.clear()
  assert.strictEqual(led.snapshot('a'), null)
})

test('durationMs 缺失时 ms 记 null 而不是 NaN', () => {
  const led = createActivityLedger()
  led.onToolCall({ agentId: 'a', name: 'x', ok: true })
  assert.strictEqual(led.snapshot('a').tools[0].ms, null)
})
