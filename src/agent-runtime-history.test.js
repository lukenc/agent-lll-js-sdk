import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { Agent } from './agent.js'
import { SlidingWindowMemory } from './memory.js'

describe('Agent runtime history APIs', () => {
  it('getHistory(trackName) reads built-in memory runtime tracks', async () => {
    const memory = new SlidingWindowMemory(10)
    const agent = new Agent({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      memory,
    })

    agent.memory.add({ role: 'user', content: 'hello' })
    agent.memory.add({ role: 'assistant', content: 'hi' })

    assert.deepEqual(
      (await agent.getHistory('visible')).map(m => m.content),
      ['hello', 'hi'],
    )
    assert.equal((await agent.getHistory('all')).length, 3)
  })

  it('getHistory() falls back for custom memory without runtimeHistory', async () => {
    const customMemory = {
      _messages: [{ role: 'user', content: 'custom' }],
      add(message) { this._messages.push(message) },
      getMessages() { return this._messages.slice() },
      getHistory() { return this._messages.filter(m => m.role !== 'system') },
      clear() { this._messages = [] },
    }
    const agent = new Agent({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      memory: customMemory,
    })

    assert.deepEqual(await agent.getHistory('visible'), [{ role: 'user', content: 'custom' }])
    assert.deepEqual(await agent.getArtifacts(), [])
  })
})

const originalFetch = globalThis.fetch
let responseQueue = []

function installFetchMock() {
  responseQueue = []
  globalThis.fetch = async () => {
    const next = responseQueue.shift()
    if (!next) throw new Error('mock fetch exhausted')
    return {
      ok: true,
      status: 200,
      async json() { return next },
      async text() { return JSON.stringify(next) },
    }
  }
}

function restoreFetchMock() {
  globalThis.fetch = originalFetch
}

function queue(content) {
  responseQueue.push({ choices: [{ message: { content } }] })
}

describe('Agent PlanAndExecute artifacts', () => {
  before(installFetchMock)
  after(restoreFetchMock)
  beforeEach(() => { responseQueue = [] })

  it('records plan and final synthesis artifacts when using built-in memory', async () => {
    const agent = new Agent({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      strategy: 'plan_and_execute',
      memory: new SlidingWindowMemory(50),
    })

    queue(JSON.stringify([{ step: 1, description: 'Do the work' }]))
    queue('step result')

    const reply = await agent.chat('make a plan')
    assert.equal(reply, 'step result')

    const artifacts = await agent.getArtifacts()
    assert.ok(artifacts.some(a => a.kind === 'plan'))
    assert.ok(artifacts.some(a => a.kind === 'final_answer' && a.content === 'step result'))
  })
})
