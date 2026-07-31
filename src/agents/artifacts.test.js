import test from 'node:test'
import assert from 'node:assert'
import { RuntimeHistory } from '../runtime-history.js'
import { ArtifactTrack, fnv1a32 } from './artifacts.js'

const A = { agentId: 'agt_1', agentName: 'explorer-1', nodeId: null, attempt: 1 }
const B = { agentId: 'agt_2', agentName: 'writer-1', nodeId: null, attempt: 1 }

test('fnv1a32 稳定、定长、内容敏感', () => {
  assert.strictEqual(fnv1a32('hello'), fnv1a32('hello'))
  assert.notStrictEqual(fnv1a32('hello'), fnv1a32('hello!'))
  assert.match(fnv1a32('hello'), /^[0-9a-f]{8}$/)
  assert.match(fnv1a32(''), /^[0-9a-f]{8}$/)
  assert.match(fnv1a32('中文内容'), /^[0-9a-f]{8}$/)
})

test('写入产生带归属的记录并落进 artifacts 轨', () => {
  const shared = new RuntimeHistory()
  const track = new ArtifactTrack({ sharedHistory: shared })
  const { ok, record, conflict } = track.write({
    ...A, key: 'docs/findings.md', kind: 'file', summary: '6 处问题', content: 'body',
  })
  assert.strictEqual(ok, true)
  assert.strictEqual(conflict, null)
  assert.strictEqual(record.agentName, 'explorer-1')
  assert.strictEqual(record.key, 'docs/findings.md')
  assert.strictEqual(record.sha, fnv1a32('body'))
  assert.strictEqual(record.bytes, 4)
  assert.match(record.artifactId, /^art_/)
  assert.strictEqual(shared.project('artifacts').length, 1)
})

test('同一 agent 重复写同一 key 不算冲突', () => {
  const track = new ArtifactTrack({ sharedHistory: new RuntimeHistory() })
  track.write({ ...A, key: 'k', kind: 'text', summary: 's', content: 'v1' })
  const second = track.write({ ...A, key: 'k', kind: 'text', summary: 's', content: 'v2' })
  assert.strictEqual(second.conflict, null)
  assert.strictEqual(second.ok, true)
})

test('另一个 agent 写同 key：warn 策略允许写入但报告 owner', () => {
  const track = new ArtifactTrack({ sharedHistory: new RuntimeHistory(), policy: 'warn' })
  track.write({ ...A, key: 'k', kind: 'text', summary: 's', content: 'v1' })
  const second = track.write({ ...B, key: 'k', kind: 'text', summary: 's', content: 'v2' })
  assert.strictEqual(second.ok, true)
  assert.strictEqual(second.conflict.ownerAgentName, 'explorer-1')
  assert.strictEqual(second.conflict.ownerSha, fnv1a32('v1'))
})

test('deny 策略下拒绝写入且轨道不增长', () => {
  const shared = new RuntimeHistory()
  const track = new ArtifactTrack({ sharedHistory: shared, policy: 'deny' })
  track.write({ ...A, key: 'k', kind: 'text', summary: 's', content: 'v1' })
  const second = track.write({ ...B, key: 'k', kind: 'text', summary: 's', content: 'v2' })
  assert.strictEqual(second.ok, false)
  assert.strictEqual(second.record, null)
  assert.ok(second.conflict)
  assert.strictEqual(shared.project('artifacts').length, 1)
})

test('显式 supersedes 指向对方最新版时不告警', () => {
  const track = new ArtifactTrack({ sharedHistory: new RuntimeHistory(), policy: 'deny' })
  const first = track.write({ ...A, key: 'k', kind: 'text', summary: 's', content: 'v1' })
  const second = track.write({
    ...B, key: 'k', kind: 'text', summary: 's', content: 'v2', supersedes: first.record.artifactId,
  })
  assert.strictEqual(second.ok, true)
  assert.strictEqual(second.conflict, null)
})

test('supersedes 指向过期版本仍算冲突', () => {
  const track = new ArtifactTrack({ sharedHistory: new RuntimeHistory() })
  const first = track.write({ ...A, key: 'k', kind: 'text', summary: 's', content: 'v1' })
  track.write({ ...A, key: 'k', kind: 'text', summary: 's', content: 'v2' })
  const third = track.write({
    ...B, key: 'k', kind: 'text', summary: 's', content: 'v3', supersedes: first.record.artifactId,
  })
  assert.ok(third.conflict, '引用的不是最新版，仍应告警')
})

test('轨道只追加：历史版本全部保留且有序', () => {
  const track = new ArtifactTrack({ sharedHistory: new RuntimeHistory() })
  track.write({ ...A, key: 'k', kind: 'text', summary: 's', content: 'v1' })
  track.write({ ...B, key: 'k', kind: 'text', summary: 's', content: 'v2' })
  const all = track.list({ key: 'k' })
  assert.strictEqual(all.length, 2)
  assert.strictEqual(all[0].sha, fnv1a32('v1'))
  assert.strictEqual(track.latest('k').sha, fnv1a32('v2'))
})

test('list 按 agentId / key / limit 过滤', () => {
  const track = new ArtifactTrack({ sharedHistory: new RuntimeHistory() })
  track.write({ ...A, key: 'k1', kind: 'text', summary: 's', content: 'a' })
  track.write({ ...B, key: 'k2', kind: 'text', summary: 's', content: 'b' })
  assert.strictEqual(track.list({ agentId: 'agt_1' }).length, 1)
  assert.strictEqual(track.list({ key: 'k2' })[0].agentName, 'writer-1')
  assert.strictEqual(track.list({ limit: 1 }).length, 1)
})

test('无 content 时 sha 由 path 派生，bytes 为 null', () => {
  const track = new ArtifactTrack({ sharedHistory: new RuntimeHistory() })
  const { record } = track.write({ ...A, key: 'k', kind: 'file', summary: 's', path: 'docs/x.md' })
  assert.strictEqual(record.sha, fnv1a32('path:docs/x.md'))
  assert.strictEqual(record.bytes, null)
})
