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
  // 6 个字符 = 12 列；截到 8 列（cols-1=7）：'统'+'计'+'模' 累计 6 列 <= 7，
  // 加上'块'会到 8 > 7 于是止步，结果是 3 个汉字 + 省略号
  const truncated = truncateToWidth('统计模块清单表', 8)
  assert.strictEqual(truncated, '统计模…')
  assert.strictEqual(displayWidth(truncated), 7)
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
  // settle 特有内容：update() 的 `[modules] read_note` 满足不了这两条，
  // 若 settle 被改成空实现，这里必须挂。
  assert.match(s.out(), /✓ modules/)
  assert.match(s.out(), /8\.4s/)
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

test('非 TTY:活跃 → 空闲 → 相同 key 恢复应重新打印（空闲要清掉 lastKey）', () => {
  const s = fakeStream(false)
  const r = createRenderer({ stream: s, isTTY: false })
  r.update([{ label: 'a', detail: 'read_note', ms: 1 }])   // 打印一次
  r.update([])                                             // 空闲，应清掉 lastKey
  r.update([{ label: 'a', detail: 'read_note', ms: 2 }])   // 相同 key 恢复，应当再打印一次
  assert.strictEqual(s.out().match(/read_note/g).length, 2)
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

test('TTY:settle 先清活动区再固化', () => {
  const s = fakeStream(true)
  const r = createRenderer({ stream: s, isTTY: true })
  r.update([{ label: 'a', detail: '', ms: 0 }])   // 一行活动区
  const before = s.out()
  r.settle('✓ done line')
  const added = s.out().slice(before.length)
  const clearIdx = added.indexOf('\x1b[1A')
  const lineIdx = added.indexOf('✓ done line')
  assert.notStrictEqual(clearIdx, -1, 'settle 应先走清除活动区的上移序列（单行活动区应为 \\x1b[1A）')
  assert.notStrictEqual(lineIdx, -1, '固化内容应当被写入')
  assert.ok(clearIdx < lineIdx, '清除序列必须出现在固化行之前')
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

test('done 之后 log/settle/再次 done 都不再写任何东西', () => {
  const s = fakeStream(true)
  const r = createRenderer({ stream: s, isTTY: true })
  r.update([{ label: 'a', detail: '', ms: 0 }])
  r.done()
  const before = s.out().length
  r.done()
  r.log('不应出现')
  r.settle('也不应出现')
  assert.strictEqual(s.out().length, before)
})

test('done 恢复光标显示', () => {
  const s = fakeStream(true)
  const r = createRenderer({ stream: s, isTTY: true })
  r.update([{ label: 'a', detail: '', ms: 0 }])
  r.done()
  assert.match(s.out(), /\x1b\[\?25h/)
})

test('TTY:连续两次等行数重绘的净垂直位移必须是 0（clearLive 的两次上移必须配对）', () => {
  // clearLive() 先 \x1b[nA 上移到活动区顶部，逐行清除+下移回到底部，再 \x1b[nA
  // 上移回顶部，writeLive() 才重新逐行写入并下移。四步走完，光标应当落在与
  // 上一帧相同的相对位置——净位移为 0。如果收尾那次上移被删掉，clearLive()
  // 会把光标留在活动区*下方*，writeLive() 再从那里往下写 N 行，于是每重绘一次
  // 活动区就整体下沉 N 行，10fps 下终端会持续滚屏。
  const s = fakeStream(true)
  const r = createRenderer({ stream: s, isTTY: true })
  const rows = [{ label: 'a', detail: '', ms: 0 }, { label: 'b', detail: '', ms: 0 }]
  r.update(rows)                 // 第一次：liveLines 从 0 起，clearLive 提前 return，不产生位移噪音
  const before = s.out()
  r.update(rows)                 // 第二次：liveLines=2，clearLive 真正执行清除
  const chunk = s.out().slice(before.length)

  // 净垂直位移：\x1b[nB 与 '\n' 记 +n / +1（向下），\x1b[nA 记 -n（向上）。
  let net = 0
  const re = /\x1b\[(\d+)([AB])|\n/g
  let m
  while ((m = re.exec(chunk))) {
    if (m[2] === 'A') net -= Number(m[1])
    else if (m[2] === 'B') net += Number(m[1])
    else net += 1 // '\n'
  }
  assert.strictEqual(net, 0,
    `两行活动区连续重绘一次后光标净位移应为 0，实测 ${net}（chunk=${JSON.stringify(chunk)}）`)
})

test('返回对象可以被解构后自由调用，不依赖 this（拷贝粘贴场景）', () => {
  // settle() 内部若写成 this.log(line)，`const { settle } = createRenderer()`
  // 解构出来单独调用时 this 是 undefined，会直接抛 TypeError。
  const s = fakeStream(true)
  const { log, settle, update, done } = createRenderer({ stream: s, isTTY: true })
  assert.doesNotThrow(() => {
    update([{ label: 'a', detail: 'read_note', ms: 0 }])
    log('普通输出')
    settle('✓ 固化输出')
    done()
  })
  assert.match(s.out(), /普通输出/)
  assert.match(s.out(), /✓ 固化输出/)
})
