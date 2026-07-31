import test from 'node:test'
import assert from 'node:assert'
import { AgentRegistry } from './registry.js'

const base = { type: 'general-purpose', description: 'd', parentAgentId: 'main', depth: 1, model: null }

test('agentId 唯一，name 按类型递增', () => {
  const r = new AgentRegistry()
  const a = r.create(base)
  const b = r.create(base)
  assert.notStrictEqual(a.agentId, b.agentId)
  assert.strictEqual(a.name, 'general-purpose-1')
  assert.strictEqual(b.name, 'general-purpose-2')
  assert.match(a.agentId, /^agt_[0-9a-f]{8}$/)
})

test('突发创建不产生 agentId 碰撞（时钟静止也不行）', () => {
  // 回归测试：曾用 (now() & 0xffffff) * 256 + (SEQ & 0xff) 生成 id，只给计数器
  // 留 8 位 —— 同一毫秒内第 257 个 agent 静默覆盖第 1 个，`_byId` 里早先那个
  // handle 再也查不到且不报错。图调度器一次物化多个节点就能触发。
  const r = new AgentRegistry({ now: () => 1700000000000 })
  const ids = new Set()
  const handles = []
  for (let i = 0; i < 1000; i++) {
    const h = r.create(base)
    ids.add(h.agentId)
    handles.push(h)
  }
  assert.strictEqual(ids.size, 1000, 'agentId 必须互不相同')
  assert.strictEqual(r.list({ includeFinished: true }).length, 1000, '不能有 handle 被静默覆盖')
  for (const h of handles) assert.strictEqual(r.get(h.agentId), h)
})

test('不同类型各自计数', () => {
  const r = new AgentRegistry()
  assert.strictEqual(r.create({ ...base, type: 'explorer' }).name, 'explorer-1')
  assert.strictEqual(r.create({ ...base, type: 'writer' }).name, 'writer-1')
  assert.strictEqual(r.create({ ...base, type: 'explorer' }).name, 'explorer-2')
})

test('get 支持 agentId 与 name', () => {
  const r = new AgentRegistry()
  const a = r.create(base)
  assert.strictEqual(r.get(a.agentId), a)
  assert.strictEqual(r.get('general-purpose-1'), a)
  assert.strictEqual(r.get('nope'), null)
})

test('list 默认只给未终态，includeFinished 给全部', () => {
  const r = new AgentRegistry()
  const a = r.create(base)
  const b = r.create(base)
  a.transition('queued'); a.transition('running'); a.transition('succeeded')
  r.settle(a)
  assert.deepStrictEqual(r.list().map(h => h.name), ['general-purpose-2'])
  assert.strictEqual(r.list({ includeFinished: true }).length, 2)
  assert.ok(b)
})

test('槽位：超出 maxConcurrent 的请求排队，释放后 FIFO 放行', async () => {
  const r = new AgentRegistry({ maxConcurrent: 2 })
  const r1 = await r.acquireSlot(1)
  const r2 = await r.acquireSlot(1)
  assert.strictEqual(r.slotsInUse(1), 2)

  let thirdGranted = false
  const third = r.acquireSlot(1).then(release => { thirdGranted = true; return release })
  await new Promise(resolve => setImmediate(resolve))
  assert.strictEqual(thirdGranted, false, '槽满时不应立即放行')

  r1()
  const release3 = await third
  assert.strictEqual(thirdGranted, true)
  r2(); release3()
  assert.strictEqual(r.slotsInUse(1), 0)
})

test('槽位按 depth 分层：depth 1 占满不阻塞 depth 2（防父等孙死锁）', async () => {
  const r = new AgentRegistry({ maxConcurrent: 1 })
  const releaseDepth1 = await r.acquireSlot(1)
  // depth 1 已满。若共用槽池，下面这句会永远挂起。
  const releaseDepth2 = await Promise.race([
    r.acquireSlot(2),
    new Promise((_, reject) => setTimeout(() => reject(new Error('deadlock: depth 2 被 depth 1 阻塞')), 200)),
  ])
  assert.strictEqual(r.slotsInUse(1), 1)
  assert.strictEqual(r.slotsInUse(2), 1)
  releaseDepth1(); releaseDepth2()
})

test('释放函数幂等', async () => {
  const r = new AgentRegistry({ maxConcurrent: 1 })
  const release = await r.acquireSlot(1)
  release(); release()
  assert.strictEqual(r.slotsInUse(1), 0)
})

test('acquireSlot 支持 abort', async () => {
  const r = new AgentRegistry({ maxConcurrent: 1 })
  const release = await r.acquireSlot(1)
  const ac = new AbortController()
  const pending = r.acquireSlot(1, { signal: ac.signal })
  ac.abort()
  await assert.rejects(pending, (err) => err.name === 'AbortError')
  release()
})

test('完成态超过 retainCompleted 时最旧的被淘汰上下文', () => {
  const r = new AgentRegistry({ retainCompleted: 2 })
  const made = []
  for (let i = 0; i < 3; i++) {
    const h = r.create(base)
    h._child = { fake: 'agent instance' }
    h.transition('queued'); h.transition('running'); h.transition('succeeded')
    r.settle(h)
    made.push(h)
  }
  assert.strictEqual(r.evicted(made[0].agentId), true)
  assert.strictEqual(made[0]._child, null)
  assert.strictEqual(r.evicted(made[2].agentId), false)
  assert.ok(made[2]._child)
  // handle 本身仍可查
  assert.ok(r.get(made[0].agentId))
})
