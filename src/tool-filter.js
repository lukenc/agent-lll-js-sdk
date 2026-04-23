/**
 * ToolFilter — 工具过滤器
 * 对应 Java 框架的 fc.runtime.ToolFilter
 *
 * 根据意图识别结果从全量工具列表中筛选相关工具子集。
 * BaseTool 集合始终包含在过滤结果中。
 */

/** 基础工具集合 — 始终保留，不受过滤影响 */
export const BASE_TOOLS = new Set([
  'keyword_search', 'read_file', 'write_file', 'shell_exec', 'project_tree',
])

export class ToolFilter {
  /**
   * per-session 过滤 — BaseTool 始终包含，filteredToolNames 为空时回退全量。
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

    // 过滤：BaseTool + filteredToolNames
    const keepNames = new Set([...filteredNames, ...BASE_TOOLS])
    return allTools.filter(t => keepNames.has(t.name))
  }
}
