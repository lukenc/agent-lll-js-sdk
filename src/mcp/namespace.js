/**
 * namespace.js — MCP 工具名前缀化 / 消毒 / 去重 / 解析
 *
 * 为 MCP_Client 暴露给 Agent 的工具名生成 `mcp__<serverName>__<toolName>`
 * 形态的 Namespaced_Tool_Name,并保证:
 *   - 字符集落在 `[A-Za-z0-9_-]`(OpenAI / Anthropic 工具名约束)
 *   - 长度 ≤ 64
 *   - 同一 `listTools()` 结果集内两两不同(冲突时追加 `_2` / `_3` / ... 去重后缀)
 *
 * 设计要点(见 design.md §Components `namespace.js`):
 *   - `sanitizeSegment`:非法字符(含 emoji / 中文 / 控制字符 / 空串等)一律
 *     替换为 `_`,空结果回退为 `_`(保证输出非空)。使用 `/u` 标志让 regex
 *     把代理对(surrogate pair)当作单个码点处理,这样一个 emoji 仅替换为
 *     单个 `_`,避免尾随的非打印字符污染。
 *   - `buildNamespacedName`:组装 `mcp__<s>__<t>`;超长时按 design 的"先截
 *     尾部 toolName"策略处理。当 serverName 本身已塞满整体预算时启用防御
 *     性 fallback:再截 serverName,保留至少 1 个 toolName 字符,确保输出
 *     仍匹配 `/^[a-zA-Z0-9_-]{1,64}$/`(Property 6 对"任意 Unicode 字符串"
 *     的全称断言必须成立)。
 *   - `assignUniqueNames`:遍历 descriptors,用 Set 去重;冲突时每次重算
 *     `base.slice(0, 64 - suffix.length) + suffix`(而非在已 truncate 过的
 *     结果上再 truncate),这样 `_2` → `_3` → ... 每一步都从原始 base 出发,
 *     避免累积 truncation 导致的位移。
 *   - `unprefixToolName`:按"首个 `__` 分隔符"拆分,这是 `mcp__<s>__<t>`
 *     模板的最短匹配语义(非贪婪)。返回值中 `serverName` / `toolName` 已是
 *     sanitize 后的字符串;精确的 rawName 由 `Mcp_Tool_Def._mcp.rawName`
 *     直接提供,本函数不尝试反向 sanitize(sanitize 有损,一般不可逆)。
 *
 * @see Requirements 5.1, 5.2, 5.3, 5.4
 */

const MAX_NAME_LEN = 64
const PREFIX = 'mcp__'
const SEPARATOR = '__'

// 固定结构 `mcp__<s>__<t>` 里除两段可变内容之外的固定开销:prefix + separator
const FIXED_LEN = PREFIX.length + SEPARATOR.length // 5 + 2 = 7

// `u` 标志让 regex 按码点工作,使一个 emoji / 中文字符被整体替换为单个 `_`,
// 而不是把一个代理对的两个 UTF-16 码元各替换为一个 `_`。
const SANITIZE_RE = /[^A-Za-z0-9_-]/gu

// 用于 `unprefixToolName` 校验两段内容是否合法(非空且全为允许字符)
const SEGMENT_RE = /^[A-Za-z0-9_-]+$/

/**
 * 将任意字符串消毒为仅含 `[A-Za-z0-9_-]` 的片段。
 *
 * 规则(Req 5.2):
 *   - 每个不匹配 `[A-Za-z0-9_-]` 的字符(按码点)替换为单个 `_`
 *   - 若结果为空串,返回 `'_'`(保证输出非空,方便上游拼接时不破坏结构)
 *
 * 非 string 输入(null / undefined / 数值 / 对象等)先 `String(...)` 转换,
 * null / undefined 视为空串。
 *
 * @param {unknown} raw
 * @returns {string}  非空且仅含 `[A-Za-z0-9_-]` 字符的字符串
 */
export function sanitizeSegment(raw) {
  const str = raw == null ? '' : String(raw)
  const sanitized = str.replace(SANITIZE_RE, '_')
  return sanitized.length === 0 ? '_' : sanitized
}

/**
 * 构造 `mcp__<sanitize(serverName)>__<sanitize(toolName)>` 形式的 Namespaced
 * Tool Name,长度裁剪到 ≤ 64 且匹配 `/^[a-zA-Z0-9_-]{1,64}$/`。
 *
 * 裁剪策略:
 *   1. 若 `'mcp__' + s + '__' + t` 整体 ≤ 64,直接返回。
 *   2. 否则优先截 `toolName` 尾部,保留 `serverName` 原样(design §namespace.js
 *      规定的主策略)。
 *   3. 极端 fallback:当 `serverName` 片段本身已挤满预算(`s.length >= 57`),
 *      无法给 toolName 留出至少 1 字符 —— 此时再截 `serverName`,保留头部
 *      56 字符并给 toolName 保留 1 字符,恰好凑成 64 总长。此 fallback 并未
 *      在需求文本中明说,但 Property 6 对"任意 Unicode 字符串"的全称断言
 *      要求输出必匹配 `{1,64}`,因此需要防御性处理。
 *
 * @param {unknown} serverName
 * @param {unknown} toolName
 * @returns {string}
 */
