/**
 * Tests for the `runtime-dynamic-mcp-loading` feature.
 *
 * Covers Correctness Properties 1–16 (property-based, fast-check, ≥100 runs
 * each) plus the unit / integration scenarios enumerated in the spec's
 * Testing Strategy.
 *
 * Runner: `node --test`. Generators are reused/extended from
 * `src/mcp/__fixtures__/arbitraries.js`.
 *
 * @see .kiro/specs/runtime-dynamic-mcp-loading/design.md §Correctness Properties
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'

import { Agent } from './agent.js'
import {
  ToolFilter,
  INITIAL_BASE_TOOLS,
  isBaseTool,
  getBaseTools,
  resetBaseTools,
} from './tool-filter.js'
import {
  arbToolDef,
  arbToolDefList,
  arbUniqueToolDefList,
  arbToolName,
  arbIntentResult,
  makeMockMCPClient,
} from './mcp/__fixtures__/arbitraries.js'
import { defineTool } from './tool.js'
import { SlidingWindowMemory } from './memory.js'

const RUNS = { numRuns: 100 }

function makeAgent(opts = {}) {
  return new Agent({ provider: 'openai', apiKey: 'sk-fake', model: 'gpt-4', ...opts })
}

/** A tool name that is guaranteed NOT to collide with INITIAL_BASE_TOOLS. */
const arbNonBaseToolName = arbToolName.filter((n) => !INITIAL_BASE_TOOLS.includes(n))

/** A Tool_Def whose name never collides with INITIAL_BASE_TOOLS. */
const arbNonBaseToolDef = arbToolDef.filter((t) => !INITIAL_BASE_TOOLS.includes(t.name))

// Base_Tool registry is process-global module state — reset around every test
// so registrations from one case never leak into another.
beforeEach(() => resetBaseTools())
afterEach(() => resetBaseTools())

// ---------------------------------------------------------------------------
// Property 1 (Task 2.3)
// ---------------------------------------------------------------------------

// Feature: runtime-dynamic-mcp-loading, Property 1: 工具加入后按加入顺序可见且防御性快照不可回流
describe('Property 1: insertion order visible + defensive snapshot', () => {
  it('getTools() preserves insertion order and is a non-leaking snapshot', () => {
    fc.assert(
      fc.property(arbUniqueToolDefList, (tools) => {
        const agent = makeAgent()
        for (const t of tools) agent.addTools(t)

        const snap = agent.getTools()
        // Order = insertion order.
        assert.deepEqual(snap.map((t) => t.name), tools.map((t) => t.name))

        // Mutating the returned array must not affect the registry.
        const before = agent.getTools().map((t) => t.name)
        snap.push({ name: '__intruder__' })
        snap.splice(0, snap.length)
        assert.deepEqual(agent.getTools().map((t) => t.name), before)
      }),
      RUNS,
    )
  })
})

// ---------------------------------------------------------------------------
// Property 2 (Task 2.4)
// ---------------------------------------------------------------------------

// Feature: runtime-dynamic-mcp-loading, Property 2: 同名覆盖保持唯一
describe('Property 2: same-name overwrite stays unique', () => {
  it('adding two defs with the same name keeps exactly one (the latest)', () => {
    fc.assert(
      fc.property(arbToolName, arbToolDef, arbToolDef, (name, a, b) => {
        const first = { ...a, name, _marker: 'first' }
        const second = { ...b, name, _marker: 'second' }
        const agent = makeAgent()
        agent.addTools(first)
        agent.addTools(second)

        const matches = agent.getTools().filter((t) => t.name === name)
        assert.equal(matches.length, 1)
        assert.equal(matches[0]._marker, 'second')
      }),
      RUNS,
    )
  })
})

// ---------------------------------------------------------------------------
// Property 3 (Task 2.5)
// ---------------------------------------------------------------------------

// Feature: runtime-dynamic-mcp-loading, Property 3: 数组含非法元素时整体回滚
describe('Property 3: whole-array rollback on invalid element', () => {
  it('an invalid element anywhere throws TypeError and writes nothing', () => {
    fc.assert(
      fc.property(
        arbToolDefList,
        fc.nat(),
        fc.constantFrom({ name: '' }, { name: 123 }, {}, { description: 'x' }),
        (tools, pos, badEl) => {
          const agent = makeAgent()
          const before = agent.getTools().map((t) => t.name)

          const idx = tools.length === 0 ? 0 : pos % (tools.length + 1)
          const withBad = [...tools.slice(0, idx), badEl, ...tools.slice(idx)]

          assert.throws(() => agent.addTools(withBad), TypeError)
          // No write happened (whole-array rollback).
          assert.deepEqual(agent.getTools().map((t) => t.name), before)
        },
      ),
      RUNS,
    )
  })
})

// ---------------------------------------------------------------------------
// Property 4 (Task 2.6)
// ---------------------------------------------------------------------------

// Feature: runtime-dynamic-mcp-loading, Property 4: removeTool 命中与未命中的语义
describe('Property 4: removeTool hit/miss semantics', () => {
  it('hit → true and gone; miss (non-empty string) → false and unchanged', () => {
    fc.assert(
      fc.property(arbUniqueToolDefList, arbToolName, (tools, probe) => {
        const agent = makeAgent()
        for (const t of tools) agent.addTools(t)

        const exists = tools.some((t) => t.name === probe)
        const before = agent.getTools().map((t) => t.name)
        const result = agent.removeTool(probe)

        if (exists) {
          assert.equal(result, true)
          assert.equal(agent.getTools().some((t) => t.name === probe), false)
        } else {
          assert.equal(result, false)
          assert.deepEqual(agent.getTools().map((t) => t.name), before)
        }
      }),
      RUNS,
    )
  })
})

// ---------------------------------------------------------------------------
// Task 2.7 — Unit tests for API edge cases (Requirements 1.5, 1.7, 1.8)
// ---------------------------------------------------------------------------

describe('Task 2.7: addTools / removeTool edge cases', () => {
  // Req 1.7: empty array is a no-op that returns normally and does not mutate.
  it('addTools([]) does not change the registry and returns normally (Req 1.7)', () => {
    const agent = makeAgent()
    const before = agent.getTools().map((t) => t.name)
    const genBefore = agent._toolsGeneration

    const ret = agent.addTools([])

    assert.equal(ret, undefined)
    assert.deepEqual(agent.getTools().map((t) => t.name), before)
    // No actual change means generation must not advance.
    assert.equal(agent._toolsGeneration, genBefore)
  })

  it('addTools([]) leaves an already-populated registry untouched (Req 1.7)', () => {
    const agent = makeAgent()
    agent.addTools({ name: 'alpha', description: 'a', parameters: {}, execute: async () => 'ok' })
    agent.addTools({ name: 'beta', description: 'b', parameters: {}, execute: async () => 'ok' })

    const before = agent.getTools().map((t) => t.name)
    const genBefore = agent._toolsGeneration

    agent.addTools([])

    assert.deepEqual(agent.getTools().map((t) => t.name), before)
    assert.equal(agent._toolsGeneration, genBefore)
  })

  // Req 1.5: null / undefined / non-Tool_Def / oversized array → TypeError, no write.
  it('addTools(null) throws TypeError and does not mutate (Req 1.5)', () => {
    const agent = makeAgent()
    const before = agent.getTools().map((t) => t.name)
    const genBefore = agent._toolsGeneration

    assert.throws(() => agent.addTools(null), TypeError)

    assert.deepEqual(agent.getTools().map((t) => t.name), before)
    assert.equal(agent._toolsGeneration, genBefore)
  })

  it('addTools(undefined) throws TypeError and does not mutate (Req 1.5)', () => {
    const agent = makeAgent()
    const before = agent.getTools().map((t) => t.name)
    const genBefore = agent._toolsGeneration

    assert.throws(() => agent.addTools(undefined), TypeError)

    assert.deepEqual(agent.getTools().map((t) => t.name), before)
    assert.equal(agent._toolsGeneration, genBefore)
  })

  it('addTools(non-object scalar) throws TypeError and does not mutate (Req 1.5)', () => {
    const agent = makeAgent()
    const before = agent.getTools().map((t) => t.name)
    const genBefore = agent._toolsGeneration

    for (const bad of [42, 'a-string', true]) {
      assert.throws(() => agent.addTools(bad), TypeError)
    }

    assert.deepEqual(agent.getTools().map((t) => t.name), before)
    assert.equal(agent._toolsGeneration, genBefore)
  })

  it('addTools(array longer than 1000) throws TypeError and does not mutate (Req 1.5)', () => {
    const agent = makeAgent()
    const before = agent.getTools().map((t) => t.name)
    const genBefore = agent._toolsGeneration

    const tooLong = Array.from({ length: 1001 }, (_, i) => ({
      name: `tool_${i}`,
      description: '',
      parameters: {},
      execute: async () => 'ok',
    }))

    assert.throws(() => agent.addTools(tooLong), TypeError)

    assert.deepEqual(agent.getTools().map((t) => t.name), before)
    assert.equal(agent._toolsGeneration, genBefore)
  })

  it('addTools(array of exactly 1000) is accepted (boundary, Req 1.5)', () => {
    const agent = makeAgent()
    const exactly = Array.from({ length: 1000 }, (_, i) => ({
      name: `tool_${i}`,
      description: '',
      parameters: {},
      execute: async () => 'ok',
    }))

    assert.doesNotThrow(() => agent.addTools(exactly))
    assert.equal(agent.getTools().length, 1000)
  })

  // Req 1.8: removeTool with a non-string / empty string → TypeError, no change.
  it('removeTool(non-string) throws TypeError and does not mutate (Req 1.8)', () => {
    const agent = makeAgent()
    agent.addTools({ name: 'alpha', description: 'a', parameters: {}, execute: async () => 'ok' })

    const before = agent.getTools().map((t) => t.name)
    const genBefore = agent._toolsGeneration

    for (const bad of [null, undefined, 123, {}, [], true]) {
      assert.throws(() => agent.removeTool(bad), TypeError)
    }

    assert.deepEqual(agent.getTools().map((t) => t.name), before)
    assert.equal(agent._toolsGeneration, genBefore)
  })

  it('removeTool("") throws TypeError and does not mutate (Req 1.8)', () => {
    const agent = makeAgent()
    agent.addTools({ name: 'alpha', description: 'a', parameters: {}, execute: async () => 'ok' })

    const before = agent.getTools().map((t) => t.name)
    const genBefore = agent._toolsGeneration

    assert.throws(() => agent.removeTool(''), TypeError)

    assert.deepEqual(agent.getTools().map((t) => t.name), before)
    assert.equal(agent._toolsGeneration, genBefore)
  })
})

// ---------------------------------------------------------------------------
// Property 9 (Task 6.2)
// ---------------------------------------------------------------------------

