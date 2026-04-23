/**
 * Regression tests for P0-2: SummarizingMemory summary preservation through
 * the ContextManager path.
 *
 * Before the fix:
 *   - SummarizingMemory.getHistory() was sync and filtered out ALL system
 *     messages, including the compressed summary → summary lost.
 *   - The ContextManager path (Agent._runPipeline when tokenBudget or
 *     knowledgeBase is set) only called getHistory(), so _maybeSummarize()
 *     never fired → summarization effectively disabled.
 *
 * After the fix:
 *   - SummarizingMemory.getHistory() is async and proactively triggers
 *     summarization; summary messages carry `_isSummary: true` and are kept.
 *   - ContextManager.assemblePrompt pulls out _isSummary messages and merges
 *     them into the system prompt content (not emitted as standalone system
 *     messages).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SummarizingMemory } from './memory.js'
import { ContextManager } from './context-manager.js'
import { Agent } from './agent.js'

describe('P0-2: SummarizingMemory summary is preserved through ContextManager', () => {
  it('getHistory() is async and keeps _isSummary-tagged messages', async () => {
    const mem = new SummarizingMemory({
      threshold: 3,
      keepRecent: 2,
      summarizer: async (text) => 'SUM:' + text.length,
    })
    for (let i = 0; i < 6; i++) {
      mem.add({ role: 'user', content: 'u' + i })
      mem.add({ role: 'assistant', content: 'a' + i })
    }

    const history = await mem.getHistory()
    const summary = history.find(m => m._isSummary === true)
    assert.ok(summary, 'getHistory must retain the _isSummary message')
    assert.strictEqual(summary.role, 'system')
    assert.ok(summary.content.startsWith('[Previous conversation summary]:'))

    // Non-summary portion should only contain recent (non-system) messages
    const nonSummary = history.filter(m => !m._isSummary)
    assert.ok(nonSummary.every(m => m.role !== 'system'))
    assert.ok(nonSummary.length > 0)
  })

  it('ContextManager merges _isSummary into system message, not a standalone one', () => {
    const cm = new ContextManager()
    const history = [
      {
        role: 'system',
        content: '[Previous conversation summary]: compressed old chat',
        _isSummary: true,
      },
      { role: 'user', content: 'most recent' },
      { role: 'assistant', content: 'ok' },
    ]
    const result = cm.assemblePrompt({
      systemPrompt: 'You are helpful.',
      history,
      tokenBudget: {
        totalTokens: 10000,
        systemPromptRatio: 0.2,
        knowledgeRatio: 0.2,
        historyRatio: 0.5,
        toolsRatio: 0.1,
      },
    })

    const systemMsgs = result.messages.filter(m => m.role === 'system')
    assert.strictEqual(systemMsgs.length, 1, 'should emit exactly one system message')
    assert.ok(
      systemMsgs[0].content.includes('You are helpful.'),
      'system message must include original systemPrompt'
    )
    assert.ok(
      systemMsgs[0].content.includes('compressed old chat'),
      'system message must include the summary content'
    )

    // Non-system portion must not leak the summary
    const nonSystem = result.messages.filter(m => m.role !== 'system')
    assert.ok(
      nonSystem.every(m => !m._isSummary),
      'summary messages must not leak into non-system portion'
    )
    // Recent messages should be preserved as normal history
    assert.deepStrictEqual(
      nonSystem.map(m => m.content),
      ['most recent', 'ok']
    )
  })

  it('Agent + SummarizingMemory + tokenBudget: full pipeline preserves summary', async () => {
    const mem = new SummarizingMemory({
      threshold: 3,
      keepRecent: 2,
      summarizer: async () => 'Earlier: user asked about project layout.',
    })
    const agent = new Agent({
      provider: 'openai',
      apiKey: 'sk-fake',
      model: 'gpt-4',
      systemPrompt: 'You are helpful.',
      memory: mem,
      tokenBudget: {
        totalTokens: 10000,
        systemPromptRatio: 0.2,
        knowledgeRatio: 0.2,
        historyRatio: 0.5,
        toolsRatio: 0.1,
      },
    })

    // Seed the memory to blow past threshold
    for (let i = 0; i < 8; i++) {
      agent.memory.add({ role: 'user', content: 'u' + i })
      agent.memory.add({ role: 'assistant', content: 'a' + i })
    }

    const { body } = await agent._runPipeline('new question')

    const systemMsgs = body.messages.filter(m => m.role === 'system')
    assert.strictEqual(systemMsgs.length, 1, 'exactly one system message to the LLM')
    assert.ok(
      systemMsgs[0].content.includes('You are helpful.'),
      'agent systemPrompt preserved'
    )
    assert.ok(
      systemMsgs[0].content.includes('Earlier: user asked about project layout.'),
      'summary was merged into system message (not filtered out)'
    )

    // No message object leaks _isSummary to the wire (clean API schema)
    assert.ok(
      body.messages.every(m => m._isSummary === undefined),
      'no _isSummary key should leak to LLM body'
    )
  })

  it('SummarizingMemory: repeated _maybeSummarize does not accumulate old summaries', async () => {
    // Before fix: each _maybeSummarize prepended a new summary without dropping
    // the previous one, so summaries could pile up.
    const mem = new SummarizingMemory({
      threshold: 3,
      keepRecent: 2,
      summarizer: async () => 'S',
    })
    for (let i = 0; i < 10; i++) {
      mem.add({ role: 'user', content: 'u' + i })
    }
    await mem.getHistory()
    // Add more messages and trigger again
    for (let i = 0; i < 10; i++) {
      mem.add({ role: 'user', content: 'v' + i })
    }
    const history = await mem.getHistory()
    const summaries = history.filter(m => m._isSummary)
    assert.strictEqual(summaries.length, 1, 'at most one summary message should ever be present')
  })
})
