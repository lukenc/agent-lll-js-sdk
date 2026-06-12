import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  SlidingWindowMemory,
  SummarizingMemory,
  TokenAwareMemory,
} from './memory.js'

describe('RuntimeHistory-backed Memory compatibility', () => {
  it('SlidingWindowMemory keeps public API while all track retains complete facts', () => {
    const mem = new SlidingWindowMemory(2)
    mem.add({ role: 'system', content: 'SP' })
    mem.add({ role: 'user', content: 'u1' })
    mem.add({ role: 'assistant', content: 'a1' })
    mem.add({ role: 'user', content: 'u2' })

    assert.deepEqual(mem.getMessages().map(m => m.content), ['SP', 'a1', 'u2'])
    assert.equal(mem.runtimeHistory.getEvents('all').length, 4)
    assert.equal(mem.size, 3)
  })

  it('TokenAwareMemory returns a safe projected suffix while preserving all events', () => {
    const mem = new TokenAwareMemory(4)
    mem.add({ role: 'system', content: 'SP' })
    mem.add({ role: 'user', content: 'x'.repeat(200) })
    mem.add({ role: 'assistant', content: 'short' })

    assert.deepEqual(mem.getMessages().map(m => m.content), ['SP', 'short'])
    assert.equal(mem.runtimeHistory.getEvents('all').length, 3)
  })

  it('legacy messages assignment rebuilds RuntimeHistory', () => {
    const mem = new SlidingWindowMemory(10)
    mem.messages = [
      { role: 'system', content: 'SP' },
      { role: 'user', content: 'assigned' },
    ]
    assert.deepEqual(mem.getMessages().map(m => m.content), ['SP', 'assigned'])
    assert.equal(mem.runtimeHistory.getEvents('all').length, 2)
  })

  it('legacy messages push syncs before reads', () => {
    const mem = new SlidingWindowMemory(10)
    mem.messages.push({ role: 'user', content: 'pushed' })
    assert.deepEqual(mem.getMessages(), [{ role: 'user', content: 'pushed' }])
    assert.equal(mem.runtimeHistory.getEvents('all').length, 1)
  })

  it('SummarizingMemory stores summary as event and preserves legacy projections', async () => {
    const mem = new SummarizingMemory({
      threshold: 3,
      keepRecent: 2,
      summarizer: async (text) => 'SUM:' + text.length,
    })
    for (let i = 0; i < 6; i++) mem.add({ role: 'user', content: 'u' + i })

    const history = await mem.getHistory()
    const summary = history.find(m => m._isSummary === true)
    assert.ok(summary)
    assert.ok(summary.content.startsWith('[Previous conversation summary]: SUM:'))
    assert.equal(mem.runtimeHistory.getEvents('all').filter(e => e.type === 'summary').length, 1)

    const wire = await mem.getMessages()
    assert.ok(wire.every(m => m._isSummary === undefined))
    assert.equal(wire.filter(m => m.role === 'system').length, 1)
  })

  it('SummarizingMemory includes previous summary on later summaries', async () => {
    const captured = []
    const mem = new SummarizingMemory({
      threshold: 2,
      keepRecent: 1,
      summarizer: async (text) => {
        captured.push(text)
        return 'S' + captured.length
      },
    })
    for (let i = 0; i < 4; i++) mem.add({ role: 'user', content: 'u' + i })
    await mem.getMessages()
    for (let i = 0; i < 4; i++) mem.add({ role: 'user', content: 'v' + i })
    await mem.getMessages()

    assert.equal(captured.length, 2)
    assert.ok(captured[1].includes('[Previous summary]'))
    assert.ok(captured[1].includes('S1'))
  })

  it('visible track excludes system summary and raw tool messages by default', async () => {
    const mem = new SummarizingMemory({
      threshold: 20,
      keepRecent: 2,
      summarizer: async () => 'unused',
    })
    mem.add({ role: 'system', content: 'SP' })
    mem.add({ role: 'user', content: 'question' })
    mem.add({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
    })
    mem.add({ role: 'tool', tool_call_id: 'c1', name: 'f', content: 'raw' })
    mem.add({ role: 'assistant', content: 'answer' })

    assert.deepEqual(
      mem.runtimeHistory.projectMessages('visible').map(m => m.content),
      ['question', 'answer'],
    )
  })
})
