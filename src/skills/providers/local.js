/**
 * 本地文件夹 SkillProvider。扫描 dir 下每个含 SKILL.md 的子目录;
 * fetchSkill 返回 { baseDir }(零拷贝,注册表跳过物化)。
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { parseFrontmatter } from '../model.js'
import { _setBuiltinProvider } from '../provider.js'
import { SkillProviderError } from '../errors.js'

/** 递归列出目录下所有文件的相对路径(POSIX 风格分隔)。 */
async function listFilesRecursive(baseDir) {
  const out = []
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) await walk(full)
      else out.push(relative(baseDir, full).split(sep).join('/'))
    }
  }
  await walk(baseDir)
  return out
}

export function createLocalSkillProvider({ dir }) {
  if (typeof dir !== 'string' || dir.length === 0) {
    throw new SkillProviderError('local skill provider requires a `dir` string', { providerName: 'local' })
  }

  async function listSkills() {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (cause) {
      throw new SkillProviderError(`cannot read skills dir "${dir}"`, { providerName: 'local', cause })
    }
    const result = []
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const skillMd = join(dir, e.name, 'SKILL.md')
      try {
        const text = await readFile(skillMd, 'utf8')
        const { frontmatter } = parseFrontmatter(text)
        result.push({
          name: e.name,
          description: typeof frontmatter.description === 'string' ? frontmatter.description : '',
          version: frontmatter.version ?? null,
        })
      } catch {
        // 无 SKILL.md 的目录跳过
      }
    }
    return result
  }

  async function fetchSkill(name) {
    const baseDir = join(dir, name)
    let files
    try {
      files = await listFilesRecursive(baseDir)
    } catch (cause) {
      throw new SkillProviderError(`cannot read skill dir for "${name}"`, { providerName: 'local', cause })
    }
    return { baseDir, files }
  }

  async function readResource(name, relPath) {
    const baseDir = resolve(dir, name)
    const target = resolve(baseDir, relPath)
    if (target !== baseDir && !target.startsWith(baseDir + sep)) {
      throw new SkillProviderError(`resource path escapes skill dir: "${relPath}"`, { providerName: 'local' })
    }
    return readFile(target, 'utf8')
  }

  return { name: 'local', origin: dir, listSkills, fetchSkill, readResource }
}

_setBuiltinProvider('local', createLocalSkillProvider)