// Feature: runtime-dynamic-mcp-loading, Property 9: 动态工具加入即注册为 Base_Tool、移除即取消（预置名除外）
describe('Property 9: dynamic tool base-tool lifecycle', () => {
  it('dynamic add registers Base_Tool; successful remove (non-preset) unregisters it', () => {
    fc.assert(
      fc.property(arbNonBaseToolDef, (tool) => {
        resetBaseTools()
        const agent = makeAgent()

        // A non-base name starts out NOT registered as a Base_Tool.
        assert.equal(isBaseTool(tool.name), false)

        // Dynamic load path adds the tool as a Base_Tool (asBaseTool: true).
        agent.addTools(tool, { asBaseTool: true })
        assert.equal(isBaseTool(tool.name), true)

        // Successful removal of a non-preset name cancels the Base_Tool registration.
        const removed = agent.removeTool(tool.name)
        assert.equal(removed, true)
        assert.equal(isBaseTool(tool.name), false)
      }),
      RUNS,
    )
  })
})

// ---------------------------------------------------------------------------
// Property 10 (Task 6.3)
// ---------------------------------------------------------------------------

// Feature: runtime-dynamic-mcp-loading, Property 10: Base_Tool 动态工具永不被意图过滤剔除
describe('Property 10: Base_Tool dynamic tools are never filtered out', () => {
  it('ToolFilter always keeps every Base_Tool dynamic tool regardless of filteredToolNames', () => {
    fc.assert(
      fc.property(arbUniqueToolDefList, arbIntentResult, (dynamicTools, intent) => {
        resetBaseTools()
        const agent = makeAgent()

        // Add every dynamic tool through the runtime-load path, which registers
        // each as a Base_Tool (asBaseTool: true).
        for (const t of dynamicTools) agent.addTools(t, { asBaseTool: true })

        // Sanity: all dynamic tools are now Base_Tools.
        for (const t of dynamicTools) assert.equal(isBaseTool(t.name), true)

        // Filter the current registry with an arbitrary intent result whose
        // filteredToolNames may or may not include the dynamic tool names.
        const filtered = new ToolFilter().filter(intent, agent.getTools())
        const filteredNames = new Set(filtered.map((t) => t.name))

        // Every base-registered dynamic tool must survive filtering, whether or
        // not intent.filteredToolNames mentions it.
        for (const t of dynamicTools) {
          assert.equal(
            filteredNames.has(t.name),
            true,
            `Base_Tool dynamic tool "${t.name}" was filtered out`,
          )
        }
      }),
      RUNS,
    )
  })
})

// ---------------------------------------------------------------------------
// Property 11 (Task 6.4)
// ---------------------------------------------------------------------------

// Feature: runtime-dynamic-mcp-loading, Property 11: INITIAL_BASE_TOOLS 始终是 Base_Tool 超集且预置名不被取消
describe('Property 11: INITIAL_BASE_TOOLS superset + preset names never unregistered', () => {
  it('getBaseTools() stays a superset of INITIAL_BASE_TOOLS across any add/remove sequence; removing a preset name keeps it a Base_Tool', () => {
    // An op is either an addTools (optionally asBaseTool) or a removeTool. The
    // removeTool targets are deliberately biased to include INITIAL_BASE_TOOLS
    // names so the "preset names are never unregistered" invariant (Req 4.4) is
    // actually exercised, alongside arbitrary/dynamic names.
    const arbOp = fc.oneof(
      fc.record({
        kind: fc.constant('add'),
        tool: arbToolDef,
        asBaseTool: fc.boolean(),
      }),
      fc.record({
        kind: fc.constant('remove'),
        name: fc.oneof(fc.constantFrom(...INITIAL_BASE_TOOLS), arbToolName),
      }),
    )

    fc.assert(
      fc.property(fc.array(arbOp, { maxLength: 30 }), (ops) => {
        resetBaseTools()
        const agent = makeAgent()

        for (const op of ops) {
          if (op.kind === 'add') {
            agent.addTools(op.tool, { asBaseTool: op.asBaseTool })
          } else {
            agent.removeTool(op.name)
          }

          // Invariant 1 (Req 4.5): after every operation, getBaseTools() remains
          // a superset of INITIAL_BASE_TOOLS — no preset name is ever dropped.
          const base = new Set(getBaseTools())
          for (const preset of INITIAL_BASE_TOOLS) {
            assert.equal(base.has(preset), true, `preset "${preset}" missing from Base_Tools`)
          }
        }

        // Invariant 2 (Req 4.4): every preset name is still a Base_Tool, even if
        // removeTool was called on it during the sequence.
        for (const preset of INITIAL_BASE_TOOLS) {
          assert.equal(isBaseTool(preset), true, `preset "${preset}" lost Base_Tool identity`)
        }
      }),
      RUNS,
    )
  })
})

// ---------------------------------------------------------------------------
// Property 5 (Task 4.4)
// ---------------------------------------------------------------------------

// Feature: runtime-dynamic-mcp-loading, Property 5: 每轮派生的工具集与 toolMap 与过滤结果精确一致且确定
describe('Property 5: per-round derivation + toolMap consistency and determinism', () => {
  it('derived round tools equal ToolFilter.filter (or all tools when intent off); toolMap maps names to refs and returns undefined for missing names; derivation is deterministic', () => {
    fc.assert(
      fc.property(
        arbUniqueToolDefList,
        arbIntentResult,
        fc.boolean(),
        (tools, intent, enableIntent) => {
          resetBaseTools()
          const agent = makeAgent({ enableIntentRecognition: enableIntent })
          for (const t of tools) agent.addTools(t)
          // When intent recognition is on, the per-round derivation re-applies
          // ToolFilter against the cached first-round intent; when off, it
          // returns the full registry. _lastIntent is only consulted in the
          // intent-on branch.
          agent._lastIntent = enableIntent ? intent : null

          // Determinism: calling twice (stands in for the non-stream/stream
          // paths, which both delegate to the same _deriveRoundTools()) yields
          // element-set-equal results.
          const derived1 = agent._deriveRoundTools()
          const derived2 = agent._deriveRoundTools()
          const names1 = new Set(derived1.map((t) => t.name))
          const names2 = new Set(derived2.map((t) => t.name))
          assert.deepEqual(names2, names1)

          // The derived tool-name set equals ToolFilter.filter(intent, tools)
          // when intent recognition is enabled, else the full registry.
          const expected = enableIntent
            ? new ToolFilter().filter(intent, agent.getTools())
            : agent.getTools()
          const expectedNames = new Set(expected.map((t) => t.name))
          assert.deepEqual(names1, expectedNames)

          // toolMap (built exactly as the ReAct loop does) maps every derived
          // name to its corresponding Tool_Def reference.
          const toolMap = Object.fromEntries(derived1.map((t) => [t.name, t]))
          for (const t of derived1) {
            assert.equal(toolMap[t.name], t)
          }

          // Lookups for names absent from the derived set return undefined.
          const absent = '__missing_tool_name_for_property5__'
          if (!names1.has(absent)) {
            assert.equal(toolMap[absent], undefined)
          }
        },
      ),
      RUNS,
    )
  })
})

// ---------------------------------------------------------------------------
// Property 6 (Task 4.5)
// ---------------------------------------------------------------------------

// Feature: runtime-dynamic-mcp-loading, Property 6: Tool_Registry 未变更时下一轮复用等价快照
describe('Property 6: unchanged-registry reuse equivalence', () => {
  it('when _toolsGeneration is unchanged, the next round derives a tool set + toolMap element-set-equal to the previous round (same name set, each name → same Tool_Def reference)', () => {
    fc.assert(
      fc.property(
        arbUniqueToolDefList,
        arbIntentResult,
        fc.boolean(),
        (tools, intent, enableIntent) => {
          resetBaseTools()
          const agent = makeAgent({ enableIntentRecognition: enableIntent })
          for (const t of tools) agent.addTools(t)
          // _lastIntent is only consulted when intent recognition is enabled;
          // the per-round derivation re-applies ToolFilter against it.
          agent._lastIntent = enableIntent ? intent : null

          // --- Round N: derive once and snapshot the generation. ---
          const prevTools = agent._deriveRoundTools()
          const prevToolMap = Object.fromEntries(prevTools.map((t) => [t.name, t]))
          const derivedGeneration = agent._toolsGeneration

          // --- Between rounds the registry is NOT touched. ---

          // --- Round N+1: generation is unchanged, so re-derive and assert
          // observable equivalence with round N. ---
          assert.equal(
            agent._toolsGeneration,
            derivedGeneration,
            'Tool_Registry generation must be unchanged between rounds',
          )

          const nextTools = agent._deriveRoundTools()
          const nextToolMap = Object.fromEntries(nextTools.map((t) => [t.name, t]))

          // Same tool-name set across the two rounds.
          const prevNames = new Set(prevTools.map((t) => t.name))
          const nextNames = new Set(nextTools.map((t) => t.name))
          assert.deepEqual(nextNames, prevNames)

          // Each name maps to the SAME Tool_Def reference (===) in both rounds.
          for (const name of prevNames) {
            assert.equal(
              nextToolMap[name],
              prevToolMap[name],
              `tool "${name}" must map to the same Tool_Def reference across rounds`,
            )
          }

          // Generation still unchanged after the second derivation (deriving
          // does not mutate the registry).
          assert.equal(agent._toolsGeneration, derivedGeneration)
        },
      ),
      RUNS,
    )
  })
})

// ---------------------------------------------------------------------------
// Task 4.6 — In-round vs next-round tool visibility (Requirements 2.6, 2.7)
//
// These are example / unit tests (NOT property-based). They drive the real
// ReAct loop (`agent.chat` → `_reactLoop`) with a mock LLM by stubbing
// `globalThis.fetch`, asserting that:
//   - Req 2.6: a tool added DURING a round is NOT exposed to the LLM in that
//     round's request body, but IS exposed (and dispatchable) in the next
//     round.
//   - Req 2.7: when the LLM requests a tool that is no longer in the current
//     round's toolMap (removed via `removeTool`), the agent returns a
//     not_found error string and the ReAct loop continues without throwing.
// ---------------------------------------------------------------------------

const _prevFetch_46 = { f: null }

/** Minimal `Response`-shaped object returning a canned JSON body. */
function _mockJson46(body) {
  return {
    ok: true,
    status: 200,
    async json() { return body },
    async text() { return JSON.stringify(body) },
  }
}

/** A sync chat-completion that requests a single tool call. */
function _toolCallResponse(toolName, { callId = 'c1', argumentsJson = '{}' } = {}) {
  return {
    model: 'gpt-4o-mini',
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id: callId,
          type: 'function',
          function: { name: toolName, arguments: argumentsJson },
        }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }
}

/** A sync chat-completion that returns final text (no tool calls). */
function _textResponse(content) {
  return {
    model: 'gpt-4o-mini',
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }
}

