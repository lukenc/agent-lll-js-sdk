/**
 * Regression tests for F-A2 + D-11 — PlanAndExecuteStrategy now carries a
 * full per-step execution trace instead of advertising an empty
 * `toolCallHistory` and discarding `_reactLoop`'s messages.
 *
 * Contract validated here:
 *   - PlanStep exposes `toolCalls` / `messages` / `usage` / `rounds` /
 *     `durationMs` fields, populated during step execution.
 *   - `execute()` returns `toolCallHistory = plan.flatMap(s => s.toolCalls)`.
 *   - `onStepStart` / `onStepComplete` receive the full PlanStep as a
 *     trailing argument (old positional args kept in the leading positions
 *     for true backward compatibility — legacy `(i, desc)` / `(i, ok, result)`
 *     callbacks keep working unchanged).
 *   - `stream()` emits a `step` snapshot on every `step_start` /
 *     `step_complete` event and attaches `toolCallHistory` to `done`.
 *   - The planner-fallback path still produces a well-formed plan + trace
 *     so downstream consumers don't see an empty array.
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { PlanAndExecuteStrategy, PlanStep, StepStatus } from './plan-and-execute.js'
import { defineTool } from './tool.js'

// ---- Minimal fetch mock (shared across this file) ----

const originalFetch = globalThis.fetch
/** @type {Array<any>} */
let responseQueue = []
/** @type {Array<{url:string,body:any}>} */
let capturedRequests = []

function installMockFetch() {
  responseQueue = []
  capturedRequests = []
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    capturedRequests.push({ url, body })
    const next = responseQueue.shift()
    if (!next) throw new Error('mock fetch: response queue empty')
    return {
      ok: true,
      status: 200,
      async json() { return next },
      async text() { return JSON.stringify(next) },
    }
  }
}

function restoreFetch() {
  globalThis.fetch = originalFetch
}

/**
 * Queue one non-streaming LLM response. `toolCalls` is the OpenAI-style
 * `tool_calls` array; `usage` is the provider usage echo (OpenAI shape).
 */
function queueResponse({ content = '', toolCalls = null, usage = null } = {}) {
  const message = { content }
  if (toolCalls) message.tool_calls = toolCalls
  /** @type {{choices:Array<any>,usage?:any}} */
  const resp = { choices: [{ message }] }
  if (usage) resp.usage = usage
  responseQueue.push(resp)
}

// ---- Tests ----

describe('PlanStep trace fields (F-A2 / D-11)', () => {
  it('new PlanStep initializes trace collections to empty', () => {
    const s = new PlanStep(0, 'demo')
    assert.deepStrictEqual(s.toolCalls, [])
    assert.deepStrictEqual(s.messages, [])
    assert.deepStrictEqual(s.usage, {
      input_tokens: 0,
      output_tokens: 0,
      cached_tokens: 0,
      reasoning_tokens: 0,
    })
    assert.strictEqual(s.rounds, 0)
    assert.strictEqual(s.durationMs, 0)
    assert.strictEqual(s.status, StepStatus.PENDING)
  })
})

