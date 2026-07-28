import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalSkillProvider } from './local.js'

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'skills-local-'))
  await mkdir(join(root, 'pdf'), { recursive: true })
  await writeFile(join(root, 'pdf', 'SKILL.md'), '---\nname: pdf\ndescription: Process PDFs\n---\nBody')
  await mkdir(join(root, 'pdf', 'scripts'), { recursive: true })
  await writeFile(join(root, 'pdf', 'scripts', 'run.py'), 'print(1)')
  await mkdir(join(root, 'not-a-skill'), { recursive: true }) // no SKILL.md
  return root
}

test('listSkills returns only dirs with SKILL.md, reading frontmatter', async () => {
  const root = await setup()
  try {
    const p = createLocalSkillProvider({ dir: root })
    const list = await p.listSkills()
    assert.strictEqual(list.length, 1)
    assert.strictEqual(list[0].name, 'pdf')
    assert.strictEqual(list[0].description, 'Process PDFs')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('fetchSkill returns baseDir and file list', async () => {
  const root = await setup()
  try {
    const p = createLocalSkillProvider({ dir: root })
    const bundle = await p.fetchSkill('pdf')
    assert.strictEqual(bundle.baseDir, join(root, 'pdf'))
    assert.ok(bundle.files.includes('SKILL.md'))
    assert.ok(bundle.files.includes('scripts/run.py'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('readResource reads a bundled file', async () => {
  const root = await setup()
  try {
    const p = createLocalSkillProvider({ dir: root })
    const content = await p.readResource('pdf', 'scripts/run.py')
    assert.strictEqual(content, 'print(1)')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('readResource rejects path traversal', async () => {
  const root = await setup()
  try {
    const p = createLocalSkillProvider({ dir: root })
    await assert.rejects(() => p.readResource('pdf', '../not-a-skill/x'))
  } finally { await rm(root, { recursive: true, force: true }) }
})
