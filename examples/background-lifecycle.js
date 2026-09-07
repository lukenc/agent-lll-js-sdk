/**
 * node examples/background-lifecycle.js
 * Keyless HTTP integration: stream -> background tools/artifact -> idle wakeup -> memory.
 * Model output is scripted by a local server, not a real-provider evaluation.
 */
import assert from 'node:assert/strict'
import { Agent, defineTool, SlidingWindowMemory } from '../src/index.js'
import { startBackgroundFixture } from './support/background-fixture.js'

const fixture = await startBackgroundFixture()
const calculate = defineTool({ name: 'calculate', description: 'Multiply 6 by 7', parameters: { type: 'object', properties: { expression: { type: 'string' } } }, execute: async ({ expression }) => { assert.equal(expression, '6*7'); return '42' } })
const options = { provider: 'openai', apiKey: 'fixture', model: 'fixture', url: fixture.url, tools: [calculate], memory: new SlidingWindowMemory(30), enableIntentRecognition: true, maxRounds: 10 }
const waitFor = async predicate => {
  const end = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() > end) throw new Error('integration did not settle within 5 seconds')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function scenario(timeout = false) {
  const agent = new Agent({ ...options, memory: new SlidingWindowMemory(30), subagents: { keepAlive: false, retry: { attemptTimeoutMs: timeout ? 80 : 2000, maxAttempts: 2, backoffMs: 0 } } })
  const answers = []
  const errors = []
  const events = []
  let busy = true
  let queued = false
  const pump = async () => {
    queued = true
    if (busy) return
    busy = true
    try {
      while (queued) {
        queued = false
        const answer = await agent.followup()
        if (answer != null) answers.push(answer)
      }
    } catch (error) { errors.push(error) }
    finally { busy = false }
  }
  agent.on('run.wakeup', () => { void pump() })
  for (const name of ['agent.retry', 'agent.failed', 'agent.succeeded', 'tool.call']) agent.on(name, payload => events.push({ name, payload }))
  try {
    let done
    for await (const event of agent.stream(timeout ? '超时回归' : '后台回归')) if (event.type === 'done') done = event
    assert.equal(done.stopReason, 'completed')
    assert.equal(agent.subagents.hasInFlight(), true)
    busy = false
    if (queued) await pump()
    await waitFor(() => answers.length > 0 || errors.length > 0)
    if (errors.length) throw errors[0]
    assert.equal(agent.subagents.hasInFlight(), false)
    if (timeout) {
      assert.match(answers[0], /timeout/)
      assert.equal(events.filter(e => e.name === 'agent.retry').length, 1)
      assert.equal(events.find(e => e.name === 'agent.failed').payload.failureKind, 'timeout')
    } else {
      assert.match(answers[0], /42/)
      assert.ok((await agent.getArtifacts()).some(a => a.key === 'background-answer'))
      assert.ok(events.some(e => e.name === 'tool.call' && e.payload.name === 'calculate' && e.payload.ok))
      assert.match(await agent.chat('上一轮结果是多少？'), /42/)
    }
    console.log(JSON.stringify({ scenario: timeout ? 'timeout-retry-notification' : 'late-result-tools-artifact-memory', firstStopReason: done.stopReason, answer: answers[0], terminal: agent.subagents.registry.list({ includeFinished: true }).map(h => h.state) }))
  } finally { await agent.closeSubagents() }
}
try {
  await scenario()
  await scenario(true)
  assert.ok(fixture.stats.intents > 0)
  console.log('PASS', JSON.stringify(fixture.stats))
} finally { await fixture.close() }
