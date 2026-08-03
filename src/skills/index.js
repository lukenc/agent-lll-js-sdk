/**
 * Skill 子系统入口。导入 providers 触发内置 provider 自注册
 * (local 内部使用动态 import('node:fs/promises'),浏览器打包安全)。
 */

export { createSkillRegistry } from './registry.js'
export { registerSkillProvider, resolveProvider } from './provider.js'
export { createLocalSkillProvider } from './providers/local.js'
export { createHttpSkillProvider } from './providers/http.js'
export { SkillFilter } from './filter.js'
export { parseFrontmatter, parseSkillMd, applySkillArgs } from './model.js'
export {
  SkillLoadError, SkillParseError, SkillMaterializeError, SkillProviderError,
} from './errors.js'
