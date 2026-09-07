import { pathToFileURL } from 'node:url'
const { Agent } = await import(pathToFileURL(process.env.LLL_SDK || `${process.cwd()}/src/agent.js`))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const response = message => new Response(JSON.stringify({ choices: [{ message, finish_reason: 'stop' }] }), { headers: { 'Content-Type': 'application/json' } })
const opts = { provider: 'openai', apiKey: 'test', model: 'mock', url: 'http://mock', systemPrompt: 'MAIN', maxRounds: 12 }
const original = globalThis.fetch
try {
  let release
  const gate = new Promise(resolve => { release = resolve })
  let calls = 0
  let wakes = 0
  const bodies = []
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    if (!body.messages[0].content.includes('MAIN')) {
      await gate
      return response({ content: 'LATE_CHILD_RESULT' })
    }
    bodies.push(body)
    return response(++calls === 1
      ? { content: '', tool_calls: [{ id: 'dispatch', type: 'function', function: { name: 'agent', arguments: JSON.stringify({ description: 'slow task', prompt: 'work' }) } }] }
      : { content: '等待通知' })
  }
  const a = new Agent({ ...opts, subagents: { keepAlive: false } })
  a.on('run.wakeup', () => { wakes++ })
  await a.chat('请并行处理')
  const before = { stopReason: a.lastStopReason, inFlight: a.subagents.hasInFlight() }
  release()
  for (let i = 0; i < 100 && a.subagents.hasInFlight(); i++) await sleep(5)
  const pendingBefore = a._pendingInjections.length
  const index = bodies.length
  await a.chat('继续')
  console.log(JSON.stringify({ scenario: 'late-result-next-turn', before, wakes, pendingBefore, firstRequestSawResult: JSON.stringify(bodies[index]).includes('LATE_CHILD_RESULT'), pendingAfter: a._pendingInjections.length }))
  await a.closeSubagents()

  let childCalls = 0
  const terminal = []
  globalThis.fetch = async (_url, init) => {
    childCalls++
    return new Promise((_resolve, reject) => {
      if (init.signal?.aborted) return reject(init.signal.reason)
      init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true })
    })
  }
  const b = new Agent({ ...opts, subagents: { keepAlive: false, retry: { attemptTimeoutMs: 30, maxAttempts: 2, backoffMs: 0 } } })
  for (const event of ['agent.retry', 'agent.failed', 'agent.cancelled']) b.on(event, payload => terminal.push({ event, failureKind: payload.failureKind }))
  const ac = new AbortController()
  const safety = setTimeout(() => ac.abort(new DOMException('probe limit', 'AbortError')), 200)
  const start = Date.now()
  await b.subagents.spawn({ description: 'hanging request', prompt: 'work', background: false, signal: ac.signal })
  clearTimeout(safety)
  console.log(JSON.stringify({ scenario: 'request-timeout', elapsedMs: Date.now() - start, childCalls, probeSafetyAbort: ac.signal.aborted, terminal }))
  await b.closeSubagents()
} finally {
  globalThis.fetch = original
}
