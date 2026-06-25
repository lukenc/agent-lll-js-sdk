// Minimal MCP server fixture for streamable-http integration tests.
//
// Exposes `startMockHttpServer({ port, seed })` which boots a Node
// `http.createServer` that speaks MCP 2025-03-26 over a single POST
// endpoint and returns `{ url, stop }`. Because `server.listen` is
// asynchronous and we need the actually-bound port to build `url`
// (port 0 asks the OS to pick a free port), this function returns
// a Promise — see the JSDoc below.
//
// Supported JSON-RPC methods:
//   - initialize        → protocolVersion '2025-03-26' + serverInfo
//   - tools/list        → two descriptors: 'echo' (json path) and 'sse-echo' (event-stream path)
//   - tools/call        → text content containing JSON.stringify(arguments)
//   - notifications/*   → 202 Accepted, empty body
// Unknown methods return a JSON-RPC error with code -32601.
//
// Response media type:
//   - default                                  → 'application/json'
//   - tools/call with params.name === 'sse-echo' → 'text/event-stream' (single `data:` frame)
//
// This fixture is test-only and not re-exported from `src/mcp/index.js`.

import http from 'node:http'

const PROTOCOL_VERSION = '2025-03-26'

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo via application/json response',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Text to echo' },
      },
      required: [],
    },
    annotations: { readOnlyHint: true, title: 'Echo (JSON)' },
  },
  {
    name: 'sse-echo',
    description: 'Echo via text/event-stream response',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
      },
      required: [],
    },
    annotations: { readOnlyHint: true, title: 'Echo (SSE)' },
  },
]

/**
 * Build a JSON-RPC response object for a given inbound message.
 *
 * Returns `null` for notifications (no `id` field) so the caller can
 * emit an empty `202 Accepted`.
 *
 * @param {object} msg
 * @param {object} [seed]  Optional overrides (e.g. `{ protocolVersion }`) for tests that
 *                         want to simulate an incompatible server.
 * @returns {object | null}
 */
function handleMessage(msg, seed = {}) {
  if (msg == null || msg.id == null) return null

  switch (msg.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: seed.protocolVersion ?? PROTOCOL_VERSION,
          serverInfo: { name: 'mock-mcp-http', version: '0.0.1' },
          capabilities: { tools: {} },
          instructions: 'Mock streamable-http server for integration tests',
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

/**
 * Read the full request body as a UTF-8 string.
 *
 * @param {http.IncomingMessage} req
 * @returns {Promise<string>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => { buf += chunk })
    req.on('end', () => resolve(buf))
    req.on('error', reject)
  })
}

/**
 * Start a mock MCP streamable-http server on localhost.
 *
 * **Return type is a Promise** — even though the task description lists the
 * synchronous shape `{ url, stop }`, we must await `server.listen` to know the
 * OS-assigned port when `port === 0` (the default, so tests don't collide on a
 * fixed port). Callers do `const { url, stop } = await startMockHttpServer()`.
 *
 * @param {object} [opts]
 * @param {number} [opts.port]   Port to bind. Defaults to 0 (OS-picked free port).
 * @param {object} [opts.seed]   Optional response overrides (e.g. `{ protocolVersion }`).
 * @returns {Promise<{ url: string, stop: () => Promise<void> }>}
 */
export function startMockHttpServer({ port = 0, seed } = {}) {
  const server = http.createServer(async (req, res) => {
    // MCP streamable-http only uses POST. Everything else → 405.
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain' })
      res.end('Method Not Allowed')
      return
    }

    let body
    try {
      body = await readBody(req)
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('Bad Request')
      return
    }

    let msg
    try {
      msg = JSON.parse(body)
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('Malformed JSON')
      return
    }

    const response = handleMessage(msg, seed)

    // Notification (no id) — 202 Accepted with empty body, per MCP HTTP spec.
    if (response == null) {
      res.writeHead(202)
      res.end()
      return
    }

    // Exercise the text/event-stream response path for the 'sse-echo' tool.
    if (msg.method === 'tools/call' && msg.params?.name === 'sse-echo') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      // Single 'message' event carrying the JSON-RPC response as its `data:` field.
      res.write(`data: ${JSON.stringify(response)}\n\n`)
      res.end()
      return
    }

    // Default path: application/json.
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(response))
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject)
      const addr = server.address()
      const boundPort = typeof addr === 'object' && addr ? addr.port : port
      const url = `http://127.0.0.1:${boundPort}/`
      resolve({
        url,
        stop: () => new Promise((r, rj) => {
          server.close((err) => {
            if (err) rj(err)
            else r()
          })
        }),
      })
    })
  })
}
