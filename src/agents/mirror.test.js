import test from 'node:test'
import assert from 'node:assert'
import { RuntimeHistory } from '../runtime-history.js'
import { wrapMemoryForMirror, agentTrackName } from './mirror.js'

function fakeMemory() {
  const added = []
  return {
    added,
    add(msg) { added.push(msg) },
    async getMessages() { return added },
    someField: 42,
  }
}

test('add 先落 inner 再镜像进共享轨', () => {
  const shared = new RuntimeHistory()
  const inner = fakeMemory()
  const m = wrapMemoryForMirror(inner, { sharedHistory: shared, agentId: 'agt_1' })
  m.add({ role: 'user', content: 'hello' })
  assert.strictEqual(inner.added.length, 1)
  assert.strictEqual(shared.size, 1)
  const [event] = shared.getEvents('all')
  assert.strictEqual(event.topicId, 'agt_1')
  assert.ok(event.tracks.includes('internal'))
  assert.ok(event.tracks.includes(agentTrackName('agt_1')))
})

test('子 agent 的消息不进 model 轨（不污染主 agent 的对话投影）', () => {
  const shared = new RuntimeHistory()
  const m = wrapMemoryForMirror(fakeMemory(), { sharedHistory: shared, agentId: 'agt_1' })
  m.add({ role: 'user', content: 'child message' })
  m.add({ role: 'assistant', content: 'child reply' })
  assert.strictEqual(shared.getEvents('model').length, 0)
  assert.strictEqual(shared.projectMessages('model').length, 0)
})

test('回归：摘要消息也不能进 model 轨', () => {
  // RuntimeHistory.appendMessage 遇到 _isSummary 会转调 appendSummary，
  // 而那条路径不透传 meta.tracks，tracks 会落回默认值 ['all','model','internal']。
  // mirror 必须自己判断并直接调 appendSummary。
  const shared = new RuntimeHistory()
  const m = wrapMemoryForMirror(fakeMemory(), { sharedHistory: shared, agentId: 'agt_1' })
  m.add({ role: 'system', content: '[Previous conversation summary]: child compacted', _isSummary: true })
  const events = shared.getEvents('all')
  assert.strictEqual(events.length, 1)
  assert.strictEqual(events[0].type, 'summary')
  assert.ok(!events[0].tracks.includes('model'), '子 agent 摘要泄进了 model 轨')
  assert.strictEqual(events[0].topicId, 'agt_1')
})

test('其余属性与方法透传 inner', async () => {
  const inner = fakeMemory()
  const m = wrapMemoryForMirror(inner, { sharedHistory: new RuntimeHistory(), agentId: 'agt_1' })
  m.add({ role: 'user', content: 'x' })
  assert.strictEqual(m.someField, 42)
  assert.deepStrictEqual(await m.getMessages(), inner.added)
})

test('sharedHistory 为 null 时退化为纯透传', () => {
  const inner = fakeMemory()
  const m = wrapMemoryForMirror(inner, { sharedHistory: null, agentId: 'agt_1' })
  m.add({ role: 'user', content: 'x' })
  assert.strictEqual(inner.added.length, 1)
})

test('镜像写入失败不影响子 agent 自己的 memory', () => {
  const broken = { appendMessage() { throw new Error('disk on fire') }, appendSummary() { throw new Error('nope') } }
  const inner = fakeMemory()
  const m = wrapMemoryForMirror(inner, { sharedHistory: broken, agentId: 'agt_1' })
  m.add({ role: 'user', content: 'x' })
  assert.strictEqual(inner.added.length, 1, '镜像失败不该阻断子 agent')
})
