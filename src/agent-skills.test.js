// src/agent-skills.test.js
import { test } from 'node:test'
import assert from 'node:assert'
import { Agent } from './agent.js'
import { isBaseTool } from './tool-filter.js'

const SKILL_MD = (name, desc) => `---\nname: ${name}\ndescription: ${desc}\n---\nInstructions for ${name}`

function memProvider(skills, { disabled = [] } = {}) {
  return {
    name: 'mem', origin: 'mem:test',
    async listSkills() { return Object.keys(skills).map(n => ({ name: n, description: skills[n] })) },
    async fetchSkill(n) {
      const dmi = disabled.includes(n) ? 'disable-model-invocation: true\n' : ''
      return { files: [
        { path: 'SKILL.md', content: `---\nname: ${n}\ndescription: ${skills[n]}\n${dmi}---\nInstructions for ${n}` },
        { path: 'references/doc.md', content: 'ref content' },
      ] }
    },
    async readResource(n, rel) { return 'ref content' },
  }
}

function makeAgent(skillsOpts) {
  return new Agent({
    provider: 'openai', apiKey: 'test-key',
    skills: skillsOpts,
  })
}

test('skill meta-tool is injected when skills configured', () => {
  const agent = makeAgent({ providers: [memProvider({ alpha: 'A' })], runtime: 'browser' })
  assert.ok(agent.tools.find(t => t.name === 'skill'))
})

test('skill_resource tool injected only in browser runtime', () => {
  const browser = makeAgent({ providers: [memProvider({ a: 'A' })], runtime: 'browser' })
  assert.ok(browser.tools.find(t => t.name === 'skill_resource'))
  const node = makeAgent({ providers: [memProvider({ a: 'A' })], runtime: 'node' })
  assert.strictEqual(node.tools.find(t => t.name === 'skill_resource'), undefined)
})

test('no skill tools when skills not configured', () => {
  const agent = new Agent({ provider: 'openai', apiKey: 'k' })
  assert.strictEqual(agent.skills, null)
  assert.strictEqual(agent.tools.find(t => t.name === 'skill'), undefined)
})

test('_withSkillListingNote merges Claude Code style block into system message', async () => {
  const agent = makeAgent({ providers: [memProvider({ alpha: 'Does A' })], runtime: 'browser' })
  await agent.loadSkills()
  // parseSkillMd (Task 2, locked contract) rejects an empty `description` in
  // SKILL.md — so the empty-description branch of _withSkillListingNote can
  // never be reached via the real provider->parser pipeline. Exercise it
  // directly by stubbing list() with a synthetic entry.
  const origList = agent.skills.list.bind(agent.skills)
  agent.skills.list = () => [...origList(), { name: 'beta', description: '', disableModelInvocation: false }]
  const out = agent._withSkillListingNote([{ role: 'system', content: 'BASE' }])
  assert.match(out[0].content, /^BASE\n\nThe following skills are available for use with the Skill tool:/)
  assert.match(out[0].content, /- alpha: Does A/)
  assert.match(out[0].content, /- beta$/m) // no trailing colon when description empty
})

test('disable-model-invocation skills omitted from listing but accessible via get', async () => {
  const agent = makeAgent({ providers: [memProvider({ vis: 'V', hid: 'H' }, { disabled: ['hid'] })], runtime: 'browser' })
  await agent.loadSkills()
  const out = agent._withSkillListingNote([{ role: 'system', content: '' }])
  assert.ok(out[0].content.includes('- vis'))
  assert.ok(!out[0].content.includes('- hid'))
  assert.ok(agent.skills.get('hid'))
})

test('skill tool execute returns body + browser Level 3 note', async () => {
  const agent = makeAgent({ providers: [memProvider({ alpha: 'A' })], runtime: 'browser' })
  await agent.loadSkills()
  const result = await agent._invokeSkill('alpha')
  assert.match(result, /Instructions for alpha/)
  assert.match(result, /Bundled files: references\/doc\.md/)
  assert.match(result, /skill_resource tool/)
})

test('skill tool soft-fails on unknown name with valid list', async () => {
  const agent = makeAgent({ providers: [memProvider({ alpha: 'A' })], runtime: 'browser' })
  await agent.loadSkills()
  const result = await agent._invokeSkill('nope')
  assert.match(result, /unknown skill "nope"/)
  assert.match(result, /alpha/)
})

