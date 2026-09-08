import { Agent, defineTool } from 'lll-web-agent'

// 模型在同一轮里发出两个同名、同参的 tool_call
const CALLS = [
  { id: 'call_AAA', args: { path: 'a.txt' } },
  { id: 'call_BBB', args: { path: 'a.txt' } },
]

const enc = new TextEncoder()
const d = (o) => `data: ${JSON.stringify(o)}\n`

function sseResponse(chunks) {
  let i = 0
  return {
    ok: true, status: 200, headers: new Map(),
    body: { getReader: () => ({
      async read() { return i >= chunks.length ? { done: true } : { done: false, value: enc.encode(chunks[i++]) } },
      releaseLock() {},
    }) },
    async text() { return '' }, async json() { return {} },
  }
}

function sseTwoCalls() {
  const chunks = []
  CALLS.forEach((c, index) => {
    chunks.push(d({ choices: [{ index: 0, delta: { tool_calls: [
      { index, id: c.id, type: 'function', function: { name: 'read_file', arguments: '' } },
    ] } }] }))
    chunks.push(d({ choices: [{ index: 0, delta: { tool_calls: [
      { index, function: { arguments: JSON.stringify(c.args) } },
    ] } }] }))
  })
  chunks.push(d({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }))
  chunks.push('data: [DONE]\n')
  return sseResponse(chunks)
}

const sseText = (t) => sseResponse([
  d({ choices: [{ index: 0, delta: { content: t } }] }),
  d({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  'data: [DONE]\n',
])

let round = 0
globalThis.fetch = async () => (round++ === 0 ? sseTwoCalls() : sseText('done'))

const seenContexts = []
const readFile = defineTool({
  name: 'read_file',
  description: 'read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
  execute: async (params, context) => {
    seenContexts.push(Object.keys(context ?? {}))
    return `contents of ${params.path}`
  },
})

const hookArgs = []
const agent = new Agent({
  provider: 'openai',
  url: 'https://fake.invalid/v1/chat/completions',
  apiKey: 'k', model: 'm',
  tools: [readFile],
  maxRounds: 5,
  hooks: {
    beforeToolCall: (...a) => { hookArgs.push(['beforeToolCall', a.length, a.slice(0, 2)]) },
    afterToolCall:  (...a) => { hookArgs.push(['afterToolCall',  a.length, a.slice(0, 2)]) },
  },
})

const events = []
for await (const ev of agent.stream('读两次 a.txt')) {
  if (ev.type === 'tool_start' || ev.type === 'tool_end') events.push(ev)
}

for (const ev of events) console.log(JSON.stringify(ev))
for (const keys of seenContexts) console.log('execute context:', keys.join(', '))
for (const h of hookArgs) console.log('hook:', JSON.stringify(h))
