import test from 'node:test'
import assert from 'node:assert'
import { AgentHandle, TERMINAL_STATES } from './handle.js'
import { SubagentError } from './errors.js'

function make(overrides = {}) {
  return new AgentHandle({
    agentId: 'agt_1', name: 'general-purpose-1', type: 'general-purpose',
    description: 'Audit auth flow', parentAgentId: 'main', depth: 1,
    model: { alias: 'fast', model: 'gpt-4o-mini', apiKey: 'sk-secret', url: 'https://x/v1' },
    ...overrides,
  })
}

test('初始状态是 pending，attempt 从 0 开始', () => {
  const h = make()
  assert.strictEqual(h.state, 'pending')
  assert.strictEqual(h.attempt, 0)
  assert.deepStrictEqual(h.attempts, [])
  assert.strictEqual(h.result, null)
  assert.ok(h.createdAt > 0)
})

test('合法迁移链走通', () => {
  const h = make()
  for (const s of ['queued', 'running', 'waiting_input', 'running', 'succeeded']) h.transition(s)
  assert.strictEqual(h.state, 'succeeded')
  assert.ok(h.isTerminal())
})

test('非法迁移抛 SubagentError 且带 agentId', () => {
  const h = make()
  assert.throws(() => h.transition('succeeded'), (err) =>
    err instanceof SubagentError && err.agentId === 'agt_1' && /pending.*succeeded/.test(err.message))
})

test('终态不可再迁移', () => {
  const h = make()
  h.transition('queued'); h.transition('running'); h.transition('cancelled')
  assert.throws(() => h.transition('running'), SubagentError)
})

test('未知状态名抛错', () => {
  assert.throws(() => make().transition('nope'), SubagentError)
})

test('beginAttempt / endAttempt 记录每次尝试', () => {
  const h = make()
  h.transition('queued'); h.transition('running')
  h.beginAttempt()
  assert.strictEqual(h.attempt, 1)
  assert.ok(h.startedAt > 0)
  h.endAttempt({ failureKind: 'rate_limited', error: '429 Too Many Requests' })
  h.beginAttempt()
  h.endAttempt({})
  assert.strictEqual(h.attempt, 2)
  assert.strictEqual(h.attempts.length, 2)
  assert.strictEqual(h.attempts[0].failureKind, 'rate_limited')
  assert.strictEqual(h.attempts[0].error, '429 Too Many Requests')
  assert.strictEqual(h.attempts[1].failureKind, null)
  assert.ok(h.attempts[0].endedAt >= h.attempts[0].startedAt)
})

test('toStatus 是纯数据且绝不含 apiKey', () => {
  const h = make()
  h.transition('queued'); h.transition('running'); h.beginAttempt()
  h.artifactKeys.push('docs/x.md')
  const s = h.toStatus()
  const json = JSON.stringify(s)
  assert.ok(!json.includes('sk-secret'))
  assert.strictEqual(s.model.alias, 'fast')
  assert.strictEqual(s.model.model, 'gpt-4o-mini')
  assert.strictEqual(s.model.apiKey, undefined)
  assert.strictEqual(s.name, 'general-purpose-1')
  assert.strictEqual(s.state, 'running')
  assert.deepStrictEqual(s.artifactKeys, ['docs/x.md'])
  // 快照不与内部数组共享引用
  s.artifactKeys.push('mutated')
  assert.deepStrictEqual(h.artifactKeys, ['docs/x.md'])
})

test('TERMINAL_STATES 就是三个终态', () => {
  assert.deepStrictEqual([...TERMINAL_STATES].sort(), ['cancelled', 'failed', 'succeeded'])
})
