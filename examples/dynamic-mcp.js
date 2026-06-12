/**
 * 运行时动态 MCP 加载示例 — 对话进行中按需扩展/收缩 Agent 的工具集
 *
 * 这是 examples/mcp.js / examples/websearch-mcp.js 的进阶版。
 * 那两个例子是"构造前一次性把工具挂好",本例演示 runtime-dynamic-mcp-loading
 * 特性补齐的三个能力:
 *
 *   1. 动态工具管理 API —— `addTools` / `removeTool` / `getTools`,
 *      构造之后仍可增删工具,且下一轮 ReAct 立即可见。
 *   2. `load_mcp_server` 元工具 —— 构造时传 `enableDynamicMCP: true`,
 *      Agent 工具集里就多一个 `load_mcp_server`。LLM 可在对话中自主决定
 *      加载某个 MCP 服务器(也可以像示例 2 一样由代码直接驱动它的 execute)。
 *   3. 生命周期管理 —— Agent 持有运行时连接的 MCP_Client,
 *      `closeMCPClients()` / `reset()` 会统一关闭,避免子进程/连接泄漏。
 *
 * 本例加载的是仓库自带、零依赖、免 API Key 的内置搜索 MCP Server
 * (demo/mcp-servers/web-search.js,搜狗搜索 + 网页抓取),而不是测试用 mock。
 *
 * 运行:
 *   node examples/dynamic-mcp.js                       # 不需要 LLM Key,跑示例 1 + 2
 *   OPENAI_API_KEY=sk-xxx node examples/dynamic-mcp.js  # 额外跑示例 3(LLM 自主加载)
 *   DEEPSEEK_API_KEY=sk-xxx node examples/dynamic-mcp.js
 *
 * 注:示例 2/3 的 search 工具需要网络连通(搜狗);get_time 离线也能跑。
 */
import { fileURLToPath } from 'node:url'
import { Agent, defineTool, isBaseTool } from '../src/index.js'

// 仓库自带的内置搜索 MCP Server —— stdio 子进程,零依赖、免 API Key。
const WEB_SEARCH_SERVER = fileURLToPath(
  new URL('../demo/mcp-servers/web-search.js', import.meta.url)
)

// 加载内置搜索 server 用的连接参数(示例 2 代码驱动 / 示例 3 给 LLM 用)。
const WEB_SEARCH_CONNECTION = {
  serverKey: 'web-search',
  transport: 'stdio',
  command: process.execPath, // 当前 Node 可执行文件
  args: [WEB_SEARCH_SERVER],
  name: 'web', // 工具名前缀 → mcp__web__search / mcp__web__fetch_page / mcp__web__get_time
}

// ==================== 示例 1: 动态工具管理 API ====================

function example1_dynamicToolApi() {
  console.log('\n=== 示例 1: addTools / removeTool / getTools 运行时增删 ===\n')

  const agent = new Agent({
    provider: 'openai',
    apiKey: 'sk-not-needed-for-this-example',
    model: 'gpt-4',
    tools: [
      defineTool({
        name: 'ping',
        description: '返回 pong',
        parameters: { type: 'object', properties: {} },
        execute: async () => 'pong',
      }),
    ],
  })

  console.log('构造时工具:', agent.getTools().map(t => t.name).join(', '))

  // 运行时追加单个工具
  agent.addTools(defineTool({
    name: 'echo',
    description: '回显输入',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    execute: async ({ text }) => text,
  }))

  // 运行时批量追加
  agent.addTools([
    defineTool({ name: 'add', description: '加法', parameters: { type: 'object', properties: {} }, execute: async () => '' }),
    defineTool({ name: 'sub', description: '减法', parameters: { type: 'object', properties: {} }, execute: async () => '' }),
  ])
  console.log('追加 echo / add / sub 后:', agent.getTools().map(t => t.name).join(', '))

  // 同名覆盖 —— 工具数量保持唯一
  agent.addTools(defineTool({
    name: 'echo',
    description: '回显输入(v2,带前缀)',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    execute: async ({ text }) => `[v2] ${text}`,
  }))
  const echoCount = agent.getTools().filter(t => t.name === 'echo').length
  console.log('同名 addTools("echo") 后 echo 数量:', echoCount, '(保持唯一)')

  // 移除 —— 命中返回 true,未命中返回 false
  console.log('removeTool("sub"):', agent.removeTool('sub'), '(命中)')
  console.log('removeTool("nope"):', agent.removeTool('nope'), '(未命中)')
  console.log('移除后工具:', agent.getTools().map(t => t.name).join(', '))

  // getTools 是防御性快照 —— 改返回数组不影响 Agent
  const snapshot = agent.getTools()
  snapshot.push({ name: 'injected' })
  console.log('修改快照不回流:', agent.getTools().some(t => t.name === 'injected') === false)

  // 整体回滚 —— 数组含非法元素时(任一元素缺非空 name)不写入任何工具。
  // 这里用普通对象而非 defineTool,以便错误确实来自 addTools 的校验/回滚。
  const before = agent.getTools().map(t => t.name)
  try {
    agent.addTools([
      { name: 'valid_a', description: 'ok', parameters: { type: 'object', properties: {} }, execute: async () => '' },
      { description: '缺 name 的非法元素' },
    ])
  } catch (err) {
    console.log('\n含非法元素 →', err.constructor.name + ':', err.message)
  }
  const after = agent.getTools().map(t => t.name)
  console.log('整体回滚(注册表不变):', JSON.stringify(before) === JSON.stringify(after))
}

// ==================== 示例 2: load_mcp_server 元工具(代码驱动) ====================

