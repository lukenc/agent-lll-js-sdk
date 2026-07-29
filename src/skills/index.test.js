import { test } from 'node:test'
import assert from 'node:assert'

test('skills/index.js exports the full public surface', async () => {
  const m = await import('./index.js')
  for (const name of [
    'createSkillRegistry', 'registerSkillProvider',
    'createLocalSkillProvider', 'createHttpSkillProvider', 'SkillFilter',
    'SkillLoadError', 'SkillParseError', 'SkillMaterializeError', 'SkillProviderError',
  ]) {
    assert.strictEqual(typeof m[name], 'function', `missing export: ${name}`)
  }
})

test('src/index.js re-exports the skill surface', async () => {
  const m = await import('../index.js')
  assert.strictEqual(typeof m.createSkillRegistry, 'function')
  assert.strictEqual(typeof m.registerSkillProvider, 'function')
  assert.strictEqual(typeof m.SkillFilter, 'function')
  assert.strictEqual(typeof m.SkillLoadError, 'function')
})

test('built-in provider types resolve after importing index', async () => {
  await import('./index.js')
  const { resolveProvider } = await import('./provider.js')
  const p = resolveProvider({ type: 'http', baseUrl: 'https://x' })
  assert.strictEqual(p.name, 'http')
})