/**
 * Stub `globalThis.fetch` to return each queued response on successive calls,
 * capturing the parsed request body of every call so tests can inspect the
 * `tools` list the LLM was shown per round.
 */
function _stubFetchCapturing(responses) {
  const bodies = []
  let i = 0
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body))
    if (i >= responses.length) throw new Error(`fetch stub exhausted (call #${i + 1})`)
    return _mockJson46(responses[i++])
  }
  return bodies
}

/** Extract the tool-name set exposed in a captured request body. */
function _bodyToolNames(body) {
  return (body.tools ?? []).map((t) => t.function?.name ?? t.name)
}

// --- Streaming SSE stubs (mirror the helpers in src/agent.test.js) ---

/** Minimal SSE `Response` shim serving the given chunk strings. */
function _mockSseStream(chunks) {
  const encoder = new TextEncoder()
  let idx = 0
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        let released = false
        return {
          async read() {
            if (released || idx >= chunks.length) return { done: true, value: undefined }
            return { done: false, value: encoder.encode(chunks[idx++]) }
          },
          releaseLock() { released = true },
        }
      },
    },
    async text() { return '' },
    async json() { return {} },
  }
}

/** SSE chunk stream that emits a single tool_call then finish_reason=tool_calls. */
function _toolCallSse(toolName, { callId = 'c1', argumentsJson = '{}', model = 'gpt-4o-mini' } = {}) {
  const open = 'data: ' + JSON.stringify({
    model,
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: toolName, arguments: '' } }] } }],
  }) + '\n'
  const args = 'data: ' + JSON.stringify({
    model,
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argumentsJson } }] } }],
  }) + '\n'
  const finish = 'data: ' + JSON.stringify({
    model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
  }) + '\n'
  return [open, args, finish, 'data: [DONE]\n']
}

/** SSE chunk stream that emits final text then finish_reason=stop. */
function _textSse(content, { model = 'gpt-4o-mini' } = {}) {
  const delta = 'data: ' + JSON.stringify({ model, choices: [{ index: 0, delta: { content } }] }) + '\n'
  const finish = 'data: ' + JSON.stringify({ model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n'
  return [delta, finish, 'data: [DONE]\n']
}

/** Stub `globalThis.fetch` to serve queued SSE chunk-streams in order. */
function _stubFetchCapturingStream(streams) {
  let i = 0
  globalThis.fetch = async () => {
    if (i >= streams.length) throw new Error(`fetch stub exhausted (call #${i + 1})`)
    return _mockSseStream(streams[i++])
  }
}

describe('Task 4.6: in-round vs next-round tool visibility (Req 2.6, 2.7)', () => {
  beforeEach(() => { _prevFetch_46.f = globalThis.fetch })
  afterEach(() => { globalThis.fetch = _prevFetch_46.f })

  // Req 2.6: adding a tool mid-round does not affect the current round, but is
  // visible (and dispatchable) in the next round.
  it('addTools() during a round is invisible to the current round and live in the next round (Req 2.6)', async () => {
    let dynamicRan = 0
    const dynamicAdded = defineTool({
      name: 'dynamic_added',
      description: 'A tool registered at runtime mid-round',
      parameters: { type: 'object', properties: {} },
      execute: async () => { dynamicRan++; return 'dynamic-result' },
    })

    let agent
    const trigger = defineTool({
      name: 'trigger',
      description: 'Adds a new tool to the registry while round 0 is executing',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        // Tool_Registry mutation happens AFTER round 0's body was already built.
        agent.addTools(dynamicAdded)
        return 'trigger-done'
      },
    })

    agent = makeAgent({
      memory: new SlidingWindowMemory(50),
      tools: [trigger],
      maxRounds: 3,
    })

    const bodies = _stubFetchCapturing([
      _toolCallResponse('trigger'),        // round 0 → runs trigger → addTools
      _toolCallResponse('dynamic_added'),  // round 1 → must now be dispatchable
      _textResponse('all-done'),           // round 2 → final answer
    ])

    const reply = await agent.chat('go')
    assert.equal(reply, 'all-done')

    // Round 0's exposed tools must NOT include the mid-round addition.
    const round0Names = new Set(_bodyToolNames(bodies[0]))
    assert.equal(round0Names.has('trigger'), true, 'round 0 should expose the static trigger tool')
    assert.equal(
      round0Names.has('dynamic_added'),
      false,
      'a tool added mid-round must NOT be exposed in the current round',
    )

    // Round 1's exposed tools MUST include the dynamically added tool.
    const round1Names = new Set(_bodyToolNames(bodies[1]))
    assert.equal(
      round1Names.has('dynamic_added'),
      true,
      'a tool added during round 0 must be exposed to the LLM in round 1',
    )
    assert.equal(round1Names.has('trigger'), true, 'pre-existing tools remain exposed next round')

    // It was not merely listed: the LLM selected it in round 1 and the agent
    // found it in the round's toolMap and executed it.
    assert.equal(dynamicRan, 1, 'the dynamically added tool must be dispatchable in the next round')
  })

  // Req 2.7: a tool removed via removeTool() is gone from the next round's
  // toolMap; if the LLM still requests it, the agent returns a not_found error
  // string and the loop continues without throwing.
  it('LLM call to a removed/unknown tool yields a not_found result and the loop continues (Req 2.7)', async () => {
    let victimRan = 0
    const victim = defineTool({
      name: 'victim',
      description: 'A tool that will be removed at runtime',
      parameters: { type: 'object', properties: {} },
      execute: async () => { victimRan++; return 'victim-ran' },
    })

    let agent
    const remover = defineTool({
      name: 'remover',
      description: 'Removes the victim tool from the registry during round 0',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        agent.removeTool('victim')
        return 'removed'
      },
    })

    agent = makeAgent({
      memory: new SlidingWindowMemory(50),
      tools: [remover, victim],
      maxRounds: 3,
    })

    const bodies = _stubFetchCapturing([
      _toolCallResponse('remover'), // round 0 → removes 'victim'
      _toolCallResponse('victim'),  // round 1 → 'victim' no longer in toolMap
      _textResponse('finished'),    // round 2 → final answer
    ])

    const toolCalls = []
    agent.on('tool.call', (p) => toolCalls.push(p))

    // The loop must not throw despite the unknown-tool request.
    const reply = await agent.chat('go')
    assert.equal(reply, 'finished')

    // 'victim' was never dispatched once removed.
    assert.equal(victimRan, 0, 'a removed tool must not be executed')

    // Round 1 must not expose the removed tool to the LLM.
    const round1Names = new Set(_bodyToolNames(bodies[1]))
    assert.equal(round1Names.has('victim'), false, 'removed tool must be gone from the next round')

    // The not_found branch emitted a tool.call with errorKind 'not_found'.
    const victimCall = toolCalls.find((c) => c.name === 'victim')
    assert.ok(victimCall, 'expected a tool.call event for the unknown tool')
    assert.equal(victimCall.ok, false)
    assert.equal(victimCall.errorKind, 'not_found')

    // A descriptive not_found error string was appended to memory and the loop
    // proceeded to a normal final answer. The message must also give the model a
    // corrective signal: the tools actually available this round, plus explicit
    // guidance not to retry the missing tool (regression guard for the
    // mid-conversation tool-unload case).
    const msgs = await agent.memory.getMessages()
    const victimMsg = msgs.find((m) => m.role === 'tool' && m.name === 'victim')
    assert.ok(victimMsg, 'expected a tool result message for the unknown tool')
    assert.match(victimMsg.content, /not found/i)
    assert.match(victimMsg.content, /Available tools now:/i)
    assert.match(victimMsg.content, /remover/, 'must list a still-available tool name')
    assert.doesNotMatch(victimMsg.content, /Available tools now:[^.]*\bvictim\b/, 'removed tool must not be listed as available')
    assert.match(victimMsg.content, /Do not call "victim" again/i)
  })

  // Streaming counterpart of Req 2.7: the stream() path previously returned a
  // bare "Tool X not found" with no available-tools hint, so the model would
  // keep retrying a removed tool. Verify the streaming not_found message now
  // carries the same corrective signal as the non-streaming path.
  it('streaming: removed-tool call yields a not_found result with available tools + no-retry guidance', async () => {
    let agent
    const remover = defineTool({
      name: 'remover',
      description: 'Removes the victim tool from the registry during round 0',
      parameters: { type: 'object', properties: {} },
      execute: async () => { agent.removeTool('victim'); return 'removed' },
    })
    const victim = defineTool({
      name: 'victim',
      description: 'A tool that will be removed at runtime',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'victim-ran',
    })

    agent = makeAgent({
      memory: new SlidingWindowMemory(50),
      tools: [remover, victim],
      maxRounds: 3,
    })

    _stubFetchCapturingStream([
      _toolCallSse('remover'), // round 0 → removes 'victim'
      _toolCallSse('victim'),  // round 1 → 'victim' no longer in toolMap
      _textSse('finished'),    // round 2 → final answer
    ])

    const toolEnds = []
    let finalContent = ''
    for await (const ev of agent.stream('go')) {
      if (ev.type === 'tool_end') toolEnds.push(ev)
      if (ev.type === 'done') finalContent = ev.content
    }

    assert.equal(finalContent, 'finished', 'loop continues to a normal final answer')

    const victimEnd = toolEnds.find((e) => e.name === 'victim')
    assert.ok(victimEnd, 'expected a tool_end event for the removed tool')
    assert.match(victimEnd.result, /not found/i)
    assert.match(victimEnd.result, /Available tools now:/i)
    assert.match(victimEnd.result, /remover/, 'must list a still-available tool name')
    assert.match(victimEnd.result, /Do not call "victim" again/i)
  })

  // Proactive guard: when a NEW turn begins and the conversation history still
  // references a tool that has since been removed/unloaded (e.g. an MCP server
  // was detached between turns), the round-0 request must carry a system note
  // telling the model that tool is no longer available — so it does not retry
  // it on the strength of the stale tool_call records in history. Covers the
  // case where tools change via ANY mechanism (here a direct removeTool).
  it('a new turn injects an "unavailable tools" system note when history references a removed tool', async () => {
    const search = defineTool({
      name: 'searchx',
      description: 'search the web',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'ok',
    })
    const agent = makeAgent({ memory: new SlidingWindowMemory(50), tools: [search] })

    // Simulate a prior turn that successfully used searchx (these records stay
    // in memory and would otherwise make the model believe searchx still exists).
    agent.memory.add({ role: 'user', content: 'search something' })
    agent.memory.add({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'searchx', arguments: '{}' } }],
    })
    agent.memory.add({ role: 'tool', tool_call_id: 'c1', name: 'searchx', content: 'prior results' })

    // The tool is unloaded before the next turn (direct registry change).
    assert.equal(agent.removeTool('searchx'), true)

    const bodies = _stubFetchCapturing([_textResponse('done')])
    await agent.chat('search again')

    // Round 0's outgoing messages must carry a system note naming the removed tool.
    const sys = bodies[0].messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n')
    assert.match(sys, /no longer available/i)
    assert.match(sys, /searchx/, 'the note must name the removed tool')

    // And the note must NOT be persisted into memory (recomputed per turn).
    const persisted = (await agent.memory.getMessages())
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n')
    assert.doesNotMatch(persisted, /no longer available/i, 'note must be transient, not stored in memory')
  })
})

