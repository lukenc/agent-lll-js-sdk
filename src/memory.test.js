/**
 * Bug Condition Exploration Tests — Orphaned Tool Messages After Trim
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4**
 *
 * These property-based tests demonstrate that the current (unfixed) Memory
 * implementations produce orphaned `tool` messages when the trim boundary
 * splits a tool-call group. Tests are EXPECTED TO FAIL on unfixed code —
 * failure confirms the bug exists.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'
import {
  SlidingWindowMemory,
  TokenAwareMemory,
  SummarizingMemory,
} from './memory.js'

// ---- Helpers ----

/**
 * Check that every `tool` message in the array is preceded (somewhere before it)
 * by an `assistant` message whose `tool_calls` contains a matching `tool_call_id`.
 */
function everyToolMessageHasMatchingAssistant(messages) {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role !== 'tool') continue

    const toolCallId = msg.tool_call_id
    let found = false
    // Search backward for a matching assistant
    for (let j = i - 1; j >= 0; j--) {
      const prev = messages[j]
      if (
        prev.role === 'assistant' &&
        Array.isArray(prev.tool_calls) &&
        prev.tool_calls.some(tc => tc.id === toolCallId)
      ) {
        found = true
        break
      }
    }
    if (!found) return false
  }
  return true
}

/**
 * Build a tool-call group: an assistant message with tool_calls followed by
 * tool response messages.
 */
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

// ---- Arbitraries ----

/** Generate a unique tool_call_id */
const toolCallIdArb = fc.uuid()

/**
 * Generate 1-3 unique tool_call_ids for a tool-call group.
 */
const toolCallIdsArb = fc.uniqueArray(toolCallIdArb, { minLength: 1, maxLength: 3 })

/**
 * Generate a simple user or assistant message (no tool_calls).
 */
const simpleMsgArb = fc.oneof(
  fc.record({
    role: fc.constant('user'),
    content: fc.string({ minLength: 1, maxLength: 20 }),
  }),
  fc.record({
    role: fc.constant('assistant'),
    content: fc.string({ minLength: 1, maxLength: 20 }),
  })
)

/**
 * Generate 0-5 simple padding messages.
 */
const paddingArb = fc.array(simpleMsgArb, { minLength: 0, maxLength: 5 })

// ---- Tests ----

