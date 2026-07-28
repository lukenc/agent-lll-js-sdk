import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { materializeBundle, defaultCacheDir } from './materializer.js'

test('defaultCacheDir points under home/.lll-agent', () => {
  assert.match(defaultCacheDir(), /\.lll-agent[\/\\]skills-cache$/)
})

test('materializeBundle writes files and returns baseDir', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'skills-cache-'))
  try {
    const bundle = { files: [
      { path: 'SKILL.md', content: '---\nname: pdf\ndescription: d\n---\nb' },
      { path: 'scripts/run.py', content: 'print(1)' },
    ] }
    const { baseDir, files } = await materializeBundle('pdf', bundle, { cacheDir })
    assert.strictEqual(baseDir, join(cacheDir, 'pdf'))
    assert.ok(files.includes('SKILL.md'))
    assert.ok(files.includes('scripts/run.py'))
    assert.strictEqual(await readFile(join(baseDir, 'scripts', 'run.py'), 'utf8'), 'print(1)')
  } finally { await rm(cacheDir, { recursive: true, force: true }) }
})

test('materializeBundle overwrites an existing skill dir cleanly', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'skills-cache-'))
  try {
    await materializeBundle('pdf', { files: [{ path: 'old.txt', content: 'old' }] }, { cacheDir })
    const { baseDir } = await materializeBundle('pdf', { files: [{ path: 'SKILL.md', content: 'new' }] }, { cacheDir })
    await assert.rejects(() => readFile(join(baseDir, 'old.txt'), 'utf8'))
    assert.strictEqual(await readFile(join(baseDir, 'SKILL.md'), 'utf8'), 'new')
  } finally { await rm(cacheDir, { recursive: true, force: true }) }
})