// ---------------------------------------------------------------------------
// Property 12 (Task 7.5)
// ---------------------------------------------------------------------------

// A serverKey that is guaranteed NOT to collide with INITIAL_BASE_TOOLS naming
// is irrelevant here (serverKeys are independent of tool names), so any
// non-empty string works.
const arbServerKey = fc.oneof(
  fc.string({ minLength: 1, maxLength: 24 }),
  fc.string({ unit: 'grapheme', minLength: 1, maxLength: 8 }),
)

// One managed server spec: a stable key, the dynamic tools it contributed, and
// how its client's close() behaves (normal / throw / hang). 'throw' and 'hang'
// are the failing paths the teardown must isolate (Req 5.4).
const arbManagedServer = fc.record({
  serverKey: arbServerKey,
  tools: arbUniqueToolDefList,
  closeBehavior: fc.constantFrom('normal', 'throw', 'hang'),
})

// Keep the set small: hanging clients are resolved by a real (short) timeout
// race, processed sequentially during teardown, so bounding the count keeps
// 100 runs fast.
const arbManagedServers = fc.array(arbManagedServer, { minLength: 1, maxLength: 4 })

// Feature: runtime-dynamic-mcp-loading, Property 12: 拆除在部分失败下仍隔离错误并清空集合
describe('Property 12: teardown isolates partial failures and empties the set', () => {
  it('closeMCPClients() diagnoses every failing serverKey, still closes the rest, removes all dynamic tools + cancels their Base_Tool registration, and leaves the managed set empty', async () => {
    await fc.assert(
      fc.asyncProperty(arbManagedServers, async (servers) => {
        resetBaseTools()

        // Normalize: serverKeys must be unique (Map key), and dynamic tool names
        // must be globally unique and not collide with INITIAL_BASE_TOOLS (a
        // preset name is never unregistered, which would break the
        // "Base_Tool cancelled" assertion). First occurrence wins.
        const seenKeys = new Set()
        const seenToolNames = new Set()
        const normalized = []
        for (const s of servers) {
          if (seenKeys.has(s.serverKey)) continue
          seenKeys.add(s.serverKey)
          const tools = []
          for (const t of s.tools) {
            if (seenToolNames.has(t.name)) continue
            if (INITIAL_BASE_TOOLS.includes(t.name)) continue
            seenToolNames.add(t.name)
            tools.push(t)
          }
          normalized.push({ serverKey: s.serverKey, tools, closeBehavior: s.closeBehavior })
        }

        // Capture lifecycle diagnostics via the onError hook (preferred over
        // console.warn when provided).
        const onErrorCalls = []
        const agent = makeAgent({
          // Small close timeout so hanging clients resolve quickly via the race.
          dynamicMCPOpts: { closeTimeoutMs: 25 },
          hooks: {
            onError: (err, ctx) => onErrorCalls.push({ err, ctx }),
          },
        })

        // Populate the registry with each server's dynamic tools (as Base_Tools,
        // exactly as the runtime-load path does) and seed _managedClients with a
        // ManagedEntry whose client has the generated close() behavior.
        for (const s of normalized) {
          if (s.tools.length > 0) agent.addTools(s.tools, { asBaseTool: true })
          const client = makeMockMCPClient({ closeBehavior: s.closeBehavior })
          agent._managedClients.set(s.serverKey, {
            serverKey: s.serverKey,
            client,
            toolNames: new Set(s.tools.map((t) => t.name)),
          })
        }

        // Sanity: before teardown every dynamic tool is present and base-registered.
        for (const s of normalized) {
          for (const t of s.tools) {
            assert.equal(isBaseTool(t.name), true)
          }
        }

        await agent.closeMCPClients()

        // The managed set is fully emptied.
        assert.equal(agent._managedClients.size, 0)

        // Every dynamic tool was removed from the registry (no other tools exist).
        assert.equal(agent.getTools().length, 0)

        // Every dynamic tool's Base_Tool registration was cancelled.
        for (const s of normalized) {
          for (const t of s.tools) {
            assert.equal(
              isBaseTool(t.name),
              false,
              `dynamic tool "${t.name}" should no longer be a Base_Tool after teardown`,
            )
          }
        }

        // Every failing client (throw OR hang) produced a diagnostic carrying its
        // own Server_Key, and teardown continued past it to close the rest.
        const failingKeys = new Set(
          normalized.filter((s) => s.closeBehavior !== 'normal').map((s) => s.serverKey),
        )
        const diagnosedKeys = new Set(onErrorCalls.map((c) => c.ctx?.serverKey))
        for (const key of failingKeys) {
          assert.equal(
            diagnosedKeys.has(key),
            true,
            `expected an error diagnostic referencing failing serverKey "${key}"`,
          )
        }
      }),
      RUNS,
    )
  })
})

// ---------------------------------------------------------------------------
// Task 7.6 — reset() teardown + empty-set no-op (Requirements 5.3, 5.5, 5.7, 7.2, 7.5)
//
// These are example / unit tests (NOT property-based). They exercise the
// lifecycle wiring of `reset()` and `closeMCPClients()` directly by seeding
// `_managedClients` with mock clients that count their close() calls:
//   - Req 5.3 / 5.5: reset() closes every managed client and, once teardown
//     settles, empties the set, removes the dynamic tools those clients
//     contributed, and cancels their Base_Tool registration.
//   - Req 7.2: reset() returns undefined (and does so synchronously; teardown
//     is fire-and-forget).
//   - Req 5.7 / 7.5: closeMCPClients() and reset() on an empty managed set are
//     safe no-ops — they never throw and never invoke teardown / close().
// ---------------------------------------------------------------------------

/** Poll `predicate` until it is truthy or the timeout elapses. */
async function _waitFor76(predicate, { timeoutMs = 1000, intervalMs = 5 } = {}) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('_waitFor76 timed out waiting for condition')
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

/** Seed one managed entry: register its tools as Base_Tools and track its client. */
function _seedManagedServer76(agent, serverKey, toolNames, closeBehavior = 'normal') {
  const tools = toolNames.map((name) => ({
    name,
    description: '',
    parameters: { type: 'object', properties: {} },
    execute: async () => 'ok',
  }))
  if (tools.length > 0) agent.addTools(tools, { asBaseTool: true })
  const client = makeMockMCPClient({ closeBehavior })
  agent._managedClients.set(serverKey, {
    serverKey,
    client,
    toolNames: new Set(toolNames),
  })
  return client
}

describe('Task 7.6: reset() teardown + empty-set no-op (Req 5.3, 5.5, 5.7, 7.2, 7.5)', () => {
  // Req 5.3 / 5.5 / 7.2: reset() returns undefined synchronously, then (via its
  // fire-and-forget teardown) closes every managed client, empties the set,
  // removes the contributed dynamic tools, and cancels their Base_Tool ids.
  it('reset() closes managed clients, clears the set, removes dynamic tools + cancels Base_Tool registration, and returns undefined (Req 5.3, 5.5, 7.2)', async () => {
    resetBaseTools()
    const agent = makeAgent()

    const clientA = _seedManagedServer76(agent, 'serverA', ['srv_a_tool'])
    const clientB = _seedManagedServer76(agent, 'serverB', ['srv_b_one', 'srv_b_two'])

    // Sanity: dynamic tools present and base-registered before reset.
    assert.equal(agent._managedClients.size, 2)
    assert.equal(agent.getTools().length, 3)
    for (const name of ['srv_a_tool', 'srv_b_one', 'srv_b_two']) {
      assert.equal(isBaseTool(name), true)
    }

    // reset() returns undefined, synchronously (Req 7.2). Teardown is
    // fire-and-forget, so close() has not necessarily run yet at this point.
    const ret = agent.reset()
    assert.equal(ret, undefined)

    // Await the fire-and-forget teardown to observe its effects (Req 5.3/5.5).
    await _waitFor76(() => agent._managedClients.size === 0)

    // Every managed client's close() was invoked exactly once.
    assert.equal(clientA.closeCalls, 1)
    assert.equal(clientB.closeCalls, 1)

    // The managed set is fully emptied.
    assert.equal(agent._managedClients.size, 0)

    // The dynamic tools those clients contributed were removed from the registry.
    assert.equal(agent.getTools().length, 0)
    for (const name of ['srv_a_tool', 'srv_b_one', 'srv_b_two']) {
      assert.equal(agent.getTools().some((t) => t.name === name), false)
      // Their Base_Tool registration was cancelled.
      assert.equal(isBaseTool(name), false, `dynamic tool "${name}" should no longer be a Base_Tool`)
    }
  })

  // Req 7.2: reset() always returns undefined, even with an empty managed set.
  it('reset() returns undefined on an empty managed set (Req 7.2)', () => {
    resetBaseTools()
    const agent = makeAgent()
    assert.equal(agent._managedClients.size, 0)
    assert.equal(agent.reset(), undefined)
  })

  // Req 5.7 / 7.5: reset() on an empty managed set must not trigger any
  // teardown / close() — it only performs the pre-existing state cleanup.
  it('reset() on an empty managed set does not trigger teardown and does not throw (Req 5.7, 7.5)', async () => {
    resetBaseTools()
    const agent = makeAgent()
    assert.equal(agent._managedClients.size, 0)

    // Spy on teardown to prove no close path runs when the set is empty.
    let teardownCalls = 0
    const origTeardown = agent._teardownManagedClients.bind(agent)
    agent._teardownManagedClients = (...args) => {
      teardownCalls += 1
      return origTeardown(...args)
    }

    assert.doesNotThrow(() => agent.reset())

    // Give any (erroneously) scheduled fire-and-forget teardown a chance to run.
    await new Promise((r) => setTimeout(r, 20))

    assert.equal(teardownCalls, 0, 'empty managed set must not trigger teardown')
    assert.equal(agent._managedClients.size, 0)
  })

  // Req 5.7: closeMCPClients() on an empty managed set is a safe no-op that
  // never throws and never invokes teardown / close().
  it('closeMCPClients() on an empty managed set is a no-op that does not throw and calls no close() (Req 5.7)', async () => {
    resetBaseTools()
    const agent = makeAgent()
    assert.equal(agent._managedClients.size, 0)

    let teardownCalls = 0
    const origTeardown = agent._teardownManagedClients.bind(agent)
    agent._teardownManagedClients = (...args) => {
      teardownCalls += 1
      return origTeardown(...args)
    }

    await assert.doesNotReject(() => agent.closeMCPClients())

    assert.equal(teardownCalls, 0, 'empty managed set must not invoke teardown')
    assert.equal(agent._managedClients.size, 0)
  })
})

