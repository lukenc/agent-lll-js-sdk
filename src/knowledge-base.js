/**
 * KnowledgeBase — 知识库管理器
 * 对应 Java 框架的 fc.runtime.KnowledgeBase
 *
 * 管理项目知识条目，按类型分类，支持注入到 prompt 中。
 * Node.js 环境下支持持久化到磁盘；浏览器环境下仅内存模式。
 */

/**
 * @typedef {'GENERAL'|'ARCHITECTURE'|'ERROR_PATTERN'} KnowledgeType
 */

/**
 * @typedef {object} KnowledgeEntry
 * @property {string} id
 * @property {KnowledgeType} type
 * @property {string} title
 * @property {string} content
 * @property {number} createdAt - timestamp ms
 */

/** 按优先级排序的类型顺序 */
const TYPE_ORDER = ['ARCHITECTURE', 'GENERAL', 'ERROR_PATTERN']
const TYPE_HEADERS = {
  ARCHITECTURE: '## 项目架构',
  GENERAL: '## 通用知识',
  ERROR_PATTERN: '## 错误避免模式',
}

export class KnowledgeBase {
  constructor() {
    /** @type {Map<string, KnowledgeEntry>} */
    this.entries = new Map()
  }

  /**
   * 添加知识条目
   * @param {KnowledgeEntry} entry
   */
  addEntry(entry) {
    if (entry) this.entries.set(entry.id, entry)
  }

  /**
   * 移除知识条目
   * @param {string} entryId
   */
  removeEntry(entryId) {
    this.entries.delete(entryId)
  }

  /**
   * 按类型查询
   * @param {KnowledgeType} type
   * @returns {KnowledgeEntry[]}
   */
  getEntriesByType(type) {
    return [...this.entries.values()].filter(e => e.type === type)
  }

  /**
   * 将所有知识条目格式化为可注入系统提示词的文本片段。
   * 按 ARCHITECTURE → GENERAL → ERROR_PATTERN 优先级排序。
   * @returns {string}
   */
  buildKnowledgePrompt() {
    let result = ''
    for (const type of TYPE_ORDER) {
      const list = this.getEntriesByType(type)
      if (list.length > 0) {
        result += TYPE_HEADERS[type] + '\n\n'
        for (const e of list) {
          result += `### ${e.title}\n${e.content}\n\n`
        }
      }
    }
    return result
  }

  get size() {
    return this.entries.size
  }
}

/**
 * 创建一个 KnowledgeEntry 的便捷工厂
 * @param {KnowledgeType} type
 * @param {string} title
 * @param {string} content
 * @returns {KnowledgeEntry}
 */
export function createKnowledgeEntry(type, title, content) {
  return {
    id: `kb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    title,
    content,
    createdAt: Date.now(),
  }
}
