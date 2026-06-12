/**
 * MCP 自定义 Transport 示例 — 使用 `registerTransport` 注入一个非内置 transport。
 *
 * 内置 transport 只有 stdio / http / streamable-http / sse。规范里不存在
 * "websocket" transport,因此框架不自带;但任何符合 `MCP_Transport` 契约的
 * factory 都可以通过 `registerTransport(name, factory)` 挂进去。
 *
 * 本示例用一个"内存回环"模拟自定义 transport,避免依赖真实 WS 服务器。
 * 思路完全适用于真实 WebSocket:替换 send / onMessage 的底层载体即可。
 *
 * 运行: node examples/mcp-custom-transport.js
 */
import { createMCPClient, registerTransport } from '../src/index.js'

/**
 * 内存 MCP Server —— 模拟一个会对 initialize / tools/list / tools/call 作响应的
 * server,把"发送消息"与"接收消息"分成两个回调,方便 transport factory 接入。
 *
 * 真实 WebSocket 场景下,这里的 server 逻辑在对端进程;自定义 transport 的
 * factory 只关心"我有一个双向消息通道"。
 */
function createInMemoryServer() {
  const subscribers = []   // 注册的 onMessage 回调列表(server → client 方向)

  function subscribe(cb) { subscribers.push(cb) }
  function publish(msg) {
    // 异步递交,模拟真实网络传输不同步返回
    queueMicrotask(() => { for (const cb of subscribers) cb(msg) })
  }

  function handle(msg) {
    if (msg.id == null) return   // notification,忽略
    let result
    switch (msg.method) {
      case 'initialize':
        result = {
          protocolVersion: '2025-03-26',
          serverInfo: { name: 'inmem-server', version: '0.0.1' },
          capabilities: { tools: {} },
          instructions: 'Demo in-memory MCP server',
        }
        break
      case 'tools/list':
        result = {
          tools: [{
            name: 'ping',
            description: '返回 pong',
            inputSchema: { type: 'object', properties: {} },
          }],
        }
        break
      case 'tools/call':
        result = {
          content: [{ type: 'text', text: `pong (args=${JSON.stringify(msg.params?.arguments ?? {})})` }],
          isError: false,
        }
        break
      default:
        publish({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } })
        return
    }
    publish({ jsonrpc: '2.0', id: msg.id, result })
  }

  return { handle, subscribe }
}

/**
 * 自定义 transport factory —— 符合 `MCP_Transport_Factory` 契约:
 * 返回对象必须有 `{ send, onMessage, onError, onClose, close }`。
 *
 * 这里把内存 server 当作对端,`send` 直接把 msg 交给 server.handle,
 * `onMessage` 订阅 server 的发布流。WebSocket / 自定义 RPC 只需把
 * send 改成 ws.send(JSON.stringify(msg)),onMessage 改成 ws.on('message',
 * (raw) => cb(JSON.parse(raw))) 即可。
 */
function inMemoryFactory(options) {
  const server = options._server   // 把 server 实例通过 options 传进来
  let messageCb = null
  let closed = false
  let closePromise = null

  server.subscribe((msg) => {
    if (!closed && messageCb) messageCb(msg)
  })

  return {
    async send(msg) {
      if (closed) throw new Error('inmem transport: closed')
      server.handle(msg)
    },
    onMessage(cb) { messageCb = cb },
    onError(_cb) { /* 内存 transport 不产生 error */ },
    onClose(_cb) { /* 内存 transport 由 close() 主动触发 */ },
    async close() {
      if (closePromise) return closePromise
      closePromise = Promise.resolve().then(() => { closed = true })
      return closePromise
    },
  }
}

// ==================== 运行 ====================

// 1. 注册自定义 transport —— 名字不能用保留名(stdio / http / streamable-http / sse)
registerTransport('inmem', inMemoryFactory)
console.log('已注册自定义 transport: inmem')

// 2. 创建 server 实例,通过 options 透传给 factory
const server = createInMemoryServer()

// 3. 像使用内置 transport 一样调用 createMCPClient
const client = await createMCPClient({
  transport: 'inmem',
  name: 'inmem-demo',
  _server: server,   // factory 专属选项,createMCPClient 会透传给 factory
})

console.log('客户端就绪,server:', client.serverInfo)
console.log('状态:', client.state)

// 4. listTools / execute 完全复用框架内核
const tools = await client.listTools()
console.log(`\n发现 ${tools.length} 个工具:`, tools.map(t => t.name).join(', '))

const ping = tools.find(t => t._mcp.rawName === 'ping')
const result = await ping.execute({ timestamp: Date.now() })
console.log('\nexecute 返回:', result)

await client.close()
console.log('\n已关闭,状态:', client.state)

// 5. 尝试用保留名注册 —— 会抛错
try {
  registerTransport('stdio', () => {})
} catch (err) {
  console.log('\n保留名注册被拒:', err.message)
}

console.log('\n完成')
