#!/usr/bin/env node
// Minimal MCP server fixture for stdio integration tests.
//
// Reads JSON-RPC 2.0 messages line-by-line from stdin and writes
// responses line-by-line to stdout. Supports:
//   - initialize        → protocolVersion '2025-11-25' + serverInfo
//   - tools/list        → two descriptors with 2025-11-25 metadata
//   - tools/call        → text content containing JSON.stringify(arguments)
//   - notifications/*   → ignored
// Unknown methods return a JSON-RPC error with code -32601.

import readline from 'node:readline'

const PROTOCOL_VERSION = '2025-11-25'

const ECHO_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    arguments: { type: 'object' },
  },
  required: ['arguments'],
}

const ADD_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    a: { type: 'number' },
    b: { type: 'number' },
    sum: { type: 'number' },
  },
  required: ['a', 'b', 'sum'],
}

const TOOLS = [
  {
    name: 'echo',
    title: 'Echo Arguments',
    description: 'Echo back the input arguments as JSON',
    icons: [{ src: 'https://example.test/echo.png', mimeType: 'image/png', sizes: ['32x32'] }],
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Text to echo' },
      },
      required: [],
    },
    outputSchema: ECHO_OUTPUT_SCHEMA,
    execution: { taskSupport: 'forbidden' },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false, title: 'Echo tool' },
  },
  {
    name: 'add',
    title: 'Add Numbers',
    description: 'Add two numbers',
    icons: [{ src: 'https://example.test/add.png', mimeType: 'image/png', sizes: ['32x32'] }],
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'number' },
        b: { type: 'number' },
      },
      required: ['a', 'b'],
    },
    outputSchema: ADD_OUTPUT_SCHEMA,
    execution: { taskSupport: 'forbidden' },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
]

function handleMessage(msg) {
  // Notifications have no id; silently ignored.
  if (msg == null || msg.id == null) return null

  switch (msg.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          serverInfo: { name: 'mock-mcp-server', version: '0.0.1' },
          capabilities: { tools: {} },
          instructions: 'Mock server for integration tests',
        },
      }
    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: { tools: TOOLS },
      }
    case 'tools/call':
      if (msg.params?.name === 'add') {
        const args = msg.params?.arguments ?? {}
        const a = Number(args.a ?? 0)
        const b = Number(args.b ?? 0)
        const structuredContent = { a, b, sum: a + b }
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify(structuredContent),
              },
            ],
            structuredContent,
            isError: false,
          },
        }
      }
      {
        const args = msg.params?.arguments ?? {}
        const structuredContent = { arguments: args }
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify(args),
              },
            ],
            structuredContent,
            isError: false,
          },
        }
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

const rl = readline.createInterface({ input: process.stdin })

rl.on('line', (line) => {
  if (!line) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    // Malformed frame — silently drop (real MCP servers would log).
    return
  }
  const response = handleMessage(msg)
  if (response) {
    process.stdout.write(JSON.stringify(response) + '\n')
  }
})

rl.on('close', () => {
  process.exit(0)
})
