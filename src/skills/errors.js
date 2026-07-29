/**
 * Skill 子系统错误类。构造函数只接收白名单标量字段
 * (skillName / providerName / cause),绝不接收原始 options 对象,
 * 防止 API key、headers 等敏感值泄漏进 err.message 或 err 自身属性。
 * 与 src/mcp/errors.js 同款设计。
 */

export class SkillLoadError extends Error {
  constructor(message, { skillName, providerName, cause } = {}) {
    super(message)
    this.name = 'SkillLoadError'
    if (skillName !== undefined) this.skillName = skillName
    if (providerName !== undefined) this.providerName = providerName
    if (cause !== undefined) this.cause = cause
  }
}

export class SkillParseError extends Error {
  constructor(message, { skillName, cause } = {}) {
    super(message)
    this.name = 'SkillParseError'
    if (skillName !== undefined) this.skillName = skillName
    if (cause !== undefined) this.cause = cause
  }
}

export class SkillMaterializeError extends Error {
  constructor(message, { skillName, cause } = {}) {
    super(message)
    this.name = 'SkillMaterializeError'
    if (skillName !== undefined) this.skillName = skillName
    if (cause !== undefined) this.cause = cause
  }
}

export class SkillProviderError extends Error {
  constructor(message, { providerName, cause } = {}) {
    super(message)
    this.name = 'SkillProviderError'
    if (providerName !== undefined) this.providerName = providerName
    if (cause !== undefined) this.cause = cause
  }
}
