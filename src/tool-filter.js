/**
 * ToolFilter — 工具过滤器
 * 对应 Java 框架的 fc.runtime.ToolFilter
 *
 * 根据意图识别结果从全量工具列表中筛选相关工具子集。
 * BaseTool 集合始终包含在过滤结果中。
 */

/**
 * 初始基础工具名列表(6 个),`Object.freeze` 防止外部变异。
 * 作为 `BASE_TOOLS` 与 `resetBaseTools()` 的唯一真值来源。
 */
export const INITIAL_BASE_TOOLS = Object.freeze([
  'keyword_search',
  'read_file',
  'write_file',
  'shell_exec',
  'project_tree',
  'ask_user',
])

/**
 * 基础工具集合 — 始终保留,不受过滤影响。
 * `ask_user` 是 `Agent` 在 `hooks.onAskUser` 存在时自动注入的内置工具,
 * 逻辑上始终可用:意图识别的 `filteredToolNames` 不应该把它过滤掉,
 * 否则 LLM 看不见这个工具、只会在文本里"口头"发问而不真正触发交互。
 *
 * 注意:本导出绑定的 Set 实例在整个进程生命周期内保持**引用身份不变**,
 * 所有 CRUD 操作(`registerBaseTool` / `unregisterBaseTool` / `setBaseTools` /
 * `clearBaseTools` / `resetBaseTools`)都直接在此实例上进行 add/delete/clear,
 * 不会替换该绑定。
 */
export const BASE_TOOLS = new Set(INITIAL_BASE_TOOLS)

/**
 * 模块私有助手:统一校验非空字符串。
 * 统一 error message 契约,让 AC 11.4 / 11.7 / 11.9 的消息包含
 * 调用方 API 名与固定字符串 `'non-empty string'`。
 *
 * @param {unknown} name
 * @param {string} apiName
 */
function assertNonEmptyString(name, apiName) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError(
      `${apiName}: expected a non-empty string, received ${typeof name === 'string' ? 'empty string' : typeof name}`
    )
  }
}

/**
 * 将 `name` 注册为 base tool。Set 语义天然幂等。
 * @param {string} name
 */
export function registerBaseTool(name) {
  assertNonEmptyString(name, 'registerBaseTool')
  BASE_TOOLS.add(name)
}

/**
 * 将 `name` 从 base tool 集合中移除。
 * 透传 `Set.prototype.delete` 的 boolean 返回值。
 * @param {string} name
 * @returns {boolean} 原先存在则返回 true,不存在返回 false
 */
export function unregisterBaseTool(name) {
  assertNonEmptyString(name, 'unregisterBaseTool')
  return BASE_TOOLS.delete(name)
}

/**
 * 两阶段原子覆盖 base tool 集合:
 *  1. 校验 `names` 全部合法(不触碰 `BASE_TOOLS`);
 *  2. 校验通过后才 `clear` + `add`。
 * 若任一元素非法,`BASE_TOOLS` 保持调用前状态(字节级一致)。
 *
 * @param {Iterable<string>} names
 */
export function setBaseTools(names) {
  // Phase 1: validate ALL elements first (BASE_TOOLS untouched)
  if (names == null || typeof names[Symbol.iterator] !== 'function') {
    throw new TypeError(
      `setBaseTools: expected an iterable of non-empty strings, received ${names === null ? 'null' : typeof names}`
    )
  }
  const staged = new Set()
  for (const n of names) {
    assertNonEmptyString(n, 'setBaseTools')
    staged.add(n)
  }
  // Phase 2: commit (BASE_TOOLS reference preserved)
  BASE_TOOLS.clear()
  for (const n of staged) BASE_TOOLS.add(n)
}

/**
 * 清空 base tool 集合。
 */
export function clearBaseTools() {
  BASE_TOOLS.clear()
}

/**
 * 恢复 base tool 集合为 `INITIAL_BASE_TOOLS`。
 * 保持 `BASE_TOOLS` 引用身份不变。
 */
export function resetBaseTools() {
  BASE_TOOLS.clear()
  for (const n of INITIAL_BASE_TOOLS) BASE_TOOLS.add(n)
}

/**
 * 查询 `name` 是否为 base tool。
 * 透传 `Set.prototype.has` 的 total 语义:非 string 输入自然返回 false 且不抛错。
 *
 * @param {unknown} name
 * @returns {boolean}
 */
export function isBaseTool(name) {
  return BASE_TOOLS.has(name)
}

/**
 * 返回当前 base tool 名字的防御性快照数组。
 * 每次调用生成**新**数组实例,调用方的变异不会回流到 `BASE_TOOLS`。
 *
 * @returns {string[]}
 */
export function getBaseTools() {
  return [...BASE_TOOLS]
}

export class ToolFilter {
  /**
   * per-session 过滤 — BaseTool 始终包含,filteredToolNames 为空时回退全量。
   *
   * @param {import('./intent-recognizer.js').IntentResult|null} intent
   * @param {import('./tool.js').ToolDef[]} allTools
   * @returns {import('./tool.js').ToolDef[]}
   */
  filter(intent, allTools) {
    if (!allTools || allTools.length === 0) return []

    const filteredNames = intent?.filteredToolNames
    if (!filteredNames || filteredNames.length === 0) {
      // 回退为全量工具
      return [...allTools]
    }

    // 过滤:BaseTool + filteredToolNames
    const keepNames = new Set([...filteredNames, ...BASE_TOOLS])
    return allTools.filter(t => keepNames.has(t.name))
  }
}
