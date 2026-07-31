import test from 'node:test'
import assert from 'node:assert'
import { AskRegistry } from './ask.js'

const who = (n) => ({
  agentId: `agt_${n}`, agentName: `explorer-${n}`, parentAgentId: 'main',
  nodeId: null, taskDescription: `task ${n}`,
})

test('提问登记归属，回答定向送回', async () => {
  const reg = new AskRegistry({})
  const p1 = reg.ask({ ...who(1), question: '用哪个数据库？' })
  const p2 = reg.ask({ ...who(2), question: '要不要加索引？' })

  const pending = reg.pending()
  assert.strictEqual(pending.length, 2)
  assert.strictEqual(pending[0].agentName, 'explorer-1')
  assert.strictEqual(pending[0].question, '用哪个数据库？')
  assert.ok(pending[0].askId)

  // 乱序回答：先答第二个
  assert.strictEqual(reg.answer(pending[1].askId, 'PostgreSQL 加索引'), true)
  assert.strictEqual(await p2, 'PostgreSQL 加索引')
  assert.strictEqual(reg.answer(pending[0].askId, '用 Postgres'), true)
  assert.strictEqual(await p1, '用 Postgres')
  assert.strictEqual(reg.pending().length, 0)
})

test('pending 快照不含函数，可安全序列化', () => {
  const reg = new AskRegistry({})
  reg.ask({ ...who(1), question: 'q' })
  const [record] = reg.pending()
  assert.doesNotThrow(() => JSON.stringify(record))
  assert.strictEqual(record.resolve, undefined)
  assert.strictEqual(record.state, 'pending')
})

test('重复回答同一 askId 是 no-op，不抛错', async () => {
  const reg = new AskRegistry({})
  const p = reg.ask({ ...who(1), question: 'q' })
  const [{ askId }] = reg.pending()
  assert.strictEqual(reg.answer(askId, 'first'), true)
  assert.strictEqual(reg.answer(askId, 'second'), false)
  assert.strictEqual(await p, 'first')
})

test('settle 自身幂等 —— 拿着 record 引用重复 settle 也只有第一次算', async () => {
  const reg = new AskRegistry({})
  const p = reg.ask({ ...who(1), question: 'q' })
  const [{ askId }] = reg.pending()
  // 直接拿内部 record：这是"先到先赢"的真正闸门所在，两条应答通道、超时与取消
  // 全部经过它，绕过 _pending 那道门也不能让迟到者覆盖已交付的回答。
  const { settle } = reg._pending.get(askId)
  assert.strictEqual(settle('first'), true)
  assert.strictEqual(settle('second'), false)
  assert.strictEqual(await p, 'first')
})

test('未知 askId 回答返回 false', () => {
  assert.strictEqual(new AskRegistry({}).answer('nope', 'x'), false)
})

test('null/undefined 不算回答，提问继续挂着', async () => {
  const reg = new AskRegistry({})
  const p = reg.ask({ ...who(1), question: 'q' })
  const [{ askId }] = reg.pending()
  assert.strictEqual(reg.answer(askId, undefined), false)
  assert.strictEqual(reg.answer(askId, null), false)
  assert.strictEqual(reg.pending().length, 1)
  // 空字符串是**合法**回答（"没有偏好"也是一种回答）
  assert.strictEqual(reg.answer(askId, ''), true)
  assert.strictEqual(await p, '')
})

test('cancel 让等待方拿到取消说明而不是挂死', async () => {
  const reg = new AskRegistry({})
  const p = reg.ask({ ...who(1), question: 'q' })
  const [{ askId }] = reg.pending()
  reg.cancel(askId, 'agent cancelled')
  const result = await p
  assert.match(result, /cancelled/i)
  assert.match(result, /agent cancelled/)
})

test('cancelAll 清空并返回条数', async () => {
  const reg = new AskRegistry({})
  const ps = [reg.ask({ ...who(1), question: 'a' }), reg.ask({ ...who(2), question: 'b' })]
  assert.strictEqual(reg.cancelAll('shutting down'), 2)
  for (const p of ps) assert.match(await p, /cancelled/i)
  assert.strictEqual(reg.pending().length, 0)
})

