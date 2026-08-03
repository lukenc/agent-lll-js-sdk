import test from 'node:test'
import assert from 'node:assert'
import { displayWidth, truncateToWidth, formatSettled, formatLive, createRenderer } from './subagent-render.js'

test('displayWidth: CJK 记 2 列，ASCII 记 1 列', () => {
  assert.strictEqual(displayWidth('abc'), 3)
  assert.strictEqual(displayWidth('模块清单'), 8)
  assert.strictEqual(displayWidth('a模块'), 5)
  assert.strictEqual(displayWidth(''), 0)
})

test('truncateToWidth 按显示宽度而不是字符数截断', () => {
  // 6 个字符 = 12 列；截到 8 列应当只剩 3 个汉字 + 省略号
  assert.strictEqual(displayWidth(truncateToWidth('统计模块清单表', 8)) <= 8, true)
  assert.strictEqual(truncateToWidth('abcdef', 100), 'abcdef')
  assert.strictEqual(truncateToWidth('abcdef', 4), 'abc…')
})

test('formatSettled 成功与失败前缀不同', () => {
  const ok = formatSettled({ label: 'modules', rounds: 3, tokens: 1100, ms: 8400, ok: true })
  assert.match(ok, /^✓ modules/)
  assert.match(ok, /3 步/)
  assert.match(ok, /1\.1k tok/)
  assert.match(ok, /8\.4s/)
  assert.match(formatSettled({ label: 'x', rounds: 1, tokens: 0, ms: 100, ok: false }), /^✗ x/)
})

test('formatLive 带 spinner 帧', () => {
  const line = formatLive({ label: 'modules', detail: 'read_note', ms: 4200 }, 0)
  assert.match(line, /modules/)
  assert.match(line, /read_note/)
  assert.match(line, /4\.2s/)
  assert.notStrictEqual(formatLive({ label: 'a', detail: '', ms: 0 }, 0), formatLive({ label: 'a', detail: '', ms: 0 }, 1))
})

/** 收集写入内容的假 stream */
function fakeStream(isTTY) {
  const chunks = []
  return { isTTY, columns: 80, write: (s) => { chunks.push(s); return true }, out: () => chunks.join('') }
}

test('非 TTY:一个 ANSI 字节都不吐', () => {
  const s = fakeStream(false)
  const r = createRenderer({ stream: s, isTTY: false })
  r.log('第 5 幕')
  r.update([{ label: 'modules', detail: 'read_note', ms: 4200 }])
  r.settle(formatSettled({ label: 'modules', rounds: 3, tokens: 1100, ms: 8400, ok: true }))
  r.done()
  assert.ok(!/\x1b\[/.test(s.out()), '非 TTY 输出里不应出现 ANSI 转义')
  assert.match(s.out(), /第 5 幕/)
  assert.match(s.out(), /modules/)
})

test('非 TTY:update 不重复刷屏，只在内容变化时追加一行', () => {
  const s = fakeStream(false)
  const r = createRenderer({ stream: s, isTTY: false })
  r.update([{ label: 'a', detail: 'read_note', ms: 1 }])
  r.update([{ label: 'a', detail: 'read_note', ms: 2 }])   // detail 没变 → 不再打
  r.update([{ label: 'a', detail: 'artifact_write', ms: 3 }])
  assert.strictEqual(s.out().match(/read_note/g).length, 1)
  assert.strictEqual(s.out().match(/artifact_write/g).length, 1)
})

test('TTY:重绘会先上移并清掉上一次的行数', () => {
  const s = fakeStream(true)
  const r = createRenderer({ stream: s, isTTY: true })
  r.update([{ label: 'a', detail: '', ms: 0 }, { label: 'b', detail: '', ms: 0 }])
  const before = s.out()
  r.update([{ label: 'a', detail: '', ms: 0 }, { label: 'b', detail: '', ms: 0 }])
  const added = s.out().slice(before.length)
  assert.match(added, /\x1b\[2A/, '两行活动区应当上移 2 行')
  assert.match(added, /\x1b\[2K/, '应当逐行清除')
})

test('TTY:活动行超过 maxRows 时收敛成一行提示', () => {
  const s = fakeStream(true)
  const r = createRenderer({ stream: s, isTTY: true, maxRows: 2 })
  r.update([1, 2, 3, 4].map(i => ({ label: 'a' + i, detail: '', ms: 0 })))
  assert.match(s.out(), /还有 2 个/)
})

test('done 之后再 update 不再写任何东西', () => {
  const s = fakeStream(true)
  const r = createRenderer({ stream: s, isTTY: true })
  r.update([{ label: 'a', detail: '', ms: 0 }])
  r.done()
  const before = s.out().length
  r.update([{ label: 'b', detail: '', ms: 0 }])
  assert.strictEqual(s.out().length, before)
})

test('done 恢复光标显示', () => {
  const s = fakeStream(true)
  const r = createRenderer({ stream: s, isTTY: true })
  r.update([{ label: 'a', detail: '', ms: 0 }])
  r.done()
  assert.match(s.out(), /\x1b\[\?25h/)
})