// ---------------------------------------------------------------------------
// Property 7 (Task 9.3)
//
// The success path of load_mcp_server (_loadMCPServer) must return text that
// identifies the loaded server (its Server_Key) and lists every newly added
// tool name. We drive it through the internal createMCPClient seam
// (agent._createMCPClient) so no real MCP connection is made: the seam returns
// a mock MCP_Client whose listTools() resolves the generated non-empty Tool_Def
// set.
// ---------------------------------------------------------------------------

/** A non-empty Tool_Def list with globally-unique names (success path needs ≥1 tool). */
const arbNonEmptyUniqueToolDefList = arbUniqueToolDefList.filter((tools) => tools.length > 0)

/** A non-empty Server_Key (any non-empty string; independent of tool names). */
const arbNonEmptyServerKey = fc.oneof(
  fc.string({ minLength: 1, maxLength: 24 }),
  fc.string({ unit: 'grapheme', minLength: 1, maxLength: 8 }),
)

// Feature: runtime-dynamic-mcp-loading, Property 7: 成功加载文本包含 Server_Key 与全部新增工具名
describe('Property 7: success text contains Server_Key and every added tool name', () => {
  it('load_mcp_server success path returns text including the serverKey and each tool name', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbNonEmptyUniqueToolDefList,
        arbNonEmptyServerKey,
        async (tools, serverKey) => {
          resetBaseTools()

          const agent = makeAgent({ enableDynamicMCP: true })

          // Override the createMCPClient seam to return a mock MCP_Client whose
          // listTools() yields the generated non-empty Tool_Def set. The factory
          // is invoked as factory(options) by _loadMCPServer.
          agent._createMCPClient = () => makeMockMCPClient({ tools })

          const text = await agent._loadMCPServer({
            serverKey,
            transport: 'http',
            url: 'https://example.test/mcp',
          })

          // The returned text identifies the loaded server by its Server_Key.
          assert.ok(
            text.includes(serverKey),
            `success text must contain the serverKey "${serverKey}", got: ${text}`,
          )

          // The returned text lists every newly added tool name.
          for (const t of tools) {
            assert.ok(
              text.includes(t.name),
              `success text must contain tool name "${t.name}", got: ${text}`,
            )
          }
        },
      ),
      RUNS,
    )
  })

  it('load_mcp_server success text includes MCP metadata that helps the LLM choose the loaded tools', async () => {
    const agent = makeAgent({ enableDynamicMCP: true })
    const outputSchema = {
      type: 'object',
      properties: {
        results: { type: 'array' },
        totalResults: { type: 'number' },
      },
      required: ['results'],
    }
    const tool = {
      name: 'mcp__web__search',
      description: 'Search the web.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      execute: async () => '',
    }
    Object.defineProperty(tool, 'title', { value: 'Web Search', enumerable: false })
    Object.defineProperty(tool, 'outputSchema', { value: outputSchema, enumerable: false })
    Object.defineProperty(tool, 'execution', { value: { taskSupport: 'optional' }, enumerable: false })
    Object.defineProperty(tool, 'annotations', { value: { readOnlyHint: true }, enumerable: false })
    Object.defineProperty(tool, '_mcp', {
      value: {
        rawName: 'search',
        serverName: 'web',
        rawDescription: 'Search the web.',
        title: 'Web Search',
        outputSchema,
        execution: { taskSupport: 'optional' },
        annotations: { readOnlyHint: true },
      },
      enumerable: false,
    })

    agent._createMCPClient = () => makeMockMCPClient({ tools: [tool] })

    const text = await agent._loadMCPServer({
      serverKey: 'web',
      transport: 'http',
      url: 'https://example.test/mcp',
    })

    assert.match(text, /mcp__web__search/)
    assert.match(text, /Web Search/)
    assert.match(text, /taskSupport=optional/)
    assert.match(text, /outputSchema=object/)
    assert.match(text, /properties: results, totalResults/)
  })
})

// ---------------------------------------------------------------------------
// Property 8 (Task 9.4)
//
// For any category of invalid connection params (non-object, missing
// serverKey, empty serverKey, unsupported transport), _loadMCPServer must
// return a descriptive error string that names the offending parameter, must
// NOT call createMCPClient, and must leave the Tool_Registry unchanged.
//
// We install a spy on the internal createMCPClient seam (agent._createMCPClient)
// that records calls and throws if ever invoked, so a single invocation fails
// the test outright.
// ---------------------------------------------------------------------------

const SUPPORTED_TRANSPORTS_P8 = ['stdio', 'http', 'streamable-http', 'sse']

/**
 * One invalid-params case: the params to feed _loadMCPServer, the category
 * label (for diagnostics), and a token the returned error text must mention to
 * identify the offending parameter.
 */
const arbInvalidConnParams = fc.oneof(
  // Non-object: null / number / string / boolean / array. The offending
  // "parameter" is the params object itself, so the error must mention that an
  // object was expected.
  fc
    .oneof(
      fc.constant(null),
      fc.integer(),
      fc.string(),
      fc.boolean(),
      fc.array(fc.anything(), { maxLength: 4 }),
    )
    .map((params) => ({ params, category: 'non-object', token: /object/i })),

  // Missing serverKey: a valid object with a valid transport but no serverKey.
  fc
    .constantFrom(...SUPPORTED_TRANSPORTS_P8)
    .map((transport) => ({ params: { transport }, category: 'missing-serverKey', token: /serverKey/ })),

  // Empty serverKey: serverKey is the empty string.
  fc
    .constantFrom(...SUPPORTED_TRANSPORTS_P8)
    .map((transport) => ({
      params: { serverKey: '', transport },
      category: 'empty-serverKey',
      token: /serverKey/,
    })),

  // Unsupported transport: a valid non-empty serverKey but a transport that is
  // not one of the four supported values.
  fc
    .tuple(
      arbNonEmptyServerKey,
      fc.string().filter((t) => !SUPPORTED_TRANSPORTS_P8.includes(t)),
    )
    .map(([serverKey, transport]) => ({
      params: { serverKey, transport },
      category: 'unsupported-transport',
      token: /transport/,
    })),
)

// Feature: runtime-dynamic-mcp-loading, Property 8: 非法连接参数返回指明参数名的错误且不改 Tool_Registry
describe('Property 8: invalid connection params return a parameter-naming error without touching Tool_Registry', () => {
  it('returns a descriptive error naming the offending parameter, never calls createMCPClient, and leaves the registry unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(arbInvalidConnParams, async ({ params, category, token }) => {
        resetBaseTools()
        const agent = makeAgent({ enableDynamicMCP: true })

        // Spy: a single invocation of the createMCPClient seam must fail the test.
        let createCalls = 0
        agent._createMCPClient = () => {
          createCalls++
          throw new Error('createMCPClient must not be called for invalid connection params')
        }

        const before = agent.getTools().map((t) => t.name)

        const text = await agent._loadMCPServer(params)

        // (1) The returned text is a descriptive error naming the offending param.
        assert.equal(typeof text, 'string')
        assert.match(
          text,
          token,
          `[${category}] error text must name the offending parameter, got: ${text}`,
        )

        // (2) createMCPClient was never called.
        assert.equal(createCalls, 0, `[${category}] createMCPClient must not be called`)

        // (3) Tool_Registry is unchanged.
        assert.deepEqual(
          agent.getTools().map((t) => t.name),
          before,
          `[${category}] Tool_Registry must be unchanged`,
        )
      }),
      RUNS,
    )
  })
})

// ---------------------------------------------------------------------------
// Property 13 (Task 9.5)
//
// Reloading the SAME serverKey must close the previously-managed client
// (reusing the 5000ms close timeout + error handling) and replace it: the
// managed set ends with that serverKey uniquely mapped to the NEW client.
//
// We drive it through the internal createMCPClient seam (agent._createMCPClient),
// which returns distinct mock MCP_Clients on successive _loadMCPServer calls
// made under the same serverKey, so no real MCP connection is made. The mock
// client exposes `closeCalls`, letting us assert the old client was close()d
// exactly once.
// ---------------------------------------------------------------------------

// Feature: runtime-dynamic-mcp-loading, Property 13: 同 Server_Key 重复加载替换旧客户端
describe('Property 13: same-serverKey reload replaces the previous client', () => {
  it('closes the old client (closeCalls === 1) and maps the serverKey uniquely to the new client', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbNonEmptyServerKey,
        arbUniqueToolDefList,
        arbUniqueToolDefList,
        async (serverKey, toolsA, toolsB) => {
          resetBaseTools()
          const agent = makeAgent({ enableDynamicMCP: true })

          const clientA = makeMockMCPClient({ tools: toolsA })
          const clientB = makeMockMCPClient({ tools: toolsB })

          // The seam returns clientA on the first load and clientB on the second,
          // both requested under the SAME serverKey.
          let call = 0
          agent._createMCPClient = () => (call++ === 0 ? clientA : clientB)

          // First load: clientA becomes the managed client for serverKey.
          await agent._loadMCPServer({
            serverKey,
            transport: 'http',
            url: 'https://example.test/mcp',
          })
          assert.equal(agent._managedClients.get(serverKey).client, clientA)
          assert.equal(clientA.closeCalls, 0)

          // Second load with the SAME serverKey: the old client (A) must be
          // close()d and replaced by the new client (B).
          await agent._loadMCPServer({
            serverKey,
            transport: 'http',
            url: 'https://example.test/mcp',
          })

          // (1) The previous client was closed exactly once.
          assert.equal(clientA.closeCalls, 1, 'old client must be close()d on same-key reload')

          // (2) The serverKey now maps to the NEW client.
          assert.equal(
            agent._managedClients.get(serverKey).client,
            clientB,
            'serverKey must map to the new client after reload',
          )

          // (3) The managed set has exactly one entry for this serverKey.
          const keysForServer = [...agent._managedClients.keys()].filter((k) => k === serverKey)
          assert.equal(keysForServer.length, 1, 'serverKey must map to exactly one entry')
          assert.equal(agent._managedClients.size, 1)
        },
      ),
      RUNS,
    )
  })
})

// ---------------------------------------------------------------------------
// Task 9.6 — Integration tests with mock createMCPClient / MCP_Client
//
// These are example / integration tests (NOT property-based). They exercise
// the load_mcp_server meta-tool (`_loadMCPServer`) end-to-end through the
// internal createMCPClient seam (`agent._createMCPClient`), so no real MCP
// connection is ever made. `makeMockMCPClient` provides the MCP_Client surface
// (`listTools` / `close`) the load path consumes. Coverage:
//   - Req 3.2: valid params connect exactly once via createMCPClient.
//   - Req 3.3: a successful connect calls listTools() and the returned tools
//     are added to the Tool_Registry (and registered as Base_Tools).
//   - Req 3.6: createMCPClient throwing yields a descriptive error string
//     (no unhandled exception) and the registry is unchanged.
//   - Req 3.8: a connect that never settles times out after connectTimeoutMs,
//     returning a timeout error string and leaving the registry unchanged.
//   - Req 3.9: an empty listTools() adds no tools, returns the "no available
//     tools" text, and still saves the client to _managedClients.
// ---------------------------------------------------------------------------

