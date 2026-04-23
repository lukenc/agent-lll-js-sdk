/**
 * Regression tests for the post-P0 review findings (R-1 ~ R-4).
 *
 * R-1  `_buildSimpleBody` path must not leak `_isSummary` nor emit duplicate
 *      system messages when SummarizingMemory has compressed history.
 * R-2  `_maybeSummarize` must dedupe concurrent calls via an in-flight
 *      Promise so two `summarizer(...)` invocations never race-rewrite
 *      `this.messages`.
 * R-3  New summaries must ingest the previous summary text so long
 *      conversations do not silently lose early context.
 * R-4  All four trim call sites (three memory `_trim` + ContextManager
 *      `trimHistory`) must share the same orphan-tool invariant.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Agent } from './agent.js'
import {
  SummarizingMemory,
  SlidingWindowMemory,
  TokenAwareMemory,
  sliceWithoutOrphanTools,
} from './memory.js'
import { ContextManager } from './context-manager.js'

// --------------------------------------------------------------------------
// R-1: summary does not leak into the wire, and we never emit two system msgs
// --------------------------------------------------------------------------

describe('R-1: _buildSimpleBody must merge summary + strip _isSummary', () => {
  it('SummarizingMemory + no tokenBudget: wire body has 1 system, no _isSummary', async () => {
    const mem = new SummarizingMemory({
      threshold: 3,
      keepRecent: 2,
      summarizer: async () => 'SUMMARY_TEXT',
    })
    const agent = new Agent({
      provider: 'openai',
      apiKey: 'sk-fake',
      model: 'gpt-4',
      systemPrompt: 'SP',
      memory: mem,
    })
    for (let i = 0; i < 6; i++) {
      agent.memory.add({ role: 'user', content: 'u' + i })
      agent.memory.add({ role: 'assistant', content: 'a' + i })
    }

    const { body } = await agent._buildSimpleBody()
    const wire = JSON.parse(JSON.stringify(body))

    const systemMsgs = wire.messages.filter(m => m.role === 'system')
    assert.strictEqual(systemMsgs.length, 1, 'exactly one system message on the wire')
    assert.ok(
      systemMsgs[0].content.includes('SP'),
      'original systemPrompt preserved'
    )
    assert.ok(
      systemMsgs[0].content.includes('SUMMARY_TEXT'),
      'summary content merged into the system message'
    )
    assert.ok(
      !JSON.stringify(wire).includes('_isSummary'),
      '_isSummary field must not leak onto the wire'
    )
  })

  it('getMessages() strips _isSummary even when summary already materialized', async () => {
    const mem = new SummarizingMemory({
      threshold: 2,
      keepRecent: 1,
      summarizer: async () => 'X',
    })
    mem.add({ role: 'system', content: 'SP' })
    for (let i = 0; i < 5; i++) mem.add({ role: 'user', content: 'u' + i })

    const msgs = await mem.getMessages()
    assert.ok(
      msgs.every(m => m._isSummary === undefined),
      'no exposed message should carry _isSummary'
    )
    const systems = msgs.filter(m => m.role === 'system')
    assert.strictEqual(systems.length, 1, 'exactly one system message')
    assert.ok(systems[0].content.includes('SP'))
    assert.ok(systems[0].content.includes('[Previous conversation summary]: X'))
  })

  it('getMessagesSync() keeps the same projection', () => {
    const mem = new SummarizingMemory({
      threshold: 100,
      keepRecent: 1,
      summarizer: async () => 'unused',
    })
    mem.add({ role: 'system', content: 'SP' })
    // Manually plant an _isSummary message to simulate post-compression state.
    mem.messages.push({
      role: 'system',
      content: '[Previous conversation summary]: FAKE',
      _isSummary: true,
    })
    mem.add({ role: 'user', content: 'hi' })

    const msgs = mem.getMessagesSync()
    const systems = msgs.filter(m => m.role === 'system')
    assert.strictEqual(systems.length, 1)
    assert.ok(systems[0].content.includes('SP'))
    assert.ok(systems[0].content.includes('FAKE'))
    assert.ok(msgs.every(m => m._isSummary === undefined))
  })
})

// --------------------------------------------------------------------------
// R-2: concurrent _maybeSummarize must not race
// --------------------------------------------------------------------------

describe('R-2: _maybeSummarize shares in-flight Promise', () => {
  it('N concurrent getMessages() calls only invoke summarizer once', async () => {
    let callCount = 0
    const mem = new SummarizingMemory({
      threshold: 3,
      keepRecent: 2,
      summarizer: async (text) => {
        callCount++
        // Simulate slow LLM round-trip so multiple callers can stack up.
        await new Promise(r => setTimeout(r, 20))
        return 'S' + callCount
      },
    })
    for (let i = 0; i < 6; i++) mem.add({ role: 'user', content: 'u' + i })

    const results = await Promise.all([
      mem.getMessages(),
      mem.getMessages(),
      mem.getHistory(),
      mem.getMessages(),
      mem.getHistory(),
    ])

    assert.strictEqual(callCount, 1, 'summarizer must be called exactly once')
    // All callers observe the same, well-formed state:
    for (const msgs of results) {
      // No state should still contain 6+ user messages (compression must have
      // happened before any caller returned).
      const userMsgs = msgs.filter(m => m.role === 'user')
      assert.ok(userMsgs.length < 6, 'compression applied before return')
    }
  })

  it('after first batch resolves, next getMessages() triggers a new summarize', async () => {
    let callCount = 0
    const mem = new SummarizingMemory({
      threshold: 2,
      keepRecent: 1,
      summarizer: async () => {
        callCount++
        return 'S'
      },
    })
    for (let i = 0; i < 4; i++) mem.add({ role: 'user', content: 'u' + i })
    await mem.getMessages()
    const firstCount = callCount
    assert.strictEqual(firstCount, 1)

    // Add more messages to cross threshold again.
    for (let i = 0; i < 4; i++) mem.add({ role: 'user', content: 'v' + i })
    await mem.getMessages()
    assert.strictEqual(callCount, 2, 'in-flight cache cleared after settle')
  })
})

// --------------------------------------------------------------------------
// R-3: previous summary is fed into the summarizer on subsequent compressions
// --------------------------------------------------------------------------

describe('R-3: summarizer receives previous summary on later rounds', () => {
  it('second summarization sees [Previous summary] block in input', async () => {
    const captured = []
    const mem = new SummarizingMemory({
      threshold: 2,
      keepRecent: 1,
      summarizer: async (text) => {
        captured.push(text)
        return 'SUMMARY_' + captured.length
      },
    })

    // Round 1: plenty of messages, first summarization fires.
    for (let i = 0; i < 5; i++) mem.add({ role: 'user', content: 'u' + i })
    await mem.getMessages()
    assert.strictEqual(captured.length, 1)
    assert.ok(
      !captured[0].includes('[Previous summary]'),
      'first compression has no previous summary to inherit'
    )

    // Round 2: pile on more messages, summarizer runs again.
    for (let i = 0; i < 5; i++) mem.add({ role: 'user', content: 'v' + i })
    await mem.getMessages()
    assert.strictEqual(captured.length, 2)
    assert.ok(
      captured[1].includes('[Previous summary]'),
      'second compression must include the previous summary as a prefix'
    )
    assert.ok(
      captured[1].includes('SUMMARY_1'),
      'the actual previous summary text must be carried forward'
    )
    assert.ok(
      captured[1].includes('[New messages]'),
      'new messages are clearly delimited'
    )
  })
})

// --------------------------------------------------------------------------
// R-4: orphan-tool invariant holds across all trim call sites
// --------------------------------------------------------------------------

describe('R-4: unified orphan-tool invariant', () => {
  const msg = (role, extra = {}) => ({ role, content: 'x', ...extra })

  it('sliceWithoutOrphanTools: well-formed pair is pulled back in', () => {
    const nonSystem = [
      msg('user'),
      { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 't1', content: 'r' },
      msg('user'),
    ]
    const out = sliceWithoutOrphanTools(nonSystem, 2) // cut at tool
    assert.strictEqual(out.length, 3, 'assistant(tc) pulled back in')
    assert.strictEqual(out[0].role, 'assistant')
    assert.ok(out[0].tool_calls)
  })

  it('sliceWithoutOrphanTools: malformed tool with no parent → stripped', () => {
    const nonSystem = [
      msg('user'),
      { role: 'tool', tool_call_id: 'ghost', content: 'r' },
      msg('user'),
    ]
    const out = sliceWithoutOrphanTools(nonSystem, 1) // cut at orphan tool
    assert.strictEqual(out.length, 1, 'orphan tool stripped, only trailing user remains')
    assert.strictEqual(out[0].role, 'user')
  })

  it('SlidingWindowMemory._trim: never leaves memory starting with orphan tool', () => {
    const mem = new SlidingWindowMemory(2)
    // Intentionally craft malformed injection: an orphan tool at position 0.
    mem.messages = [
      { role: 'system', content: 'SP' },
      { role: 'tool', tool_call_id: 'ghost', content: 'r' },
      msg('user'),
      msg('assistant'),
      msg('user'),
    ]
    mem._trim()
    const nonSys = mem.messages.filter(m => m.role !== 'system')
    assert.ok(
      nonSys.length === 0 || nonSys[0].role !== 'tool',
      'memory must not begin (non-system-wise) with a tool message'
    )
  })

  it('TokenAwareMemory._trim: orphan tool at budget boundary is stripped', () => {
    const mem = new TokenAwareMemory(8) // extremely tight
    mem.messages = [
      { role: 'system', content: 'SP' },
      // a huge message that will be cut
      msg('user', { content: 'x'.repeat(500) }),
      { role: 'tool', tool_call_id: 'ghost', content: 'r' },
      msg('user', { content: 'hi' }),
    ]
    mem._trim()
    const nonSys = mem.messages.filter(m => m.role !== 'system')
    assert.ok(
      nonSys.length === 0 || nonSys[0].role !== 'tool',
      'trimmed TokenAwareMemory must not start with an orphan tool'
    )
  })

  it('ContextManager.trimHistory: invariant still holds (regression)', () => {
    const cm = new ContextManager()
    const history = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'r' },
    ]
    const result = cm.assemblePrompt({
      systemPrompt: '',
      history,
      tokenBudget: {
        totalTokens: 6,
        systemPromptRatio: 0,
        knowledgeRatio: 0,
        historyRatio: 1,
        toolsRatio: 0,
      },
    })
    const nonSys = result.messages.filter(m => m.role !== 'system')
    assert.ok(
      nonSys.length === 0 || nonSys[0].role !== 'tool',
      'ContextManager must never emit a leading orphan tool'
    )
  })
})
