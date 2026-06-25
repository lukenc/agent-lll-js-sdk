/**
 * websearch-mcp.js — 用 SearXNG MCP Server 做实时网络搜索 + 网页抓取
 *
 * SearXNG 是开源元搜索引擎,聚合 Bing/百度/Google/DuckDuckGo 等多引擎,
 * 本地 Docker 一键起,免 API Key,实时搜索。本例演示:
 *   - search:多引擎聚合搜索
 *   - fetch_page:抓取搜索结果里某个页面的正文
 *   - 与 Agent 集成做"搜索 → 抓取 → 总结"
 *
 * 前置条件: 先启动 SearXNG(Docker):
 *   docker run -d --name searxng-demo -p 8888:8080 \
 *     -v "$(pwd)/demo/searxng:/etc/searxng" \
 *     -e "INSTANCE_NAME=lll-demo" searxng/searxng:latest
 *   详见 demo/searxng/README.md
 *
 * 运行:
 *   node examples/websearch-mcp.js
 *   DEEPSEEK_API_KEY=sk-xxx node examples/websearch-mcp.js   # 额外跑 Agent 对话
 *
 * 环境变量:
 *   SEARXNG_URL — SearXNG 地址,默认 http://localhost:8888
 */
import { createMCPClient, registerBaseTool, formatMcpToolSummary } from '../src/index.js'

const SEARXNG_URL = process.env.SEARXNG_URL || 'http://localhost:8888'

// ==================== 预检 SearXNG 是否在线 ====================

try {
  const ping = await fetch(`${SEARXNG_URL}/search?q=ping&format=json`)
  if (!ping.ok) throw new Error(`HTTP ${ping.status}`)
} catch (err) {
  console.error(`❌ 无法连接 SearXNG (${SEARXNG_URL}): ${err.message}\n`)
  console.error('请先启动 SearXNG:')
  console.error('  docker run -d --name searxng-demo -p 8888:8080 \\')
  console.error('    -v "$(pwd)/demo/searxng:/etc/searxng" \\')
  console.error('    -e "INSTANCE_NAME=lll-demo" searxng/searxng:latest')
  console.error('\n详见 demo/searxng/README.md')
  process.exit(1)
}

// ==================== 连接 SearXNG MCP Server ====================

console.log(`正在连接 SearXNG MCP Server (后端: ${SEARXNG_URL})...\n`)

const client = await createMCPClient({
  transport: 'stdio',
  command: 'node',
  args: ['demo/mcp-servers/searxng-search.js'],
  name: 'searxng',
  env: { ...process.env, SEARXNG_URL },
  requestTimeoutMs: 60_000,
})

console.log('✅ 连接成功!')
console.log(`   server: ${client.serverInfo?.name} v${client.serverInfo?.version}`)
console.log(`   状态: ${client.state}\n`)

// ==================== 查看可用工具 ====================

const tools = await client.listTools()
console.log(`📦 可用工具(${tools.length} 个):`)
for (const t of tools) {
  console.log(`   • ${formatMcpToolSummary(t)}`)
  console.log(`     ${t.description}`)
}
console.log()

// ==================== 示例 1: 搜索 ====================

console.log('=== 示例 1: 多引擎搜索 ===\n')

const searchTool = tools.find(t => t._mcp.rawName === 'search')
const searchResult = await searchTool.execute({
  query: 'Model Context Protocol MCP',
  limit: 3,
})

const parsed = JSON.parse(searchResult)
console.log(`搜索 "Model Context Protocol MCP",找到 ${parsed.totalResults ?? 0} 条结果:\n`)
let firstUrl = null
for (const r of (parsed.results || [])) {
  console.log(`  📄 ${r.title}  [${r.engine}]`)
  console.log(`     ${r.url}`)
  console.log(`     ${(r.description || '').slice(0, 80)}`)
  console.log()
  if (!firstUrl) firstUrl = r.url
}

// ==================== 示例 2: 抓取网页内容 ====================

console.log('=== 示例 2: 抓取搜索结果的第一个页面 ===\n')

const fetchTool = tools.find(t => t._mcp.rawName === 'fetch_page')
if (fetchTool && firstUrl) {
  const pageResult = await fetchTool.execute({ url: firstUrl, maxChars: 400 })
  console.log(`抓取 ${firstUrl} (前 400 字符):`)
  console.log(`  ${pageResult.slice(0, 400)}`)
  console.log()
} else {
  console.log('(无可抓取的 URL,跳过)')
}

// ==================== 示例 3: 与 Agent 集成 ====================

console.log('=== 示例 3: 与 Agent 集成(需要 LLM API Key) ===\n')

if (process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY) {
  const { Agent } = await import('../src/index.js')

  // 把 MCP 工具标记为 base tool(开启意图识别时不会被过滤掉)
  tools.forEach(t => registerBaseTool(t.name))

  const agent = new Agent({
    provider: process.env.DEEPSEEK_API_KEY ? 'deepseek' : 'openai',
    apiKey: process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY,
    model: process.env.DEEPSEEK_API_KEY ? 'deepseek-chat' : 'gpt-4',
    tools: tools,
    systemPrompt:
      '你是一个能联网的助手。回答前先用 search 搜索,必要时用 fetch_page 抓取页面正文,再综合回答。' +
      'MCP 工具摘要: ' + tools.map(formatMcpToolSummary).join('；') +
      '。请结合工具 outputSchema 组织最终答案。用中文回答。',
  })

  console.log('Agent 已创建,正在对话...\n')
  const reply = await agent.chat('MCP 协议是什么?它解决了什么问题?')
  console.log('Agent 回复:')
  console.log(reply)
  console.log()
} else {
  console.log('未设置 OPENAI_API_KEY 或 DEEPSEEK_API_KEY,跳过 Agent 对话。')
  console.log('设置后可体验完整的"搜索 + 抓取 + LLM 总结"流程:')
  console.log('  DEEPSEEK_API_KEY=sk-xxx node examples/websearch-mcp.js')
  console.log()
}

// ==================== 收尾 ====================

await client.close()
console.log('已关闭 MCP 连接。')
