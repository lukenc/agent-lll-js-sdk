/**
 * output-retention —— 有界输出保留原语
 *
 * 回答一个纯机械的问题：**留了什么，丢了多少**。
 * 不涉及业务语义（分组、行号、退出码、spill 文件、给模型看的措辞都不在这儿）。
 *
 * 两个保留器按资源模型分开，而不是做成一个泛型收集器：
 *   - ItemRetainer —— 按「条目」计数（路径、匹配行、搜索结果）
 *   - TextRetainer —— 按「字节」计数（命令输出、HTTP body），支持 head/tail/headTail
 *
 * 移植自 deepseek-harness 的 `@deepseek-ai/dsh-output-retention`（MIT）。
 * 行为契约见 docs/dsh-diff/CONTRACT-NOTES.md A 节，逐条对齐其测试用例。
 *
 * 零依赖：只用 TextEncoder/TextDecoder，Node 18+ 与浏览器均为全局对象。
 */

const encoder = new TextEncoder()
// 非 fatal：内部真正损坏的字节交给解码器替换为 U+FFFD，我们只保证「切口」不产生乱码
const decoder = new TextDecoder()

/**
 * @typedef {{kind:'none'}|{kind:'exact',count:number}|{kind:'unknown'}} Omitted
 * 省略了多少。`exact` 是保留器的正常形态（每个单位都被观察过，所以数字精确）；
 * `unknown` 留给「省略了但数不清」的调用方，保留器自己永远不会返回它。
 */

/** @typedef {{kept:boolean, truncated:boolean}} PushDecision */

/** 断言预算是非负整数 —— 这是保留器的入参契约，违反即编程错误 */
function assertBudget(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }
}

// ---------------------------------------------------------------- ItemRetainer

/**
 * 按条目数截断，保留前 maxItems 个。
 *
 * 调用方应当**继续 push 所有观察到的条目**（即使已经超了），
 * 这样最终的省略计数才是精确的。
 */
export class ItemRetainer {
  /** @param {{kind?:'head', maxItems:number}} strategy */
  constructor(strategy) {
    assertBudget(strategy.maxItems, 'maxItems')
    this._maxItems = strategy.maxItems
    this._items = []
    this._seen = 0
    this._omittedCount = 0
  }

  /**
   * @param {*} item
   * @returns {PushDecision}
   */
  push(item) {
    this._seen++
    if (this._items.length < this._maxItems) {
      // 只有在未超上限时才走到这里，此时必然还没丢过东西（条目只增、上限固定）
      this._items.push(item)
      return { kept: true, truncated: false }
    }
    this._omittedCount++
    return { kept: false, truncated: true }
  }

  finish() {
    const truncated = this._omittedCount > 0
    return {
      items: this._items,
      truncated,
      seen: this._seen,
      kept: this._items.length,
      omitted: truncated ? { kind: 'exact', count: this._omittedCount } : { kind: 'none' },
    }
  }
}

// ------------------------------------------------------------ UTF-8 边界处理

/**
 * 剪掉结尾不完整的 UTF-8 序列，避免前缀切口产生替换字符。
 *
 * 往回走过延续字节（10xxxxxx）找到首字节；如果它后面跟的字节数
 * 少于首字节声明的长度，说明这个字符不完整，剪掉。
 *
 * 两种情况**原样返回**（重要）：
 *   - 回退不到首字节（一串裸延续字节）—— 不是可剪的不完整序列
 *   - 首字节非法（如 0xF8）—— 不做幻觉修剪
 * 这些交给非 fatal 解码器去替换。
 */
function trimTrailingPartialUtf8(bytes) {
  let i = bytes.length - 1
  // 延续字节是 0b10xxxxxx；最长序列 4 字节，所以最多回退 3 个
  while (i >= 0 && (bytes[i] & 0xc0) === 0x80 && bytes.length - i <= 3) i--
  if (i < 0) return bytes
  const lead = bytes[i]
  const expected = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : lead < 0xf8 ? 4 : 0
  if (expected === 0) return bytes // 不是合法首字节
  return bytes.length - i < expected ? bytes.subarray(0, i) : bytes
}

