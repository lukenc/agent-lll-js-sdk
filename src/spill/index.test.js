/**
 * spill 存储层测试 —— 契约见 docs/dsh-diff/CONTRACT-NOTES.md 的 B/C 节。
 *
 * Node 后端的安全措施（私有目录、独占创建、路径段编码）对齐 dsh 的
 * spill-local.spec.ts；内存后端是浏览器 IndexedDB 后端的可测替身，
 * 两者共用同一套 SpillStore 契约测试。
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert'
import { rm, stat, readFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  encodeSegment,
  MemorySpillStore,
  createNodeSpillStore,
  SpillError,
} from './index.js'

// ---- C 节：路径段编码 ----

describe('encodeSegment（C 节）', () => {
  test('安全字符原样保留', () => {
    assert.equal(encodeSegment('abcXYZ019._-'), 'abcXYZ019._-')
  })

  test('分隔符和波浪号被转义', () => {
    assert.equal(encodeSegment('a/b'), 'a~002Fb')
    assert.equal(encodeSegment('a\\b'), 'a~005Cb')
    assert.equal(encodeSegment('a~b'), 'a~007Eb')
    assert.equal(encodeSegment('a\0b'), 'a~0000b')
  })

  test('整段的 . 和 .. 被转义，无法穿越目录', () => {
    assert.equal(encodeSegment('.'), '~002E')
    assert.equal(encodeSegment('..'), '~002E~002E')
    // 但普通名字里的点是字面量
    assert.equal(encodeSegment('a.txt'), 'a.txt')
  })

  test('空串编码成非空段', () => {
    assert.equal(encodeSegment(''), '~')
  })

  test('编码是单射的：不同输入不会撞名', () => {
    const inputs = ['a/b', 'a~002Fb', '~', '', '.', '..', 'a b', '中文.txt']
    const encoded = inputs.map(encodeSegment)
    assert.equal(new Set(encoded).size, inputs.length, '编码后仍应两两不同')
  })

  test('编码结果永远是单个安全路径段', () => {
    for (const raw of ['../../etc/passwd', 'a/b/c', '/abs/path', 'C:\\x']) {
      const e = encodeSegment(raw)
      assert.ok(!e.includes('/'), `${e} 不应含 /`)
      assert.ok(!e.includes('\\'), `${e} 不应含反斜杠`)
      assert.notEqual(e, '.')
      assert.notEqual(e, '..')
    }
  })
})

// ---- 两种后端共用的契约测试 ----

function contractTests(name, makeStore) {
  describe(`${name} —— SpillStore 契约`, () => {
    test('保存后能原样读回', async () => {
      const store = await makeStore()
      const ref = await store.saveText({
        sessionId: 's1', toolName: 'shell_exec', callId: 'c1', content: 'hello 世界',
      })
      assert.ok(ref.locator, '应返回 locator')
      assert.equal(ref.bytes, Buffer.byteLength('hello 世界', 'utf8'))
      assert.ok(ref.retrievalHint, '应返回取回提示')
      assert.equal(await store.readText(ref.locator), 'hello 世界')
    })

    test('分段读取：offset + limit 边界不重不漏', async () => {
      const store = await makeStore()
      const body = 'abcdefghij'
      const ref = await store.saveText({ sessionId: 's1', toolName: 't', callId: 'c', content: body })

      assert.equal(await store.readText(ref.locator, { offset: 0, limit: 4 }), 'abcd')
      assert.equal(await store.readText(ref.locator, { offset: 4, limit: 4 }), 'efgh')
      assert.equal(await store.readText(ref.locator, { offset: 8, limit: 4 }), 'ij')
      // 拼起来必须等于原文
      const parts = []
      for (let o = 0; o < 10; o += 3) parts.push(await store.readText(ref.locator, { offset: o, limit: 3 }))
      assert.equal(parts.join(''), body)
    })

    test('offset 超出末尾返回空串，不抛', async () => {
      const store = await makeStore()
      const ref = await store.saveText({ sessionId: 's1', toolName: 't', callId: 'c', content: 'abc' })
      assert.equal(await store.readText(ref.locator, { offset: 999, limit: 10 }), '')
    })

    test('分段读取不会切坏多字节字符', async () => {
      const store = await makeStore()
      // '中' 是 3 字节，从第 1 字节处切
      const ref = await store.saveText({ sessionId: 's1', toolName: 't', callId: 'c', content: '中文测试' })
      const part = await store.readText(ref.locator, { offset: 1, limit: 4 })
      assert.ok(!part.includes('\uFFFD'), `不应出现替换字符，实得 ${JSON.stringify(part)}`)
    })

    test('读取不存在的 locator 抛 SpillError', async () => {
      const store = await makeStore()
      await assert.rejects(() => store.readText('spill://nonexistent'), SpillError)
    })

    test('同一会话保存两次同名内容，locator 不同', async () => {
      const store = await makeStore()
      const a = await store.saveText({ sessionId: 's1', toolName: 't', callId: 'c1', content: 'A' })
      const b = await store.saveText({ sessionId: 's1', toolName: 't', callId: 'c2', content: 'B' })
      assert.notEqual(a.locator, b.locator)
      assert.equal(await store.readText(a.locator), 'A')
      assert.equal(await store.readText(b.locator), 'B')
    })

    test('clear 之后读不到了', async () => {
      const store = await makeStore()
      const ref = await store.saveText({ sessionId: 's1', toolName: 't', callId: 'c', content: 'x' })
      await store.clear('s1')
      await assert.rejects(() => store.readText(ref.locator), SpillError)
    })

    test('clear 只清指定会话，不影响别的会话', async () => {
      const store = await makeStore()
      const a = await store.saveText({ sessionId: 'sA', toolName: 't', callId: 'c', content: 'A' })
      const b = await store.saveText({ sessionId: 'sB', toolName: 't', callId: 'c', content: 'B' })
      await store.clear('sA')
      await assert.rejects(() => store.readText(a.locator), SpillError)
      assert.equal(await store.readText(b.locator), 'B', 'sB 的内容不应被清掉')
    })

    test('空内容也能存能读', async () => {
      const store = await makeStore()
      const ref = await store.saveText({ sessionId: 's1', toolName: 't', callId: 'c', content: '' })
      assert.equal(ref.bytes, 0)
      assert.equal(await store.readText(ref.locator), '')
    })
  })
}

contractTests('MemorySpillStore', async () => new MemorySpillStore())

let nodeRoot
before(async () => { nodeRoot = await mkdtemp(join(tmpdir(), 'lll-spill-test-')) })
after(async () => { if (nodeRoot) await rm(nodeRoot, { recursive: true, force: true }) })

contractTests('NodeSpillStore', async () => createNodeSpillStore({ root: nodeRoot }))

// ---- C 节：Node 后端专有的安全措施 ----

describe('NodeSpillStore 安全措施（C 节）', () => {
  test('会话目录按 sessionId 哈希命名，且稳定', async () => {
    const store = createNodeSpillStore({ root: nodeRoot })
    const a = await store.saveText({ sessionId: 'sess-x', toolName: 't', callId: 'c', content: '1' })
    const b = await store.saveText({ sessionId: 'sess-x', toolName: 't', callId: 'c', content: '2' })
    const dirA = store._pathOf(a.locator).replace(/\/[^/]+$/, '')
    const dirB = store._pathOf(b.locator).replace(/\/[^/]+$/, '')
    assert.equal(dirA, dirB, '同一会话应落在同一目录')
    assert.match(dirA, /session-[0-9a-f]{12}$/, '目录名应是 session-<12位hex>')
  })

  test('目录 0700、文件 0600（仅属主可读写）', async () => {
    const store = createNodeSpillStore({ root: nodeRoot })
    const ref = await store.saveText({ sessionId: 'perm', toolName: 't', callId: 'c', content: 'x' })
    const filePath = store._pathOf(ref.locator)
    const dirPath = filePath.replace(/\/[^/]+$/, '')
    assert.equal((await stat(filePath)).mode & 0o777, 0o600)
    assert.equal((await stat(dirPath)).mode & 0o777, 0o700)
  })

  test('文件名带随机前缀，不可预测', async () => {
    const store = createNodeSpillStore({ root: nodeRoot })
    const a = await store.saveText({ sessionId: 'rnd', toolName: 'tool', callId: 'c', content: 'A' })
    const b = await store.saveText({ sessionId: 'rnd', toolName: 'tool', callId: 'c', content: 'B' })
    const nameA = store._pathOf(a.locator).split('/').pop()
    const nameB = store._pathOf(b.locator).split('/').pop()
    assert.notEqual(nameA, nameB, '两次保存文件名必须不同')
    assert.match(nameA, /^[0-9a-f]{12}-tool\.txt$/)
  })

  test('穿越形状的工具名被消毒成单个路径段', async () => {
    const store = createNodeSpillStore({ root: nodeRoot })
    const ref = await store.saveText({
      sessionId: 'trav', toolName: '../../etc/passwd', callId: 'c', content: 'safe',
    })
    const p = store._pathOf(ref.locator)
    assert.ok(p.startsWith(nodeRoot), '路径必须仍在 root 下')
    assert.ok(!p.includes('/../'), '不应含穿越片段')
    assert.equal(await store.readText(ref.locator), 'safe')
  })

  test('内容按 UTF-8 原样落盘', async () => {
    const store = createNodeSpillStore({ root: nodeRoot })
    const body = '第一行\n第二行\ttab'
    const ref = await store.saveText({ sessionId: 'enc', toolName: 't', callId: 'c', content: body })
    assert.equal(await readFile(store._pathOf(ref.locator), 'utf8'), body)
  })

  test('root 不可写时 saveText 抛错（由策略层负责降级）', async () => {
    const store = createNodeSpillStore({ root: '/nonexistent-root-xyz/deep' })
    await assert.rejects(() => store.saveText({ sessionId: 's', toolName: 't', callId: 'c', content: 'x' }))
  })
})

// ---- 内存后端专有 ----

describe('MemorySpillStore 容量控制', () => {
  test('超过条目上限时淘汰最旧的', async () => {
    const store = new MemorySpillStore({ maxEntries: 2 })
    const a = await store.saveText({ sessionId: 's', toolName: 't', callId: '1', content: 'A' })
    await store.saveText({ sessionId: 's', toolName: 't', callId: '2', content: 'B' })
    await store.saveText({ sessionId: 's', toolName: 't', callId: '3', content: 'C' })
    await assert.rejects(() => store.readText(a.locator), SpillError, '最旧的应被淘汰')
  })
})

// ---- 回归：readText 对已删除/不存在的 locator 必须**抛错**，不能返回 undefined ----
//
// 这条是浏览器 IndexedDB 后端真跑时发现的：早期 tx() 包装用
// `result?.result ?? result` 解析返回值，「记录不存在」和「请求未完成」
// 都得到 undefined，导致 `!rec` 判断失效 —— clear() 明明删干净了，
// readText 却静默返回 undefined 而不是抛 SpillError。
// 调用方（spill_read 工具）据此把 undefined 当内容返回给模型。
//
// Node 侧后端不共用那段代码，所以这条对两个后端都测一遍。
describe('回归：读不到就必须抛，不能静默返回 undefined', () => {
  for (const [name, make] of [
    ['MemorySpillStore', async () => new MemorySpillStore()],
    ['NodeSpillStore', async () => createNodeSpillStore({ root: nodeRoot })],
  ]) {
    test(`${name}: clear 之后 readText 抛 SpillError 而非返回 undefined`, async () => {
      const store = await make()
      const ref = await store.saveText({ sessionId: 'reg', toolName: 't', callId: 'c', content: 'X' })
      assert.equal(await store.readText(ref.locator), 'X')
      await store.clear('reg')
      let result = 'NOT_CALLED'
      let thrown = null
      try { result = await store.readText(ref.locator) } catch (e) { thrown = e }
      assert.ok(thrown instanceof SpillError,
        `应抛 SpillError，实际返回了 ${JSON.stringify(result)}`)
    })
  }
})
