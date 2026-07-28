/**
 * 内存包物化(仅 Node)。写入 cacheDir/<name>/,采用先写临时目录再原子 rename,
 * 避免半包状态。旧目录先删除再替换,确保覆盖干净。
 */

import { mkdir, writeFile, rm, rename } from 'node:fs/promises'
import { join, dirname, sep } from 'node:path'
import { homedir } from 'node:os'
import { SkillMaterializeError } from './errors.js'

export function defaultCacheDir() {
  return join(homedir(), '.lll-agent', 'skills-cache')
}

/**
 * @param {string} name skill 名
 * @param {{ files: Array<{ path: string, content: string|Uint8Array }> }} bundle
 * @param {{ cacheDir: string }} opts
 * @returns {Promise<{ baseDir: string, files: string[] }>}
 */
export async function materializeBundle(name, bundle, { cacheDir }) {
  const baseDir = join(cacheDir, name)
  const tmpDir = join(cacheDir, `.tmp-${name}-${process.pid}`)
  const files = Array.isArray(bundle?.files) ? bundle.files : []
  try {
    await rm(tmpDir, { recursive: true, force: true })
    await mkdir(tmpDir, { recursive: true })
    for (const f of files) {
      const rel = String(f.path).split('/').join(sep)
      const target = join(tmpDir, rel)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, f.content)
    }
    await rm(baseDir, { recursive: true, force: true })
    await mkdir(dirname(baseDir), { recursive: true })
    await rename(tmpDir, baseDir)
  } catch (cause) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    throw new SkillMaterializeError(`failed to materialize skill "${name}"`, { skillName: name, cause })
  }
  return { baseDir, files: files.map(f => f.path) }
}
