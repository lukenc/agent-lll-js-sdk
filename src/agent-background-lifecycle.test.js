import test from 'node:test'
import assert from 'node:assert/strict'
import { Agent } from './agent.js'

const opts = { provider: 'openai', apiKey: 'test', model: 'mock', systemPrompt: 'MAIN', subagents: { keepAlive: false } }
const response = content => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }))

for (const breakOnDone of [false, true]) test(`a notification after stream done wakes the idle host (break=${breakOnDone})`, async t => {
  const fetch = globalThis.fetch
  t.after(() => { globalThis.fetch = fetch })
  globalThis.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  const agent = new Agent(opts)
  const wakes = []
  agent.on('run.wakeup', p => wakes.push(p))
  for await (const event of agent.stream('start')) {
    if (event.type === 'done') {
      agent.enqueueMessage({ content: 'LATE_RESULT' })
      if (breakOnDone) break
    }
  }
  assert.equal(wakes.length, 1)
  assert.equal(agent._pendingInjections.length, 1)
})

test('followup during an active turn leaves its notification for that turn', async t => {
  const fetch = globalThis.fetch
  t.after(() => { globalThis.fetch = fetch })
  let release
  const gate = new Promise(resolve => { release = resolve })
  let started
  const entered = new Promise(resolve => { started = resolve })
  let calls = 0
  globalThis.fetch = async () => { calls++; started(); await gate; return response('done') }
  const agent = new Agent(opts)
  const running = agent.chat('work')
  await entered
  agent.enqueueMessage({ content: 'LATE_RESULT' })
  const followup = agent.followup()
  release()
  const result = await followup
  await running
  assert.equal(result, null)
  assert.equal(calls, 1)
  assert.equal(agent._pendingInjections.length, 1)
})

test('agent_status reports actual progress while a child is still running', async t => {
  const fetch = globalThis.fetch
  t.after(() => { globalThis.fetch = fetch })
  let release
  const gate = new Promise(resolve => { release = resolve })
  t.after(() => release())
  let entered
  const waiting = new Promise(resolve => { entered = resolve })
  let calls = 0
  globalThis.fetch = async () => {
    if (++calls === 1) return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'read', type: 'function', function: { name: 'read_note', arguments: '{}' } }] } }] }))
    entered()
    await gate
    return response('child result')
  }
  const agent = new Agent({ ...opts, tools: [{ name: 'read_note', description: 'Read note', parameters: { type: 'object', properties: {} }, execute: async () => 'note' }] })
  t.after(() => agent.closeSubagents())
  await agent.subagents.spawn({ description: 'progress', prompt: 'read note' })
  await waiting
  const handle = agent.subagents.registry.list()[0]
  const status = handle.toStatus()
  release()
  assert.equal(status.state, 'running')
  assert.ok(status.metrics.rounds >= 1, 'a finished round must not be reported as zero')
  assert.equal(status.metrics.toolCalls, 1)
  assert.ok(status.lastToolCallAt > 0)
})

test('two idle wakeups cannot start overlapping followups during async initialization', async t => {
  const fetch = globalThis.fetch
  t.after(() => { globalThis.fetch = fetch })
  let calls = 0
  globalThis.fetch = async () => { calls++; return response('done') }
  const agent = new Agent(opts)
  agent.enqueueMessage({ content: 'FIRST_RESULT' })
  const first = agent.followup()
  agent.enqueueMessage({ content: 'SECOND_RESULT' })
  const second = agent.followup()
  assert.equal(await second, null)
  await first
  assert.equal(calls, 1)
  assert.equal(agent._pendingInjections.length, 0)
})

for (const mode of ['chat', 'stream']) test(`followup respects ${mode} initialization before the first await`, async t => {
  const fetch = globalThis.fetch
  t.after(() => { globalThis.fetch = fetch })
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return mode === 'chat' ? response('done') : new Response('data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  }
  const agent = new Agent(opts)
  const first = mode === 'chat' ? agent.chat('USER_START') : (async () => { for await (const _ of agent.stream('USER_START')) {} })()
  agent.enqueueMessage({ content: 'LATE_RESULT' })
  const second = agent.followup()
  const results = await Promise.allSettled([first, second])
  assert.equal(results[0].status, 'fulfilled')
  assert.deepEqual(results[1], { status: 'fulfilled', value: null })
  assert.equal(calls, 1)
  assert.equal(agent.getSessionMetrics().totalRuns, 1)
})