test('cancelByAgent 只取消指定 agent 的提问，别人的照旧挂着', async () => {
  const reg = new AskRegistry({})
  const mine = reg.ask({ ...who(1), question: 'a' })
  reg.ask({ ...who(2), question: 'b' })
  assert.strictEqual(reg.cancelByAgent('agt_1', 'agent cancelled'), 1)
  assert.match(await mine, /agent cancelled/)
  const left = reg.pending()
  assert.strictEqual(left.length, 1)
  assert.strictEqual(left[0].agentId, 'agt_2')
  // 已经没有它的提问了，再取消返回 0
  assert.strictEqual(reg.cancelByAgent('agt_1', 'again'), 0)
  reg.cancelAll('cleanup')
})

test('timeoutMs 到点后返回未回答说明', async () => {
  const reg = new AskRegistry({ timeoutMs: 30 })
  const answer = await reg.ask({ ...who(1), question: 'q' })
  assert.match(answer, /did not answer|未在/i)
  assert.strictEqual(reg.pending().length, 0)
})

test('emit 了 ask.user 与 ask.answered，且 answered 标注来源', async () => {
  const events = []
  const reg = new AskRegistry({ emit: (type, payload) => events.push({ type, payload }) })
  const p = reg.ask({ ...who(1), question: 'q' })
  const [{ askId }] = reg.pending()
  reg.answer(askId, 'a', { via: 'api' })
  await p
  assert.strictEqual(events[0].type, 'ask.user')
  assert.strictEqual(events[0].payload.agentName, 'explorer-1')
  assert.strictEqual(events[1].type, 'ask.answered')
  assert.strictEqual(events[1].payload.via, 'api')
})

test('onStateChange 在提问/回答时报告 waiting_input 切换', async () => {
  const changes = []
  const reg = new AskRegistry({ onStateChange: (agentId, waiting) => changes.push([agentId, waiting]) })
  const p = reg.ask({ ...who(1), question: 'q' })
  assert.deepStrictEqual(changes[0], ['agt_1', true])
  reg.answer(reg.pending()[0].askId, 'a')
  await p
  assert.deepStrictEqual(changes[1], ['agt_1', false])
})

test('onQuestion 通道的回答与 answer() 竞速，先到先赢', async () => {
  let release
  const reg = new AskRegistry({
    onQuestion: () => new Promise((resolve) => { release = resolve }),
  })
  const p = reg.ask({ ...who(1), question: 'q' })
  const [{ askId }] = reg.pending()
  assert.strictEqual(reg.answer(askId, 'from api'), true)
  release('from hook')
  assert.strictEqual(await p, 'from api')
  // 迟到的 hook 回答是 no-op，不抛、不覆盖
  await new Promise(resolve => setImmediate(resolve))
  assert.strictEqual(reg.pending().length, 0)
})

test('onQuestion 拿到 meta（含 askId 与归属），返回值即回答', async () => {
  let seen = null
  const reg = new AskRegistry({
    onQuestion: (question, meta) => { seen = { question, meta }; return 'via hook' },
  })
  assert.strictEqual(await reg.ask({ ...who(7), question: 'pick one' }), 'via hook')
  assert.strictEqual(seen.question, 'pick one')
  assert.ok(seen.meta.askId)
  assert.strictEqual(seen.meta.agentId, 'agt_7')
  assert.strictEqual(seen.meta.agentName, 'explorer-7')
  assert.strictEqual(seen.meta.taskDescription, 'task 7')
  assert.strictEqual(seen.meta.settle, undefined)
})

test('onQuestion 返回 null/undefined 不算回答，问题继续挂着等 API', async () => {
  const reg = new AskRegistry({ onQuestion: () => undefined })
  const p = reg.ask({ ...who(1), question: 'q' })
  await new Promise(resolve => setImmediate(resolve))
  const pending = reg.pending()
  assert.strictEqual(pending.length, 1)
  assert.strictEqual(reg.answer(pending[0].askId, 'later'), true)
  assert.strictEqual(await p, 'later')
})

test('onQuestion 抛错时提问被取消，等待方不挂死', async () => {
  const events = []
  const reg = new AskRegistry({
    emit: (type, payload) => events.push({ type, payload }),
    onQuestion: async () => { throw new Error('ui exploded') },
  })
  const result = await reg.ask({ ...who(1), question: 'q' })
  assert.match(result, /cancelled/i)
  assert.match(result, /ui exploded/)
  assert.strictEqual(reg.pending().length, 0)
  assert.ok(events.some(e => e.type === 'ask.cancelled'))
})
