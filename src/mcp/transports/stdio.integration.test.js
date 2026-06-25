// Feature: mcp-client-integration, Task 15.1: stdio full lifecycle integration test
//
// Spawns the mock MCP server fixture (`src/mcp/__fixtures__/mock-mcp-server.js`)
// as a child process over real stdin/stdout and exercises the full happy path:
//   initialize → listTools → tools/call (execute) → close.
//
// This complements the unit tests (which use the in-memory mock-transport) by
// verifying the actual bytes-on-pipe path works end-to-end.
//
// Requirements: 1.2, 2.4, 3.1-3.4, 4.1-4.4, 5.5, 6.1, 7.1, 7.3

import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { fileURLToPath } from 'node:url'
import { createMCPClient } from '../index.js'

// Resolve the mock server path relative to this test file so the test works
// regardless of the cwd `node --test` is invoked from.
const MOCK_SERVER = fileURLToPath(
  new URL('../__fixtures__/mock-mcp-server.js', import.meta.url)
)

test('[INTEGRATION] stdio: full initialize → listTools → tools/call → close lifecycle', async () => {
  const client = await createMCPClient({
    transport: 'stdio',
    command: process.execPath,
    args: [MOCK_SERVER],
    name: 'mock',
  })

  try {
    // Handshake complete: state is ready, serverInfo populated.
    assert.equal(client.state, 'ready')
    assert.equal(client.serverInfo?.name, 'mock-mcp-server')
    assert.equal(client.serverInfo?.version, '0.0.1')

    // listTools returns both mock tools under the `mcp__<server>__<tool>` prefix.
    const tools = await client.listTools()
    assert.equal(tools.length, 2)

    const toolNames = tools.map((t) => t.name).sort()
    assert.deepEqual(toolNames, ['mcp__mock__add', 'mcp__mock__echo'])

    // _mcp metadata is non-enumerable.
    const echoTool = tools.find((t) => t._mcp.rawName === 'echo')
    assert.ok(echoTool, 'echo tool should be present')
    assert.equal(echoTool._mcp.serverName, 'mock')
    assert.equal(echoTool._mcp.rawName, 'echo')
    assert.ok(
      !Object.keys(echoTool).includes('_mcp'),
      '_mcp should be non-enumerable (excluded from Object.keys)'
    )

    // execute → tools/call round-trip. Mock server echoes JSON.stringify(args)
    // as the single text content part, so the normalized result is that exact
    // JSON string; parsing it back should yield an object deep-equal to args.
    const args = { message: 'hello world', n: 42 }
    const result = await echoTool.execute(args)
    const parsed = JSON.parse(result)
    assert.deepEqual(
      parsed,
      args,
      'execute result should round-trip the arguments passed to tools/call'
    )
  } finally {
    await client.close()
    assert.equal(client.state, 'closed')
  }
})

test('[INTEGRATION] stdio: listTools returns cached reference on repeat call', async () => {
  const client = await createMCPClient({
    transport: 'stdio',
    command: process.execPath,
    args: [MOCK_SERVER],
    name: 'mock',
  })
  try {
    const a = await client.listTools()
    const b = await client.listTools()
    assert.equal(a, b, 'listTools cache should return the same reference')
  } finally {
    await client.close()
  }
})

test('[INTEGRATION] stdio: close() rejects subsequent calls and transitions to closed', async () => {
  const client = await createMCPClient({
    transport: 'stdio',
    command: process.execPath,
    args: [MOCK_SERVER],
    name: 'mock',
  })

  assert.equal(client.state, 'ready')
  await client.close()
  assert.equal(client.state, 'closed')

  // After close, further calls reject immediately.
  await assert.rejects(
    () => client.listTools(),
    /closed|not ready/i,
    'listTools after close should reject with MCPClosedError'
  )
})
