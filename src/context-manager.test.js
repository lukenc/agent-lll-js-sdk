/**
 * Regression tests for ContextManager.trimHistory (P0-3)
 *
 * Ensures the assembled `messages` array never starts with an orphan
 * `role: 'tool'` message (i.e. without a preceding `assistant(tool_calls)`).
 * This invariant must hold for any history shape and any token budget.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'
import { ContextManager } from './context-manager.js'

// ---- Helpers ----

function makeToolCallGroup(toolCallIds) {
  const assistant = {
    role: 'assistant',
    content: null,
    tool_calls: toolCallIds.map(id => ({
      id,
      type: 'function',
      function: { name: 'test_fn', arguments: '{}' },
    })),
  }
  const toolResponses = toolCallIds.map(id => ({
    role: 'tool',
    tool_call_id: id,
    content: 'result',
  }))
  return [assistant, ...toolResponses]
}

function everyToolMessageHasMatchingAssistant(messages) {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role !== 'tool') continue
    let found = false
    for (let j = i - 1; j >= 0; j--) {
      const prev = messages[j]
      if (
        prev.role === 'assistant' &&
        Array.isArray(prev.tool_calls) &&
        prev.tool_calls.some(tc => tc.id === msg.tool_call_id)
      ) {
        found = true
        break
      }
    }
    if (!found) return false
  }
  return true
}

// ---- Tests ----

describe('ContextManager.trimHistory: orphan tool invariant (P0-3)', () => {
  it('minimal repro: [assistant(tc), tool] with tight budget → no orphan', () => {
    const cm = new ContextManager()
    const history = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'result1' },
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
      everyToolMessageHasMatchingAssistant(nonSys),
      `orphan tool found: ${JSON.stringify(nonSys.map(m => m.role))}`
    )
  })

  it('property: no orphan tool for any history + any budget', () => {
    const simpleMsgArb = fc.oneof(
      fc.record({ role: fc.constant('user'), content: fc.string({ minLength: 1, maxLength: 20 }) }),
      fc.record({ role: fc.constant('assistant'), content: fc.string({ minLength: 1, maxLength: 20 }) })
    )
    const paddingArb = fc.array(simpleMsgArb, { minLength: 0, maxLength: 5 })
    const toolCallIdsArb = fc.uniqueArray(fc.uuid(), { minLength: 1, maxLength: 3 })

    fc.assert(
      fc.property(
        toolCallIdsArb,
        paddingArb,
        paddingArb,
        fc.integer({ min: 1, max: 200 }),
        (toolCallIds, prefix, suffix, totalTokens) => {
          const group = makeToolCallGroup(toolCallIds)
          const history = [...prefix, ...group, ...suffix]

          const cm = new ContextManager()
          const result = cm.assemblePrompt({
            systemPrompt: '',
            history,
            tokenBudget: {
              totalTokens,
              systemPromptRatio: 0,
              knowledgeRatio: 0,
              historyRatio: 1,
              toolsRatio: 0,
            },
          })
          const nonSys = result.messages.filter(m => m.role !== 'system')
          assert.ok(
            everyToolMessageHasMatchingAssistant(nonSys),
            `orphan tool with totalTokens=${totalTokens}, roles=${JSON.stringify(nonSys.map(m => m.role))}`
          )
        }
      ),
      { numRuns: 200 }
    )
  })

  it('multi-tool-call group: split budget still maintains invariant', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.uuid(), { minLength: 2, maxLength: 4 }),
        fc.integer({ min: 1, max: 50 }),
        (toolCallIds, totalTokens) => {
          const group = makeToolCallGroup(toolCallIds)
          const history = [
            { role: 'user', content: 'x'.repeat(200) },
            ...group,
            { role: 'user', content: 'last' },
          ]
          const cm = new ContextManager()
          const result = cm.assemblePrompt({
            systemPrompt: '',
            history,
            tokenBudget: {
              totalTokens,
              systemPromptRatio: 0,
              knowledgeRatio: 0,
              historyRatio: 1,
              toolsRatio: 0,
            },
          })
          const nonSys = result.messages.filter(m => m.role !== 'system')
          assert.ok(
            everyToolMessageHasMatchingAssistant(nonSys),
            `orphan in multi-tool case totalTokens=${totalTokens}, roles=${JSON.stringify(nonSys.map(m => m.role))}`
          )
        }
      ),
      { numRuns: 150 }
    )
  })

  it('non-tool-boundary: existing trim behavior preserved', () => {
    const cm = new ContextManager()
    const history = [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
      { role: 'user', content: 'three' },
    ]
    const result = cm.assemblePrompt({
      systemPrompt: '',
      history,
      tokenBudget: {
        totalTokens: 4,
        systemPromptRatio: 0,
        knowledgeRatio: 0,
        historyRatio: 1,
        toolsRatio: 0,
      },
    })
    const nonSys = result.messages.filter(m => m.role !== 'system')
    assert.ok(nonSys.length >= 1, 'at least 1 message kept')
    assert.strictEqual(
      nonSys[nonSys.length - 1].content,
      'three',
      'should always keep the latest message'
    )
  })
})
