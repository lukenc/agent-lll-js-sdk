/**
 * SkillRegistry — 聚合多 Provider,全量急切加载为内存 Skill_Def[]。
 * 重名 first-wins;单 skill / 单 provider 失败隔离(warn + skip);
 * refresh 按 hash 差异跳过未变更 skill。浏览器运行时不物化(baseDir=null)。
 */

import { resolveProvider } from './provider.js'
import { parseSkillMd } from './model.js'

function detectRuntime(runtime) {
  if (runtime === 'node' || runtime === 'browser') return runtime
  return (typeof process !== 'undefined' && process.versions?.node) ? 'node' : 'browser'
}

export function createSkillRegistry({ providers = [], cacheDir, runtime = 'auto' } = {}) {
  const resolved = providers.map(resolveProvider)
  const mode = detectRuntime(runtime)
  // name → { def, provider, hash }
  const entries = new Map()

  async function buildDef(provider, name, hash) {
    const bundle = await provider.fetchSkill(name)
    let text, files, baseDir
    if (bundle && typeof bundle.baseDir === 'string') {
      // 已在磁盘(local provider):零拷贝
      const { readFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      text = await readFile(join(bundle.baseDir, 'SKILL.md'), 'utf8')
      files = Array.isArray(bundle.files) ? bundle.files : []
      baseDir = bundle.baseDir
    } else {
      // 内存包
      const memFiles = Array.isArray(bundle?.files) ? bundle.files : []
      const skillMd = memFiles.find(f => f.path === 'SKILL.md')
      if (!skillMd) throw new Error(`bundle for "${name}" has no SKILL.md`)
      text = typeof skillMd.content === 'string' ? skillMd.content : new TextDecoder().decode(skillMd.content)
      files = memFiles.map(f => f.path)
      if (mode === 'node') {
        const { materializeBundle, defaultCacheDir } = await import('./materializer.js')
        const out = await materializeBundle(name, bundle, { cacheDir: cacheDir ?? defaultCacheDir() })
        baseDir = out.baseDir
      } else {
        baseDir = null
      }
    }
    const def = parseSkillMd(text, {
      dirName: name,
      source: { provider: provider.name, origin: provider.origin },
      files,
      baseDir,
    })
    return { def, provider, hash: hash ?? null }
  }

  async function loadInto(target) {
    for (const provider of resolved) {
      let listed
      try {
        listed = await provider.listSkills()
      } catch (e) {
        console.warn(`[skills] provider "${provider.name}" listSkills failed, skipping:`, e.message)
        continue
      }
      for (const item of listed) {
        const name = item?.name
        if (typeof name !== 'string' || name.length === 0) continue
        if (target.has(name)) {
          console.warn(`[skills] duplicate skill "${name}" from provider "${provider.name}" skipped (first wins)`)
          continue
        }
        // refresh 优化:hash 非空且与旧条目一致 → 复用旧 Skill_Def
        const prev = entries.get(name)
        if (prev && prev.hash !== null && item.hash === prev.hash && prev.provider === provider) {
          target.set(name, prev)
          continue
        }
        try {
          target.set(name, await buildDef(provider, name, item.hash))
        } catch (e) {
          console.warn(`[skills] failed to load skill "${name}":`, e.message)
        }
      }
    }
  }

  const registry = {
    generation: 0,

    async load() {
      const next = new Map()
      await loadInto(next)
      entries.clear()
      for (const [k, v] of next) entries.set(k, v)
      registry.generation++
    },

    async refresh() {
      return registry.load()
    },

    list() {
      return [...entries.values()].map(e => e.def)
    },

    get(name) {
      return entries.get(name)?.def ?? null
    },

    async readResource(name, relPath) {
      const entry = entries.get(name)
      if (!entry) throw new Error(`unknown skill "${name}"`)
      const rel = String(relPath)
      if (rel.split('/').includes('..') || rel.startsWith('/')) {
        throw new Error(`invalid resource path "${relPath}"`)
      }
      if (typeof entry.provider.readResource !== 'function') {
        throw new Error(`provider "${entry.provider.name}" does not support readResource`)
      }
      return entry.provider.readResource(name, rel)
    },
  }

  return registry
}
