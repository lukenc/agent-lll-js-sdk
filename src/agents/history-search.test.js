import test from 'node:test'
import assert from 'node:assert'
import { RuntimeHistory } from '../runtime-history.js'
import { searchHistory, getHistoryEvent, MAX_SNIPPET } from './history-search.js'

function seed() {
  const h = new RuntimeHistory()
  // 注意：匹配是大小写不敏感的，所以 fixture 里刻意只让 user 那条含 "oauth"
  // 字样，assistant / tool 两条改用别的词 —— 否则 "命中 1 条" 与 "role 过滤后
  // 0 条" 这两个断言会互相矛盾（三条都会命中）。
  h.appendMessage({ role: 'user', content: '帮我看看 OAuth 回调的实现' })
  h.appendMessage({ role: 'assistant', content: '我先读 src/auth/callback.js' })
  h.appendMessage({ role: 'tool', name: 'read_file', content: 'export function handleCallback() { /* 回调入口 */ }' })
  h.appendMessage({ role: 'user', content: '换个话题：数据库迁移' }, { topicId: 'agt_1', tracks: ['all', 'internal'] })
  return h
}

test('子串命中，返回 eventId 与片段', () => {
  const hits = searchHistory(seed(), { query: 'OAuth' })
  assert.strictEqual(hits.length, 1)
  assert.ok(hits[0].eventId)
  assert.strictEqual(hits[0].role, 'user')
  assert.ok(hits[0].snippet.includes('OAuth'))
  assert.ok(hits[0].ts > 0)
})

test('大小写不敏感', () => {
  // fixture 里只有 user 那条含 "OAuth"；用全小写查也应命中它。
  const hits = searchHistory(seed(), { query: 'oauth' })
  assert.strictEqual(hits.length, 1)
  assert.strictEqual(hits[0].role, 'user')
})

test('regex 模式', () => {
  const hits = searchHistory(seed(), { query: 'handle[A-Z]\\w+', regex: true })
  assert.strictEqual(hits.length, 1)
  assert.ok(hits[0].snippet.includes('handleCallback'))
})

test('非法正则降级为子串且不抛', () => {
  const hits = searchHistory(seed(), { query: '(unclosed', regex: true })
  assert.deepStrictEqual(hits, [])
})

test('按 agentId 过滤（topicId）', () => {
  const hits = searchHistory(seed(), { query: '迁移', agentId: 'agt_1' })
  assert.strictEqual(hits.length, 1)
  assert.strictEqual(hits[0].agentId, 'agt_1')
  assert.strictEqual(searchHistory(seed(), { query: '迁移', agentId: 'agt_other' }).length, 0)
})

test('按 role 过滤', () => {
  // "callback" 在 assistant（src/auth/callback.js）与 tool（handleCallback）
  // 两条里都出现，正好用来验证 role 过滤真的在起作用。
  assert.strictEqual(searchHistory(seed(), { query: 'callback' }).length, 2)
  assert.strictEqual(searchHistory(seed(), { query: 'callback', role: 'tool' }).length, 1)
  assert.strictEqual(searchHistory(seed(), { query: 'callback', role: 'assistant' }).length, 1)
  assert.strictEqual(searchHistory(seed(), { query: 'callback', role: 'user' }).length, 0)
})

test('limit 生效，默认 20', () => {
  const h = new RuntimeHistory()
  for (let i = 0; i < 30; i++) h.appendMessage({ role: 'user', content: `needle ${i}` })
  assert.strictEqual(searchHistory(h, { query: 'needle' }).length, 20)
  assert.strictEqual(searchHistory(h, { query: 'needle', limit: 3 }).length, 3)
})

test('片段被截断到 MAX_SNIPPET', () => {
  const h = new RuntimeHistory()
  h.appendMessage({ role: 'user', content: `${'x'.repeat(2000)}needle${'y'.repeat(2000)}` })
  const [hit] = searchHistory(h, { query: 'needle' })
  assert.ok(hit.snippet.length <= MAX_SNIPPET)
  assert.ok(hit.snippet.includes('needle'))
})

test('被 summary 压缩过的原始事件仍可检出（找回记忆）', () => {
  const h = new RuntimeHistory()
  const e1 = h.appendMessage({ role: 'user', content: '早期的关键决定：用 JWT 不用 session' })
  h.appendMessage({ role: 'assistant', content: '好的' })
  h.appendSummary({ content: '讨论了鉴权方案', sourceEventIds: [e1.id] })
  // 投影里原事件已被摘要覆盖
  assert.ok(!h.projectMessages('model').some(m => String(m.content).includes('JWT')))
  // 但检索仍能找到
  const hits = searchHistory(h, { query: 'JWT' })
  assert.strictEqual(hits.length, 1)
})

test('getHistoryEvent 展开前后文，受 MAX_CONTEXT 限制', () => {
  const h = new RuntimeHistory()
  const ids = []
  for (let i = 0; i < 25; i++) ids.push(h.appendMessage({ role: 'user', content: `m${i}` }).id)
  const got = getHistoryEvent(h, { eventId: ids[12], before: 2, after: 3 })
  assert.strictEqual(got.target.message.content, 'm12')
  assert.deepStrictEqual(got.before.map(e => e.message.content), ['m10', 'm11'])
  assert.deepStrictEqual(got.after.map(e => e.message.content), ['m13', 'm14', 'm15'])

  const clamped = getHistoryEvent(h, { eventId: ids[12], before: 999, after: 999 })
  assert.strictEqual(clamped.before.length, 10)
  assert.strictEqual(clamped.after.length, 10)
})

test('getHistoryEvent 未知 id 返回 null', () => {
  assert.strictEqual(getHistoryEvent(seed(), { eventId: 'nope' }), null)
})
