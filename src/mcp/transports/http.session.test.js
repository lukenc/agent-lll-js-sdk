import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { createMCPClient } from '../index.js'

const SESSION_ID = 'session-abc-123'
const PROTOCOL_VERSION = '2025-11-25'

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function jsonRpcResult(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result })
}

function startSessionAwareServer() {
  const requests = []

  const server = http.createServer(async (req, res) => {
    const body = req.method === 'POST' ? await readBody(req) : ''
    const json = body ? JSON.parse(body) : null
    requests.push({
      method: req.method,
      headers: { ...req.headers },
      json,
    })

    if (req.method === 'DELETE') {
      if (req.headers['mcp-session-id'] !== SESSION_ID) {
        res.writeHead(400, { 'Content-Type': 'text/plain' })
        res.end('missing MCP-Session-Id')
        return
      }
      if (req.headers['mcp-protocol-version'] !== PROTOCOL_VERSION) {
        res.writeHead(400, { 'Content-Type': 'text/plain' })
        res.end('missing MCP-Protocol-Version')
        return
      }
      res.writeHead(202)
      res.end()
      return
    }

    if (req.method !== 'POST') {
      res.writeHead(405)
      res.end()
      return
    }

    if (json?.method !== 'initialize') {
      if (req.headers['mcp-session-id'] !== SESSION_ID) {
        res.writeHead(400, { 'Content-Type': 'text/plain' })
        res.end('missing MCP-Session-Id')
        return
      }
      if (req.headers['mcp-protocol-version'] !== PROTOCOL_VERSION) {
        res.writeHead(400, { 'Content-Type': 'text/plain' })
        res.end('missing MCP-Protocol-Version')
        return
      }
    }

    if (json?.method === 'initialize') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'MCP-Session-Id': SESSION_ID,
      })
      res.end(jsonRpcResult(json.id, {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: { name: 'session-aware-http', version: '1.0.0' },
        capabilities: { tools: {} },
      }))
      return
    }

    if (json?.method === 'notifications/initialized') {
      res.writeHead(202)
      res.end()
      return
    }

    if (json?.method === 'tools/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(jsonRpcResult(json.id, { tools: [] }))
      return
    }

    res.writeHead(404)
    res.end()
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      const addr = server.address()
      resolve({
        url: `http://127.0.0.1:${addr.port}/mcp`,
        requests,
        stop: () => new Promise((res, rej) => {
          server.close((err) => (err ? rej(err) : res()))
        }),
      })
    })
  })
}

test('streamable-http includes session id and negotiated protocol version on requests after initialize', async () => {
  const server = await startSessionAwareServer()
  let client
  try {
    client = await createMCPClient({
      transport: 'http',
      url: server.url,
      protocolVersion: PROTOCOL_VERSION,
      requestTimeoutMs: 1000,
    })

    await client.listTools()

    const posts = server.requests.filter((req) => req.method === 'POST')
    assert.equal(posts[0].json.method, 'initialize')
    assert.deepEqual(posts[0].json.params.capabilities, {})
    assert.equal(posts[0].headers['mcp-session-id'], undefined)

    const initialized = posts.find((req) => req.json?.method === 'notifications/initialized')
    assert.equal(initialized.headers['mcp-session-id'], SESSION_ID)
    assert.equal(initialized.headers['mcp-protocol-version'], PROTOCOL_VERSION)

    const toolsList = posts.find((req) => req.json?.method === 'tools/list')
    assert.equal(toolsList.headers['mcp-session-id'], SESSION_ID)
    assert.equal(toolsList.headers['mcp-protocol-version'], PROTOCOL_VERSION)
  } finally {
    if (client) await client.close()
    await server.stop()
  }
})

test('streamable-http sends DELETE with session headers when closing a stateful session', async () => {
  const server = await startSessionAwareServer()
  let client
  try {
    client = await createMCPClient({
      transport: 'http',
      url: server.url,
      protocolVersion: PROTOCOL_VERSION,
      requestTimeoutMs: 1000,
    })

    await client.close()
    client = null

    const deletes = server.requests.filter((req) => req.method === 'DELETE')
    assert.equal(deletes.length, 1)
    assert.equal(deletes[0].headers['mcp-session-id'], SESSION_ID)
    assert.equal(deletes[0].headers['mcp-protocol-version'], PROTOCOL_VERSION)
  } finally {
    if (client) await client.close()
    await server.stop()
  }
})

test('createMCPClient defaults initialize protocolVersion to the latest supported MCP version', async () => {
  const server = await startSessionAwareServer()
  let client
  try {
    client = await createMCPClient({
      transport: 'http',
      url: server.url,
      requestTimeoutMs: 1000,
    })

    const initialize = server.requests.find((req) => req.json?.method === 'initialize')
    assert.equal(initialize.json.params.protocolVersion, PROTOCOL_VERSION)
  } finally {
    if (client) await client.close()
    await server.stop()
  }
})
