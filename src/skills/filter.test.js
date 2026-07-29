import { test } from 'node:test'
import assert from 'node:assert'
import { SkillFilter } from './filter.js'

const SKILLS = Array.from({ length: 5 }, (_, i) => ({
  name: `skill-${i}`, description: `Does thing ${i}`,
}))

function respond(content) {
  return async () => ({ choices: [{ message: { content } }] })
}

test('filter returns Skill_Defs matching LLM-ranked names, in order', async () => {
  const f = new SkillFilter({ url: 'u', apiKey: 'k', model: 'm' })
  f._syncChat = respond('["skill-3","skill-1"]')
  const out = await f.filter('do thing three', SKILLS, { topK: 20 })
  assert.deepStrictEqual(out.map(s => s.name), ['skill-3', 'skill-1'])
})

test('filter truncates to topK', async () => {
  const f = new SkillFilter({ url: 'u', apiKey: 'k', model: 'm' })
  f._syncChat = respond('["skill-0","skill-1","skill-2","skill-3"]')
  const out = await f.filter('x', SKILLS, { topK: 2 })
  assert.strictEqual(out.length, 2)
})

test('filter ignores unknown names from the LLM', async () => {
  const f = new SkillFilter({ url: 'u', apiKey: 'k', model: 'm' })
  f._syncChat = respond('["skill-1","hallucinated"]')
  const out = await f.filter('x', SKILLS, { topK: 20 })
  assert.deepStrictEqual(out.map(s => s.name), ['skill-1'])
})

test('filter extracts JSON array embedded in prose', async () => {
  const f = new SkillFilter({ url: 'u', apiKey: 'k', model: 'm' })
  f._syncChat = respond('Sure! Here you go: ["skill-2"] hope that helps')
  const out = await f.filter('x', SKILLS, { topK: 20 })
  assert.deepStrictEqual(out.map(s => s.name), ['skill-2'])
})

test('filter fails open on LLM error', async () => {
  const f = new SkillFilter({ url: 'u', apiKey: 'k', model: 'm' })
  f._syncChat = async () => { throw new Error('503') }
  const out = await f.filter('x', SKILLS, { topK: 2 })
  assert.strictEqual(out.length, SKILLS.length)
})

test('filter fails open on garbage response', async () => {
  const f = new SkillFilter({ url: 'u', apiKey: 'k', model: 'm' })
  f._syncChat = respond('no json here')
  const out = await f.filter('x', SKILLS, { topK: 2 })
  assert.strictEqual(out.length, SKILLS.length)
})
