/**
 * spill 策略层 —— 决定「什么时候把工具输出移出上下文，以及跟模型怎么说」。
 *
 * 存储机制在 ./index.js，截断机制在 ../output-retention.js。
 * 这一层只做判断和措辞，不碰这两者的内部。
 *
 * 移植自 deepseek-harness 的 `dsh-spill-policy`（MIT）。
 * 契约见 docs/dsh-diff/CONTRACT-NOTES.md 的 D 节。
 *
 * 与 dsh 的结构差异：它挂在 `tools/post-execute` 事件瀑布上，
 * 我们没有 Cordis，所以做成一个对象由 agent.js 在工具执行处直接调用。
 * 判断逻辑和措辞逐条对齐。
 */

import { TextRetainer, describeOmitted } from '../output-retention.js'
import { utf8Bytes } from './index.js'

/** spill 取回工具的名字。策略层自己要跳过它（D4），agent 要注册它为基础工具。 */
export const SPILL_READ_TOOL_NAME = 'spill_read'

/**
 * spill 搜索工具的名字。
 *
 * 为什么需要它：dsh 的 retrievalHint 原文是
 * 「Use read with offset/limit, **or grep this path to search within it**」——
 * 它假设宿主已有能搜真实路径的 grep（dsh 自带打包 ripgrep 的 fs-search 工具）。
 * 我们是库，宿主不一定有 grep，浏览器里更没有文件路径可 grep。
 * 只给顺序分段读的话，模型在大文件里找一行错误只能线性扫，实测会撞 maxRounds。
 * 所以这里把「搜」这一环补上，等价于 dsh 依赖的外部 grep。
 */
export const SPILL_SEARCH_TOOL_NAME = 'spill_search'

/**
 * 默认跳过的工具。
 *
 * `read_file` 和 `spill_read`：否则会出现「读文件 → 内容太大转存 →
 * 模型去读转存内容 → 又转存」的死循环。
 */
const DEFAULT_SKIP_TOOLS = ['read_file', SPILL_READ_TOOL_NAME, SPILL_SEARCH_TOOL_NAME]

