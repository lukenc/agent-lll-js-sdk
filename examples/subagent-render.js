/**
 * 终端渲染器 —— 把并发 subagent 的进展画成一个活动区。
 *
 * 接终端(TTY)时底部维持一块原地刷新的区域,每个在跑的 agent 占一行;某个 agent
 * 落终态就把它固化成一行打在活动区上方。被重定向到文件/管道时**整块降级**为逐行
 * 追加,一个 ANSI 字节都不吐 —— 否则日志里全是转义序列,没法看。
 *
 * 拆成独立文件而不是内联进 examples/subagents.js:ANSI 光标算术和 CJK 宽度计算
 * 是这里最容易写错的两处,内联进一个有顶层副作用的示例文件就没法写测试了。
 */

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/**
 * 字符串的**显示宽度**。CJK / 全角字符占 2 列。
 * 按字符数算会让中文行超宽,把活动区的行数算错,重绘的上移行数就跟着错,画面会烂。
 */
export function displayWidth(str) {
  let w = 0
  for (const ch of String(str ?? '')) {
    const c = ch.codePointAt(0)
    w += (
      (c >= 0x1100 && c <= 0x115f) ||   // 韩文字母
      (c >= 0x2e80 && c <= 0xa4cf) ||   // CJK 部首 · 汉字 · 假名
      (c >= 0xac00 && c <= 0xd7a3) ||   // 韩文音节
      (c >= 0xf900 && c <= 0xfaff) ||   // CJK 兼容汉字
      (c >= 0xfe30 && c <= 0xfe6f) ||   // CJK 兼容标点
      (c >= 0xff00 && c <= 0xff60) ||   // 全角 ASCII
      (c >= 0xffe0 && c <= 0xffe6)      // 全角符号
    ) ? 2 : 1
  }
  return w
}

/** 按显示宽度截断,超出时结尾补 `…`（省略号本身占 1 列，已计入）。 */
export function truncateToWidth(str, cols) {
  const s = String(str ?? '')
  if (displayWidth(s) <= cols) return s
  let out = ''
  let w = 0
  for (const ch of s) {
    const cw = displayWidth(ch)
    if (w + cw > cols - 1) break
    out += ch
    w += cw
  }
  return out + '…'
}

function fmtMs(ms) {
  if (!ms) return ''
  if (ms < 1000) return Math.round(ms) + 'ms'
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's'
  return Math.floor(ms / 60000) + 'm' + Math.round((ms % 60000) / 1000) + 's'
}

function fmtTok(n) {
  if (!n) return ''
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k tok' : n + ' tok'
}

function pad(label, cols) {
  const w = displayWidth(label)
  return label + ' '.repeat(Math.max(1, cols - w))
}

/** 固化行:`✓ modules    3 步 · 1.1k tok · 8.4s` */
export function formatSettled({ label, rounds, tokens, ms, ok = true }) {
  const bits = [rounds ? rounds + ' 步' : '', fmtTok(tokens), fmtMs(ms)].filter(Boolean)
  return `${ok ? '✓' : '✗'} ${pad(String(label), 12)}${bits.join(' · ')}`
}

/** 活动行:`⠋ modules    read_note        4.2s` */
export function formatLive({ label, detail, ms }, frame = 0) {
  return `${SPINNER[frame % SPINNER.length]} ${pad(String(label), 12)}${pad(String(detail ?? ''), 18)}${fmtMs(ms)}`
}

/**
 * @param {{ stream?: NodeJS.WriteStream, isTTY?: boolean, maxRows?: number }} [opts]
 */
export function createRenderer({ stream = process.stdout, isTTY = stream.isTTY, maxRows = 8 } = {}) {
  let liveLines = 0        // 当前活动区占了几行
  let frame = 0
  let finished = false
  let lastKey = ''         // 非 TTY 下用来抑制重复行

  const cols = () => stream.columns || 80

  function clearLive() {
    if (!isTTY || liveLines === 0) return
    // 光标此刻在活动区下方一行:逐行上移并清除。
    stream.write(`\x1b[${liveLines}A`)
    for (let i = 0; i < liveLines; i++) stream.write('\x1b[2K\x1b[1B')
    stream.write(`\x1b[${liveLines}A`)
    liveLines = 0
  }

  function writeLive(rows) {
    const shown = rows.slice(0, maxRows)
    const lines = shown.map(r => truncateToWidth(formatLive(r, frame), cols()))
    if (rows.length > shown.length) lines.push(`  …还有 ${rows.length - shown.length} 个在跑`)
    for (const l of lines) stream.write(l + '\n')
    liveLines = lines.length
  }

  return {
    /** 普通输出。必定落在活动区上方。 */
    log(line = '') {
      if (finished) return
      clearLive()
      stream.write(line + '\n')
    },

    /** 固化一行（某个 agent 落终态）。语义等同 log，单独开一个名字是为了读起来清楚。 */
    settle(line) {
      this.log(line)
    },

    /** 重绘活动区。rows: Array<{label, detail, ms}> */
    update(rows = []) {
      if (finished) return
      if (!isTTY) {
        // 降级:只在"某一行的内容真的变了"时追加一条，否则 10fps 会把日志刷爆。
        // 空闲(rows.length === 0)要清掉 lastKey —— 否则活跃 → 空闲 → 相同 key 恢复
        // 会被当成"没变"而静默吞掉,即便中间确实经过了一整段空闲期。
        if (rows.length === 0) { lastKey = ''; return }
        const key = rows.map(r => `${r.label}|${r.detail}`).join(';')
        if (key === lastKey) return
        lastKey = key
        for (const r of rows) stream.write(`[${r.label}] ${r.detail || '进行中'}\n`)
        return
      }
      if (liveLines === 0) stream.write('\x1b[?25l')   // 隐藏光标
      clearLive()
      frame += 1
      writeLive(rows)
    },

    /** 清空活动区并恢复光标。finally 与 SIGINT 都必须调,否则终端留残影。 */
    done() {
      if (finished) return
      finished = true
      if (isTTY) {
        clearLive()
        stream.write('\x1b[?25h')   // 恢复光标
      }
    },
  }
}
