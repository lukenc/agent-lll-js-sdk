// Minimal MCP legacy-SSE server fixture for integration tests.
//
// Protocol:
//   GET  /sse       → SSE stream. First event is `event: endpoint\ndata: /messages\n\n`
//                     telling the client where to POST subsequent messages.
//                     Responses to POSTed requests are delivered back on the
//                     same open stream as `data: <json>\n\n` events.
//   POST /messages  → Accepts one JSON-RPC request per call. Returns 202 Accepted
//                     immediately; the real response is streamed via SSE.
//                     Notifications (no `id`) do not produce a response.
//
// Supported methods: initialize / tools/list / tools/call.
// Unknown methods return a JSON-RPC error with code -32601.

import http from 'node:http'

const PROTOCOL_VERSION = '2025-03-26'

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo back the input arguments as JSON',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Text to echo' },
      },
      required: [],
    },
    annotations: { readOnlyHint: true, title: 'Echo tool' },
  },
]

function handleMessage(msg) {
  // Notifications (no id) produce no response.
  if (msg == null || msg.id == null) return null

  switch (msg.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          serverInfo: { name: 'mock-mcp-sse', version: '0.0.1' },
          capabilities: { tools: {} },
          instructions: 'Mock legacy-SSE server for integration tests',
        },
      }
    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: { tools: TOOLS },
      }
    case 'tools/call':
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(msg.params?.arguments ?? {}),
            },
          ],
          isError: false,
        },
      }
    default:
      return {
        jsonrpc: '2.0',
        id: msg.id,
        error: {
          code: -32601,
          message: `Method not found: ${msg.method}`,
        },
      }
  }
}

export function startMockSseServer({ port = 0 } = {}) {
  // For simplicity assume at most one active SSE consumer at a time —
  // sufficient for integration tests.
  let sseResponse = null

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/sse') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      // Announce the POST endpoint via the `endpoint` event.
      res.write('event: endpoint\ndata: /messages\n\n')
      sseResponse = res
      req.on('close', () => {
        if (sseResponse === res) sseResponse = null
      })
      return
    }

    if (req.method === 'POST' && req.url === '/messages') {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        let msg
        try {
          msg = JSON.parse(body)
        } catch {
          res.writeHead(400)
          res.end()
          return
        }

        // Always acknowledge the POST with 202; real payload flows over SSE.
        res.writeHead(202)
        res.end()

        const response = handleMessage(msg)
        if (response != null && sseResponse) {
          sseResponse.write(`data: ${JSON.stringify(response)}\n\n`)
        }
      })
      return
    }

    res.writeHead(404)
    res.end()
  })

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address()
      const url = `http://127.0.0.1:${addr.port}/sse`
      resolve({
        url,
        stop: () =>
          new Promise((r) => {
            if (sseResponse) {
              try {
                sseResponse.end()
              } catch {
                // ignore
              }
              sseResponse = null
            }
            server.close(() => r())
          }),
      })
    })
  })
}
