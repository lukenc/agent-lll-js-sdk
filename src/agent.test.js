/**
 * Regression tests for Agent._buildSimpleBody + async memory (P0-1)
 *
 * Before the fix: when using SummarizingMemory (whose getMessages is async),
 * subsequent ReAct rounds produced a body whose `messages` was a Promise,
 * which JSON.stringify serialized to `{}` and the LLM API rejected.
 *
 * After the fix: _buildSimpleBody awaits memory.getMessages and always
 * returns a plain array.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Agent } from './agent.js'
import { SlidingWindowMemory, SummarizingMemory, TokenAwareMemory } from './memory.js'

describe('Agent._buildSimpleBody: async memory compatibility (P0-1)', () => {
  it('SummarizingMemory (async getMessages) yields a plain Array, not a Promise', async () => {
    const memory = new SummarizingMemory({ summarizer: async () => 'sum' })
    const agent = new Agent({
      provider: 'openai',
      apiKey: 'sk-fake',
      model: 'gpt-4',
      memory,
    })
    const { body } = await agent._buildSimpleBody()

    assert.ok(Array.isArray(body.messages), 'body.messages must be an Array')
    assert.ok(!(body.messages instanceof Promise), 'body.messages must not be a Promise')

    // Critical: JSON.stringify must preserve messages (not collapse to {})
    const roundTripped = JSON.parse(JSON.stringify(body)).messages
    assert.ok(Array.isArray(roundTripped), 'serialized messages must remain an Array')
    assert.ok(roundTripped.length > 0, 'at least system prompt should be serialized')
  })

  it('SlidingWindowMemory (sync getMessages) still works unchanged', async () => {
    const memory = new SlidingWindowMemory(10)
    const agent = new Agent({
      provider: 'openai',
      apiKey: 'sk-fake',
      model: 'gpt-4',
      memory,
    })
    agent.memory.add({ role: 'user', content: 'hi' })
    const { body } = await agent._buildSimpleBody()

    assert.ok(Array.isArray(body.messages))
    assert.strictEqual(body.messages.at(-1).content, 'hi')
  })

  it('TokenAwareMemory (sync getMessages) still works unchanged', async () => {
    const memory = new TokenAwareMemory(1000)
    const agent = new Agent({
      provider: 'openai',
      apiKey: 'sk-fake',
      model: 'gpt-4',
      memory,
    })
    agent.memory.add({ role: 'user', content: 'hello' })
    const { body } = await agent._buildSimpleBody()

    assert.ok(Array.isArray(body.messages))
    assert.strictEqual(body.messages.at(-1).content, 'hello')
  })

  it('multi-round ReAct with SummarizingMemory does not pass Promise to fetch', async () => {
    // Simulate what _reactLoop does on round >= 1
    const memory = new SummarizingMemory({ summarizer: async () => 'sum' })
    const agent = new Agent({
      provider: 'openai',
      apiKey: 'sk-fake',
      model: 'gpt-4',
      memory,
      maxRounds: 3,
    })
    agent.memory.add({ role: 'user', content: 'q' })
    agent.memory.add({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{}' } }],
    })
    agent.memory.add({ role: 'tool', tool_call_id: 't1', name: 'f', content: 'result' })

    // Second-round body construction
    const { body } = await agent._buildSimpleBody()
    const serialized = JSON.stringify(body)
    assert.ok(
      serialized.includes('"messages":['),
      'serialized body must contain a messages array, not an empty object'
    )
    assert.ok(
      !serialized.includes('"messages":{}'),
      'serialized body must NOT contain an empty object as messages'
    )
  })
})
