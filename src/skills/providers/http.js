/**
 * HTTP SkillProvider。wire 协议:
 *   GET {baseUrl}/manifest.json → { skills: [{ name, description, version, hash, files }] }
 *   GET {baseUrl}/skills/{name}/{relPath} → 文件内容
 * fetchSkill 返回内存包 { files: [{ path, content }] },由注册表在 Node 下物化。
 */

import { _setBuiltinProvider } from '../provider.js'
import { SkillProviderError } from '../errors.js'

export function createHttpSkillProvider({ baseUrl, headers = {}, fetchImpl } = {}) {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    throw new SkillProviderError('http skill provider requires a `baseUrl` string', { providerName: 'http' })
  }
  const base = baseUrl.replace(/\/+$/, '')
  const doFetch = fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') {
    throw new SkillProviderError('no fetch implementation available', { providerName: 'http' })
  }

  async function getText(url) {
    let resp
    try {
      resp = await doFetch(url, { headers })
    } catch (cause) {
      throw new SkillProviderError(`fetch failed for ${url}`, { providerName: 'http', cause })
    }
    if (!resp.ok) {
      throw new SkillProviderError(`HTTP ${resp.status} for ${url}`, { providerName: 'http' })
    }
    return resp.text()
  }

  async function getManifest() {
    const text = await getText(`${base}/manifest.json`)
    let obj
    try {
      obj = JSON.parse(text)
    } catch (cause) {
      throw new SkillProviderError('manifest.json is not valid JSON', { providerName: 'http', cause })
    }
    const skills = Array.isArray(obj?.skills) ? obj.skills : []
    return skills
  }

  async function listSkills() {
    return (await getManifest()).map(s => ({
      name: s.name,
      description: typeof s.description === 'string' ? s.description : '',
      version: s.version ?? null,
      hash: s.hash ?? null,
    }))
  }

  async function fetchSkill(name) {
    const entry = (await getManifest()).find(s => s.name === name)
    if (!entry) {
      throw new SkillProviderError(`skill "${name}" not in manifest`, { providerName: 'http' })
    }
    const relPaths = Array.isArray(entry.files) ? entry.files : ['SKILL.md']
    const files = []
    for (const rel of relPaths) {
      const content = await getText(`${base}/skills/${name}/${rel}`)
      files.push({ path: rel, content })
    }
    return { files }
  }

  async function readResource(name, relPath) {
    return getText(`${base}/skills/${name}/${relPath}`)
  }

  return { name: 'http', origin: base, listSkills, fetchSkill, readResource }
}

_setBuiltinProvider('http', createHttpSkillProvider)
