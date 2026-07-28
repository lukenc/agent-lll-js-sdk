import { test } from 'node:test'
import assert from 'node:assert'
import {
  registerSkillProvider, resolveProvider, _setBuiltinProvider,
} from './provider.js'
import { SkillProviderError } from './errors.js'

test('resolveProvider passes through a duck-typed instance', () => {
  const inst = { name: 'custom', listSkills: async () => [], fetchSkill: async () => ({}) }
  assert.strictEqual(resolveProvider(inst), inst)
})

test('resolveProvider builds from a registered type', () => {
  _setBuiltinProvider('local', (opts) => ({ name: 'local', dir: opts.dir, listSkills: async () => [], fetchSkill: async () => ({}) }))
  const p = resolveProvider({ type: 'local', dir: '/x' })
  assert.strictEqual(p.dir, '/x')
})

test('resolveProvider throws on unknown type', () => {
  assert.throws(() => resolveProvider({ type: 'nope' }), SkillProviderError)
})

test('registerSkillProvider rejects reserved names', () => {
  assert.throws(() => registerSkillProvider('local', () => ({})), SkillProviderError)
  assert.throws(() => registerSkillProvider('http', () => ({})), SkillProviderError)
})

test('registerSkillProvider allows a new custom type then resolves it', () => {
  registerSkillProvider('memory', (opts) => ({ name: 'memory', tag: opts.tag, listSkills: async () => [], fetchSkill: async () => ({}) }))
  const p = resolveProvider({ type: 'memory', tag: 't1' })
  assert.strictEqual(p.tag, 't1')
})
