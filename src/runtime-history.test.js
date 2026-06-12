import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RuntimeHistory } from './runtime-history.js'

describe('RuntimeHistory core tracks', () => {
  it('stores complete events in all while projecting model and visible messages separately', () => {
    const history = new RuntimeHistory({ now: () => 1000 })

    history.appendMessage({ role: 'system', content: 'SP' })
    history.appendMessage({ role: 'user', content: 'hello' })
    history.appendMessage({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
    })
    history.appendMessage({ role: 'tool', tool_call_id: 'c1', name: 'lookup', content: 'raw tool result' })
    history.appendMessage({ role: 'assistant', content: 'final answer' })

    assert.equal(history.getEvents('all').length, 5)
    assert.deepEqual(
      history.projectMessages('model').map(m => m.role),
      ['system', 'user', 'assistant', 'tool', 'assistant'],
    )
    assert.deepEqual(
      history.projectMessages('visible').map(m => m.content),
      ['hello', 'final answer'],
    )
  })

  it('supports custom tracks without duplicating event storage', () => {
    const history = new RuntimeHistory({ now: () => 1000 })
    history.append({
      type: 'diagnostic',
      tracks: ['all', 'research'],
      meta: { purpose: 'research', note: 'n1' },
    })
    history.registerTrack('research', {
      description: 'Research notes',
      include: event => event.meta?.purpose === 'research',
    })

    assert.ok(history.listTracks().includes('research'))
    assert.equal(history.getEvents('research').length, 1)
    assert.equal(history.getEvents('research')[0].meta.note, 'n1')
    assert.equal(history.getEvents('all').length, 1)
  })

  it('rejects accidental overwrite of built-in tracks', () => {
    const history = new RuntimeHistory()
    assert.throws(
      () => history.registerTrack('model', { include: () => true }),
      /built-in track/,
    )
  })

  it('projects active topic model messages without deleting all history', () => {
    const history = new RuntimeHistory({ now: () => 1000 })
    history.setActiveTopic('alpha')
    history.appendMessage({ role: 'user', content: 'alpha question' })
    history.appendMessage({ role: 'assistant', content: 'alpha answer' })
    history.setActiveTopic('beta')
    history.appendMessage({ role: 'user', content: 'beta question' })

    assert.deepEqual(
      history.projectMessages('model', { topicId: 'beta' }).map(m => m.content),
      ['beta question'],
    )
    assert.equal(history.getEvents('all').length, 3)
  })

  it('uses latest summary event to hide covered model messages while preserving all events', () => {
    const history = new RuntimeHistory({ now: () => 1000 })
    const u1 = history.appendMessage({ role: 'user', content: 'old u' })
    const a1 = history.appendMessage({ role: 'assistant', content: 'old a' })
    history.appendSummary({
      content: 'old summary',
      sourceEventIds: [u1.id, a1.id],
    })
    history.appendMessage({ role: 'user', content: 'recent u' })

    const model = history.projectMessages('model', { includeSummary: true })
    assert.deepEqual(model.map(m => m.content), [
      '[Previous conversation summary]: old summary',
      'recent u',
    ])
    assert.equal(model[0]._isSummary, true)
    assert.equal(history.getEvents('all').length, 4)
  })

  it('stores artifact and file_change events on artifacts track', () => {
    const history = new RuntimeHistory({ now: () => 1000 })
    history.appendArtifact({ kind: 'plan', title: 'Plan', content: 'step 1' })
    history.append({
      type: 'file_change',
      path: '/tmp/a.txt',
      operation: 'update',
      source: 'tool',
      toolName: 'write_file',
      tracks: ['all', 'artifacts', 'internal'],
    })

    const artifacts = history.project('artifacts')
    assert.equal(artifacts.length, 2)
    assert.equal(artifacts[0].kind, 'plan')
    assert.equal(artifacts[1].path, '/tmp/a.txt')
  })
})
