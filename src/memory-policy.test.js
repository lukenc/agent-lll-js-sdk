import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  adjustCutPointForToolPairs,
  sliceWithoutOrphanTools,
  projectSummaryForWire,
  SlidingWindowPolicy,
  TokenBudgetPolicy,
  SummaryPolicy,
  estimateMessageTokens,
} from './memory-policy.js'

function toolGroup() {
  return [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', name: 'f', content: 'result' },
  ]
}

describe('memory-policy helpers', () => {
  it('pulls assistant(tool_calls) back when a slice would start at tool', () => {
    const messages = [{ role: 'user', content: 'u' }, ...toolGroup()]
    assert.equal(adjustCutPointForToolPairs(messages, 2), 1)
    assert.deepEqual(sliceWithoutOrphanTools(messages, 2).map(m => m.role), ['assistant', 'tool'])
  })

  it('strips malformed leading orphan tool messages', () => {
    const messages = [
      { role: 'user', content: 'u' },
      { role: 'tool', tool_call_id: 'ghost', content: 'r' },
      { role: 'assistant', content: 'ok' },
    ]
    assert.deepEqual(sliceWithoutOrphanTools(messages, 1).map(m => m.role), ['assistant'])
  })

  it('merges summary system messages for wire projection and strips _isSummary', () => {
    const out = projectSummaryForWire([
      { role: 'system', content: 'SP' },
      { role: 'system', content: '[Previous conversation summary]: S', _isSummary: true },
      { role: 'user', content: 'u' },
    ])
    assert.equal(out.filter(m => m.role === 'system').length, 1)
    assert.ok(out[0].content.includes('SP'))
    assert.ok(out[0].content.includes('S'))
    assert.ok(out.every(m => m._isSummary === undefined))
  })

  it('SlidingWindowPolicy keeps recent non-system messages and preserves tool groups', () => {
    const policy = new SlidingWindowPolicy(1)
    const out = policy.apply([
      { role: 'system', content: 'SP' },
      { role: 'user', content: 'old' },
      ...toolGroup(),
    ])
    assert.deepEqual(out.map(m => m.role), ['system', 'assistant', 'tool'])
  })

  it('TokenBudgetPolicy keeps a valid suffix under tight budget', () => {
    const policy = new TokenBudgetPolicy(3)
    const out = policy.apply([
      { role: 'system', content: 'SP' },
      { role: 'user', content: 'x'.repeat(200) },
      ...toolGroup(),
      { role: 'user', content: 'hi' },
    ])
    assert.ok(out[0].role === 'system')
    assert.ok(out.slice(1).every((m, i, arr) => {
      if (m.role !== 'tool') return true
      return arr.slice(0, i).some(prev =>
        prev.role === 'assistant'
        && Array.isArray(prev.tool_calls)
        && prev.tool_calls.some(tc => tc.id === m.tool_call_id)
      )
    }))
  })

  it('SummaryPolicy plans old source ids and recent messages', () => {
    const policy = new SummaryPolicy({ threshold: 3, keepRecent: 2 })
    const events = [
      { id: 'e1', type: 'message', message: { role: 'user', content: 'u1' } },
      { id: 'e2', type: 'message', message: { role: 'assistant', content: 'a1' } },
      { id: 'e3', type: 'message', message: { role: 'user', content: 'u2' } },
      { id: 'e4', type: 'message', message: { role: 'assistant', content: 'a2' } },
    ]
    const plan = policy.plan(events, null)
    assert.deepEqual(plan.sourceEventIds, ['e1', 'e2'])
    assert.deepEqual(plan.keepMessages.map(m => m.content), ['u2', 'a2'])
    assert.ok(plan.text.includes('[user]: u1'))
    assert.ok(plan.text.includes('[assistant]: a1'))
  })

  it('estimateMessageTokens uses current chars-per-token heuristic', () => {
    assert.equal(estimateMessageTokens({ role: 'user', content: '12345' }), 2)
  })
})