describe('Bug Condition Exploration: Orphaned Tool Messages After Trim', () => {
  /**
   * **Validates: Requirements 1.1, 2.1**
   *
   * Property 1 — SlidingWindowMemory: When maxMessages causes the slice to
   * start at a tool message, the output must not contain orphaned tool messages.
   */
  it('SlidingWindowMemory: no orphaned tool messages after trim', () => {
    fc.assert(
      fc.property(
        toolCallIdsArb,
        paddingArb,
        paddingArb,
        (toolCallIds, prefixMsgs, suffixMsgs) => {
          // Build: [prefix..., assistant(tool_calls), tool(s)..., suffix...]
          const group = makeToolCallGroup(toolCallIds)
          const allNonSystem = [...prefixMsgs, ...group, ...suffixMsgs]

          // We need maxMessages such that slice(-maxMessages) starts at a tool message.
          // The tool messages start at index: prefixMsgs.length + 1 (after the assistant)
          // We want to keep from the first tool message onward.
          const firstToolIndex = prefixMsgs.length + 1
          const messagesFromFirstTool = allNonSystem.length - firstToolIndex

          // Only test when trimming actually occurs and cut lands on a tool msg
          if (messagesFromFirstTool <= 0 || messagesFromFirstTool >= allNonSystem.length) return

          const maxMessages = messagesFromFirstTool
          const mem = new SlidingWindowMemory(maxMessages)
          mem.addAll(allNonSystem)

          const result = mem.getMessages()
          const nonSystemResult = result.filter(m => m.role !== 'system')

          // The property: every tool message must have a matching assistant
          assert.ok(
            everyToolMessageHasMatchingAssistant(nonSystemResult),
            `Orphaned tool message found! maxMessages=${maxMessages}, ` +
            `messages=${JSON.stringify(nonSystemResult.map(m => m.role))}`
          )
        }
      ),
      { numRuns: 100 }
    )
  })

  /**
   * **Validates: Requirements 1.2, 2.2**
   *
   * Property 1 — TokenAwareMemory: When the token budget is exhausted between
   * an assistant(tool_calls) and its tool response(s), the output must not
   * contain orphaned tool messages.
   *
   * Strategy: Use multiple tool_call_ids so there are multiple tool response
   * messages. Set the token budget so the backward iteration keeps some tool
   * messages but runs out before reaching the assistant(tool_calls) message
   * (which has content:null → 0 tokens but is preceded by a large prefix
   * message that would bust the budget).
   *
   * The backward iteration processes: suffix → tool(idN) → ... → tool(id1) → assistant → prefix.
   * Since assistant has 0 tokens, the budget must be exhausted at the PREFIX
   * that sits before the assistant. This means the assistant IS included but
   * the prefix is not. However, if we place a large-token message BETWEEN the
   * assistant(tool_calls) and its tool responses, the budget can be exhausted
   * there. But that breaks the tool-call group structure.
   *
   * Actual approach: We construct the scenario where the budget fits exactly
   * the suffix messages + some (but not all) tool messages. The tool messages
   * have content 'result' (6 chars → 2 tokens each). We use 2+ tool_call_ids
   * and set the budget so only the last tool message(s) + suffix fit, but not
   * the first tool message. This leaves orphaned tool messages without their
   * assistant parent (since the assistant is even further back).
   */
  it('TokenAwareMemory: no orphaned tool messages after trim', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(toolCallIdArb, { minLength: 2, maxLength: 4 }),
        (toolCallIds) => {
          const group = makeToolCallGroup(toolCallIds)
          // Each tool message: content='result' → ceil(6/4) = 2 tokens
          // assistant(tool_calls): content=null → 0 tokens

          // Place a large prefix before the group to ensure budget is exhausted
          // before reaching it during backward iteration
          const bigPrefix = {
            role: 'user',
            content: 'x'.repeat(400), // 100 tokens
          }
          // A suffix message after the group
          const suffix = { role: 'user', content: 'hi' } // ceil(2/4) = 1 token

          // Messages: [bigPrefix, assistant(tc), tool(id1), tool(id2), ..., suffix]
          const allNonSystem = [bigPrefix, ...group, suffix]

          // Backward iteration: suffix(1 tok) → tool(idN)(2 tok) → ... → tool(id1)(2 tok) → assistant(0 tok) → bigPrefix(100 tok)
          // We want budget to fit: suffix + last tool message only (not all tools)
          // Budget = 1 (suffix) + 2 (one tool) = 3 tokens
          // This keeps [tool(idN), suffix] — the tool(idN) is orphaned!
          const maxTokens = 3

          const mem = new TokenAwareMemory(maxTokens)
          mem.addAll(allNonSystem)

          const result = mem.getMessages()
          const nonSystemResult = result.filter(m => m.role !== 'system')

          // We expect tool messages to be present but orphaned
          const hasToolMessages = nonSystemResult.some(m => m.role === 'tool')
          if (!hasToolMessages) return

          assert.ok(
            everyToolMessageHasMatchingAssistant(nonSystemResult),
            `Orphaned tool message found! maxTokens=${maxTokens}, ` +
            `messages=${JSON.stringify(nonSystemResult.map(m => m.role))}`
          )
        }
      ),
      { numRuns: 100 }
    )
  })

  /**
   * **Validates: Requirements 1.3, 2.3**
   *
   * Property 1 — SummarizingMemory: When keepRecent causes the slice to
   * start at a tool message, the output must not contain orphaned tool messages.
   */
  it('SummarizingMemory: no orphaned tool messages after trim', async () => {
    await fc.assert(
      fc.asyncProperty(
        toolCallIdsArb,
        paddingArb,
        paddingArb,
        async (toolCallIds, prefixMsgs, suffixMsgs) => {
          const group = makeToolCallGroup(toolCallIds)
          const allNonSystem = [...prefixMsgs, ...group, ...suffixMsgs]

          // We want keepRecent such that slice(-keepRecent) starts at a tool message.
          const firstToolIndex = prefixMsgs.length + 1
          const messagesFromFirstTool = allNonSystem.length - firstToolIndex

          if (messagesFromFirstTool <= 0 || messagesFromFirstTool >= allNonSystem.length) return

          const keepRecent = messagesFromFirstTool
          // threshold must be < total non-system messages to trigger summarization
          const threshold = Math.max(1, keepRecent - 1)

          const mem = new SummarizingMemory({
            threshold,
            keepRecent,
            summarizer: async (text) => 'Summary of old messages',
          })
          mem.addAll(allNonSystem)

          const result = await mem.getMessages()
          const nonSystemResult = result.filter(m => m.role !== 'system')

          assert.ok(
            everyToolMessageHasMatchingAssistant(nonSystemResult),
            `Orphaned tool message found! keepRecent=${keepRecent}, ` +
            `messages=${JSON.stringify(nonSystemResult.map(m => m.role))}`
          )
        }
      ),
      { numRuns: 100 }
    )
  })

  /**
   * **Validates: Requirements 1.1, 1.4, 2.1, 2.4**
   *
   * Multi-tool-call case: assistant(tool_calls:[id1, id2]) followed by
   * tool(id1), tool(id2) where the cut splits the tool responses.
   */
  it('SlidingWindowMemory: multi-tool-call group split', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(toolCallIdArb, { minLength: 2, maxLength: 4 }),
        paddingArb,
        (toolCallIds, suffixMsgs) => {
          // Ensure suffix has at least 1 message
          if (suffixMsgs.length === 0) return

          const group = makeToolCallGroup(toolCallIds)
          // prefix: one user message
          const prefix = [{ role: 'user', content: 'hello' }]
          const allNonSystem = [...prefix, ...group, ...suffixMsgs]

          // Set maxMessages so the cut lands in the middle of the tool responses.
          // Tool responses are at indices: prefix.length + 1 .. prefix.length + toolCallIds.length
          // We want to start keeping from the SECOND tool message (index prefix.length + 2)
          const secondToolIndex = prefix.length + 2
          const messagesFromSecondTool = allNonSystem.length - secondToolIndex

          if (messagesFromSecondTool <= 0 || messagesFromSecondTool >= allNonSystem.length) return
          if (secondToolIndex >= allNonSystem.length) return

          const maxMessages = messagesFromSecondTool
          const mem = new SlidingWindowMemory(maxMessages)
          mem.addAll(allNonSystem)

          const result = mem.getMessages()
          const nonSystemResult = result.filter(m => m.role !== 'system')

          assert.ok(
            everyToolMessageHasMatchingAssistant(nonSystemResult),
            `Orphaned tool message in multi-tool-call split! maxMessages=${maxMessages}, ` +
            `messages=${JSON.stringify(nonSystemResult.map(m => m.role))}`
          )
        }
      ),
      { numRuns: 100 }
    )
  })
})


