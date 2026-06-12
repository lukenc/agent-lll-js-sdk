/**
 * MCP Client 集成示例 — 把社区/自建 MCP Server 的工具挂到 Agent 上
 *
 * 演示三件事:
 *   1. `createMCPClient({ transport: 'stdio', command, args })` 连到一个
 *      stdio MCP Server(这里用框架自带的 mock server 演示,不依赖 npx)
 *   2. `client.listTools()` 返回的对象形状与 `defineTool` 完全一致,
 *      直接塞进 `new Agent({ tools: [...mcpTools, ...localTools] })`
 *   3. BASE_TOOLS 运行时 CRUD —— 在启用意图识别/token 预算时把 MCP 工具
 *      标记为 base,避免被 ToolFilter / ContextManager.trimTools 误裁剪
 *
 * 运行:
 *   node examples/mcp.js                     # 不需要 API Key,跑 MCP 基础流程
 *   OPENAI_API_KEY=sk-xxx node examples/mcp.js   # 额外跑一次 Agent 对话
 */
import { fileURLToPath } from 'node:url'
import {
  Agent,
  defineTool,
  createMCPClient,
  registerBaseTool,
  setBaseTools,
  resetBaseTools,
  getBaseTools,
  isBaseTool,
} from '../src/index.js'

// 用仓库里的 mock-mcp-server.js 作为演示用的 stdio MCP Server
// 这是一个 Node 脚本,响应 initialize / tools/list / tools/call 三种 JSON-RPC。
const MOCK_SERVER = fileURLToPath(
  new URL('../src/mcp/__fixtures__/mock-mcp-server.js', import.meta.url)
)

// ==================== 示例 1: 基础连接 + listTools ====================

async function example1_basics() {
  console.log('\n=== 示例 1: 连接 MCP Server + 查看工具清单 ===\n')

  const client = await createMCPClient({
    transport: 'stdio',
    command: process.execPath,         // Node 自身
    args: [MOCK_SERVER],
    name: 'demo',                       // 可选;影响工具名前缀 mcp__demo__<tool>
  })

  console.log('连接成功,server:', client.serverInfo)
  console.log('状态:', client.state, '(ready 表示握手完成)')

  const tools = await client.listTools()
  console.log(`\n发现 ${tools.length} 个工具:`)
  for (const t of tools) {
    console.log(`  • ${t.name}  (rawName=${t._mcp.rawName}, serverName=${t._mcp.serverName})`)
    console.log(`    描述: ${t.description}`)
  }

  // 演示 _mcp 是非可枚举的 —— 不会被序列化给 LLM
  console.log('\n_mcp 元数据非可枚举:', Object.keys(tools[0]).includes('_mcp') === false)

  // 执行一个工具 —— 这里调用 echo,mock server 会把参数 JSON 原样回显
  const echo = tools.find(t => t._mcp.rawName === 'echo')
  const result = await echo.execute({ msg: 'hello mcp' })
  console.log('\nexecute({ msg: "hello mcp" }) 返回:', result)

  await client.close()
  console.log('关闭后状态:', client.state)
}

// ==================== 示例 2: BASE_TOOLS 运行时 CRUD ====================

function example2_baseTools() {
  console.log('\n=== 示例 2: BASE_TOOLS 运行时增删改查 ===\n')

  // 从干净状态开始 —— reset 会把 registry 恢复为 6 个初始名
  resetBaseTools()
  console.log('初始 6 名:', getBaseTools().sort().join(', '))

  // 增量追加(幂等 —— 重复调用是 no-op)
  registerBaseTool('mcp__demo__echo')
  registerBaseTool('mcp__demo__echo')   // 幂等
  console.log('\n追加 mcp__demo__echo 后:', getBaseTools().length, '个')
  console.log('isBaseTool("mcp__demo__echo"):', isBaseTool('mcp__demo__echo'))

  // 批量覆盖 —— 只保留指定工具为 base(常见于"按角色重配置白名单"场景)
  setBaseTools(['ask_user', 'mcp__demo__echo', 'mcp__demo__add'])
  console.log('\n批量覆盖后:', getBaseTools().sort().join(', '))

  // 原子失败 —— setBaseTools 的输入校验先于 mutation,失败时 registry 不变
  const snapshotBefore = getBaseTools().sort()
  try {
    setBaseTools(['valid', 42, 'another-valid'])   // 第二个元素非法
  } catch (err) {
    console.log('\n预期失败:', err.message)
  }
  const snapshotAfter = getBaseTools().sort()
  console.log('注册表未被部分写入(原子性):',
    JSON.stringify(snapshotBefore) === JSON.stringify(snapshotAfter))

  // 还原为初始状态,避免污染其他示例
  resetBaseTools()
  console.log('\nresetBaseTools() 后:', getBaseTools().length, '个')
}

