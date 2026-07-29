import { test } from 'node:test'
import assert from 'node:assert'
import { createHttpSkillProvider } from './http.js'

function mockFetch(routes) {
  return async (url) => {
    const key = String(url)
    if (!(key in routes)) return { ok: false, status: 404, text: async () => 'not found' }
    const body = routes[key]
    return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) }
  }
}

const MANIFEST = JSON.stringify({
  skills: [{ name: 'pdf', description: 'Process PDFs', version: '1.0.0', hash: 'abc', files: ['SKILL.md', 'scripts/run.py'] }],
})

test('listSkills reads manifest.json', async () => {
  const fetchImpl = mockFetch({ 'https://x/manifest.json': MANIFEST })
  const p = createHttpSkillProvider({ baseUrl: 'https://x', fetchImpl })
  const list = await p.listSkills()
  assert.strictEqual(list[0].name, 'pdf')
  assert.strictEqual(list[0].hash, 'abc')
})

test('fetchSkill pulls every file in the manifest entry', async () => {
  const fetchImpl = mockFetch({
    'https://x/manifest.json': MANIFEST,
    'https://x/skills/pdf/SKILL.md': '---\nname: pdf\ndescription: d\n---\nb',
    'https://x/skills/pdf/scripts/run.py': 'print(1)',
  })
  const p = createHttpSkillProvider({ baseUrl: 'https://x', fetchImpl })
  const bundle = await p.fetchSkill('pdf')
  const paths = bundle.files.map(f => f.path).sort()
  assert.deepStrictEqual(paths, ['SKILL.md', 'scripts/run.py'])
  const skillMd = bundle.files.find(f => f.path === 'SKILL.md')
  assert.match(skillMd.content, /description: d/)
})

test('fetchSkill throws SkillProviderError for unknown skill', async () => {
  const fetchImpl = mockFetch({ 'https://x/manifest.json': MANIFEST })
  const p = createHttpSkillProvider({ baseUrl: 'https://x', fetchImpl })
  await assert.rejects(() => p.fetchSkill('nope'), /nope/)
})

test('readResource does a single-file GET', async () => {
  const fetchImpl = mockFetch({ 'https://x/skills/pdf/scripts/run.py': 'print(1)' })
  const p = createHttpSkillProvider({ baseUrl: 'https://x', fetchImpl })
  assert.strictEqual(await p.readResource('pdf', 'scripts/run.py'), 'print(1)')
})

test('trailing slash in baseUrl is normalized', async () => {
  const fetchImpl = mockFetch({ 'https://x/manifest.json': MANIFEST })
  const p = createHttpSkillProvider({ baseUrl: 'https://x/', fetchImpl })
  const list = await p.listSkills()
  assert.strictEqual(list[0].name, 'pdf')
})

test('readResource rejects invalid skill name', async () => {
  const fetchImpl = mockFetch({ 'https://x/skills/pdf/scripts/run.py': 'print(1)' })
  const p = createHttpSkillProvider({ baseUrl: 'https://x', fetchImpl })
  await assert.rejects(() => p.readResource('../evil', 'x'), /invalid|reserved|name/i)
})

test('readResource rejects path traversal in relPath', async () => {
  const fetchImpl = mockFetch({ 'https://x/skills/pdf/scripts/run.py': 'print(1)' })
  const p = createHttpSkillProvider({ baseUrl: 'https://x', fetchImpl })
  await assert.rejects(() => p.readResource('pdf', '../../etc'), /path/i)
})
