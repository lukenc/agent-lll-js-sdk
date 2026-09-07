/** Real-model integration. Requires LLM_API_KEY, LLM_URL, MODEL in the environment. */
import assert from 'node:assert/strict'
import { Agent, defineTool, SlidingWindowMemory } from '../src/index.js'

if (!process.env.LLM_API_KEY || !process.env.LLM_URL || !process.env.MODEL) {
  throw new Error('Set LLM_API_KEY, LLM_URL and MODEL before running this example')
}
const events = []
const replies = []
const errors = []
let busy = true
let queued = false
const agent = new Agent({
  provider: process.env.PROVIDER || 'openai', url: process.env.LLM_URL,
  apiKey: process.env.LLM_API_KEY, model: process.env.MODEL,
  memory: new SlidingWindowMemory(30), enableIntentRecognition: true, maxRounds: 12,
  systemPrompt: '你是编排者。按用户要求调用 agent 委派后台任务，派出后简短答复。后台结果到达后核对产物并汇报。',
  tools: [defineTool({
    name: 'calculate', description: '计算 6*7，返回真实计算结果。',
    parameters: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] },
    execute: async ({ expression }, { signal } = {}) => {
      assert.match(expression.replace(/\s/g, ''), /^6\*7$/)
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, 500)
        function abort() { clearTimeout(timer); reject(signal.reason) }
        if (signal?.aborted) abort()
        else signal?.addEventListener('abort', abort, { once: true })
      })
      return String(6 * 7)
    },
  })],
  subagents: { keepAlive: false, retry: { attemptTimeoutMs: 120000, maxAttempts: 1 } },
})
const controller = new AbortController()
const timer = setTimeout(() => controller.abort(new Error('live integration deadline')), 180000)
const pump = async () => {
  queued = true
  if (busy) return
  busy = true
  try {
    while (queued) {
      queued = false
      const answer = await agent.followup({ signal: controller.signal })
      if (answer != null) { replies.push(answer); console.log('FOLLOWUP:', answer) }
    }
  } catch (error) { errors.push(error) }
  finally { busy = false }
}
agent.on('run.wakeup', () => { void pump() })
for (const name of ['agent.spawn', 'agent.succeeded', 'agent.failed', 'tool.call']) agent.on(name, payload => {
  events.push({ name, payload })
  if (name !== 'tool.call') console.log(name, payload.agentName, payload.failureKind || '')
})
try {
  let done
  for await (const event of agent.stream('请立即用 agent 工具派一个 general-purpose 后台子任务（run_in_background=true）：调用 calculate 计算 6*7，然后 artifact_write 保存 key=live-answer、content=计算结果，最后汇报结果。你派出后先简短确认，收到完成通知再汇报。不要自己计算或代替子任务调用工具。', { signal: controller.signal })) {
    if (event.type === 'done') { done = event; console.log('FIRST:', event.content, 'inFlight=', agent.subagents.hasInFlight()) }
  }
  busy = false
  if (queued) await pump()
  while (agent.subagents.hasInFlight() || busy || queued) {
    controller.signal.throwIfAborted()
    if (errors.length) throw errors[0]
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  if (errors.length) throw errors[0]
  assert.ok(events.some(e => e.name === 'agent.succeeded'))
  assert.ok(events.some(e => e.name === 'tool.call' && e.payload.name === 'calculate' && e.payload.agentId && e.payload.ok))
  assert.ok((await agent.getArtifacts()).some(a => a.key === 'live-answer'))
  assert.match([done.content, ...replies].join('\n'), /42/)
  const memory = await agent.chat('上一轮计算结果是多少？只需回答数字。', { signal: controller.signal })
  assert.match(memory, /42/)
  console.log('MEMORY:', memory)
  console.log('LIVE PASS', JSON.stringify({ model: process.env.MODEL, followups: replies.length, states: agent.subagents.registry.list({ includeFinished: true }).map(h => h.state) }))
} finally { clearTimeout(timer); await agent.closeSubagents() }