// ---- Preservation Property Tests ----

/**
 * Preservation Property Tests — Unchanged Trim Behavior for Non-Tool-Call Boundaries
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6**
 *
 * These tests verify that existing trim behavior is preserved when the trim
 * boundary does NOT split a tool-call group. They should PASS on unfixed code.
 */

describe('Preservation: Unchanged Trim Behavior for Non-Tool-Call Boundaries', () => {

  // ---- Arbitraries for preservation tests ----

  /** Generate a user message with random content */
  const userMsgArb = fc.record({
    role: fc.constant('user'),
    content: fc.string({ minLength: 1, maxLength: 30 }),
  })

  /** Generate an assistant message (no tool_calls) with random content */
  const assistantMsgArb = fc.record({
    role: fc.constant('assistant'),
    content: fc.string({ minLength: 1, maxLength: 30 }),
  })

  /** Generate a simple user or assistant message (no tool calls) */
  const simpleMessageArb = fc.oneof(userMsgArb, assistantMsgArb)

  /**
   * Generate an array of simple user/assistant messages (no tool calls).
   * Minimum 2 messages to make trimming meaningful.
   */
  const simpleMessagesArb = fc.array(simpleMessageArb, { minLength: 2, maxLength: 20 })

  // ---- SlidingWindowMemory preservation ----

  /**
   * **Validates: Requirements 3.1, 3.4**
   *
   * Property 2 — SlidingWindowMemory with only user/assistant messages
   * trims to exactly maxMessages non-system messages.
   */
  it('SlidingWindowMemory: trims to exactly maxMessages with no tool calls', () => {
    fc.assert(
      fc.property(
        simpleMessagesArb,
        fc.integer({ min: 1, max: 15 }),
        (messages, maxMessages) => {
          const mem = new SlidingWindowMemory(maxMessages)
          mem.addAll(messages)

          const result = mem.getMessages()
          const nonSystem = result.filter(m => m.role !== 'system')

          if (messages.length > maxMessages) {
            // Should trim to exactly maxMessages
            assert.strictEqual(
              nonSystem.length,
              maxMessages,
              `Expected exactly ${maxMessages} non-system messages, got ${nonSystem.length}`
            )
            // Kept messages should be the last maxMessages from the original
            const expected = messages.slice(-maxMessages)
            assert.deepStrictEqual(nonSystem, expected)
          } else {
            // No trimming needed — all messages kept
            assert.strictEqual(nonSystem.length, messages.length)
            assert.deepStrictEqual(nonSystem, messages)
          }
        }
      ),
      { numRuns: 100 }
    )
  })

  // ---- TokenAwareMemory preservation ----

  /**
   * **Validates: Requirements 3.2, 3.4**
   *
   * Property 2 — TokenAwareMemory with only user/assistant messages
   * stays within maxTokens budget.
   */
  it('TokenAwareMemory: stays within maxTokens budget with no tool calls', () => {
    const CHARS_PER_TOKEN = 4

    fc.assert(
      fc.property(
        simpleMessagesArb,
        fc.integer({ min: 1, max: 200 }),
        (messages, maxTokens) => {
          const mem = new TokenAwareMemory(maxTokens)
          mem.addAll(messages)

          const result = mem.getMessages()
          const nonSystem = result.filter(m => m.role !== 'system')

          // Total tokens of kept messages must not exceed maxTokens
          const totalTokens = nonSystem.reduce((sum, m) => {
            return sum + Math.ceil((m.content ?? '').length / CHARS_PER_TOKEN)
          }, 0)

          assert.ok(
            totalTokens <= maxTokens,
            `Token budget exceeded: ${totalTokens} > ${maxTokens}`
          )

          // Kept messages should be a suffix of the original messages
          if (nonSystem.length > 0) {
            const expected = messages.slice(-nonSystem.length)
            assert.deepStrictEqual(nonSystem, expected)
          }
        }
      ),
      { numRuns: 100 }
    )
  })

  // ---- SummarizingMemory preservation ----

  /**
   * **Validates: Requirements 3.3, 3.4**
   *
   * Property 2 — SummarizingMemory with only user/assistant messages
   * keeps keepRecent recent messages when summarization triggers.
   */
  it('SummarizingMemory: keeps keepRecent recent messages with no tool calls', async () => {
    await fc.assert(
      fc.asyncProperty(
        simpleMessagesArb,
        fc.integer({ min: 1, max: 10 }),
        async (messages, keepRecent) => {
          // threshold must be less than message count to trigger summarization
          const threshold = Math.max(1, keepRecent - 1)

          const mem = new SummarizingMemory({
            threshold,
            keepRecent,
            summarizer: async (text) => 'Summary of old messages',
          })
          mem.addAll(messages)

          const result = await mem.getMessages()
          const nonSystem = result.filter(m => m.role !== 'system')

          if (messages.length > threshold) {
            // Should keep exactly keepRecent recent messages
            const expected = messages.slice(-keepRecent)
            assert.deepStrictEqual(nonSystem, expected)
          } else {
            // No summarization — all messages kept
            assert.deepStrictEqual(nonSystem, messages)
          }
        }
      ),
      { numRuns: 100 }
    )
  })

  // ---- Tool-call groups entirely within kept window ----

  /**
   * **Validates: Requirements 3.5**
   *
   * Property 2 — When tool-call groups are entirely within the kept portion,
   * output includes the complete groups unchanged.
   */
  it('SlidingWindowMemory: tool-call groups within kept window are preserved', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.uuid(), { minLength: 1, maxLength: 3 }),
        paddingArb,
        (toolCallIds, prefixMsgs) => {
          // Build a tool-call group
          const group = makeToolCallGroup(toolCallIds)

          // Place the group at the END so it's always within the kept window
          // prefix is discardable padding
          const allMessages = [...prefixMsgs, ...group]

          // maxMessages = group.length ensures the entire group is kept
          // but prefix is trimmed
          const maxMessages = group.length
          if (allMessages.length <= maxMessages) return // no trimming

          const mem = new SlidingWindowMemory(maxMessages)
          mem.addAll(allMessages)

          const result = mem.getMessages()
          const nonSystem = result.filter(m => m.role !== 'system')

          // The kept messages should be exactly the tool-call group
          assert.deepStrictEqual(nonSystem, group)

          // Every tool message has its matching assistant
          assert.ok(
            everyToolMessageHasMatchingAssistant(nonSystem),
            'Tool-call group within window should be fully preserved'
          )
        }
      ),
      { numRuns: 100 }
    )
  })

  // ---- Public API contract ----

  /**
   * **Validates: Requirements 3.6**
   *
   * Property 2 — Public API contract: size returns correct count,
   * clear() empties messages, getHistory() excludes system messages.
   */
  it('Public API contract: size, clear, getHistory behave correctly', () => {
    fc.assert(
      fc.property(
        simpleMessagesArb,
        fc.integer({ min: 1, max: 20 }),
        (messages, maxMessages) => {
          const mem = new SlidingWindowMemory(maxMessages)

          // Test addAll and size
          mem.addAll(messages)
          const expectedSize = Math.min(messages.length, maxMessages)
          assert.strictEqual(
            mem.size,
            expectedSize,
            `size should be ${expectedSize}, got ${mem.size}`
          )

          // Test getMessages returns a copy
          const msgs1 = mem.getMessages()
          const msgs2 = mem.getMessages()
          assert.deepStrictEqual(msgs1, msgs2)
          assert.notStrictEqual(msgs1, msgs2) // different array references

          // Test getHistory excludes system messages
          const history = mem.getHistory()
          assert.ok(
            history.every(m => m.role !== 'system'),
            'getHistory should exclude system messages'
          )

          // Test clear
          mem.clear()
          assert.strictEqual(mem.size, 0, 'size should be 0 after clear')
          assert.deepStrictEqual(mem.getMessages(), [])
        }
      ),
      { numRuns: 100 }
    )
  })

  /**
   * **Validates: Requirements 3.6**
   *
   * Property 2 — Public API contract for TokenAwareMemory and SummarizingMemory.
   * NOTE: `SummarizingMemory.getHistory` is async (since P0-2 fix) — it
   * proactively triggers summarization and keeps any `_isSummary`-tagged
   * system messages so ContextManager can merge them into the prompt.
   */
  it('TokenAwareMemory & SummarizingMemory: API contract (add, clear, size)', async () => {
    await fc.assert(
      fc.asyncProperty(
        simpleMessagesArb,
        async (messages) => {
          // TokenAwareMemory — large budget so no trimming
          const tokenMem = new TokenAwareMemory(100000)
          for (const msg of messages) {
            tokenMem.add(msg)
          }
          assert.strictEqual(tokenMem.size, messages.length)

          const tokenHistory = tokenMem.getHistory()
          assert.ok(tokenHistory.every(m => m.role !== 'system'))
          assert.deepStrictEqual(tokenHistory, messages)

          tokenMem.clear()
          assert.strictEqual(tokenMem.size, 0)

          // SummarizingMemory — high threshold so no summarization
          const sumMem = new SummarizingMemory({
            threshold: 1000,
            keepRecent: 5,
            summarizer: async () => 'summary',
          })
          for (const msg of messages) {
            sumMem.add(msg)
          }
          assert.strictEqual(sumMem.size, messages.length)

          const sumHistory = await sumMem.getHistory()
          // Without summarization triggered, no _isSummary messages expected.
          assert.ok(sumHistory.every(m => m.role !== 'system'))
          assert.deepStrictEqual(sumHistory, messages)

          sumMem.clear()
          assert.strictEqual(sumMem.size, 0)
        }
      ),
      { numRuns: 100 }
    )
  })
})