test('filter triggers only above threshold and narrows the listing', async () => {
  const many = {}
  for (let i = 0; i < 4; i++) many[`s-${i}`] = `Does ${i}`
  const agent = makeAgent({
    providers: [memProvider(many)], runtime: 'browser',
    filter: { threshold: 3, topK: 2 },
  })
  await agent.loadSkills()
  agent._skillFilter._syncChat = async () => ({ choices: [{ message: { content: '["s-2","s-0"]' } }] })
  // 模拟 _runPipeline 的过滤步骤
  const all = agent.skills.list().filter(s => !s.disableModelInvocation)
  assert.ok(all.length > 3)
  agent._filteredSkills = await agent._skillFilter.filter('msg', all, { topK: 2 })
  const out = agent._withSkillListingNote([{ role: 'system', content: '' }])
  assert.ok(out[0].content.includes('- s-2'))
  assert.ok(out[0].content.includes('- s-0'))
  assert.ok(!out[0].content.includes('- s-1'))
})

test('loadSkills is memoized (providers hit once)', async () => {
  let listCalls = 0
  const p = {
    name: 'mem', origin: 'x',
    async listSkills() { listCalls++; return [{ name: 'a', description: 'A' }] },
    async fetchSkill() { return { files: [{ path: 'SKILL.md', content: SKILL_MD('a', 'A') }] } },
  }
  const agent = makeAgent({ providers: [p], runtime: 'browser' })
  await Promise.all([agent.loadSkills(), agent.loadSkills()])
  await agent.loadSkills()
  assert.strictEqual(listCalls, 1)
})

test('refreshSkills bumps _toolsGeneration', async () => {
  const agent = makeAgent({ providers: [memProvider({ a: 'A' })], runtime: 'browser' })
  await agent.loadSkills()
  const gen = agent._toolsGeneration
  await agent.refreshSkills()
  assert.ok(agent._toolsGeneration > gen)
})

test('loadSkills heals memoized rejection: first call rejects, second call succeeds and loads skills', async () => {
  // registry.load() itself isolates provider-level failures (warn + skip), so it
  // never rejects from a bad provider. The memo-healing guarantee in loadSkills()
  // covers unexpected failures from the registry's load() itself (e.g. a future
  // registry bug, or any thrown error that escapes provider isolation). Simulate
  // that directly by stubbing skills.load() to fail once then succeed.
  const agent = makeAgent({ providers: [memProvider({ a: 'A' })], runtime: 'browser' })
  const realLoad = agent.skills.load.bind(agent.skills)
  let attempt = 0
  agent.skills.load = async () => {
    attempt++
    if (attempt === 1) throw new Error('registry blew up')
    return realLoad()
  }
  await assert.rejects(() => agent.loadSkills(), /registry blew up/)
  await agent.loadSkills()
  assert.ok(agent.skills.get('a'))
})

test('refreshSkills sets the load memo so a pre-chat refresh is not followed by a redundant load', async () => {
  let listCalls = 0
  const p = {
    name: 'mem', origin: 'x',
    async listSkills() { listCalls++; return [{ name: 'a', description: 'A' }] },
    async fetchSkill() { return { files: [{ path: 'SKILL.md', content: SKILL_MD('a', 'A') }] } },
  }
  const agent = makeAgent({ providers: [p], runtime: 'browser' })
  await agent.refreshSkills()
  assert.strictEqual(listCalls, 1)
  await agent.loadSkills()
  assert.strictEqual(listCalls, 1) // loadSkills reuses the promise refreshSkills already set
})

test('skill and skill_resource tools are registered as base tools (immune to ToolFilter)', () => {
  const browser = makeAgent({ providers: [memProvider({ alpha: 'A' })], runtime: 'browser' })
  assert.ok(browser.tools.find(t => t.name === 'skill'))
  assert.strictEqual(isBaseTool('skill'), true)
  assert.strictEqual(isBaseTool('skill_resource'), true)

  const node = makeAgent({ providers: [memProvider({ alpha: 'A' })], runtime: 'node' })
  assert.ok(node.tools.find(t => t.name === 'skill'))
  assert.strictEqual(isBaseTool('skill'), true)
})
