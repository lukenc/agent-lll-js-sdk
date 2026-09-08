/** Local scripted model for the client-report investigation. No real LLM is called. */
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

export const reportIds = ['call_AAA', 'call_BBB']

export async function startToolCallIdFixture({ port = 0, toolName = 'read_file', differentArgs = false } = {}) {
  const requests = []
  const server = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization')
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
    if (req.url === '/stats') { res.end(JSON.stringify(requests)); return }
    try {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw)
      requests.push(body)
      const intent = String(body.messages[0]?.content).includes('You are an intent analyzer')
      const latestUser = body.messages.findLast(m => m.role === 'user')?.content || ''
      let message
      if (intent) {
        message = { content: JSON.stringify({ clarity: 'CLEAR', complexity: 'SIMPLE', recommendedStrategy: 'react', filteredToolNames: [toolName], reasoning: 'tool id report fixture' }) }
      } else if (String(latestUser).includes('上一轮')) {
        message = { content: `memory ids: ${body.messages.filter(m => m.role === 'tool').map(m => m.tool_call_id).join(',')}` }
      } else if (body.messages.at(-1)?.role === 'tool') {
        const results = body.messages.filter(m => m.role === 'tool')
        message = { content: `done: ${results.map(m => `${m.tool_call_id}=${m.content}`).join('; ')}` }
      } else {
        message = {
          content: '',
          tool_calls: reportIds.map((id, index) => ({
            id, type: 'function',
            function: { name: toolName, arguments: JSON.stringify(toolName === 'calculate' ? { expression: '6*7' } : { path: differentArgs && index ? 'b.txt' : 'a.txt' }) },
          })),
        }
      }
      const finish_reason = message.tool_calls ? 'tool_calls' : 'stop'
      const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
      if (!body.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message, finish_reason }], usage }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const frame = delta => res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`)
      if (message.tool_calls) {
        message.tool_calls.forEach((call, index) => {
          frame({ tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.function.name, arguments: '' } }] })
          frame({ tool_calls: [{ index, function: { arguments: call.function.arguments } }] })
        })
      } else frame(message)
      res.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason }], usage })}\n\ndata: [DONE]\n\n`)
    } catch (error) {
      res.writeHead(500); res.end(JSON.stringify({ error: { message: error.message } }))
    }
  })
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, requests,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = await startToolCallIdFixture({ port: Number(process.env.FIXTURE_PORT || 4329), toolName: process.env.FIXTURE_TOOL || 'calculate' })
  console.log(`Scripted model fixture: ${fixture.url}`)
  for (const event of ['SIGTERM', 'SIGINT']) process.on(event, async () => { await fixture.close() })
}