describe('PlanAndExecuteStrategy.execute: captures per-step tool trace', () => {
  before(installMockFetch)
  after(restoreFetch)
  beforeEach(() => { responseQueue = []; capturedRequests = [] })

  it('populates step.toolCalls / step.messages / step.usage / step.rounds and flattens into toolCallHistory', async () => {
    const echo = defineTool({
      name: 'echo',
      description: 'echoes input',
      parameters: { type: 'object', properties: { x: { type: 'string' } } },
      execute: async ({ x }) => `echo:${x}`,
    })

    // Plan fetch order:
    //   1. planner → 1-step plan (single step avoids synthesizer round-trip)
    //   2. step 0 round 0: LLM calls `echo` with {x:"hi"}
    //   3. step 0 round 1: LLM returns final text (no tool_calls) → step ends
    //   (no synthesizer — single-step plan short-circuits to plan[0].result)
    const planJson = JSON.stringify([{ step: 1, description: 'do the thing' }])
    queueResponse({ content: planJson })
    queueResponse({
      toolCalls: [{ id: 'tc1', type: 'function', function: { name: 'echo', arguments: JSON.stringify({ x: 'hi' }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 3 },
    })
    queueResponse({
      content: 'done-step',
      usage: { prompt_tokens: 7, completion_tokens: 2 },
    })

    const strategy = new PlanAndExecuteStrategy({
      url: 'https://api.example.com/v1/chat/completions',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      tools: [echo],
    })

    const { content, plan, toolCallHistory } = await strategy.execute('do stuff')

    // Single-step plan: final content is plan[0].result (no synthesizer run).
    assert.strictEqual(content, 'done-step')
    assert.strictEqual(plan.length, 1)
    const step = plan[0]

    // Status + durationMs accounting.
    assert.strictEqual(step.status, StepStatus.COMPLETED)
    assert.ok(step.durationMs >= 0)

    // rounds: 2 LLM calls inside the step (tool-call round + final round).
    assert.strictEqual(step.rounds, 2)

    // usage: null-safe sum across the step's LLM calls.
    assert.strictEqual(step.usage.input_tokens, 17)
    assert.strictEqual(step.usage.output_tokens, 5)
    // Provider didn't report these → accumulator stayed at zero (never null).
    assert.strictEqual(step.usage.cached_tokens, 0)
    assert.strictEqual(step.usage.reasoning_tokens, 0)

    // toolCalls: one entry recording the echo call.
    assert.strictEqual(step.toolCalls.length, 1)
    const tc = step.toolCalls[0]
    assert.strictEqual(tc.stepIndex, 0)
    assert.strictEqual(tc.name, 'echo')
    assert.deepStrictEqual(tc.arguments, { x: 'hi' })
    assert.strictEqual(tc.result, 'echo:hi')
    assert.strictEqual(tc.ok, true)
    assert.ok(tc.durationMs >= 0)
    assert.ok(tc.bytes > 0)

    // messages: full ReAct trace preserved.
    // Expected order: system, user, assistant(tool_calls), tool, assistant(final).
    assert.strictEqual(step.messages.length, 5)
    assert.strictEqual(step.messages[0].role, 'system')
    assert.strictEqual(step.messages[1].role, 'user')
    assert.strictEqual(step.messages[2].role, 'assistant')
    assert.ok(Array.isArray(step.messages[2].tool_calls), 'assistant tool_calls preserved')
    assert.strictEqual(step.messages[3].role, 'tool')
    assert.strictEqual(step.messages[4].role, 'assistant')
    assert.strictEqual(step.messages[4].content, 'done-step')

    // toolCallHistory: flat-map across plan.
    assert.strictEqual(toolCallHistory.length, 1)
    assert.strictEqual(toolCallHistory[0], step.toolCalls[0])
  })

  it('records tool not_found with errorKind on the step trace', async () => {
    const planJson = JSON.stringify([{ step: 1, description: 'fail first' }])
    queueResponse({ content: planJson })
    queueResponse({
      toolCalls: [{ id: 'tc1', type: 'function', function: { name: 'ghost', arguments: '{}' } }],
    })
    // Final assistant text after the not_found tool result is fed back.
    queueResponse({ content: 'recovered' })

    const strategy = new PlanAndExecuteStrategy({
      url: 'https://api.example.com/v1/chat/completions',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      tools: [],
    })

    const { plan, toolCallHistory } = await strategy.execute('x')
    assert.strictEqual(plan.length, 1)
    assert.strictEqual(plan[0].toolCalls.length, 1)
    assert.strictEqual(plan[0].toolCalls[0].ok, false)
    assert.strictEqual(plan[0].toolCalls[0].errorKind, 'not_found')
    // toolCallHistory mirrors the step trace.
    assert.strictEqual(toolCallHistory.length, 1)
    assert.strictEqual(toolCallHistory[0].errorKind, 'not_found')
  })

  it('fallback (empty plan) still yields a PlanStep with trace + non-empty toolCallHistory when tools run', async () => {
    const echo = defineTool({
      name: 'echo',
      description: 'echoes',
      parameters: { type: 'object', properties: { x: { type: 'string' } } },
      execute: async ({ x }) => `echo:${x}`,
    })

    // Planner returns empty array → fallback path runs one ReAct loop.
    queueResponse({ content: '[]' })
    queueResponse({
      toolCalls: [{ id: 'tc1', type: 'function', function: { name: 'echo', arguments: JSON.stringify({ x: 'f' }) } }],
    })
    queueResponse({ content: 'fallback-done' })

    const strategy = new PlanAndExecuteStrategy({
      url: 'https://api.example.com/v1/chat/completions',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      tools: [echo],
    })

    const { content, plan, toolCallHistory } = await strategy.execute('direct')
    assert.strictEqual(content, 'fallback-done')
    // Fallback synthesizes a "step 0" so downstream consumers stay happy.
    assert.strictEqual(plan.length, 1)
    assert.strictEqual(plan[0].toolCalls.length, 1)
    assert.strictEqual(plan[0].toolCalls[0].name, 'echo')
    assert.strictEqual(toolCallHistory.length, 1)
    assert.strictEqual(toolCallHistory[0].name, 'echo')
  })
})

describe('PlanAndExecuteStrategy.execute: callbacks receive full PlanStep', () => {
  before(installMockFetch)
  after(restoreFetch)
  beforeEach(() => { responseQueue = []; capturedRequests = [] })

  it('onStepStart / onStepComplete are invoked with the PlanStep as a trailing argument (backward-compatible)', async () => {
    queueResponse({ content: JSON.stringify([{ step: 1, description: 'only step' }]) })
    queueResponse({ content: 'finished' })

    /** @type {Array<{start:any,complete:any,legacyIndex:number,legacySuccess:boolean,legacyResult:string}>} */
    const captured = []

    const strategy = new PlanAndExecuteStrategy({
      url: 'https://api.example.com/v1/chat/completions',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      tools: [],
      // New-style signature: step is the trailing argument. Legacy
      // (index, description) consumers still work because the leading
      // arg order is preserved.
      onStepStart: (idx, desc, step) => {
        assert.strictEqual(typeof idx, 'number', 'legacy arg[0] must remain the numeric index')
        assert.strictEqual(typeof desc, 'string', 'legacy arg[1] must remain the description string')
        assert.ok(step instanceof PlanStep, 'new trailing arg must be a PlanStep')
        assert.strictEqual(step.index, idx)
        assert.strictEqual(step.description, desc)
        captured.push({ start: step, complete: null, legacyIndex: idx, legacySuccess: false, legacyResult: '' })
      },
      onStepComplete: (idx, success, result, step) => {
        assert.strictEqual(typeof idx, 'number')
        assert.strictEqual(typeof success, 'boolean')
        assert.strictEqual(typeof result, 'string')
        assert.ok(step instanceof PlanStep)
        assert.strictEqual(step.status, StepStatus.COMPLETED)
        assert.strictEqual(step.result, 'finished')
        const last = captured.pop()
        captured.push({
          start: last.start,
          complete: step,
          legacyIndex: idx,
          legacySuccess: success,
          legacyResult: result,
        })
      },
    })

    await strategy.execute('test')

    assert.strictEqual(captured.length, 1)
    const c = captured[0]
    assert.strictEqual(c.legacyIndex, 0)
    assert.strictEqual(c.legacySuccess, true)
    assert.strictEqual(c.legacyResult, 'finished')
    // onStepComplete should see the full trace that would also be returned
    // from execute() — including rounds (1) and the terminal messages.
    assert.strictEqual(c.complete.rounds, 1)
    assert.ok(c.complete.messages.length >= 2)
  })

  it('legacy (index, description) / (index, success, result) callbacks still work without touching the trailing arg', async () => {
    queueResponse({ content: JSON.stringify([{ step: 1, description: 'only' }]) })
    queueResponse({ content: 'ok' })

    let sawStart = null
    let sawComplete = null

    const strategy = new PlanAndExecuteStrategy({
      url: 'https://api.example.com/v1/chat/completions',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      tools: [],
      // Legacy signature — ignores the trailing PlanStep.
      onStepStart: (idx, desc) => { sawStart = [idx, desc] },
      onStepComplete: (idx, success, result) => { sawComplete = [idx, success, result] },
    })

    await strategy.execute('test')

    assert.deepStrictEqual(sawStart, [0, 'only'])
    assert.deepStrictEqual(sawComplete, [0, true, 'ok'])
  })
})

describe('PlanAndExecuteStrategy.stream: emits step snapshots and toolCallHistory', () => {
  before(installMockFetch)
  after(restoreFetch)
  beforeEach(() => { responseQueue = []; capturedRequests = [] })

  it('step_start / step_complete events carry a step snapshot; done carries toolCallHistory', async () => {
    queueResponse({ content: JSON.stringify([{ step: 1, description: 's' }]) })
    queueResponse({ content: 'ok' })

    const strategy = new PlanAndExecuteStrategy({
      url: 'https://api.example.com/v1/chat/completions',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      tools: [],
    })

    const events = []
    for await (const ev of strategy.stream('x')) events.push(ev)

    const start = events.find(e => e.type === 'step_start')
    const complete = events.find(e => e.type === 'step_complete')
    const done = events.find(e => e.type === 'done')

    assert.ok(start, 'step_start must be emitted')
    assert.ok(complete, 'step_complete must be emitted')
    assert.ok(done, 'done must be emitted')

    // Snapshot shape: has trace fields even when empty.
    assert.strictEqual(start.step.index, 0)
    assert.ok(Array.isArray(start.step.toolCalls))
    assert.ok(Array.isArray(start.step.messages))

    assert.strictEqual(complete.step.status, StepStatus.COMPLETED)
    assert.strictEqual(complete.step.rounds, 1)

    assert.ok(Array.isArray(done.toolCallHistory))
  })
})