/** 跳过开头的延续字节，让后缀切口从一个完整字符的开头开始 */
function trimLeadingContinuationUtf8(bytes) {
  let i = 0
  while (i < bytes.length && (bytes[i] & 0xc0) === 0x80) i++
  return bytes.subarray(i)
}

/** 把若干块拼成一块连续内存 */
function concat(chunks) {
  let length = 0
  for (const c of chunks) length += c.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

// ---------------------------------------------------------------- TextRetainer

/**
 * 按字节截断文本流，可保留前缀、后缀或两者。
 *
 * 三种策略共用一套前缀/后缀累加器：head 只有前缀，tail 只有后缀，
 * headTail 两者都有。
 *
 * **按字节而非字符**：上下文压力和进程输出都是字节维度的。
 * 跨块的多字节字符会被正确处理 —— finish() 时在每个切口修剪不完整字符，
 * 所以返回的文本不会因为「切」本身而出现替换字符。
 *
 * 内存占用恒定在 `prefixCap + tailBytes + 一个块`，
 * 老的后缀块滑出窗口即丢弃，处理超大流也不会无限累积。
 */
export class TextRetainer {
  /** @param {{kind:'head',maxBytes:number}|{kind:'tail',maxBytes:number}|{kind:'headTail',headBytes:number,tailBytes:number}} strategy */
  constructor(strategy) {
    switch (strategy?.kind) {
      case 'head':
        assertBudget(strategy.maxBytes, 'maxBytes')
        this._prefixCap = strategy.maxBytes
        this._suffixCap = 0
        break
      case 'tail':
        assertBudget(strategy.maxBytes, 'maxBytes')
        this._prefixCap = 0
        this._suffixCap = strategy.maxBytes
        break
      case 'headTail':
        assertBudget(strategy.headBytes, 'headBytes')
        assertBudget(strategy.tailBytes, 'tailBytes')
        this._prefixCap = strategy.headBytes
        this._suffixCap = strategy.tailBytes
        break
      default:
        // 不静默当成 head：未知策略是编程错误，早失败比默默截错强
        throw new Error(
          `TextRetainer: unknown strategy kind ${JSON.stringify(strategy?.kind)} `
          + `(expected 'head' | 'tail' | 'headTail')`,
        )
    }
    this._prefixChunks = []
    this._prefixHeld = 0
    this._suffixChunks = []
    this._suffixHeld = 0
    this._total = 0
  }

  /**
   * 投喂一块内容（Uint8Array，或按 UTF-8 编码的 string）。
   *
   * @param {Uint8Array|string} chunk
   * @returns {PushDecision} kept 为 true 仅当这一块**一个字节都没丢**
   */
  push(chunk) {
    const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk
    const before = this._total
    this._total += bytes.length

    // 前缀：只取到上限为止，这一块剩下的部分「没进前缀」
    const room = this._prefixCap - this._prefixHeld
    const take = Math.max(0, Math.min(room, bytes.length))
    if (take > 0) {
      this._prefixChunks.push(bytes.subarray(0, take))
      this._prefixHeld += take
    }

    // 后缀：整块追加，然后丢掉已完全滑出窗口的整块（保证内存有界）
    if (this._suffixCap > 0) {
      this._suffixChunks.push(bytes)
      this._suffixHeld += bytes.length
      let head = this._suffixChunks[0]
      while (head !== undefined && this._suffixHeld - head.length >= this._suffixCap) {
        this._suffixChunks.shift()
        this._suffixHeld -= head.length
        head = this._suffixChunks[0]
      }
      // 首块可能仍有超出窗口的前导字节 —— 单个比窗口还大的块会被上面的循环整块留下
      // （丢掉唯一一块会导致不足 cap）。把这些前导字节裁掉，让累加器真正有界。
      // finish() 只会读最后 suffixLen(≤cap) 字节，所以这里不会丢掉要返回的内容。
      if (head !== undefined && this._suffixHeld > this._suffixCap) {
        const excess = this._suffixHeld - this._suffixCap
        this._suffixChunks[0] = head.subarray(excess)
        this._suffixHeld -= excess
      }
    }

    // 用与 finish() 完全相同的方式计算累计省略量（同一个 _omittedAt），
    // 保证 push 的判断和 finish 的结果永远不会打架。
    const droppedThisChunk = this._omittedAt(this._total) > this._omittedAt(before)
    return {
      kept: !droppedThisChunk,
      truncated: this._omittedAt(this._total) > 0,
    }
  }

  /** 看过 total 字节后，按预算会省略多少：total − 前缀保留 − 后缀保留 */
  _omittedAt(total) {
    const prefixLen = Math.min(total, this._prefixCap)
    const suffixLen = Math.min(total - prefixLen, this._suffixCap)
    return total - prefixLen - suffixLen
  }

  /**
   * 收尾：解码保留下来的前缀和后缀（各自在切口处修剪到字符边界），
   * 并报告精确的省略字节数。
   *
   * @returns {{text:string, truncated:boolean, omittedBytes:Omitted}}
   */
  finish() {
    const prefixLen = Math.min(this._total, this._prefixCap)
    const suffixLen = Math.min(this._total - prefixLen, this._suffixCap)

    const prefix = concat(this._prefixChunks) // 恰好 prefixLen 字节
    const suffix = concat(this._suffixChunks).subarray(this._suffixHeld - suffixLen)

    // 关键分支：按预算没丢东西时，prefix 和 suffix 是同一条流的**相邻切片**
    // （prefixLen + suffixLen === total），head|tail 的分界是人为的，
    // 一个字符可能横跨它。此时必须拼起来整体解码 —— 分别修剪或分别解码
    // 都会破坏跨界字符，尽管一个字节都没丢。
    // 只有真的存在省略缺口时，两侧才是真正的切口：各自修边界、分别解码，
    // 保证不会跨缺口拼出一个本不存在的字符。
    const budgetOmitted = this._omittedAt(this._total)
    const keptPrefix = budgetOmitted > 0 ? trimTrailingPartialUtf8(prefix) : prefix
    const keptSuffix = budgetOmitted > 0 ? trimLeadingContinuationUtf8(suffix) : suffix
    const text = budgetOmitted > 0
      ? decoder.decode(keptPrefix) + decoder.decode(keptSuffix)
      : decoder.decode(concat([prefix, suffix]))

    // 省略量按**实际返回的字节**反推，而不是按预算：边界修剪也会丢掉字节，
    // 单看预算算出的数会高估保留量，那句「省略了 N 字节」就成了假话。
    const omitted = this._total - keptPrefix.length - keptSuffix.length
    const truncated = omitted > 0

    return {
      text,
      truncated,
      omittedBytes: truncated ? { kind: 'exact', count: omitted } : { kind: 'none' },
    }
  }
}

// ------------------------------------------------------------------ 措辞助手

/**
 * 把一个 Omitted 渲染成标准化、不会虚报精度的说法。
 *
 * `exact` 打印数字；`unknown` **不打印数字**（调用方没提供）；`none` 是空串。
 *
 * @param {Omitted} omitted
 * @param {'items'|'bytes'|'chars'|'lines'} unit
 * @returns {string} 中性短句（不带尾随空格），没省略时为空串
 */
export function describeOmitted(omitted, unit) {
  switch (omitted?.kind) {
    case 'none': return ''
    case 'exact': return `Omitted ${omitted.count} ${unit}.`
    case 'unknown': return `More ${unit} were omitted.`
    default: return ''
  }
}

/**
 * 把省略说明和「怎么取回」的指引拼成一行。
 *
 * 本模块不拥有恢复措辞 —— 只有工具自己知道该怎么恢复
 * （缩小匹配范围 / 换更具体的 URL / 读 spill 文件），
 * 所以 recovery 由调用方提供，并能拿到完整 notice 用于组织措辞。
 *
 * @param {{scope:string,strategy:string,unit:string,limit:number|{head:number,tail:number},kept:number,omitted:Omitted}} notice
 * @param {(notice:object)=>string} recovery
 * @returns {string}
 */
export function formatRetentionNotice(notice, recovery) {
  return [describeOmitted(notice.omitted, notice.unit), recovery(notice)]
    .filter(part => part.length > 0)
    .join(' ')
}