async function example2_loadMcpMetaTool() {
  console.log('\n=== 示例 2: enableDynamicMCP + load_mcp_server 加载内置搜索 server ===\n')

  // 默认构造不注入元工具(向后兼容)
  const plain = new Agent({ provider: 'openai', apiKey: 'sk-x', model: 'gpt-4' })
  console.log('默认构造含 load_mcp_server:',
    plain.getTools().some(t => t.name === 'load_mcp_server'))

  // 启用 enableDynamicMCP 后,工具集多出 load_mcp_server
  const agent = new Agent({
    provider: 'openai',
    apiKey: 'sk-x',
    model: 'gpt-4',
    enableDynamicMCP: true,
    // 可选:覆盖默认的连接 / 关闭超时(默认 30000ms / 5000ms)
    dynamicMCPOpts: { connectTimeoutMs: 30000, closeTimeoutMs: 5000 },
  })
  const loadTool = agent.getTools().find(t => t.name === 'load_mcp_server')
  console.log('enableDynamicMCP=true 注入 load_mcp_server:', !!loadTool)

  // 这里直接由代码驱动元工具(真实场景中由 LLM 在对话里自主调用)。
  // 成功路径:建连 → listTools → addTools + registerBaseTool → 保存到 Managed_Client_Set。
  const result = await loadTool.execute(WEB_SEARCH_CONNECTION)
  console.log('\nload_mcp_server 返回:\n  ', result)

  // 新增的 MCP 工具立即出现在工具集,且被注册为 Base_Tool(不会被意图过滤剔除)
  const mcpTools = agent.getTools().filter(t => t.name.startsWith('mcp__'))
  console.log('\n加载后新增 MCP 工具:', mcpTools.map(t => t.name).join(', '))
  console.log('均已注册为 Base_Tool:', mcpTools.every(t => isBaseTool(t.name)))

  // 实际调用一个加载进来的工具 —— get_time 离线可跑
  const getTime = agent.getTools().find(t => t._mcp?.rawName === 'get_time')
  if (getTime) console.log('调用 mcp__web__get_time →', await getTime.execute({}))

  // 调用 search(需要网络;失败不影响示例流程)
  const search = agent.getTools().find(t => t._mcp?.rawName === 'search')
  if (search) {
    try {
      const raw = await search.execute({ query: 'Model Context Protocol', limit: 2 })
      const hits = JSON.parse(raw)
      console.log(`调用 mcp__web__search → 命中 ${hits.length} 条,首条: ${hits[0]?.title ?? '(无)'}`)
    } catch (err) {
      console.log('调用 mcp__web__search → (网络不可用,跳过):', err.message)
    }
  }

  // 校验失败路径 —— 返回指明参数名的错误字符串,不抛异常、不改注册表
  const bad = await loadTool.execute({ transport: 'stdio' }) // 缺 serverKey
  console.log('\n缺 serverKey →', bad)
  const badTransport = await loadTool.execute({ serverKey: 'k', transport: 'carrier-pigeon' })
  console.log('不支持的 transport →', badTransport)

  // 生命周期收尾 —— 关闭全部运行时加载的客户端,移除其工具并取消 Base_Tool 注册
  await agent.closeMCPClients()
  console.log('\ncloseMCPClients() 后剩余 MCP 工具:',
    agent.getTools().filter(t => t.name.startsWith('mcp__')).length)
}

// ==================== 示例 3: LLM 自主加载(需要 LLM API Key) ====================

async function example3_llmDriven() {
  console.log('\n=== 示例 3: LLM 在对话中自主调用 load_mcp_server ===\n')

  const apiKey = process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY
  if (!apiKey) {
    console.log('(未设置 OPENAI_API_KEY / DEEPSEEK_API_KEY,跳过 LLM 驱动的对话)')
    console.log('设置后,Agent 起步时没有任何业务工具,会在需要时自己决定调用')
    console.log('load_mcp_server 加载内置搜索 server,再用 search/fetch_page 回答问题:')
    console.log('  OPENAI_API_KEY=sk-xxx node examples/dynamic-mcp.js')
    return
  }

  const useDeepseek = !!process.env.DEEPSEEK_API_KEY && !process.env.OPENAI_API_KEY
  const agent = new Agent({
    provider: useDeepseek ? 'deepseek' : 'openai',
    apiKey,
    model: useDeepseek ? 'deepseek-chat' : 'gpt-4',
    enableDynamicMCP: true,
    // 起步时不挂任何业务工具 —— 完全靠 LLM 运行时按需加载。
    systemPrompt:
      '你是一个能联网的助手。你一开始没有搜索工具,但可以用 load_mcp_server 加载。' +
      '需要联网搜索时,用以下参数加载内置搜索服务器:' +
      `transport="stdio"、command="${process.execPath}"、` +
      `args=["${WEB_SEARCH_SERVER}"]、serverKey="web-search"、name="web"。` +
      '加载成功后会得到 mcp__web__search 与 mcp__web__fetch_page 工具,用它们搜索并回答。用中文回答。',
  })

  console.log('起步工具(仅元工具):', agent.getTools().map(t => t.name).join(', '))

  try {
    const reply = await agent.chat('MCP(Model Context Protocol)是什么?先联网搜一下再回答。')
    console.log('\nAgent 回复:\n', reply)
    console.log('\n对话结束后工具集:', agent.getTools().map(t => t.name).join(', '))
  } catch (err) {
    console.log('对话失败:', err.message)
  } finally {
    // 收尾:关闭运行时加载的 MCP 客户端,避免子进程泄漏
    await agent.closeMCPClients()
    agent.reset()
  }
}

// ==================== 运行 ====================

example1_dynamicToolApi()
await example2_loadMcpMetaTool()
await example3_llmDriven()

console.log('\n完成')