/** A plain Tool_Def whose name never collides with INITIAL_BASE_TOOLS. */
function _makeTool96(name) {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {} },
    execute: async () => `ran-${name}`,
  }
}

describe('Task 9.6: load_mcp_server integration (mock createMCPClient / MCP_Client)', () => {
  // Req 3.2: a load with valid params connects via createMCPClient exactly once.
  it('connects via createMCPClient exactly once for valid params (Req 3.2)', async () => {
    resetBaseTools()
    const agent = makeAgent({ enableDynamicMCP: true })

    let createCalls = 0
    const client = makeMockMCPClient({ tools: [_makeTool96('srv96_a')] })
    agent._createMCPClient = (_options) => {
      createCalls++
      return client
    }

    const text = await agent._loadMCPServer({
      serverKey: 'srv96',
      transport: 'http',
      url: 'https://example.test/mcp',
    })

    assert.equal(createCalls, 1, 'createMCPClient must be called exactly once')
    assert.match(text, /Successfully loaded/i)
  })

  // Req 3.3: on a successful connect, listTools() is called and the returned
  // tools are added to the Tool_Registry (and registered as Base_Tools).
  it('calls listTools() and adds the returned tools to the registry on success (Req 3.3)', async () => {
    resetBaseTools()
    const agent = makeAgent({ enableDynamicMCP: true })

    const toolsFromServer = [_makeTool96('srv96_one'), _makeTool96('srv96_two')]
    const client = makeMockMCPClient({ tools: toolsFromServer })
    agent._createMCPClient = () => client

    await agent._loadMCPServer({
      serverKey: 'srv96',
      transport: 'http',
      url: 'https://example.test/mcp',
    })

    // listTools() was invoked on the connected client.
    assert.equal(client.listToolsCalls, 1, 'listTools() must be called once on a successful connect')

    // Each returned tool is now in the Tool_Registry...
    const names = new Set(agent.getTools().map((t) => t.name))
    for (const t of toolsFromServer) {
      assert.equal(names.has(t.name), true, `registry must contain "${t.name}" after load`)
      // ...and registered as a Base_Tool (so it survives intent filtering).
      assert.equal(isBaseTool(t.name), true, `"${t.name}" must be registered as a Base_Tool`)
    }

    // The client is tracked in the managed set under its serverKey.
    assert.equal(agent._managedClients.get('srv96').client, client)
  })

  // Req 3.6: createMCPClient throwing is caught and surfaced as a descriptive
  // error string; the Tool_Registry is left unchanged and no exception escapes.
  it('returns a descriptive error string when createMCPClient throws, leaving the registry unchanged (Req 3.6)', async () => {
    resetBaseTools()
    const agent = makeAgent({ enableDynamicMCP: true })

    const before = agent.getTools().map((t) => t.name)
    agent._createMCPClient = () => {
      throw new Error('UnsupportedTransportError: boom')
    }

    let text
    await assert.doesNotReject(async () => {
      text = await agent._loadMCPServer({
        serverKey: 'srv96',
        transport: 'http',
        url: 'https://example.test/mcp',
      })
    })

    assert.equal(typeof text, 'string')
    assert.match(text, /Error/)
    assert.match(text, /srv96/, 'error text should reference the serverKey')

    // No tools were added and nothing is tracked.
    assert.deepEqual(agent.getTools().map((t) => t.name), before)
    assert.equal(agent._managedClients.size, 0)
  })

  // Req 3.6 (variant): a rejected connect promise is handled identically.
  it('returns an error string when the connect promise rejects (Req 3.6)', async () => {
    resetBaseTools()
    const agent = makeAgent({ enableDynamicMCP: true })

    const before = agent.getTools().map((t) => t.name)
    agent._createMCPClient = () => Promise.reject(new Error('MCPProtocolError: handshake failed'))

    let text
    await assert.doesNotReject(async () => {
      text = await agent._loadMCPServer({
        serverKey: 'srv96',
        transport: 'sse',
        url: 'https://example.test/sse',
      })
    })

    assert.match(text, /Error/)
    assert.deepEqual(agent.getTools().map((t) => t.name), before)
    assert.equal(agent._managedClients.size, 0)
  })

  // Req 3.8: a connect that never settles is aborted after connectTimeoutMs and
  // returns a timeout error string; the Tool_Registry is unchanged. We use a
  // tiny connectTimeoutMs and a factory whose promise never resolves (the
  // AbortController race resolves via the timeout), which is more reliable than
  // fake timers against the internal AbortController + Promise.race.
  it('times out a never-settling connect and leaves the registry unchanged (Req 3.8)', async () => {
    resetBaseTools()
    const agent = makeAgent({
      enableDynamicMCP: true,
      dynamicMCPOpts: { connectTimeoutMs: 20 },
    })

    const before = agent.getTools().map((t) => t.name)
    // The factory hangs forever; only the internal timeout can resolve the race.
    agent._createMCPClient = () => new Promise(() => {})

    const text = await agent._loadMCPServer({
      serverKey: 'srv96',
      transport: 'http',
      url: 'https://example.test/mcp',
    })

    assert.match(text, /timed out/i, 'error text must indicate a connection timeout')
    assert.match(text, /srv96/, 'timeout error should reference the serverKey')

    // Nothing was added to the registry and nothing is tracked.
    assert.deepEqual(agent.getTools().map((t) => t.name), before)
    assert.equal(agent._managedClients.size, 0)
  })

  // Req 3.9: a successful connect whose listTools() returns an empty set adds no
  // tools and returns the "no available tools" text, but still saves the client
  // to _managedClients (for later onToolsChanged / unified teardown).
  it('adds no tools and reports "no available tools" when listTools() is empty, but still tracks the client (Req 3.9)', async () => {
    resetBaseTools()
    const agent = makeAgent({ enableDynamicMCP: true })

    const before = agent.getTools().map((t) => t.name)
    const client = makeMockMCPClient({ tools: [] })
    agent._createMCPClient = () => client

    const text = await agent._loadMCPServer({
      serverKey: 'srv96_empty',
      transport: 'http',
      url: 'https://example.test/mcp',
    })

    // listTools() was consulted...
    assert.equal(client.listToolsCalls, 1)

    // ...but no tools were added to the registry.
    assert.deepEqual(agent.getTools().map((t) => t.name), before)

    // The result text indicates the server provided no usable tools.
    assert.match(text, /no available tools/i)

    // The client is still tracked under its serverKey with an empty toolNames set.
    const entry = agent._managedClients.get('srv96_empty')
    assert.ok(entry, 'client must still be saved to _managedClients')
    assert.equal(entry.client, client)
    assert.equal(entry.toolNames.size, 0)
  })
})

// ---------------------------------------------------------------------------
// Task 9.7 — Meta-tool injection toggle (Requirements 3.1, 3.7)
//
// These are example / unit tests (NOT property-based). They verify the
// construction-time injection toggle for the load_mcp_server meta-tool:
//   - Req 3.1: when enableDynamicMCP is true, the Tool_Registry contains a tool
//     named 'load_mcp_server'. Per design, it is injected as a PLAIN tool (it is
//     NOT registered as a Base_Tool — its name is not in INITIAL_BASE_TOOLS).
//   - Req 3.7: default construction (no enableDynamicMCP) does NOT inject
//     'load_mcp_server'.
// ---------------------------------------------------------------------------

describe('Task 9.7: load_mcp_server injection toggle (Req 3.1, 3.7)', () => {
  // Req 3.1: enabling dynamic MCP injects the load_mcp_server meta-tool.
  it('injects load_mcp_server into the registry when enableDynamicMCP is true (Req 3.1)', () => {
    resetBaseTools()
    const agent = makeAgent({ enableDynamicMCP: true })

    const tools = agent.getTools()
    const loadTool = tools.find((t) => t.name === 'load_mcp_server')

    assert.ok(loadTool, 'getTools() must include a tool named "load_mcp_server"')
    assert.equal(typeof loadTool.execute, 'function', 'the meta-tool must be executable')

    // Per design, load_mcp_server is a PLAIN tool — not a Base_Tool. Its name is
    // not part of INITIAL_BASE_TOOLS and it must not be registered as one.
    assert.equal(
      INITIAL_BASE_TOOLS.includes('load_mcp_server'),
      false,
      'load_mcp_server must not be one of the preset INITIAL_BASE_TOOLS',
    )
    assert.equal(
      isBaseTool('load_mcp_server'),
      false,
      'load_mcp_server must NOT be registered as a Base_Tool',
    )
  })

  // Req 3.1: injection coexists with any static tools passed at construction.
  it('injects load_mcp_server alongside static tools when enableDynamicMCP is true (Req 3.1)', () => {
    resetBaseTools()
    const staticTool = {
      name: 'static_alpha',
      description: 'a static tool',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'ok',
    }
    const agent = makeAgent({ enableDynamicMCP: true, tools: [staticTool] })

    const names = agent.getTools().map((t) => t.name)
    assert.equal(names.includes('static_alpha'), true, 'static tools are preserved')
    assert.equal(names.includes('load_mcp_server'), true, 'load_mcp_server is injected')
  })

  // Req 3.7: default construction does NOT inject the meta-tool.
  it('does NOT inject load_mcp_server on default construction (Req 3.7)', () => {
    resetBaseTools()
    const agent = makeAgent()

    const names = agent.getTools().map((t) => t.name)
    assert.equal(
      names.includes('load_mcp_server'),
      false,
      'default construction must not inject load_mcp_server',
    )
  })

  // Req 3.7: explicitly disabling the option also leaves the registry clean.
  it('does NOT inject load_mcp_server when enableDynamicMCP is false (Req 3.7)', () => {
    resetBaseTools()
    const agent = makeAgent({ enableDynamicMCP: false })

    const names = agent.getTools().map((t) => t.name)
    assert.equal(
      names.includes('load_mcp_server'),
      false,
      'an explicit enableDynamicMCP=false must not inject load_mcp_server',
    )
  })
})

// ---------------------------------------------------------------------------
// Property 14 (Task 11.3)
//
// For any old dynamic-tool set contributed by some MCP_Client and any valid new
// Tool_Def set, an onToolsChanged callback must replace the client's dynamic
// tools with EXACTLY the new set (by name):
//   - old tools absent from the new set are removed + unregisterBaseTool'd,
//   - tools in the new set are added + registerBaseTool'd,
//   - same-name tools are overwritten with the NEW definition.
//
// The scenario generator partitions a pool of unique, non-INITIAL_BASE_TOOLS
// names into three NON-EMPTY groups so every run exercises real overlap AND
// difference between the old and new name sets:
//   removed = old \ new,  shared = old ∩ new,  added = new \ old.
// old = removed ∪ shared, new = shared ∪ added (shared carries a fresh def so
// the overwrite path is checked). Avoiding INITIAL_BASE_TOOLS names keeps the
// "removed names are no longer Base_Tools" assertion valid (preset names are
// never unregistered).
// ---------------------------------------------------------------------------

