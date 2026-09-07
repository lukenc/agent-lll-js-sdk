// Real local HTTP requests; scripted model responses. No provider key required.
import assert from 'node:assert/strict'
import { Agent, defineTool } from '../../src/index.js'
import { startBackgroundFixture } from '../../examples/support/background-fixture.js'

const fixture = await startBackgroundFixture({ delayMs: 500 })
const options = {
  provider: 'openai', apiKey: 'fixture', model: 'fixture', url: fixture.url,
  maxRounds: 10,
  tools: [defineTool({ name: 'calculate', description: 'Multiply', parameters: { type: 'object', properties: { expression: { type: 'string' } } }, execute: async () => '42' })],
}
const makeAgent = subagents => new Agent({ ...options, subagents: { keepAlive: false, retry: { attemptTimeoutMs: 3000, maxAttempts: 1 }, ...subagents } })
const bounded = async promise => {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('probe deadline')), 5000) })])
  } finally { clearTimeout(timer) }
}

try {
  for (const mode of ['chat', 'stream', 'stream-break-on-done', 'max-rounds', 'keepalive-budget']) {
    const agent = makeAgent(mode === 'keepalive-budget' ? { keepAlive: true, keepAliveTimeoutMs: 20, maxConsecutiveWakes: 1 } : {})
    const upstream = new AbortController()
    if (mode === 'max-rounds') agent.maxRounds = 1
    try {
      if (mode === 'stream' || mode === 'stream-break-on-done') {
        for await (const ev of agent.stream('后台回归', { signal: upstream.signal })) {
          if (mode === 'stream-break-on-done' && ev.type === 'done') break
        }
      } else await agent.chat('后台回归', { signal: upstream.signal })
      const handle = agent.subagents.registry.list()[0]
      assert.ok(handle, 'running child is still registered after parent returns')
      assert.equal(handle._abort.signal.aborted, false)
      assert.equal(upstream.signal.aborted, false)
      assert.equal(agent.subagents.hasInFlight(), true)
      const before = { stopReason: agent.lastStopReason, child: handle.state, aborted: handle._abort.signal.aborted }
      await bounded(agent.subagents.drain())
      assert.equal(handle.state, 'succeeded')
      assert.ok((await agent.getArtifacts()).some(a => a.key === 'background-answer'))
      assert.equal(agent._pendingInjections.length, 1)
      agent.maxRounds = 10
      assert.match(await agent.followup(), /42/)
      console.log(JSON.stringify({ mode, before, after: handle.state, lateResultDelivered: true }))
    } finally { await agent.closeSubagents() }
  }

  for (const action of ['closeSubagents', 'reset', 'abort-after-done']) {
    const agent = makeAgent()
    const upstream = new AbortController()
    try {
      await agent.chat('超时回归', { signal: upstream.signal })
      const handle = agent.subagents.registry.list()[0]
      assert.equal(handle._abort.signal.aborted, false)
      if (action === 'closeSubagents') await bounded(agent.closeSubagents())
      if (action === 'reset') { agent.reset(); await bounded(agent.subagents.drain()) }
      if (action === 'abort-after-done') { upstream.abort(new DOMException('host turn cleanup', 'AbortError')); await bounded(agent.subagents.drain()) }
      assert.equal(handle._abort.signal.aborted, true)
      assert.equal(agent.subagents.hasInFlight(), false)
      assert.equal(handle.state, action === 'abort-after-done' ? 'failed' : 'cancelled')
      assert.equal(handle.result.failureKind, 'aborted')
      console.log(JSON.stringify({ action, child: handle.state, failureKind: handle.result.failureKind, aborted: true, pending: agent._pendingInjections.length }))
    } finally { await agent.closeSubagents() }
  }

  const agent = makeAgent({ retainCompleted: 0 })
  try {
    await agent.subagents.spawn({ description: 'remain running', prompt: 'REPORT_CHILD REPORT_HANG' })
    const running = agent.subagents.registry.list()[0]
    await bounded(agent.subagents.spawn({ description: 'finish and evict', prompt: 'REPORT_CHILD', background: false }))
    const finished = agent.subagents.registry.list({ includeFinished: true }).find(h => h !== running)
    assert.equal(finished.state, 'succeeded')
    assert.equal(finished._child, null)
    assert.ok(running._child)
    assert.equal(running.state, 'running')
    assert.equal(running._abort.signal.aborted, false)
    console.log(JSON.stringify({ scenario: 'retainCompleted=0', finishedContextEvicted: true, runningContextRetained: true, runningAborted: false }))
  } finally { await agent.closeSubagents() }
  console.log('PASS: 9 lifecycle cases')
} finally { await fixture.close() }
