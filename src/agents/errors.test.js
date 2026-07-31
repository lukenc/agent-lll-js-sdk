import test from 'node:test'
import assert from 'node:assert'
import {
  SubagentError, AgentTypeError, AgentGraphError, A2AError, WorktreeIsolationError,
} from './errors.js'

test('SubagentError 只吸收白名单字段', () => {
  const err = new SubagentError('boom', {
    agentId: 'agt_1', agentName: 'explorer-1', nodeId: 'n1',
    failureKind: 'rate_limited',
    apiKey: 'sk-secret', headers: { Authorization: 'Bearer sk-secret' },
  })
  assert.strictEqual(err.name, 'SubagentError')
  assert.strictEqual(err.message, 'boom')
  assert.strictEqual(err.agentId, 'agt_1')
  assert.strictEqual(err.failureKind, 'rate_limited')
  assert.strictEqual(err.apiKey, undefined)
  assert.strictEqual(err.headers, undefined)
  assert.ok(!JSON.stringify({ ...err, message: err.message }).includes('sk-secret'))
})

test('每个错误类都是 Error 且 name 固定', () => {
  const cases = [
    [new AgentTypeError('a', { typeName: 'x' }), 'AgentTypeError'],
    [new AgentGraphError('b', { nodeId: 'n1', cycle: ['n1', 'n2', 'n1'] }), 'AgentGraphError'],
    [new A2AError('c', { kind: 'malformed_frame', transport: 'local' }), 'A2AError'],
    [new WorktreeIsolationError('d', { reason: 'not_a_git_repo' }), 'WorktreeIsolationError'],
  ]
  for (const [err, name] of cases) {
    assert.ok(err instanceof Error)
    assert.strictEqual(err.name, name)
  }
})

test('AgentGraphError 的 cycle 被复制而非引用', () => {
  const cycle = ['n1', 'n2', 'n1']
  const err = new AgentGraphError('cycle', { cycle })
  cycle.push('mutated')
  assert.deepStrictEqual(err.cycle, ['n1', 'n2', 'n1'])
})

test('cause 被保留', () => {
  const root = new Error('root')
  assert.strictEqual(new SubagentError('wrapped', { cause: root }).cause, root)
})
