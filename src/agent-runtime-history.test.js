import { describe, it } from 'node:test'
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
