import { test } from 'node:test'
import assert from 'node:assert'
import {
  SkillLoadError, SkillParseError, SkillMaterializeError, SkillProviderError,
} from './errors.js'

test('SkillParseError carries skillName and message, no raw options leak', () => {
  const err = new SkillParseError('missing description', { skillName: 'pdf' })
  assert.strictEqual(err.name, 'SkillParseError')
  assert.strictEqual(err.skillName, 'pdf')
  assert.match(err.message, /missing description/)
  assert.ok(err instanceof Error)
})

test('SkillProviderError carries providerName and cause', () => {
  const cause = new Error('network down')
  const err = new SkillProviderError('listSkills failed', { providerName: 'http', cause })
  assert.strictEqual(err.name, 'SkillProviderError')
  assert.strictEqual(err.providerName, 'http')
  assert.strictEqual(err.cause, cause)
})

test('errors never store a whole options object', () => {
  const err = new SkillLoadError('boom', { skillName: 'x', apiKey: 'SECRET' })
  assert.strictEqual(err.apiKey, undefined)
  assert.ok(!JSON.stringify({ ...err }).includes('SECRET'))
})
