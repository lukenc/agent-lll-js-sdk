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

test('agent 数超过 maxAgents 时按插入顺序淘汰最旧的', () => {
  const led = createActivityLedger({ maxAgents: 2 })
  led.onToolCall({ agentId: 'a', name: 'x', ok: true, durationMs: 1 })
  led.onToolCall({ agentId: 'b', name: 'x', ok: true, durationMs: 1 })
  led.onToolCall({ agentId: 'c', name: 'x', ok: true, durationMs: 1 })
  assert.strictEqual(led.snapshot('a'), null)
  assert.ok(led.snapshot('b'))
  assert.ok(led.snapshot('c'))
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
