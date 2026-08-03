/**
 * Skill 模型 + SKILL.md frontmatter 解析。
 * 零依赖手写 YAML 子集解析器:仅支持 frontmatter 实际用到的形态 ——
 * 标量、单层 map、字符串列表(block `- item` 与 inline `a, b`)。
 * 与 src/mcp/ 的"零新运行时依赖"铁律一致。
 */

import { SkillParseError } from './errors.js'

export const NAME_RE = /^[a-z0-9-]{1,64}$/
export const MAX_DESCRIPTION = 1024

const KNOWN_KEYS = new Set([
  'name', 'description', 'version', 'license', 'allowed-tools',
  'disable-model-invocation', 'metadata', 'argument-hint',
])

/** 解析标量:去引号、识别 true/false。 */
function parseScalar(raw) {
  let v = raw.trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1)
  }
  if (v === 'true') return true
  if (v === 'false') return false
  return v
}

/** 把 inline 列表 "a, b, c" 拆成数组;单元素也返回数组。 */
function parseInlineList(raw) {
  return raw.split(/[,\s]+/).map(s => s.trim()).filter(s => s.length > 0)
}

/**
 * 切分 frontmatter。文本以 `---\n` 开头且存在闭合 `---` 时,解析中间块;
 * 否则返回 { frontmatter: {}, body: 原文 }。
 * @param {string} text
 * @returns {{ frontmatter: object, body: string }}
 */
export function parseFrontmatter(text) {
  const src = String(text ?? '')
  if (!src.startsWith('---')) return { frontmatter: {}, body: src }

  // 找到第一行 --- 之后的闭合 ---(独占一行)
  const lines = src.split('\n')
  if (lines[0].trim() !== '---') return { frontmatter: {}, body: src }
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break }
  }
  if (end === -1) return { frontmatter: {}, body: src }

  const fmLines = lines.slice(1, end)
  const body = lines.slice(end + 1).join('\n')
  const frontmatter = {}

  let i = 0
  while (i < fmLines.length) {
    const line = fmLines[i]
    if (line.trim() === '' || line.trim().startsWith('#')) { i++; continue }
    const m = line.match(/^([A-Za-z0-9_-]+):(.*)$/)
    if (!m) { i++; continue }
    const key = m[1]
    const rest = m[2]
    if (rest.trim() === '') {
      // 可能是 block 列表或 block map:向下看缩进行
      const items = []
      let j = i + 1
      while (j < fmLines.length && /^\s+-\s+/.test(fmLines[j])) {
        items.push(parseScalar(fmLines[j].replace(/^\s+-\s+/, '')))
        j++
      }
      if (items.length > 0) {
        frontmatter[key] = items
        i = j
        continue
      }
      frontmatter[key] = ''
      i++
    } else {
      const val = parseScalar(rest)
      // Special-case allowed-tools: parse inline lists (comma-separated)
      if (key === 'allowed-tools' && typeof val === 'string' && val.includes(',')) {
        frontmatter[key] = parseInlineList(val)
      } else {
        frontmatter[key] = val
      }
      i++
    }
  }

  return { frontmatter, body }
}

/** 归一 allowed-tools 为 string[] | null。 */
function normalizeAllowedTools(v) {
  if (Array.isArray(v)) return v.map(String)
  if (typeof v === 'string' && v.trim().length > 0) return parseInlineList(v)
  return null
}

/**
 * 解析并校验一个 SKILL.md,产出 Skill_Def。
 * @param {string} text SKILL.md 全文
 * @param {object} ctx
 * @param {string} ctx.dirName 目录名(权威 name 来源)
 * @param {object} ctx.source 溯源 { provider, origin }
 * @param {string[]} ctx.files 捆绑资源相对路径清单
 * @param {string|null} ctx.baseDir 物化后绝对路径(浏览器为 null)
 * @returns {Skill_Def}
 * @throws {SkillParseError} 缺少必填字段或 name 非法
 */
export function parseSkillMd(text, { dirName, source, files, baseDir }) {
  const { frontmatter, body } = parseFrontmatter(text)

  // name:目录名权威;与 frontmatter 不一致时 warn 并采用目录名。
  let name = dirName
  if (frontmatter.name && frontmatter.name !== dirName) {
    console.warn(`[skills] name "${frontmatter.name}" in SKILL.md != dir "${dirName}"; using dir name`)
  }
  if (!NAME_RE.test(name)) {
    throw new SkillParseError(`invalid skill name "${name}" (must match ${NAME_RE})`, { skillName: name })
  }

  let description = frontmatter.description
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new SkillParseError('SKILL.md missing required non-empty description', { skillName: name })
  }
  if (description.length > MAX_DESCRIPTION) {
    console.warn(`[skills] description of "${name}" exceeds ${MAX_DESCRIPTION} chars; truncating`)
    description = description.slice(0, MAX_DESCRIPTION)
  }

  const extra = {}
  for (const k of Object.keys(frontmatter)) {
    if (!KNOWN_KEYS.has(k)) extra[k] = frontmatter[k]
  }

  const metadata = (frontmatter.metadata && typeof frontmatter.metadata === 'object')
    ? { ...frontmatter.metadata, extra }
    : { extra }

  return {
    name,
    description,
    version: frontmatter.version ?? null,
    license: frontmatter.license ?? null,
    allowedTools: normalizeAllowedTools(frontmatter['allowed-tools']),
    argumentHint: typeof frontmatter['argument-hint'] === 'string' && frontmatter['argument-hint'].trim()
      ? frontmatter['argument-hint'].trim()
      : null,
    disableModelInvocation: frontmatter['disable-model-invocation'] === true,
    metadata,
    body,
    files: Array.isArray(files) ? files : [],
    baseDir: baseDir ?? null,
    source: source ?? {},
  }
}

// `$ARGUMENTS`(整串)与 `$1`..`$9`(位置参数)。合并为单条正则一次扫完,
// 避免两遍替换时先替进去的文本被后一遍二次识别(如某个位置参数本身
// 含有 "$ARGUMENTS" 字面量)。
const ARG_PLACEHOLDER_RE = /\$ARGUMENTS(?![A-Za-z0-9_])|\$([1-9])/g

/**
 * 把 skill 调用参数代入正文占位符(对齐 Claude Code 斜杠命令的展开规则)。
 * `$ARGUMENTS` 取整串;`$1`..`$9` 取按空白切分的第 N 个 token,缺失代入空串。
 * 注意:替换一律用函数式 replacer,故参数里的 `$&` / `$1` 等不会被二次解释。
 *
 * @param {string} body SKILL.md 正文
 * @param {string} [args] 调用方传入的参数串
 * @returns {{ text: string, applied: boolean }} `applied` 表示正文里确实存在占位符
 *   —— 为 false 时调用方应把参数另行附加为上下文,否则参数会被静默丢弃。
 */
export function applySkillArgs(body, args) {
  const src = String(body ?? '')
  const raw = String(args ?? '').trim()
  const tokens = raw.length > 0 ? raw.split(/\s+/) : []
  let applied = false
  const text = src.replace(ARG_PLACEHOLDER_RE, (_m, digit) => {
    applied = true
    if (digit === undefined) return raw
    return tokens[Number(digit) - 1] ?? ''
  })
  return { text, applied }
}