/** A Tool_Def carrying a generation marker so overwrite can be verified. */
function _makeToolDef14(name, marker) {
  return {
    name,
    description: `tool ${name} (${marker})`,
    parameters: { type: 'object', properties: {} },
    execute: async () => `ran-${name}-${marker}`,
    _marker: marker,
  }
}

// A scenario yielding disjoint removed / shared / added name groups, each with
// at least one element, drawn from unique non-base names.
const arbReplacementScenario14 = fc
  .uniqueArray(arbNonBaseToolName, { minLength: 3, maxLength: 12 })
  .chain((names) =>
    fc
      .tuple(
        fc.integer({ min: 1, max: names.length - 2 }),
        fc.integer({ min: 2, max: names.length - 1 }),
      )
      .filter(([i, j]) => i < j)
      .map(([i, j]) => ({
        removedNames: names.slice(0, i),
        sharedNames: names.slice(i, j),
        addedNames: names.slice(j),
      })),
  )

// Feature: runtime-dynamic-mcp-loading, Property 14: onToolsChanged 以新集合精确替换该客户端的动态工具
describe('Property 14: onToolsChanged replaces the client dynamic tools with exactly the new set', () => {
  it('removes old-only tools (+ unregisterBaseTool), adds new tools (+ registerBaseTool), and overwrites same-name tools with the new definition', () => {
    fc.assert(
      fc.property(arbReplacementScenario14, arbNonEmptyServerKey, (scenario, serverKey) => {
        resetBaseTools()
        const agent = makeAgent()

        const { removedNames, sharedNames, addedNames } = scenario

        // old = removed ∪ shared (marker 'old'); new = shared ∪ added (marker 'new').
        const oldTools = [...removedNames, ...sharedNames].map((n) => _makeToolDef14(n, 'old'))
        const newTools = [...sharedNames, ...addedNames].map((n) => _makeToolDef14(n, 'new'))

        const oldNames = new Set(oldTools.map((t) => t.name))
        const newNames = new Set(newTools.map((t) => t.name))

        // Seed a managed entry whose client matches the one we will signal, then
        // load the old dynamic tools as Base_Tools (the runtime-load path).
        const client = makeMockMCPClient({ tools: oldTools })
        agent._managedClients.set(serverKey, { serverKey, client, toolNames: new Set(oldNames) })
        agent.addTools(oldTools, { asBaseTool: true })

        // Sanity: the old set is present and base-registered before the change.
        for (const name of oldNames) assert.equal(isBaseTool(name), true)

        // Trigger the tools/list_changed sync with the new set.
        agent._onToolsChanged(serverKey, client, newTools)

        // (1) The managed entry's tracked tool names now EXACTLY equal the new set.
        assert.deepEqual(agent._managedClients.get(serverKey).toolNames, newNames)

        // (2) The registry (only this client's dynamic tools were ever added)
        //     now equals the new set exactly by name.
        const registry = agent.getTools()
        assert.deepEqual(new Set(registry.map((t) => t.name)), newNames)

        // (3) Old-only tools were removed and their Base_Tool registration cancelled.
        for (const name of oldNames) {
          if (!newNames.has(name)) {
            assert.equal(registry.some((t) => t.name === name), false, `removed tool "${name}" must be gone`)
            assert.equal(isBaseTool(name), false, `removed tool "${name}" must be unregistered as Base_Tool`)
          }
        }

        // (4) Every tool in the new set is present, base-registered, and stored as
        //     the NEW definition (same-name overwrite uses the new reference).
        const byName = new Map(registry.map((t) => [t.name, t]))
        for (const t of newTools) {
          assert.equal(byName.has(t.name), true, `new tool "${t.name}" must be present`)
          assert.equal(isBaseTool(t.name), true, `new tool "${t.name}" must be a Base_Tool`)
          assert.equal(byName.get(t.name), t, `new tool "${t.name}" must be the new definition (by reference)`)
          assert.equal(byName.get(t.name)._marker, 'new', `same-name tool "${t.name}" must be overwritten by the new def`)
        }
      }),
      RUNS,
    )
  })
})

// ---------------------------------------------------------------------------
// Property 15 (Task 11.4)
//
// An onToolsChanged callback must be IGNORED — leaving Tool_Registry, the
// managed entry's tracked tool names, _toolsGeneration, and Base_Tool
// registration all unchanged — for any of these cases:
//   (a) newTools is not an array (null / undefined / number / string / object),
//   (b) newTools is an array containing ≥1 element missing a non-empty string
//       `name`,
//   (c) the callback comes from a stale client: either the passed client is not
//       the one currently mapped to serverKey, or serverKey is absent from the
//       managed set entirely.
//
// In every case we seed the agent with a managed entry (serverKey → client)
// plus that client's old dynamic tools loaded as Base_Tools, snapshot all
// observable state, fire the (to-be-ignored) callback, and assert nothing moved.
// ---------------------------------------------------------------------------

// A bad element: missing a non-empty string `name` (empty string, non-string
// name, no name at all, or a non-object).
const arbBadToolElement15 = fc.constantFrom({ name: '' }, { name: 123 }, {}, { description: 'x' }, null)

// The three ignore categories as a tagged union. Each carries just the data the
// test needs to construct the callback arguments.
const arbIgnoreScenario15 = fc.oneof(
  // (a) non-array newTools.
  fc.record({
    kind: fc.constant('non-array'),
    newTools: fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.integer(),
      fc.string(),
      fc.object(),
    ),
  }),
  // (b) array containing an invalid element somewhere among otherwise-valid defs.
  fc.record({
    kind: fc.constant('invalid-element'),
    validTools: arbUniqueToolDefList,
    pos: fc.nat(),
    badEl: arbBadToolElement15,
  }),
  // (c) stale client: wrong client instance, or a serverKey not in the map.
  fc.record({
    kind: fc.constant('stale-client'),
    validTools: arbUniqueToolDefList,
    missingServerKey: fc.boolean(),
  }),
)

// Feature: runtime-dynamic-mcp-loading, Property 15: 非法或陈旧的 onToolsChanged 回调被忽略
describe('Property 15: invalid or stale onToolsChanged callbacks are ignored', () => {
  it('leaves the registry, tracked tool names, generation, and Base_Tool registration unchanged for non-array / invalid-element / stale-client callbacks', () => {
    fc.assert(
      fc.property(
        arbNonEmptyUniqueToolDefList,
        arbNonEmptyServerKey,
        arbIgnoreScenario15,
        (oldTools, serverKey, scenario) => {
          resetBaseTools()
          const agent = makeAgent()

          // Seed a managed entry whose client matches the one we (legitimately)
          // hold, then load its old dynamic tools as Base_Tools (runtime-load path).
          const client = makeMockMCPClient({ tools: oldTools })
          const oldNames = oldTools.map((t) => t.name)
          agent._managedClients.set(serverKey, {
            serverKey,
            client,
            toolNames: new Set(oldNames),
          })
          agent.addTools(oldTools, { asBaseTool: true })

          // --- Snapshot every observable before the (ignored) callback. ---
          const toolsBefore = agent.getTools() // array of live Tool_Def references
          const namesBefore = toolsBefore.map((t) => t.name)
          const genBefore = agent._toolsGeneration
          const entryToolNamesBefore = new Set(agent._managedClients.get(serverKey).toolNames)

          // Relevant names for the Base_Tool snapshot: the old tool names plus any
          // names carried in the callback payload (which must NOT become Base_Tools).
          const payloadNames =
            scenario.kind === 'non-array' ? [] : scenario.validTools.map((t) => t.name)
          const relevantNames = new Set([...oldNames, ...payloadNames])
          const baseBefore = new Map([...relevantNames].map((n) => [n, isBaseTool(n)]))

          // --- Fire the callback for this scenario; it must be ignored. ---
          if (scenario.kind === 'non-array') {
            agent._onToolsChanged(serverKey, client, scenario.newTools)
          } else if (scenario.kind === 'invalid-element') {
            const { validTools, pos, badEl } = scenario
            const idx = validTools.length === 0 ? 0 : pos % (validTools.length + 1)
            const withBad = [...validTools.slice(0, idx), badEl, ...validTools.slice(idx)]
            agent._onToolsChanged(serverKey, client, withBad)
          } else {
            // stale-client: a different client instance, or a missing serverKey.
            const otherClient = makeMockMCPClient({ tools: [] })
            const key = scenario.missingServerKey ? `${serverKey}__absent__` : serverKey
            agent._onToolsChanged(key, otherClient, scenario.validTools)
          }

          // --- Assert nothing moved. ---

          // (1) Tool_Registry unchanged by name AND by reference.
          const toolsAfter = agent.getTools()
          assert.deepEqual(toolsAfter.map((t) => t.name), namesBefore)
          assert.equal(toolsAfter.length, toolsBefore.length)
          for (let i = 0; i < toolsAfter.length; i++) {
            assert.equal(toolsAfter[i], toolsBefore[i], 'Tool_Def references must be unchanged')
          }

          // (2) The managed entry's tracked tool names are unchanged.
          assert.deepEqual(
            agent._managedClients.get(serverKey).toolNames,
            entryToolNamesBefore,
          )

          // (3) _toolsGeneration did not advance.
          assert.equal(agent._toolsGeneration, genBefore)

          // (4) Base_Tool registration is unchanged for every relevant name.
          for (const [n, was] of baseBefore) {
            assert.equal(isBaseTool(n), was, `Base_Tool registration for "${n}" must be unchanged`)
          }
        },
      ),
      RUNS,
    )
  })
})

// ---------------------------------------------------------------------------
// Task 11.5 — Integration test for onToolsChanged wiring (Requirement 6.1)
//
// This is an example / integration test (NOT property-based). It exercises the
// load_mcp_server meta-tool (`_loadMCPServer`) through the internal
// createMCPClient seam (`agent._createMCPClient`), capturing the `options`
// argument the factory is invoked with so we can assert the agent wires an
// `onToolsChanged` callback into the connection options. Coverage:
//   - Req 6.1: a connect made via createMCPClient supplies an `onToolsChanged`
//     callback (a function that accepts a Tool_Def array).
// We additionally invoke the captured callback to confirm it is bound to the
// correct serverKey/client and routes through to `_onToolsChanged` (the new
// tool appears in getTools()).
// ---------------------------------------------------------------------------

/** A plain Tool_Def whose name never collides with INITIAL_BASE_TOOLS. */
function _makeTool115(name) {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {} },
    execute: async () => `ran-${name}`,
  }
}

