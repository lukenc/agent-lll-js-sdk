/**
 * Subagent 系统的错误类。
 *
 * 与 `mcp/errors.js` 同一策略：构造函数**只**吸收白名单标量字段，绝不接受
 * 原始 options / transport 配置对象 —— 否则 apiKey、Authorization 头、env
 * 变量会顺着 `err.message` 或错误对象的枚举属性泄进日志。
 */

/** @param {Error} err @param {object} fields */
function assign(err, fields) {
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) err[key] = value
  }
}

export class SubagentError extends Error {
  /**
   * @param {string} message
   * @param {object} [opts]
   * @param {string} [opts.agentId]
   * @param {string} [opts.agentName]
   * @param {string} [opts.nodeId]
   * @param {string} [opts.failureKind]
   * @param {unknown} [opts.cause]
   */
  constructor(message, { agentId, agentName, nodeId, failureKind, cause } = {}) {
    super(message)
    this.name = 'SubagentError'
    assign(this, { agentId, agentName, nodeId, failureKind, cause })
  }
}

export class AgentTypeError extends Error {
  constructor(message, { typeName, cause } = {}) {
    super(message)
    this.name = 'AgentTypeError'
    assign(this, { typeName, cause })
  }
}

export class AgentGraphError extends Error {
  /** @param {object} [opts] @param {string[]} [opts.cycle] 环路径（会被浅复制） */
  constructor(message, { nodeId, cycle, cause } = {}) {
    super(message)
    this.name = 'AgentGraphError'
    assign(this, { nodeId, cause })
    if (Array.isArray(cycle)) this.cycle = [...cycle]
  }
}

export class A2AError extends Error {
  constructor(message, { kind, transport, cause } = {}) {
    super(message)
    this.name = 'A2AError'
    assign(this, { kind, transport, cause })
  }
}

export class WorktreeIsolationError extends Error {
  constructor(message, { reason, cause } = {}) {
    super(message)
    this.name = 'WorktreeIsolationError'
    assign(this, { reason, cause })
  }
}
