/**
 * output-retention 测试 —— 有界保留原语的行为契约（A2–A9）。
 * 设计说明见 docs/design/spill.md。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert'
import {
  TextRetainer,
  ItemRetainer,
  describeOmitted,
  formatRetentionNotice,
} from './output-retention.js'

const utf8 = s => new TextEncoder().encode(s)
const byteLen = s => new TextEncoder().encode(s).length

// ---- A2 参数校验 ----

describe('TextRetainer 参数校验（A2）', () => {
  test('拒绝负数 / 小数预算，且在构造时就抛', () => {
    assert.throws(() => new TextRetainer({ kind: 'head', maxBytes: -1 }),
      /maxBytes must be a non-negative integer/)
    assert.throws(() => new TextRetainer({ kind: 'tail', maxBytes: 2.5 }),
      /maxBytes must be a non-negative integer/)
    assert.throws(() => new TextRetainer({ kind: 'headTail', headBytes: -1, tailBytes: 2 }),
      /headBytes must be a non-negative integer/)
    assert.throws(() => new TextRetainer({ kind: 'headTail', headBytes: 2, tailBytes: 1.1 }),
      /tailBytes must be a non-negative integer/)
  })

  test('未知策略要抛，而不是静默当成 head', () => {
    assert.throws(() => new TextRetainer({ kind: 'nope', maxBytes: 4 }))
  })
})

// ---- head / tail / headTail 基本行为 ----

describe('TextRetainer head', () => {
  test('保留前缀，精确报告省略字节数', () => {
    const r = new TextRetainer({ kind: 'head', maxBytes: 4 })
    r.push('abcdefghij')
    const out = r.finish()
    assert.equal(out.text, 'abcd')
    assert.equal(out.truncated, true)
    assert.deepEqual(out.omittedBytes, { kind: 'exact', count: 6 })
  })

  test('部分丢弃的块要标记为未完整保留（A7）', () => {
    const r = new TextRetainer({ kind: 'head', maxBytes: 3 })
    assert.deepEqual(r.push('ab'), { kept: true, truncated: false })
    assert.deepEqual(r.push('cd'), { kept: false, truncated: true })
  })
})

describe('TextRetainer tail', () => {
  test('保留末尾 maxBytes', () => {
    const r = new TextRetainer({ kind: 'tail', maxBytes: 4 })
    r.push('abcdefghij')
    const out = r.finish()
    assert.equal(out.text, 'ghij')
    assert.deepEqual(out.omittedBytes, { kind: 'exact', count: 6 })
  })

  test('未超预算时全部保留', () => {
    const r = new TextRetainer({ kind: 'tail', maxBytes: 100 })
    r.push('abc')
    const out = r.finish()
    assert.equal(out.text, 'abc')
    assert.equal(out.truncated, false)
  })
})

describe('TextRetainer headTail', () => {
  test('保留头尾、省略中间', () => {
    const r = new TextRetainer({ kind: 'headTail', headBytes: 3, tailBytes: 3 })
    r.push('abcdefghij')
    const out = r.finish()
    assert.equal(out.text, 'abchij')
    assert.equal(out.truncated, true)
    assert.deepEqual(out.omittedBytes, { kind: 'exact', count: 4 })
  })

  test('头尾正好覆盖全部时不重复计算', () => {
    const r = new TextRetainer({ kind: 'headTail', headBytes: 3, tailBytes: 3 })
    r.push('abcdef')
    const out = r.finish()
    assert.equal(out.text, 'abcdef')
    assert.equal(out.truncated, false)
    assert.deepEqual(out.omittedBytes, { kind: 'none' })
  })
})

// ---- A4 无省略时必须整体解码（最容易写错的分支）----

describe('A4 无省略时头尾相邻，必须整体解码', () => {
  test('跨 head|tail 接缝的字符不能被切坏', () => {
    // 'éab' = C3 A9 61 62（4 字节）。head 1 + tail 3 覆盖全部，
    // 但接缝落在 'é' 内部。因为没有真实缺口，整个 'éab' 必须存活。
    const r = new TextRetainer({ kind: 'headTail', headBytes: 1, tailBytes: 3 })
    r.push('éab')
    const out = r.finish()
    assert.equal(out.text, 'éab')
    assert.equal(out.truncated, false)
    assert.deepEqual(out.omittedBytes, { kind: 'none' })
  })

  test('中文同理：接缝落在汉字中间也不能坏', () => {
    // '中a' = E4 B8 AD 61（4 字节），head 2 + tail 2 覆盖全部
    const r = new TextRetainer({ kind: 'headTail', headBytes: 2, tailBytes: 2 })
    r.push('中a')
    const out = r.finish()
    assert.equal(out.text, '中a')
    assert.equal(out.truncated, false)
  })

  test('一旦真的省略了中间，两侧就是真切口，要各自修边界', () => {
    const r = new TextRetainer({ kind: 'headTail', headBytes: 2, tailBytes: 2 })
    r.push('a€€b') // 8 字节
    const out = r.finish()
    assert.equal(out.truncated, true)
    assert.ok(!out.text.includes('�'), '不应出现替换字符')
    assert.ok(out.text.startsWith('a'))
    assert.ok(out.text.endsWith('b'))
  })
})

// ---- A3 UTF-8 边界修剪 ----

describe('A3 UTF-8 边界修剪', () => {
  test('头切口的不完整 3 字节序列要剪掉，不能出乱码', () => {
    const r = new TextRetainer({ kind: 'head', maxBytes: 2 })
    r.push('a€b') // 61 E2 82 AC 62
    const out = r.finish()
    assert.equal(out.text, 'a')
    assert.ok(!out.text.includes('�'))
  })

  test('不完整 2 字节序列（é）要剪掉', () => {
    const r = new TextRetainer({ kind: 'head', maxBytes: 2 })
    r.push('aé') // 61 C3 A9
    assert.equal(r.finish().text, 'a')
  })

  test('不完整 4 字节序列（emoji）要剪掉', () => {
    const r = new TextRetainer({ kind: 'head', maxBytes: 3 })
    r.push('a😀') // 61 F0 9F 98 80
    const out = r.finish()
    assert.equal(out.text, 'a')
    assert.ok(!out.text.includes('�'))
  })

  test('正好放得下的完整字符要保留', () => {
    const r3 = new TextRetainer({ kind: 'head', maxBytes: 3 })
    r3.push('€x')
    assert.equal(r3.finish().text, '€')

    const r4 = new TextRetainer({ kind: 'head', maxBytes: 4 })
    r4.push('😀x')
    assert.equal(r4.finish().text, '😀')
  })

  test('尾切口开头的延续字节要跳过', () => {
    const r = new TextRetainer({ kind: 'tail', maxBytes: 2 })
    r.push('a€b') // 保留 AC 62，AC 是延续字节
    const out = r.finish()
    assert.equal(out.text, 'b')
    assert.ok(!out.text.includes('�'))
  })

  test('纯延续字节串（找不到 lead）原样保留，不做幻觉修剪', () => {
    const r = new TextRetainer({ kind: 'head', maxBytes: 2 })
    r.push(new Uint8Array([0x80, 0x80, 0x7a]))
    const out = r.finish()
    // 修剪器应该放弃（没找到 lead），只有末尾的 'z' 因预算被省略
    assert.deepEqual(out.omittedBytes, { kind: 'exact', count: 1 })
  })

  test('非法 lead 字节（0xF8）原样保留', () => {
    const r = new TextRetainer({ kind: 'head', maxBytes: 1 })
    r.push(new Uint8Array([0xf8, 0x61]))
    const out = r.finish()
    assert.deepEqual(out.omittedBytes, { kind: 'exact', count: 1 })
  })

  test('不能跨省略的中间拼出一个字符', () => {
    const r = new TextRetainer({ kind: 'headTail', headBytes: 2, tailBytes: 2 })
    r.push('€€€') // 9 字节
    const out = r.finish()
    assert.ok(!out.text.includes('�'))
    assert.equal(out.truncated, true)
  })
})

// ---- A5 omitted 按实际返回算 ----

describe('A5 omitted 必须是实话', () => {
  test('head 切口：算上被边界修剪掉的字节', () => {
    // 'a€b' 5 字节，maxBytes 2 → 实际只留 'a'（1 字节）
    // 省略数应是 5-1=4，而不是按预算算的 5-2=3
    const r = new TextRetainer({ kind: 'head', maxBytes: 2 })
    r.push('a€b')
    const out = r.finish()
    assert.deepEqual(out.omittedBytes, { kind: 'exact', count: 4 })
  })

  test('tail 切口同理', () => {
    const r = new TextRetainer({ kind: 'tail', maxBytes: 2 })
    r.push('a€b')
    assert.deepEqual(r.finish().omittedBytes, { kind: 'exact', count: 4 })
  })

  test('headTail：省略数恒等于 总字节 - 实际返回字节', () => {
    const r = new TextRetainer({ kind: 'headTail', headBytes: 2, tailBytes: 2 })
    r.push('a€€b') // 8 字节
    const out = r.finish()
    assert.deepEqual(out.omittedBytes, { kind: 'exact', count: 8 - byteLen(out.text) })
  })
})

// ---- A8 零预算 / 空流 ----

describe('A8 零预算与空流', () => {
  test('maxBytes 0 什么都不留，每个字节都算省略', () => {
    const r = new TextRetainer({ kind: 'head', maxBytes: 0 })
    assert.deepEqual(r.push('x'), { kept: false, truncated: true })
    const out = r.finish()
    assert.equal(out.text, '')
    assert.deepEqual(out.omittedBytes, { kind: 'exact', count: 1 })
  })

  test('空流不省略任何东西', () => {
    const r = new TextRetainer({ kind: 'headTail', headBytes: 2, tailBytes: 2 })
    const out = r.finish()
    assert.equal(out.text, '')
    assert.equal(out.truncated, false)
    assert.deepEqual(out.omittedBytes, { kind: 'none' })
  })
})

// ---- A6 内存有界 + 多块输入 ----

describe('A6 内存有界与分块输入', () => {
  test('tail 模式下滑出窗口的旧块被丢弃', () => {
    const r = new TextRetainer({ kind: 'tail', maxBytes: 4 })
    for (const c of ['aaaa', 'bbbb', 'cccc', 'dddd']) r.push(c)
    assert.equal(r.finish().text, 'dddd')
  })

  test('单个远大于窗口的块也不会撑爆内存', () => {
    const r = new TextRetainer({ kind: 'tail', maxBytes: 8 })
    r.push('x'.repeat(100000) + 'ENDMARK!')
    const out = r.finish()
    assert.equal(out.text, 'ENDMARK!')
    assert.deepEqual(out.omittedBytes, { kind: 'exact', count: 100000 })
  })

  test('接受 Uint8Array 输入', () => {
    const r = new TextRetainer({ kind: 'head', maxBytes: 2 })
    r.push(utf8('xy'))
    r.push(utf8('z'))
    assert.equal(r.finish().text, 'xy')
  })

  test('跨块的多字节字符要能正确拼回', () => {
    // 把 '中' 的 3 个字节拆成 3 次 push
    const bytes = utf8('中')
    const r = new TextRetainer({ kind: 'head', maxBytes: 10 })
    r.push(bytes.subarray(0, 1))
    r.push(bytes.subarray(1, 2))
    r.push(bytes.subarray(2, 3))
    assert.equal(r.finish().text, '中')
  })
})

// ---- ItemRetainer ----

describe('ItemRetainer', () => {
  test('保留前 maxItems，继续 push 以得到精确省略数', () => {
    const r = new ItemRetainer({ maxItems: 2 })
    for (const x of ['a', 'b', 'c', 'd']) r.push(x)
    const out = r.finish()
    assert.deepEqual(out.items, ['a', 'b'])
    assert.equal(out.seen, 4)
    assert.equal(out.kept, 2)
    assert.deepEqual(out.omitted, { kind: 'exact', count: 2 })
  })

  test('全部装得下时不报省略', () => {
    const r = new ItemRetainer({ maxItems: 5 })
    r.push('a')
    const out = r.finish()
    assert.equal(out.truncated, false)
    assert.deepEqual(out.omitted, { kind: 'none' })
  })

  test('maxItems 0 全部算省略', () => {
    const r = new ItemRetainer({ maxItems: 0 })
    assert.deepEqual(r.push('a'), { kept: false, truncated: true })
    assert.deepEqual(r.finish().omitted, { kind: 'exact', count: 1 })
  })

  test('拒绝非法 maxItems', () => {
    assert.throws(() => new ItemRetainer({ maxItems: -1 }),
      /maxItems must be a non-negative integer/)
  })
})

// ---- A9 describeOmitted ----

describe('A9 describeOmitted 防虚假精度', () => {
  test('exact 打印具体数字', () => {
    assert.equal(describeOmitted({ kind: 'exact', count: 3 }, 'items'), 'Omitted 3 items.')
  })

  test('unknown 不打印数字', () => {
    const s = describeOmitted({ kind: 'unknown' }, 'bytes')
    assert.equal(s, 'More bytes were omitted.')
    assert.ok(!/\d/.test(s), 'unknown 不应包含任何数字')
  })

  test('none 返回空串', () => {
    assert.equal(describeOmitted({ kind: 'none' }, 'bytes'), '')
  })
})

describe('formatRetentionNotice', () => {
  const notice = { scope: 'bash', strategy: 'headTail', unit: 'bytes', limit: { head: 2, tail: 2 }, kept: 4, omitted: { kind: 'exact', count: 10 } }

  test('把省略说明和恢复指引用一个空格连起来', () => {
    const s = formatRetentionNotice(notice, () => '缩小范围后重试。')
    assert.equal(s, 'Omitted 10 bytes. 缩小范围后重试。')
  })

  test('没有省略时只剩恢复指引', () => {
    const s = formatRetentionNotice({ ...notice, omitted: { kind: 'none' } }, () => '继续。')
    assert.equal(s, '继续。')
  })

  test('恢复指引为空时只剩省略说明', () => {
    assert.equal(formatRetentionNotice(notice, () => ''), 'Omitted 10 bytes.')
  })

  test('完整 notice 会传给恢复指引构造函数', () => {
    let got
    formatRetentionNotice(notice, n => { got = n; return '' })
    assert.deepEqual(got.limit, { head: 2, tail: 2 })
    assert.equal(got.scope, 'bash')
  })
})
