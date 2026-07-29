/**
 * SkillProvider 契约 + provider 工厂注册表。
 * 仿 src/mcp/transports/index.js:内置 local/http 经 _setBuiltinProvider 自注册,
 * 用户经 registerSkillProvider 注册自定义类型,保留名不可覆盖。
 */

import { SkillProviderError } from './errors.js'

export const RESERVED_PROVIDER_TYPES = ['local', 'http']

const registry = new Map()

/** 内置 provider 自注册入口(绕过保留名守卫)。 */
export function _setBuiltinProvider(type, factory) {
  registry.set(type, factory)
}

/**
 * 注册自定义 provider 工厂。
 * @param {string} type 非保留、未占用的类型名
 * @param {(opts: object) => object} factory
 * @throws {SkillProviderError}
 */
export function registerSkillProvider(type, factory) {
  if (RESERVED_PROVIDER_TYPES.includes(type)) {
    throw new SkillProviderError(`provider type "${type}" is reserved`, { providerName: type })
  }
  if (registry.has(type)) {
    throw new SkillProviderError(`provider type "${type}" already registered`, { providerName: type })
  }
  if (typeof factory !== 'function') {
    throw new SkillProviderError(`provider factory for "${type}" must be a function`, { providerName: type })
  }
  registry.set(type, factory)
}

/** duck-type 检查:有 listSkills + fetchSkill 即视为 provider 实例。 */
function isProviderInstance(x) {
  return x && typeof x.listSkills === 'function' && typeof x.fetchSkill === 'function'
}

/**
 * 解析配置为 provider 实例。接受实例(原样返回)或 { type, ...opts } 配置。
 * @param {object} config
 * @returns {object} provider 实例
 * @throws {SkillProviderError}
 */
export function resolveProvider(config) {
  if (isProviderInstance(config)) return config
  if (!config || typeof config.type !== 'string') {
    throw new SkillProviderError('skill provider config must have a string `type` or be a provider instance', {})
  }
  const factory = registry.get(config.type)
  if (!factory) {
    throw new SkillProviderError(`unknown skill provider type "${config.type}"`, { providerName: config.type })
  }
  return factory(config)
}
