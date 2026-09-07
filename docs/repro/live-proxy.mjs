// Local test relay: keeps the real credential out of browser forms and logs.
// Usage: provide LLM_API_KEY and LLM_URL through environment, then run this file.
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:4321')
  res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return }
  const ac = new AbortController()
  res.on('close', () => { if (!res.writableEnded) ac.abort() })
  try {
    let body = ''
    for await (const chunk of req) body += chunk
    const upstream = await fetch(process.env.LLM_URL, {
      method: 'POST', signal: ac.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.LLM_API_KEY}` }, body,
    })
    res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json' })
    await pipeline(Readable.fromWeb(upstream.body), res)
  } catch { if (!res.destroyed) { res.writeHead(502); res.end('Upstream request failed') } }
})
server.listen(4322, '127.0.0.1', () => console.log('Live model relay listening on 127.0.0.1:4322'))
process.on('SIGTERM', () => { server.close(); server.closeAllConnections() })
