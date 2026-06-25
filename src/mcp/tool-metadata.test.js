import test from 'node:test'
import assert from 'node:assert/strict'

import { MCP_Client } from './client.js'
import { createMockTransport } from './__fixtures__/mock-transport.js'

async function createReadyClient(serverName = 'meta') {
  const handle = createMockTransport()
  const client = new MCP_Client({
    transport: handle.transport,
    serverName,
    options: {
      protocolVersion: '2025-11-25',
      clientInfo: { name: 'metadata-test', version: '1.0.0' },
      requestTimeoutMs: 1000,
    },
  })

  const handshake = client._performHandshake()
  const initialize = await handle.waitForSend((msg) => msg.method === 'initialize')
  handle.injectMessage({
    jsonrpc: '2.0',
    id: initialize.id,
    result: {
      protocolVersion: '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: 'metadata-server', version: '1.0.0' },
    },
  })
  await handle.waitForSend((msg) => msg.method === 'notifications/initialized')
  await handshake

  return { client, handle }
}

test('MCP tools expose official descriptor metadata without enumerating it into the Agent tool schema', async () => {
  const { client, handle } = await createReadyClient()
  try {
    const inputSchema = {
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
    }
    const outputSchema = {
      type: 'object',
      properties: { count: { type: 'number' } },
      required: ['count'],
    }
    const icons = [
      { src: 'https://example.test/icon.png', mimeType: 'image/png', sizes: ['48x48'] },
    ]
    const execution = { taskSupport: 'optional' }
    const annotations = { readOnlyHint: true, title: 'Search' }

    const listPromise = client.listTools()
    const list = await handle.waitForSend((msg) => msg.method === 'tools/list')
    handle.injectMessage({
      jsonrpc: '2.0',
      id: list.id,
      result: {
        tools: [
          {
            name: 'search',
            title: 'Search Records',
            description: 'Search indexed records',
            inputSchema,
            outputSchema,
            icons,
            execution,
            annotations,
          },
        ],
      },
    })

    const [tool] = await listPromise

    assert.equal(tool.title, 'Search Records')
    assert.equal(tool.icons, icons)
    assert.equal(tool.outputSchema, outputSchema)
    assert.equal(tool.execution, execution)
    assert.equal(tool.annotations, annotations)
    assert.equal(tool.execution.taskSupport, 'optional')

    assert.equal(tool._mcp.title, 'Search Records')
    assert.equal(tool._mcp.icons, icons)
    assert.equal(tool._mcp.outputSchema, outputSchema)
    assert.equal(tool._mcp.execution, execution)
    assert.equal(tool._mcp.annotations, annotations)

    assert.deepEqual(
      Object.keys(tool).sort(),
      ['description', 'execute', 'name', 'parameters'],
      'MCP metadata must stay non-enumerable so JSON schema formatting remains unchanged'
    )
  } finally {
    await client.close()
  }
})
