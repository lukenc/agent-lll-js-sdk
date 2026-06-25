import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createMCPClient } from './mcp/index.js'

describe('demo MCP presets', () => {
  it('starts the bundled mock MCP server and exposes echo/add tools', async () => {
    const fixture = fileURLToPath(new URL('./mcp/__fixtures__/mock-mcp-server.js', import.meta.url))
    let stderr = ''
    const client = await createMCPClient({
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
      name: 'mock',
      requestTimeoutMs: 5000,
      onStderr: chunk => { stderr += chunk },
    })

    try {
      const tools = await client.listTools()
      assert.deepEqual(tools.map(t => t.name), ['mcp__mock__echo', 'mcp__mock__add'])

      const echo = tools.find(t => t.name === 'mcp__mock__echo')
      const add = tools.find(t => t.name === 'mcp__mock__add')

      assert.deepEqual(JSON.parse(await echo.execute({ text: 'hello' })), { text: 'hello' })
      assert.deepEqual(JSON.parse(await add.execute({ a: 2, b: 3 })), { a: 2, b: 3, sum: 5 })
      assert.equal(stderr, '')
    } finally {
      await client.close()
    }
  })
})