export function buildNamespacedName(serverName, toolName) {
  const s = sanitizeSegment(serverName)
  const t = sanitizeSegment(toolName)

  // 理想情况:直接拼接不超长
  if (FIXED_LEN + s.length + t.length <= MAX_NAME_LEN) {
    return PREFIX + s + SEPARATOR + t
  }

  // 主策略:只截 toolName 尾部
  const maxToolLen = MAX_NAME_LEN - FIXED_LEN - s.length
  if (maxToolLen >= 1) {
    return PREFIX + s + SEPARATOR + t.slice(0, maxToolLen)
  }

  // Fallback:serverName 自己就塞满了预算,必须也截 serverName;保留 1 字符
  // 给 toolName,保证三段结构 `mcp__<s>__<t>` 仍完整且两个 `__` 分隔符都在。
  const maxServerLen = MAX_NAME_LEN - FIXED_LEN - 1 // 56
  const truncatedServer = s.slice(0, maxServerLen)
  const truncatedTool = t.slice(0, 1)
  return PREFIX + truncatedServer + SEPARATOR + truncatedTool
}

/**
 * 为同一 server 下的一组 descriptors 批量分配唯一的 Namespaced_Tool_Name。
 *
 * 逻辑:
 *   - 对每个 descriptor 先按 `buildNamespacedName` 得到候选 `base`;
 *   - 若 `base` 与已分配集合冲突,按 `_2`、`_3`、... 追加数字后缀去重;
 *   - 追加后缀时,每轮都从 **原始 base** 重新 truncate 到 `64 - suffix.length`
 *     再拼 suffix(而不是在已 truncate 过的前一轮结果上再操作),这样后缀
 *     `_<n>` 长度变化(2 位数、3 位数等)不会累积位移,总长始终 ≤ 64。
 *
 * 返回形状 `Array<{ namespaced, descriptor }>`:保持输入顺序,`descriptor`
 * 原样透传,便于 client.js 后续用 `descriptor.name` 作 rawName、
 * `descriptor.description` / `descriptor.inputSchema` / `descriptor.annotations`
 * 构造 `Tool_Def`。
 *
 * @param {unknown} serverName
 * @param {Array<{ name?: string, [k: string]: unknown }>} descriptors
 * @returns {Array<{ namespaced: string, descriptor: object }>}
 */
export function assignUniqueNames(serverName, descriptors) {
  const used = new Set()
  const result = []
  const list = Array.isArray(descriptors) ? descriptors : []

  for (const descriptor of list) {
    const rawName = descriptor != null && descriptor.name != null ? descriptor.name : ''
    const base = buildNamespacedName(serverName, rawName)

    let namespaced = base
    let counter = 2
    while (used.has(namespaced)) {
      const suffix = '_' + counter
      const maxBody = MAX_NAME_LEN - suffix.length
      // 始终从原始 base 截取,避免累积 truncation
      namespaced = base.slice(0, maxBody) + suffix
      counter++
    }

    used.add(namespaced)
    result.push({ namespaced, descriptor })
  }

  return result
}

/**
 * 将 Namespaced_Tool_Name 反解为 `{ serverName, toolName }`。
 *
 * 匹配规则(最短匹配 / 首个 `__` 分隔):
 *   - 必须以 `'mcp__'` 开头;
 *   - 剩余部分含至少一个 `'__'`,以**首次出现**的位置为分隔符;
 *   - 分隔前后两段均非空且仅含 `[A-Za-z0-9_-]`(sanitize 输出空间);
 *
 * 任一条件不满足返回 `null`。
 *
 * 注(design §namespace.js):返回的 `serverName` / `toolName` 是 sanitize 后
 * 的字符串,不保证反向等于调用方原始输入。精确的 rawName 应通过
 * `Mcp_Tool_Def._mcp.rawName` 查询,该函数仅做字符串模板解析。
 *
 * @param {unknown} namespaced
 * @returns {{ serverName: string, toolName: string } | null}
 */
export function unprefixToolName(namespaced) {
  if (typeof namespaced !== 'string') return null
  if (!namespaced.startsWith(PREFIX)) return null

  const rest = namespaced.slice(PREFIX.length)
  const sepIdx = rest.indexOf(SEPARATOR)
  // serverName 段至少要 1 字符,故 sepIdx 必须 >= 1
  if (sepIdx < 1) return null

  const serverName = rest.slice(0, sepIdx)
  const toolName = rest.slice(sepIdx + SEPARATOR.length)

  if (toolName.length === 0) return null
  if (!SEGMENT_RE.test(serverName)) return null
  if (!SEGMENT_RE.test(toolName)) return null

  return { serverName, toolName }
}