// ==================== 示例 3: 与 Agent 集成 ====================

async function example3_withAgent() {
  console.log('\n=== 示例 3: MCP 工具 + 本地工具混用 ===\n')

  // 1. 拉起 MCP client,取得 MCP 工具列表
  const client = await createMCPClient({
    transport: 'stdio',
    command: process.execPath,
    args: [MOCK_SERVER],
    name: 'demo',
  })
  const mcpTools = await client.listTools()

  // 2. 一个本地工具 —— 演示 MCP 与 defineTool 在 Agent 眼里完全等价
  const sayHello = defineTool({
    name: 'say_hello',
    description: '向某人问好',
    parameters: {
      type: 'object',
      properties: { who: { type: 'string' } },
      required: ['who'],
    },
    execute: async ({ who }) => `Hello, ${who}!`,
  })

  // 3. 若开启意图识别/token 预算,把 MCP 工具标记为 base 避免被误过滤。
  //    这里为了演示一次性写全,实际只有用到 ToolFilter / trimTools 时才需要。
  mcpTools.forEach(t => registerBaseTool(t.name))

  if (!process.env.OPENAI_API_KEY) {
    console.log('(未设置 OPENAI_API_KEY,跳过 Agent 构造与对话)')
    console.log('即便不构造 Agent,MCP 工具本身完全可用:')
    console.log('  mcpTools.length =', mcpTools.length)
    console.log('  形状契约:', Object.keys(mcpTools[0]).sort().join(', '))
    await client.close()
    resetBaseTools()
    return
  }

  // 4. 构造 Agent —— tools 数组里 MCP 工具与本地工具完全平权
  const agent = new Agent({
    provider: 'openai',
    apiKey: process.env.OPENAI_API_KEY,
    model: 'gpt-4',
    systemPrompt: '你是一个助手,可以使用 echo / add / say_hello 工具。',
    tools: [...mcpTools, sayHello],
  })

  console.log('agent.tools 总数:', agent.tools.length, '(', mcpTools.length, 'MCP +', 1, '本地 )')

  // 5. 跑一次真实对话
  try {
    const reply = await agent.chat('请调用 echo 工具,参数 {"msg":"来自 Agent"},然后告诉我结果')
    console.log('\nAgent 回复:', reply)
  } catch (err) {
    console.log('\nAgent 调用失败:', err.message)
  }

  // 6. 收尾 —— 关闭 MCP 子进程 + 清理 BASE_TOOLS 注册
  await client.close()
  resetBaseTools()
}

// ==================== 示例 4: 错误类型 ====================

async function example4_errors() {
  console.log('\n=== 示例 4: MCP 错误类型(instanceof 判定) ===\n')

  const {
    UnsupportedTransportError,
    MCPProtocolError,
    MCPRequestError,
    MCPClosedError,
  } = await import('../src/index.js')

  // UnsupportedTransportError —— 未知 transport 名
  try {
    await createMCPClient({ transport: 'not-a-real-transport', url: 'x' })
  } catch (err) {
    console.log('未知 transport →',
      err instanceof UnsupportedTransportError ? 'UnsupportedTransportError' : err.constructor.name)
    console.log('  message:', err.message)
  }

  // MCPClosedError —— 连接关闭后调用
  const client = await createMCPClient({
    transport: 'stdio',
    command: process.execPath,
    args: [MOCK_SERVER],
    name: 'err-demo',
  })
  await client.close()
  try {
    await client.listTools()
  } catch (err) {
    console.log('\nclosed 状态调用 →',
      err instanceof MCPClosedError ? 'MCPClosedError' : err.constructor.name)
    console.log('  message:', err.message)
  }

  console.log('\n四个错误类都可 instanceof 判定:',
    [UnsupportedTransportError, MCPProtocolError, MCPRequestError, MCPClosedError]
      .every(c => typeof c === 'function'))
}

// ==================== 运行 ====================

await example1_basics()
example2_baseTools()
await example3_withAgent()
await example4_errors()

console.log('\n完成')