describe('Task 11.5: onToolsChanged wiring (Req 6.1)', () => {
  // Req 6.1: createMCPClient is invoked with options carrying an onToolsChanged
  // callback whose signature accepts a Tool_Def array.
  it('supplies an onToolsChanged function in the createMCPClient options (Req 6.1)', async () => {
    resetBaseTools()
    const agent = makeAgent({ enableDynamicMCP: true })

    // Capture the options the factory is called with; return a mock MCP_Client.
    let capturedOptions
    const client = makeMockMCPClient({ tools: [_makeTool115('srv115_a')] })
    agent._createMCPClient = (options) => {
      capturedOptions = options
      return client
    }

    await agent._loadMCPServer({
      serverKey: 'srv115',
      transport: 'http',
      url: 'https://example.test/mcp',
    })

    assert.ok(capturedOptions, 'createMCPClient must be called with an options object')
    assert.equal(
      typeof capturedOptions.onToolsChanged,
      'function',
      'connection options must include an onToolsChanged callback',
    )
  })

  // The captured callback is bound to the correct serverKey/client and routes
  // through to _onToolsChanged: invoking it with a new Tool_Def set updates the
  // Tool_Registry accordingly.
  it('the captured onToolsChanged callback routes through to the registry (Req 6.1)', async () => {
    resetBaseTools()
    const agent = makeAgent({ enableDynamicMCP: true })

    let capturedOptions
    const initialTool = _makeTool115('srv115_initial')
    const client = makeMockMCPClient({ tools: [initialTool] })
    agent._createMCPClient = (options) => {
      capturedOptions = options
      return client
    }

    await agent._loadMCPServer({
      serverKey: 'srv115',
      transport: 'http',
      url: 'https://example.test/mcp',
    })

    // The initial tool from listTools() is present.
    assert.equal(
      agent.getTools().some((t) => t.name === 'srv115_initial'),
      true,
    )

    // Drive a tools/list_changed notification through the captured callback.
    const newTool = _makeTool115('srv115_added')
    capturedOptions.onToolsChanged([newTool])

    // The callback is bound to this serverKey/client, so the set-replacement
    // routed through _onToolsChanged: the new tool is now in the registry and
    // the old (no-longer-present) tool was removed.
    const names = new Set(agent.getTools().map((t) => t.name))
    assert.equal(names.has('srv115_added'), true, 'new tool must appear in getTools() after callback')
    assert.equal(names.has('srv115_initial'), false, 'replaced tool must be removed')
    assert.equal(isBaseTool('srv115_added'), true, 'new dynamic tool must be registered as a Base_Tool')
  })
})

// ---------------------------------------------------------------------------
// Property 16 (Task 12.2)
// ---------------------------------------------------------------------------

// A static tools list that MAY include INITIAL_BASE_TOOLS names mixed in among
// arbitrary (non-base) tool names. Reuses arbUniqueToolDefList for the unique
// dynamic-style names, then injects a random subset of preset base-tool names
// (as valid Tool_Defs) so the "contains INITIAL_BASE_TOOLS names" case is
// actually exercised — without ever duplicating a name in the registry.
const arbStaticToolsWithMaybeBase = fc
  .tuple(arbUniqueToolDefList, fc.subarray([...INITIAL_BASE_TOOLS]))
  .map(([tools, baseNames]) => {
    const seen = new Set(tools.map((t) => t.name))
    const baseDefs = baseNames
      .filter((n) => !seen.has(n))
      .map((name) => ({
        name,
        description: '',
        parameters: { type: 'object', properties: {} },
        execute: async () => `mock-static:${name}`,
      }))
    return [...tools, ...baseDefs]
  })

// Feature: runtime-dynamic-mcp-loading, Property 16: 未启用动态加载时静态工具不入 Base_Tool 也不入 Managed_Client_Set
describe('Property 16: no dynamic loading → static tools are not Base_Tools nor managed', () => {
  it('non-preset static tool names are never isBaseTool, and Managed_Client_Set stays empty throughout', () => {
    fc.assert(
      fc.property(
        arbStaticToolsWithMaybeBase,
        // An arbitrary sequence of non-dynamic-load operations (reading the
        // registry via getTools()). None of these involve runtime MCP loading.
        fc.array(fc.constantFrom('getTools', 'noop'), { maxLength: 12 }),
        (staticTools, ops) => {
          resetBaseTools()

          // Construct WITHOUT enableDynamicMCP, passing the static tools list at
          // construction time (the list may include INITIAL_BASE_TOOLS names).
          const agent = makeAgent({ tools: staticTools })

          // Managed_Client_Set is empty from construction (Req 7.4).
          assert.equal(agent._managedClients.size, 0)

          // Perform the arbitrary sequence of non-dynamic-load operations; the
          // managed set must remain empty throughout.
          for (const op of ops) {
            if (op === 'getTools') agent.getTools()
            assert.equal(agent._managedClients.size, 0)
          }

          // Every static tool whose name is NOT in INITIAL_BASE_TOOLS must not be
          // registered as a Base_Tool (Req 7.3).
          for (const t of staticTools) {
            if (!INITIAL_BASE_TOOLS.includes(t.name)) {
              assert.equal(
                isBaseTool(t.name),
                false,
                `static tool "${t.name}" must not be a Base_Tool`,
              )
            }
          }

          // And the managed set is still empty after the operation sequence.
          assert.equal(agent._managedClients.size, 0)
        },
      ),
      RUNS,
    )
  })
})

// ---------------------------------------------------------------------------
// Task 12.3 — Public signature compatibility (Requirement 7.2)
//
// Example / unit tests (NOT property-based). These pin the backward-compatible
// public API surface of `chat()` / `stream()` / `reset()` and the Agent
// constructor:
//   - reset() returns undefined.
//   - chat()/stream() keep their pre-feature parameter arity (message, opts?).
//   - chat('msg') still resolves to a string (no-tool answer via fetch stub).
//   - stream('msg') is still an async generator that yields and completes with
//     a terminal `done` event whose content is the final answer.
//   - new Agent({ provider, apiKey, model }) still constructs with no new
//     REQUIRED constructor parameter.
//
// The non-streaming fetch stub (`_stubFetchCapturing` / `_textResponse`) and
// `makeAgent` are reused from above. A minimal SSE stub is added locally for
// the streaming path, mirroring the helpers in `src/agent.test.js`.
// ---------------------------------------------------------------------------

const _prevFetch_123 = { f: null }

/** Minimal SSE `Response` shim (mirrors `_mockSse_91` in src/agent.test.js). */
function _mockSse123(chunks) {
  const encoder = new TextEncoder()
  let idx = 0
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        let released = false
        return {
          async read() {
            if (released || idx >= chunks.length) return { done: true, value: undefined }
            return { done: false, value: encoder.encode(chunks[idx++]) }
          },
          releaseLock() { released = true },
        }
      },
    },
    async text() { return '' },
    async json() { return {} },
  }
}

/** SSE chunk stream for a single no-tool round ending in final text. */
function _sseText123(content, { model = 'gpt-4o-mini' } = {}) {
  const delta = 'data: ' + JSON.stringify({
    model, choices: [{ index: 0, delta: { content } }],
  }) + '\n'
  const finish = 'data: ' + JSON.stringify({
    model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  }) + '\n'
  return [delta, finish, 'data: [DONE]\n']
}

/** Stub `globalThis.fetch` to serve queued SSE chunk-streams in order. */
function _stubFetchSse123(streams) {
  let i = 0
  globalThis.fetch = async () => {
    if (i >= streams.length) throw new Error(`fetch stub exhausted (call #${i + 1})`)
    return _mockSse123(streams[i++])
  }
}

describe('Task 12.3: public signature compatibility (Req 7.2)', () => {
  beforeEach(() => { _prevFetch_123.f = globalThis.fetch })
  afterEach(() => { globalThis.fetch = _prevFetch_123.f })

  // reset() returns undefined (and is callable with no arguments).
  it('reset() returns undefined', () => {
    const agent = makeAgent()
    const ret = agent.reset()
    assert.equal(ret, undefined)
  })

  // chat()/stream() keep their pre-feature parameter arity. The pre-feature
  // signatures are `chat(message, opts = {})` and `stream(message, opts = {})`,
  // whose Function.length is 1 (only the required `message` is counted; `opts`
  // has a default). reset() takes no parameters.
  it('chat()/stream()/reset() retain their public parameter arity', () => {
    assert.equal(Agent.prototype.chat.length, 1, 'chat(message, opts?) → arity 1')
    assert.equal(Agent.prototype.stream.length, 1, 'stream(message, opts?) → arity 1')
    assert.equal(Agent.prototype.reset.length, 0, 'reset() → arity 0')
  })

  // chat('msg') still resolves to a string (no-tool answer). Return type is a
  // Promise<string>, unchanged by this feature.
  it('chat() resolves to a string for a no-tool answer', async () => {
    const agent = makeAgent({ memory: new SlidingWindowMemory(50) })
    _stubFetchCapturing([_textResponse('plain-answer')])

    const reply = await agent.chat('hello')

    assert.equal(typeof reply, 'string')
    assert.equal(reply, 'plain-answer')
  })

  // stream('msg') is still an async generator that yields events and completes
  // with a terminal `done` event carrying the final answer — consistent with
  // existing stream() behavior (see src/agent.test.js).
  it('stream() is an async generator that yields and completes', async () => {
    const agent = makeAgent({ memory: new SlidingWindowMemory(50) })

    // The returned object is an async iterator (async generator).
    const iter = agent.stream('hello')
    assert.equal(typeof iter[Symbol.asyncIterator], 'function')

    _stubFetchSse123([_sseText123('streamed-final')])

    const yielded = []
    let content = ''
    let done = null
    for await (const evt of iter) {
      yielded.push(evt)
      if (evt.type === 'delta') content += evt.content
      if (evt.type === 'done') done = evt
    }

    // It produced output and completed with a terminal `done` event.
    assert.ok(yielded.length > 0, 'stream() must yield at least one event')
    assert.equal(yielded[yielded.length - 1].type, 'done', 'final yielded event is done')
    assert.equal(content, 'streamed-final')
    assert.ok(done, 'expected a terminal done event')
    assert.equal(done.content, 'streamed-final')
  })

  // No new REQUIRED constructor parameter was introduced: the documented
  // minimal construction still works.
  it('new Agent({ provider, apiKey, model }) still constructs successfully', () => {
    assert.doesNotThrow(() => {
      const agent = new Agent({ provider: 'openai', apiKey: 'sk-fake', model: 'gpt-4' })
      assert.ok(agent instanceof Agent)
      // Backward-compatible public surface is present.
      assert.equal(typeof agent.chat, 'function')
      assert.equal(typeof agent.stream, 'function')
      assert.equal(typeof agent.reset, 'function')
    })
  })
})