/** 把 `*` 通配模式编译成锚定正则（其余正则元字符按字面量处理） */
function wildcardToRegExp(pattern) {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

/**
 * 组装提示语。
 *
 * 关键是给模型一条**可执行的路**（用 spill_read 取回），
 * 而不只是告诉它「被截断了」—— 后者只会让它反复重跑同一个命令。
 */
function buildNotice(omitted, ref) {
  const omission = describeOmitted(omitted, 'bytes')
  // locator 用空格与后续文字隔开，不要紧跟中文句号 —— 模型（和正则）
  // 很容易把 `spill://x/y。使用` 整串当成地址。
  return `(${omission} 完整内容已转存，locator: ${ref.locator} — ${ref.retrievalHint})`
}

/**
 * 创建 spill 策略。
 *
 * @param {object} [opts]
 * @param {number|null} [opts.maxInlineBytes] 模型可见的单条工具结果上限（UTF-8 字节）。
 *   **省略或 null = 完全不启用**（返回 null，调用方不必再判断）。
 * @param {object|null} [opts.store] SpillStore 实例。为空时策略降级为「保留原文 + 告警」。
 * @param {string[]} [opts.skipTools] 跳过的工具名（支持 `*` 通配）。覆盖默认清单。
 * @param {number} [opts.readDefaultLimit] spill_read 不传 limit 时的默认值。
 * @param {number} [opts.readMaxLimit] spill_read 的硬上限。
 * @param {(msg:string)=>void} [opts.onWarn] 降级告警回调。
 * @returns {{apply:Function, createReadTool:Function, clear:Function}|null}
 */
export function createSpillPolicy(opts = {}) {
  const {
    maxInlineBytes = null,
    store = null,
    skipTools = DEFAULT_SKIP_TOOLS,
    readDefaultLimit = 8192,
    readMaxLimit = 65536,
    // 搜索结果的两道闸：最多几处匹配、总共几字节。
    // 少了任何一道，搜一个高频词就等于把整个文件倒回上下文。
    searchMaxMatches = 20,
    searchMaxBytes = 8192,
    onWarn = null,
  } = opts ?? {}

  // D1：未配置就是真 no-op —— 返回 null 而不是一个「什么都不做的策略」，
  // 让调用方的 `if (this._spill)` 一目了然。
  if (maxInlineBytes === null || maxInlineBytes === undefined) return null

  // D2：配置非法在**构造时**抛。若留到调用时，截断器的参数断言会在
  // 工具执行之后抛出，把一次本来成功的工具调用变成报错 —— 配置错误
  // 应该让初始化失败，而不是让运行中的业务失败。
  if (!Number.isInteger(maxInlineBytes) || maxInlineBytes < 0) {
    throw new Error(
      `createSpillPolicy: maxInlineBytes must be a non-negative integer (got ${maxInlineBytes})`,
    )
  }

  const skipPatterns = skipTools.map(wildcardToRegExp)
  const warn = msg => { try { onWarn?.(msg) } catch { /* 告警自身不能出事 */ } }

  return {
    /** 供 agent 判断某个工具是否走 spill —— 也用于把 spill_read 排除在外 */
    shouldSkip(toolName) {
      return skipPatterns.some(p => p.test(toolName))
    },

    /**
     * 对一条工具结果应用策略。
     *
     * **永远不抛**：任何失败都降级成「原样返回」，因为 spill 是辅助设施，
     * 它坏了应该退化成「没有这个设施」，而不是拖垮工具调用（D7）。
     *
     * @returns {Promise<string>} 替换后的文本，或原样返回
     */
    async apply({ sessionId, toolName, callId, text }) {
      // 只处理字符串（D3 的等价物：我们的工具结果就是字符串）
      if (typeof text !== 'string') return text
      const totalBytes = utf8Bytes(text)
      if (totalBytes <= maxInlineBytes) return text
      if (this.shouldSkip(toolName)) return text // D4

      if (!store) {
        warn(`spill: 未配置存储后端，保留 ${toolName} 的完整内容（${totalBytes} 字节）`)
        return text
      }
      if (sessionId === null || sessionId === undefined) {
        warn(`spill: ${toolName} 缺少会话标识，保留完整内容`)
        return text
      }

      let ref
      try {
        ref = await store.saveText({ sessionId, toolName, callId, content: text })
      } catch (err) {
        // D7：权限、配额、后端故障 —— 都不能让这次调用失败或把内容藏起来
        warn(`spill: 转存 ${toolName} 失败（${err?.message ?? err}），保留完整内容`)
        return text
      }

      // D5：先按**最坏情况**（省略数 = 全部字节）算出提示语要占多少字节，
      // 从预算里扣掉，剩下的才给预览。最坏情况的数字位数是真实值的上界，
      // 所以这个预留一定够，最终提示语不会比预留的更长。
      // +2 是预览和提示语之间的 '\n\n'。
      const worstNotice = buildNotice({ kind: 'exact', count: totalBytes }, ref)
      const reserve = utf8Bytes(worstNotice) + 2
      const previewBudget = Math.max(0, maxInlineBytes - reserve)

      const retainer = new TextRetainer({
        kind: 'headTail',
        // D8：头尾各一半。不是只留头 —— 退出码、总数、最终报错这类结论
        // 通常在尾部，只留头会让模型看到命令开始执行然后不知道结果。
        headBytes: Math.ceil(previewBudget / 2),
        tailBytes: Math.floor(previewBudget / 2),
      })
      retainer.push(text)
      const kept = retainer.finish()
      const notice = buildNotice(kept.omittedBytes, ref)
      const replaced = kept.text.length > 0 ? `${kept.text}\n\n${notice}` : notice

      // D6：上限是硬不变量。提示语本身就超过上限时（上限设得极小，
      // 或 locator 很长），没有任何合规的替换方案 —— 保留原文。
      // 已写入的文件成为无害的孤儿。
      // 注：合规的替换一定比原文小（原文按入口条件已 > 上限），
      // 所以这一个判断同时覆盖了「不得比原文还长」。
      if (utf8Bytes(replaced) > maxInlineBytes) {
        warn(`spill: ${toolName} 的提示语超过 maxInlineBytes，保留完整内容`)
        return text
      }
      return replaced
    },

    /**
     * 构造 spill_read 工具。
     *
     * 三件事必须做对：
     *   - 有默认 limit（否则模型一句不带参数的调用就把内容全倒回来了）
     *   - 有硬上限（同上，防止模型显式传个巨大的 limit）
     *   - 返回进度信息（让模型知道还剩多少，能决定要不要继续读）
     */
    createReadTool() {
      return {
        name: SPILL_READ_TOOL_NAME,
        description:
          '读取此前因过大而被转存的工具输出。用 offset 和 limit 按字节分段读取，'
          + `不传 limit 时默认读 ${readDefaultLimit} 字节。`
          + '返回结果会标明本段范围和总字节数，据此决定是否继续读下一段。',
        parameters: {
          type: 'object',
          properties: {
            locator: { type: 'string', description: '提示语中给出的 spill:// 地址' },
            offset: { type: 'number', description: '起始字节偏移，默认 0' },
            limit: { type: 'number', description: `最多读取的字节数，默认 ${readDefaultLimit}，上限 ${readMaxLimit}` },
          },
          required: ['locator'],
        },
        async execute(args = {}) {
          const { locator } = args
          if (!locator || typeof locator !== 'string') {
            return 'Error: 缺少必需参数 locator（应为提示语中给出的 spill:// 地址）。'
          }
          if (!store) return 'Error: 当前未配置 spill 存储后端，无法取回内容。'

          const offset = Number.isInteger(args.offset) && args.offset >= 0 ? args.offset : 0
          const requested = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : readDefaultLimit
          const limit = Math.min(requested, readMaxLimit)

          try {
            const full = await store.readText(locator)
            const total = utf8Bytes(full)
            const chunk = await store.readText(locator, { offset, limit })
            const end = Math.min(offset + limit, total)
            const more = end < total
              ? `还有 ${total - end} 字节未读，继续请用 offset=${end}。`
              : '已读到末尾。'
            return `[spill ${locator} 字节 ${offset}-${end} / 共 ${total}] ${more}\n\n${chunk}`
          } catch (err) {
            // 与既有工具的错误处理一致：返回可读错误让模型继续推理，而不是抛异常
            return `Error: 读取 ${locator} 失败 —— ${err?.message ?? err}`
          }
        },
      }
    },

    /**
     * 构造 spill_search 工具 —— 在转存内容里按关键词/正则定位。
     *
     * 这是 dsh 里由外部 grep 承担的那一环（见 SPILL_SEARCH_TOOL_NAME 注释）。
     * 没有它，模型面对大文件只能从头顺序读，实测 150KB 日志找一行错误
     * 要 19 轮以上，直接撞 maxRounds。
     *
     * 与 spill_read 同样的三条约束：结果必须受限、截断要说明、失败返回
     * 可读错误而不是抛异常。
     */
    createSearchTool() {
      return {
        name: SPILL_SEARCH_TOOL_NAME,
        description:
          '在被转存的工具输出里搜索关键词，返回匹配行及其行号。'
          + '面对大文件时**优先用它定位**，再用 spill_read 按 offset 精读附近内容 —— '
          + '不要从头顺序读整个文件。'
          + '搜错误建议用 pattern="error" 配 ignore_case=true（日志里常见全大写 ERROR）。',
        parameters: {
          type: 'object',
          properties: {
            locator: { type: 'string', description: '提示语中给出的 spill:// 地址' },
            pattern: { type: 'string', description: '要搜索的关键词；regex 为 true 时按正则解释' },
            regex: { type: 'boolean', description: '是否按正则匹配，默认 false（按纯文本）' },
            ignore_case: { type: 'boolean', description: '忽略大小写，默认 false。日志里常见全大写 ERROR，不确定时建议开' },
            context: { type: 'number', description: '每个匹配前后附带的上下文行数，默认 0' },
            max_matches: { type: 'number', description: `最多返回多少个匹配，默认 ${searchMaxMatches}` },
          },
          required: ['locator', 'pattern'],
        },
        async execute(args = {}) {
          const { locator, pattern } = args
          if (!locator || typeof locator !== 'string') {
            return 'Error: 缺少必需参数 locator（应为提示语中给出的 spill:// 地址）。'
          }
          if (!pattern || typeof pattern !== 'string') {
            return 'Error: 缺少必需参数 pattern（要搜索的关键词）。'
          }
          if (!store) return 'Error: 当前未配置 spill 存储后端，无法搜索。'

          let matcher
          const ic = args.ignore_case === true
          if (args.regex) {
            try {
              const re = new RegExp(pattern, ic ? 'i' : '')
              matcher = line => re.test(line)
            } catch (err) {
              // 非法正则是模型可纠正的输入错误，返回可读信息让它改，而不是抛异常
              return `Error: 正则表达式无效 —— ${err?.message ?? err}`
            }
          } else if (ic) {
            const needle = pattern.toLowerCase()
            matcher = line => line.toLowerCase().includes(needle)
          } else {
            matcher = line => line.includes(pattern)
          }

          let content
          try {
            content = await store.readText(locator)
          } catch (err) {
            return `Error: 读取 ${locator} 失败 —— ${err?.message ?? err}`
          }

          const lines = String(content).split('\n')
          const ctx = Number.isInteger(args.context) && args.context > 0
            ? Math.min(args.context, 10) : 0
          const cap = Number.isInteger(args.max_matches) && args.max_matches > 0
            ? Math.min(args.max_matches, searchMaxMatches) : searchMaxMatches

          const hits = []
          for (let i = 0; i < lines.length; i++) {
            if (matcher(lines[i])) hits.push(i)
          }
          if (hits.length === 0) {
            return `在 ${locator} 中没有找到匹配「${pattern}」的内容（共 ${lines.length} 行）。`
          }

          // 输出也要有字节上限 —— 否则搜一个高频词等于把整个文件倒回上下文，
          // 绕一圈回到 spill 要解决的问题本身。
          const shown = hits.slice(0, cap)
          const out = []
          let budget = searchMaxBytes
          let rendered = 0
          for (const idx of shown) {
            const from = Math.max(0, idx - ctx)
            const to = Math.min(lines.length - 1, idx + ctx)
            const block = []
            for (let i = from; i <= to; i++) {
              block.push(`${i === idx ? '>' : ' '}${i + 1}: ${lines[i]}`)
            }
            const text = block.join('\n')
            if (utf8Bytes(text) > budget) break
            budget -= utf8Bytes(text)
            out.push(text)
            rendered++
          }

          const omitted = hits.length - rendered
          const head = `在 ${locator} 中找到 ${hits.length} 处匹配「${pattern}」`
            + `（共 ${lines.length} 行）${omitted > 0 ? `，仅显示前 ${rendered} 处，还有 ${omitted} 处未显示` : ''}：`
          const tail = omitted > 0
            ? `\n\n（用更精确的 pattern 缩小范围，或用 spill_read offset 精读某处附近。）`
            : ''
          return `${head}\n\n${out.join(ctx > 0 ? '\n--\n' : '\n')}${tail}`
        },
      }
    },

    /** 清理某个会话的转存内容（供 reset / close 调用） */
    async clear(sessionId) {
      if (!store) return
      try {
        await store.clear(sessionId)
      } catch (err) {
        warn(`spill: 清理失败（${err?.message ?? err}）`)
      }
    },
  }
}
