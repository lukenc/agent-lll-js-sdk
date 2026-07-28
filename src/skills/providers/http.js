/**
 * HTTP SkillProvider。wire 协议:
 *   GET {baseUrl}/manifest.json → { skills: [{ name, description, version, hash, files }] }
 *   GET {baseUrl}/skills/{name}/{relPath} → 文件内容
 * fetchSkill 返回内存包 { files: [{ path, content }] },由注册表在 Node 下物化。
 */

import { NAME_RE } from '../model.js'
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
    let text
    try {
      text = await resp.text()
    } catch (cause) {
      throw new SkillProviderError(`cannot read response body for ${url}`, { providerName: 'http', cause })
    }
    return text
  }

  function encodePathSegments(relPath) {
    const rel = String(relPath)
    if (rel.startsWith('/')) {
      throw new SkillProviderError('relative path must not start with /', { providerName: 'http' })
    }
    const segs = rel.split('/')
    for (const seg of segs) {
      if (seg === '' || seg === '..') {
        throw new SkillProviderError(`invalid path segment: "${seg}"`, { providerName: 'http' })
      }
    }
    return segs.map(encodeURIComponent).join('/')
  }

  async function getManifest() {
    const bodyText = await getText(`${base}/manifest.json`)
    let obj
    try {
      obj = JSON.parse(bodyText)
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
    if (!NAME_RE.test(name)) {
      throw new SkillProviderError(`invalid skill name "${name}" (must match ${NAME_RE})`, { providerName: 'http' })
    }
    const entry = (await getManifest()).find(s => s.name === name)
    if (!entry) {
      throw new SkillProviderError(`skill "${name}" not in manifest`, { providerName: 'http' })
    }
    const relPaths = Array.isArray(entry.files) ? entry.files : ['SKILL.md']
    const files = []
    for (const rel of relPaths) {
      const encodedRel = encodePathSegments(rel)
      const encodedName = encodeURIComponent(name)
      const content = await getText(`${base}/skills/${encodedName}/${encodedRel}`)
      files.push({ path: rel, content })
    }
    return { files }
  }

  async function readResource(name, relPath) {
    if (!NAME_RE.test(name)) {
      throw new SkillProviderError(`invalid skill name "${name}" (must match ${NAME_RE})`, { providerName: 'http' })
    }
    const encodedRel = encodePathSegments(relPath)
    const encodedName = encodeURIComponent(name)
    return getText(`${base}/skills/${encodedName}/${encodedRel}`)
  }

  return { name: 'http', origin: base, listSkills, fetchSkill, readResource }
}

_setBuiltinProvider('http', createHttpSkillProvider)
