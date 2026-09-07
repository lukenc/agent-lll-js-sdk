/** Scripted OpenAI-compatible HTTP service for repeatable lifecycle integration.
 * Only model responses are scripted; SDK agents, tools, memory and fetch are real.
 */
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

export async function startBackgroundFixture({ port = 0, delayMs = 350 } = {}) {
  const stats = { requests: 0, abortedRequests: 0, intents: 0 }
  const call = (name, args) => ({ content: '', tool_calls: [{ id: `call_${stats.requests}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
  const server = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization')
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
    let raw = ''
    for await (const chunk of req) raw += chunk
    try {
      const body = JSON.parse(raw)
      stats.requests++
      const users = body.messages.filter(m => m.role === 'user')
      const latest = users.at(-1)?.content || ''
      const child = String(users[0]?.content).includes('REPORT_CHILD')
      const lastCall = body.messages.flatMap(m => m.tool_calls || []).at(-1)?.function.name
      let message
      if (String(body.messages[0]?.content).includes('You are an intent analyzer')) {
        stats.intents++
        message = { content: JSON.stringify({ clarity: 'CLEAR', complexity: 'SIMPLE', recommendedStrategy: 'react', filteredToolNames: ['calculate'], reasoning: '生命周期集成用例' }) }
      } else if (child && String(users[0].content).includes('REPORT_HANG')) {
        // A real pending fetch; its AbortSignal closes the connection.
        res.on('close', () => { stats.abortedRequests++ })
        return
      } else if (child) {
        if (!lastCall) message = call('calculate', { expression: '6*7' })
        else if (lastCall === 'calculate') {
          await new Promise(resolve => setTimeout(resolve, delayMs))
          if (res.destroyed) return
          message = call('artifact_write', { key: 'background-answer', content: '42' })
        } else message = { content: '后台计算完成：42；产物 background-answer 已保存。' }
      } else if (latest.includes('<agent-notification')) {
        message = { content: latest.includes('failed') ? '后台任务失败：timeout；已收到失败通知。' : '已收到后台结果：42；产物 background-answer 可查询。' }
      } else if (latest.includes('上一轮')) {
        message = { content: JSON.stringify(body.messages).includes('42') ? '上一轮的结果是 42。' : '没有找到上一轮结果。' }
      } else if (body.messages.at(-1)?.role === 'tool') {
        message = { content: '已经派出后台任务，等待完成通知。' }
      } else {
        message = call('agent', { description: '后台回归计算', prompt: latest.includes('超时') ? 'REPORT_CHILD REPORT_HANG' : 'REPORT_CHILD 计算 6*7，写入产物并汇报。' })
      }
      const finish = message.tool_calls ? 'tool_calls' : 'stop'
      const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const delta = message.tool_calls ? { ...message, tool_calls: message.tool_calls.map((c, index) => ({ ...c, index })) } : message
        res.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }], usage })}\n\ndata: [DONE]\n\n`)
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message, finish_reason: finish }], usage }))
      }
    } catch (error) {
      res.writeHead(500); res.end(JSON.stringify({ error: { message: error.message } }))
    }
  })
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, stats,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = await startBackgroundFixture({ port: Number(process.env.FIXTURE_PORT || 4319) })
  console.log(`Scripted model fixture: ${fixture.url}`)
  process.on('SIGTERM', async () => { await fixture.close() })
  process.on('SIGINT', async () => { await fixture.close() })
}
