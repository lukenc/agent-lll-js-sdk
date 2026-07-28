import { test } from 'node:test'
import assert from 'node:assert'
import { createSkillRegistry } from './registry.js'

const SKILL_MD = (name, desc) => `---\nname: ${name}\ndescription: ${desc}\n---\nBody of ${name}`

function memProvider(name, skills, { hash = null } = {}) {
  // skills: { skillName: description }
  return {
    name,
    origin: `mem:${name}`,
    calls: { fetch: [] },
    async listSkills() {
      return Object.keys(skills).map(n => ({ name: n, description: skills[n], hash }))
    },
    async fetchSkill(n) {
      this.calls.fetch.push(n)
      if (!(n in skills)) throw new Error(`no skill ${n}`)
      return { files: [{ path: 'SKILL.md', content: SKILL_MD(n, skills[n]) }, { path: 'references/doc.md', content: 'ref' }] }
    },
    async readResource(n, rel) {
      if (rel === 'references/doc.md') return 'ref'
      throw new Error('not found')
    },
  }
}

test('load builds Skill_Def list from in-memory bundles (browser runtime)', async () => {
  const reg = createSkillRegistry({ providers: [memProvider('p1', { alpha: 'A skill' })], runtime: 'browser' })
  await reg.load()
  const defs = reg.list()
  assert.strictEqual(defs.length, 1)
  assert.strictEqual(defs[0].name, 'alpha')
  assert.strictEqual(defs[0].body, 'Body of alpha')
  assert.strictEqual(defs[0].baseDir, null)
  assert.deepStrictEqual(defs[0].files, ['SKILL.md', 'references/doc.md'])
  assert.strictEqual(defs[0].source.provider, 'p1')
})

test('cross-provider duplicate: first provider wins', async () => {
  const p1 = memProvider('p1', { alpha: 'from p1' })
  const p2 = memProvider('p2', { alpha: 'from p2', beta: 'B' })
  const reg = createSkillRegistry({ providers: [p1, p2], runtime: 'browser' })
  await reg.load()
  assert.strictEqual(reg.get('alpha').source.provider, 'p1')
  assert.ok(reg.get('beta'))
})

test('single skill failure does not abort load', async () => {
  const p = memProvider('p1', { good: 'G' })
  const broken = {
    name: 'p2', origin: 'mem:p2',
    async listSkills() { return [{ name: 'bad', description: 'B' }] },
    async fetchSkill() { throw new Error('boom') },
  }
  const reg = createSkillRegistry({ providers: [broken, p], runtime: 'browser' })
  await reg.load()
  assert.strictEqual(reg.get('bad'), null)
  assert.ok(reg.get('good'))
})

test('provider listSkills failure skips that provider only', async () => {
  const dead = { name: 'dead', origin: 'x', async listSkills() { throw new Error('net') }, async fetchSkill() {} }
  const reg = createSkillRegistry({ providers: [dead, memProvider('p1', { ok: 'O' })], runtime: 'browser' })
  await reg.load()
  assert.ok(reg.get('ok'))
})

test('refresh skips unchanged hashes, refetches changed', async () => {
  const p = memProvider('p1', { alpha: 'A' }, { hash: 'h1' })
  const reg = createSkillRegistry({ providers: [p], runtime: 'browser' })
  await reg.load()
  assert.strictEqual(p.calls.fetch.length, 1)
  await reg.refresh()
  assert.strictEqual(p.calls.fetch.length, 1) // hash unchanged → no refetch
  const gen1 = reg.generation
  assert.ok(gen1 >= 2)
})

test('readResource delegates to owning provider and blocks traversal', async () => {
  const reg = createSkillRegistry({ providers: [memProvider('p1', { alpha: 'A' })], runtime: 'browser' })
  await reg.load()
  assert.strictEqual(await reg.readResource('alpha', 'references/doc.md'), 'ref')
  await assert.rejects(() => reg.readResource('alpha', '../escape'))
  await assert.rejects(() => reg.readResource('nope', 'x'))
})

test('node runtime materializes in-memory bundles to cacheDir', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const cacheDir = await mkdtemp(join(tmpdir(), 'skills-reg-'))
  try {
    const reg = createSkillRegistry({ providers: [memProvider('p1', { alpha: 'A' })], runtime: 'node', cacheDir })
    await reg.load()
    assert.strictEqual(reg.get('alpha').baseDir, join(cacheDir, 'alpha'))
  } finally { await rm(cacheDir, { recursive: true, force: true }) }
})
