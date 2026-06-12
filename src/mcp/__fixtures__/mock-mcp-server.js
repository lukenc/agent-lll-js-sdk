const tools = [
  {
    name: 'echo',
    description: 'Echo the provided text.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
      },
      required: ['text'],
    },
  },
  {
    name: 'add',
    description: 'Add two numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'number' },
        b: { type: 'number' },
      },
      required: ['a', 'b'],
    },
  },
]

function write(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

function result(id, value) {
  write({ jsonrpc: '2.0', id, result: value })
}

function error(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } })
}

function callTool(name, args) {
  if (name === 'echo') {
    return String(args?.text ?? '')
  }
  if (name === 'add') {
    return String(Number(args?.a ?? 0) + Number(args?.b ?? 0))
  }
  throw new Error(`Unknown tool: ${name}`)
}

function handle(message) {
  if (!message || message.jsonrpc !== '2.0') return

  if (message.method === 'initialize') {
    result(message.id, {
      protocolVersion: message.params?.protocolVersion ?? '2025-03-26',
      serverInfo: { name: 'mock-mcp-server', version: '0.1.0' },
      capabilities: { tools: {} },
    })
    return
  }

  if (message.method === 'notifications/initialized') return

  if (message.method === 'tools/list') {
    result(message.id, { tools })
    return
  }

  if (message.method === 'tools/call') {
    try {
      const text = callTool(message.params?.name, message.params?.arguments ?? {})
      result(message.id, { content: [{ type: 'text', text }] })
    } catch (err) {
      error(message.id, -32602, err?.message ?? String(err))
    }
    return
  }

  if (message.id !== undefined) {
    error(message.id, -32601, `Method not found: ${message.method}`)
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  let idx = buffer.indexOf('\n')
  while (idx !== -1) {
    const line = buffer.slice(0, idx).trim()
    buffer = buffer.slice(idx + 1)
    if (line) {
      try {
        handle(JSON.parse(line))
      } catch (err) {
        error(null, -32700, err?.message ?? String(err))
      }
    }
    idx = buffer.indexOf('\n')
  }
})
