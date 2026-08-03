/**
 * Demo 代理服务器 — 转发浏览器请求到 LLM API
 * 运行：OPENAI_API_KEY=sk-xxx node demo/server.js
 * 然后打开 http://localhost:3000
 *
 * 本 demo 演示了 Agent 的遥测 (telemetry) 能力：
 *   - 订阅 `llm.call` / `tool.call` / `round.*` / `session.*` 事件
 *   - 通过 SSE 把事件转发到浏览器，以便前端展示
 *   - 调用 `agent.getLastRunMetrics()` / `agent.getSessionMetrics()`
 *     获取聚合指标
 *
 * 可选：MCP Server 集成
 *   MCP_SERVER_CMD 与 MCP_SERVER_ARGS 环境变量可挂载一个 stdio MCP Server
 *   的工具到 agent.tools 上。工具名自动前缀化为 mcp__<MCP_SERVER_NAME>__<tool>,
 *   并通过 registerBaseTool 标记为 base tool,避免被 ToolFilter / trimTools 误裁剪。
 *
 *   示例:
 *     # 挂载仓库自带的 stdio mock MCP server(无需额外安装)
 *     MCP_SERVER_CMD="node" MCP_SERVER_ARGS="src/mcp/__fixtures__/mock-mcp-server.js" \
 *     MCP_SERVER_NAME="mock" \
 *     OPENAI_API_KEY=sk-xxx node demo/server.js
 *
 *     # 挂载社区 MCP server (filesystem)
 *     MCP_SERVER_CMD="npx" MCP_SERVER_ARGS="-y @modelcontextprotocol/server-filesystem /tmp" \
 *     OPENAI_API_KEY=sk-xxx node demo/server.js
 *
 * 可选：运行时动态 MCP 加载 (load_mcp_server 元工具)
 *   设 DYNAMIC_MCP=1 启用后,服务端 Agent 工具集会多一个 `load_mcp_server` 元工具,
 *   LLM 可在对话过程中自主决定加载某个 MCP 服务器(无需预先在面板/环境变量里挂好)。
 *   运行时加载的客户端由 Agent 持有,reset()/关机时统一关闭。
 *
 *   示例:
 *     DYNAMIC_MCP=1 OPENAI_API_KEY=sk-xxx node demo/server.js
 *     # 然后在对话里说:"联网搜一下 MCP 是什么" —— LLM 会自己调用 load_mcp_server
 *     # 加载内置搜索服务器(demo/mcp-servers/web-search.js),再用 search 回答
 *
 * 可选：Subagent 系统(默认开启,SUBAGENTS=0 关闭)
 *   服务端 Agent 会带上 12 个元工具(agent / agent_graph / graph_start / artifact_write ...)
 *   以及两个演示用的 Agent_Type(explorer / interviewer)。相关接口:
 *     GET  /agents     —— 当前所有 subagent、图节点、产物的快照(前端面板轮询它)
 *     GET  /questions  —— subagent 通过 ask_user 提出、等待用户回答的问题
 *     POST /answer     —— { askId, answer } 定向回答某一个提问
 *   提问走的是**命令式通道**(pendingQuestions / answerQuestion),而不是 onAskUser hook ——
 *   HTTP 服务端不需要在某个请求上下文里 await 一个可能几分钟才有的回答。
 */
import { createServer } from 'http'
import { readFile } from 'fs/promises'
import {
  Agent,
  defineTool,
  createMCPClient,
  registerBaseTool,
  unregisterBaseTool,
  formatMcpToolSummary,
  serializeMcpToolForBrowser,
  listAgentTypes,
  SUBAGENT_TOOL_NAMES,
} from '../src/index.js'

const PORT = parseInt(process.env.PORT, 10) || 3000
const API_KEY = process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY
const PROVIDER = process.env.PROVIDER || (process.env.DEEPSEEK_API_KEY ? 'deepseek' : 'openai')
const MODEL = process.env.MODEL || (PROVIDER === 'deepseek' ? 'deepseek-chat' : 'gpt-4')
// 自定义 API 端点(OpenAI 兼容的代理/聚合服务);不设则用 provider 注册表里的默认地址。
const LLM_URL = process.env.LLM_URL || undefined

// MCP 集成 —— 可选。未设置 MCP_SERVER_CMD 时完全跳过,向后兼容。
const MCP_SERVER_CMD = process.env.MCP_SERVER_CMD
const MCP_SERVER_ARGS = process.env.MCP_SERVER_ARGS
  ? process.env.MCP_SERVER_ARGS.split(/\s+/).filter(Boolean)
  : []
const MCP_SERVER_NAME = process.env.MCP_SERVER_NAME || 'demo'

// MCP_SERVER_ENV —— JSON 对象格式,比如 '{"MODE":"stdio","DEFAULT_SEARCH_ENGINE":"duckduckgo"}'。
// 单独传给 MCP server 子进程,避免和 demo server 本身的环境变量(PORT/OPENAI_API_KEY)混淆。
// 默认会继承父进程环境,但显式 MCP_SERVER_ENV 会 merge 进来覆盖。
function parseMcpServerEnv(extraEnv) {
  const source = extraEnv ?? process.env.MCP_SERVER_ENV
  if (!source) return undefined
  try {
    const extra = typeof source === 'string' ? JSON.parse(source) : source
    return { ...process.env, ...extra }
  } catch (err) {
    console.warn(`[mcp] MCP_SERVER_ENV 解析失败(需为 JSON 对象): ${err.message}`)
    return undefined
  }
}

/**
 * 浏览器配置面板用的预设清单 —— 一键挂常用 MCP server。
 * 命令通过环境变量启动后端 npx,不在浏览器里跑。
 */
const MCP_PRESETS = [
  {
    id: 'searxng',
    label: '🌐 SearXNG 搜索 (本地 Docker / 多引擎实时聚合,推荐)',
    command: 'node',
    args: ['demo/mcp-servers/searxng-search.js'],
    name: 'searxng',
    env: { SEARXNG_URL: 'http://localhost:8888' },
    description: '对接本地 SearXNG 实例(Docker 起),聚合 Google/Bing/百度 等多引擎实时结果,质量最好。需先启动 SearXNG: npm run searxng (或见 demo/searxng/README.md)',
  },
  {
    id: 'builtin-search',
    label: '⭐ 内置搜索 (搜狗爬取,零依赖,无需 Docker)',
    command: 'node',
    args: ['demo/mcp-servers/web-search.js'],
    name: 'web',
    env: {},
    description: '仓库自带的搜索 MCP server — 搜狗搜索 + fetch 抓网页,秒启,国内直连,不需要 Docker/npx/Playwright',
  },
  {
    id: 'open-websearch',
    label: '🔍 open-websearch (多引擎,需 npx 下载,可能需 Playwright)',
    command: 'npx',
    args: ['-y', 'open-websearch@latest'],
    name: 'search',
    env: { MODE: 'stdio', DEFAULT_SEARCH_ENGINE: 'baidu', SEARCH_MODE: 'request' },
    description: '基于 Bing/DuckDuckGo/Baidu 的免费搜索 + 多平台抓取(Bing 可能需要 Playwright)',
  },
  {
    id: 'sequential-thinking',
    label: '🧠 sequential-thinking (Anthropic 官方 / 思维链工具)',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking@latest'],
    name: 'thinking',
    env: {},
    description: 'Anthropic 官方维护的 reflection / chain-of-thought 工具',
  },
  {
    id: 'fetch',
    label: '🌐 fetch-mcp (拉网页内容,无 API Key)',
    command: 'npx',
    args: ['-y', 'mcp-server-fetch-typescript@latest'],
    name: 'fetch',
    env: {},
    description: '通用 HTTP 抓取,可配合搜索做检索增强',
  },
  {
    id: 'mock',
    label: '🧪 mock (本仓库自带的 echo / add 测试 server)',
    command: 'node',
    args: ['src/mcp/__fixtures__/mock-mcp-server.js'],
    name: 'mock',
    env: {},
    description: '本仓库自带的 mock,用于快速验证 MCP 路径',
  },
]

if (!API_KEY) {
  console.warn('提示: 未设置 OPENAI_API_KEY 或 DEEPSEEK_API_KEY。')
  console.warn('  • /browser 模式(浏览器端 Agent)不受影响 — LLM key 在浏览器页面里填')
  console.warn('  • / 模式(服务端 Agent)的 /chat 接口将无法使用')
  console.warn('  设置方式: OPENAI_API_KEY=sk-xxx node demo/server.js')
}

const getCurrentTime = defineTool({
  name: 'get_current_time',
  description: '获取当前时间',
  parameters: { type: 'object', properties: {} },
  execute: async () => new Date().toLocaleString('zh-CN'),
})

const calculate = defineTool({
  name: 'calculate',
  description: '计算数学表达式',
  parameters: {
    type: 'object',
    properties: { expression: { type: 'string', description: '数学表达式' } },
    required: ['expression'],
  },
  execute: async ({ expression }) => String(Function(`"use strict"; return (${expression})`)()),
})

// ==================== Subagent 演示素材 ====================
//
// 一份假的"项目笔记"。subagent 光有元工具是演示不出东西的 —— 它得有点真东西可读、
// 可汇报、可登记成产物,面板上那几行状态才有意义。
const NOTES = {
  'error-handling': '# 错误处理约定（ERR-CONV-01）\n'
    + '- 对外 API 一律返回软失败字符串,不 throw；throw 只留给编程错误。\n'
    + '- 错误类构造函数只接受白名单标量字段,避免 apiKey 泄进 err.message。\n'
    + '- 传输层错误重试,语义层错误不重试。',
  modules: '# 模块清单（MOD-01）\n'
    + 'agent.js / context-manager.js / memory.js / tool-filter.js / mcp / skills / agents',
  changelog: '# 变更记录（CHG-01）\n- 0.5.0 引入 MCP 客户端\n- 0.5.1 引入 Skill 系统\n- 0.6.0 引入 Subagent 系统',
}

const readNote = defineTool({
  name: 'read_note',
  description: `读取项目笔记。可用的 name: ${Object.keys(NOTES).join(', ')}`,
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: '笔记名' } },
    required: ['name'],
  },
  execute: async ({ name }) => NOTES[name] ?? `no note named "${name}"`,
})

/**
 * 演示用的 Agent_Type。`tools` 只列任务工具就够 —— artifact_write / artifact_list /
 * history_search / history_get / send_message / ask_user 是框架保证带上的基础设施 floor。
 */
const SUBAGENT_TYPES = [
  {
    name: 'explorer',
    description: '只读检索：读项目笔记、汇报事实,不做任何修改。',
    systemPrompt: '你是一个只读检索子 agent。用 read_note 找事实,'
      + '用 artifact_write 把结论登记到产物轨,最后一条消息就是你交回去的报告 —— 先给结论,再给证据。',
    model: 'fast',
    tools: ['read_note'],
    maxRounds: 8,
  },
  {
    name: 'interviewer',
    description: '需要用户拍板时,替编排者去问一个具体问题。',
    systemPrompt: '你负责替编排者向用户问一个具体问题：'
      + '用 ask_user 提问,拿到回答后把回答原样带回去,不要自行猜测。',
    model: 'fast',
    tools: [],
    maxRounds: 6,
  },
]

// 默认开启。关掉的方式是 SUBAGENTS=0 —— 关掉后 Agent 不注入那 12 个元工具,
// 也不发任何 subagent 事件,行为与引入 subagent 之前一致。
const ENABLE_SUBAGENTS = process.env.SUBAGENTS !== '0' && process.env.SUBAGENTS !== 'false'

// ==================== MCP 工具加载(可选,支持多个并存) ====================

/**
 * 多 MCP server 并存管理。
 * key = server name, value = { client, tools, spec }
 * @type {Map<string, { client: object, tools: object[], spec: object }>}
 */
const mcpConnections = new Map()

/** 所有已挂载 MCP server 的工具合并列表(缓存,挂载/卸载时刷新) */
function getAllMcpTools() {
  const all = []
  for (const { tools } of mcpConnections.values()) {
    all.push(...tools)
  }
  return all
}

function getMcpToolSummaries(tools = getAllMcpTools()) {
  return tools.map((t) => formatMcpToolSummary(t))
}

function getMcpPromptNote() {
  const summaries = getMcpToolSummaries()
  if (summaries.length === 0) return ''
  return '。当前已挂载 MCP 工具摘要: ' + summaries.join('；')
}

/**
 * Agent 构造时注入、但不在本文件 `tools` 数组里的元工具。`refreshAgentTools` 必须
 * 原样保留它们 —— 面板上挂载/卸载一次 MCP server 就把 subagent 的 12 个元工具和
 * ask_user 冲掉,是最难发现的那种回归:system 消息里的 agent type 清单还在,模型照着
 * 它去调 `agent`,却被告知没有这个工具。
 */
const META_TOOL_NAMES = new Set([...SUBAGENT_TOOL_NAMES, 'ask_user', 'skill'])

/** 重建 agent 的 tools(不重建 agent 本身,保留对话历史) */
function refreshAgentTools() {
  if (!agent) return
  // 保留运行时动态加载相关的工具,避免被面板挂载/卸载操作覆盖丢失:
  //   - load_mcp_server 元工具(enableDynamicMCP 启用时注入)
  //   - LLM 通过 load_mcp_server 运行时加载、由 agent._managedClients 持有的工具
  //   - 构造时注入的元工具(ask_user / subagent 的 12 个)
  const dynamicNames = new Set()
  for (const entry of agent._managedClients?.values?.() ?? []) {
    for (const n of entry.toolNames) dynamicNames.add(n)
  }
  const preserved = agent.tools.filter(
    (t) => t.name === 'load_mcp_server' || dynamicNames.has(t.name) || META_TOOL_NAMES.has(t.name)
  )
  agent.tools = [getCurrentTime, calculate, readNote, ...getAllMcpTools(), ...preserved]
}

/**
 * 挂载一个 MCP server(追加,不影响已有连接)。
 * 同名 server 会先卸载再重连。
 */
async function connectMcp(spec) {
  const { command, args, name, env } = spec
  if (!command || !name) throw new Error('command 与 name 必填')

  // 同名先卸载
  if (mcpConnections.has(name)) {
    await disconnectMcp(name)
  }

  console.log(`[mcp] 正在连接 MCP Server "${name}": ${command} ${(args ?? []).join(' ')}`)

  const client = await createMCPClient({
    transport: 'stdio',
    command,
    args: args ?? [],
    env: parseMcpServerEnv(env),
    name,
    requestTimeoutMs: 120_000,
    onStderr: (chunk) => process.stderr.write(`[mcp:${name}] ${chunk}`),
    onClose: (reason) => {
      console.warn(`[mcp] ${name} 连接已关闭:`, reason)
      if (mcpConnections.has(name)) {
        const entry = mcpConnections.get(name)
        entry.tools.forEach((t) => unregisterBaseTool(t.name))
        mcpConnections.delete(name)
        refreshAgentTools()
      }
    },
  })
  const tools = await client.listTools()
  tools.forEach((t) => registerBaseTool(t.name))

  mcpConnections.set(name, { client, tools, spec })
  refreshAgentTools()

  console.log(`[mcp] 已挂载 "${name}" (${tools.length} 个工具):\n` +
    getMcpToolSummaries(tools).map((s) => `  - ${s}`).join('\n'))
  return tools
}

/** 卸载指定 name 的 MCP server。不传 name 则卸载全部。 */
async function disconnectMcp(name) {
  if (name) {
    const entry = mcpConnections.get(name)
    if (!entry) return
    entry.tools.forEach((t) => unregisterBaseTool(t.name))
    mcpConnections.delete(name)
    try { await entry.client.close() } catch (err) {
      console.warn(`[mcp] close "${name}" 失败:`, err.message)
    }
  } else {
    // 卸载全部
    for (const [n, entry] of mcpConnections) {
      entry.tools.forEach((t) => unregisterBaseTool(t.name))
      try { await entry.client.close() } catch { /* ignore */ }
    }
    mcpConnections.clear()
  }
  refreshAgentTools()
}

/** 启动时根据环境变量连接预设 MCP server(向后兼容)。 */
async function loadMcpFromEnv() {
  if (!MCP_SERVER_CMD) return
  try {
    await connectMcp({
      command: MCP_SERVER_CMD,
      args: MCP_SERVER_ARGS,
      name: MCP_SERVER_NAME,
      env: process.env.MCP_SERVER_ENV ? JSON.parse(process.env.MCP_SERVER_ENV) : undefined,
    })
  } catch (err) {
    console.warn(`[mcp] 启动时挂载失败: ${err.message}`)
    console.warn('[mcp] Agent 将继续启动,但不会带 MCP 工具。可以从浏览器面板再连。')
  }
}

let currentStrategy = 'react'

// 运行时动态 MCP 加载 —— 设 DYNAMIC_MCP=1 启用 load_mcp_server 元工具,
// 让 LLM 在对话中自主决定加载 MCP 服务器(runtime-dynamic-mcp-loading 特性)。
// 默认关闭,保持与既有 demo 行为一致。
const ENABLE_DYNAMIC_MCP = process.env.DYNAMIC_MCP === '1' || process.env.DYNAMIC_MCP === 'true'

function createAgent(strategy) {
  currentStrategy = strategy || 'react'
  if (!API_KEY) return null  // browser 模式不需要服务端 agent
  return new Agent({
    provider: PROVIDER,
    url: LLM_URL,
    apiKey: API_KEY,
    model: MODEL,
    // fast 别名的来源:subagent 的 `model: 'fast'` 解析到 simpleModel/simpleApiKey/simpleUrl 这三件套。
    simpleModel: process.env.SIMPLE_MODEL || undefined,
    systemPrompt: '你是一个有用的助手,可以查询时间、做数学计算、读项目笔记,并可使用当前已挂载的 MCP 工具'
      + '。注意:可用工具会在对话中动态变化(可能被挂载或卸载),请始终以本轮实际提供给你的工具列表为准,不要凭历史记录假设某个工具仍然存在'
      + getMcpPromptNote()
      + (ENABLE_DYNAMIC_MCP
        ? '。你还可以用 load_mcp_server 工具在对话中按需加载新的 MCP 服务器'
          + `(例如 transport="stdio"、command="node"、args=["demo/mcp-servers/web-search.js"]、serverKey="web"、name="web" 可加载内置搜索服务器,得到 mcp__web__search / mcp__web__fetch_page)`
        : '')
      + (ENABLE_SUBAGENTS
        ? '。成块的、边界清晰的活可以用 `agent` 工具派给 subagent 去做;多件事之间有依赖时用 `agent_graph` 声明依赖图'
        : '')
      + '。请用中文回答。',
    tools: [getCurrentTime, calculate, readNote, ...getAllMcpTools()],
    strategy: currentStrategy,
    // 启用后,Agent 工具集会多一个 load_mcp_server 元工具,LLM 可自主加载 MCP 服务器;
    // 连接/关闭超时沿用默认 30s/5s。运行时加载的客户端由 Agent 持有,reset()/
    // closeMCPClients() 时统一关闭。未启用时行为不变(向后兼容)。
    enableDynamicMCP: ENABLE_DYNAMIC_MCP,
    // Subagent 系统。未配置时 agent.subagents 恒为 null,不注入任何元工具。
    // 提问不接 hooks.onAskUser —— HTTP 服务端用 pendingQuestions()/answerQuestion()
    // 这条命令式通道更顺手,不需要在某个请求上下文里 await 一个几分钟后才有的回答。
    ...(ENABLE_SUBAGENTS
      ? {
        subagents: {
          types: SUBAGENT_TYPES,
          maxConcurrent: 2,
          maxDepth: 2,
          artifacts: { policy: 'warn' },
          keepAlive: true,
          // demo 场景等 10 分钟没意义,超时后模型会拿到一条"收尾或 agent_cancel"的提示。
          keepAliveTimeoutMs: 60_000,
          ask: { timeoutMs: 180_000 },
        },
      }
      : {}),
    // Demo 场景下 8 轮已经够覆盖 ask_user + tool_call + synth 的典型组合；
    // 默认值 300 太大，真跑起来会让用户以为卡住。subagent 开启后一轮对话里可能要
    // 「派活 → 等 → 收结果 → 起下一个节点 → 收尾」,8 轮不够用。
    maxRounds: ENABLE_SUBAGENTS ? 16 : 8,
  })
}

let agent = createAgent('react')

async function buildContextSnapshot(agent) {
  if (!agent) {
    return {
      tracks: { all: [], visible: [], model: [], artifacts: [] },
      counts: { all: 0, visible: 0, model: 0, artifacts: 0 },
    }
  }
  const all = await agent.getHistory('all')
  const visible = await agent.getHistory('visible')
  const model = await agent.getHistory('model')
  const artifacts = await agent.getArtifacts()
  return {
    tracks: { all, visible, model, artifacts },
    counts: {
      all: all.length,
      visible: visible.length,
      model: model.length,
      artifacts: artifacts.length,
    },
  }
}

/**
 * 订阅 agent 的遥测事件，把每一条事件通过 res (SSE) 转发给浏览器。
 * 注册于 chat() 前，在 session.end 后自动解绑，避免跨请求泄漏。
 * 返回解绑函数。
 */
function pipeTelemetry(agent, res) {
  const types = [
    'session.start', 'session.end', 'round.start', 'round.end', 'llm.call', 'tool.call',
    // subagent 系统的事件。列在这里而不是订阅 '*' —— 事件流面板是给人看的,
    // 图的每一次 tick 都推过去会把真正重要的几条淹掉。
    'agent.spawn', 'agent.state', 'agent.succeeded', 'agent.failed', 'agent.cancelled',
    'graph.declared', 'graph.node.ready', 'graph.node.started', 'graph.node.settled', 'graph.closed',
    'artifact.write', 'artifact.conflict',
    'ask.user', 'ask.answered', 'ask.cancelled',
    'run.keep_alive.timeout',
  ]
  const listeners = []
  for (const t of types) {
    const fn = (payload) => {
      // 包装一层 `type: 'telemetry'`，避免和已有 stream 事件（delta / tool_start 等）
      // 的 type 空间冲突；前端通过 `event.type === 'telemetry'` 识别。
      try {
        res.write(`data: ${JSON.stringify({ type: 'telemetry', name: t, payload })}\n\n`)
      } catch (_) { /* connection closed */ }
    }
    agent.on(t, fn)
    listeners.push([t, fn])
  }
  return () => { for (const [t, fn] of listeners) agent.off(t, fn) }
}

/**
 * subagent 面板要的一切:agent 列表、每张图的节点、产物轨、待回答的提问。
 * 前端在一次对话进行中轮询它 —— 后台 agent 的进展不走 SSE 的 delta 通道,
 * 只靠事件流的话面板上看不到"现在有几个在跑"。
 */
async function buildSubagentSnapshot(agent) {
  if (!agent?.subagents) {
    return { enabled: false, types: [], agents: [], graphs: [], artifacts: [], questions: [] }
  }
  const rt = agent.subagents
  const graphs = [...rt.graphs.values()].map((entry) => ({
    graphId: entry.graphId,
    label: entry.label ?? null,
    state: entry.state,
    active: entry.graphId === rt.activeGraphId,
    nodes: [...entry.graph.nodes.keys()].map((id) => {
      const n = entry.graph.get(id)
      return {
        nodeId: n.nodeId,
        description: n.description,
        state: n.state,
        dependsOn: n.dependsOn ?? [],
        agentId: n.agentId ?? null,
        blockedReason: n.blockedReason ?? null,
      }
    }),
  }))
  return {
    enabled: true,
    types: listAgentTypes().map(t => ({ name: t.name, description: t.description })),
    // toStatus() 是一份不含函数、不含 apiKey 的快照 —— 直接下发给浏览器是安全的。
    agents: rt.registry.list({ includeFinished: true }).map(h => h.toStatus()),
    graphs,
    artifacts: await agent.getArtifacts(),
    questions: agent.pendingQuestions(),
  }
}

const server = createServer(async (req, res) => {
  // 静态页面
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const html = await readFile(new URL('./index.html', import.meta.url), 'utf-8')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
    return
  }

  // 浏览器端 Demo(browser.html) —— 直接在浏览器里跑 Agent,通过 /mcp-call
  // 代理使用服务端挂载的 MCP 工具。API key 留在前端配置栏(浏览器 demo
  // 的已知权衡)。
  if (req.method === 'GET' && req.url === '/browser') {
    const html = await readFile(new URL('./browser.html', import.meta.url), 'utf-8')
    // 替换 bundle 的相对路径,让它在 server 路由下也能加载
    const patched = html.replace('../dist/lll-web-agent.js', '/bundle.js')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(patched)
    return
  }

  // 浏览器端 Demo 用的 IIFE bundle
  if (req.method === 'GET' && req.url === '/bundle.js') {
    try {
      const js = await readFile(new URL('../dist/lll-web-agent.js', import.meta.url))
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' })
      res.end(js)
    } catch (_err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('bundle 未构建。请先运行 `npm run build` 生成 dist/lll-web-agent.js')
    }
    return
  }

  // SSE 聊天接口
  if (req.method === 'POST' && req.url === '/chat') {
    let body = ''
    for await (const chunk of req) body += chunk
    const { message } = JSON.parse(body)

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })

    // 订阅遥测事件并转发到 SSE。`unsubscribe` 在 finally 中调用以避免跨请求泄漏。
    const unsubscribe = pipeTelemetry(agent, res)

    try {
      for await (const event of agent.stream(message)) {
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      }
      // 把本次运行的聚合指标一起下发，前端可以直接渲染。
      const lastRun = agent.getLastRunMetrics()
      const session = agent.getSessionMetrics()
      res.write(`data: ${JSON.stringify({ type: 'metrics', lastRun, session })}\n\n`)
      const context = await buildContextSnapshot(agent)
      res.write(`data: ${JSON.stringify({ type: 'context', context })}\n\n`)
      // 一轮结束时再补一份 subagent 快照 —— 后台 agent 可能在这一轮里刚 settle,
      // 面板不该停在最后一次轮询看到的中间态。
      const subagents = await buildSubagentSnapshot(agent)
      res.write(`data: ${JSON.stringify({ type: 'subagents', subagents })}\n\n`)
    } catch (err) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`)
    } finally {
      unsubscribe()
    }
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }

  // 当前会话的 RuntimeHistory 轨道快照。
  if (req.method === 'GET' && req.url === '/context') {
    const context = await buildContextSnapshot(agent)
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify(context))
    return
  }

  // ==================== Subagent 面板 ====================

  // 全量快照:agent / 图节点 / 产物 / 待答提问。前端在对话进行中轮询。
  if (req.method === 'GET' && req.url === '/agents') {
    const snapshot = await buildSubagentSnapshot(agent)
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify(snapshot))
    return
  }

  // 只要待答提问 —— 轮询频率比全量快照高,单独开一个省带宽。
  if (req.method === 'GET' && req.url === '/questions') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({ questions: agent?.pendingQuestions?.() ?? [] }))
    return
  }

  // 定向回答某一个提问。`askId` 是必须的:多个 agent 可能同时在问,
  // 按 askId 路由才能保证答案回到问它的那一个,也才允许乱序回答。
  if (req.method === 'POST' && req.url === '/answer') {
    let body = ''
    for await (const chunk of req) body += chunk
    res.setHeader('Access-Control-Allow-Origin', '*')
    try {
      const { askId, answer, cancel, reason } = JSON.parse(body || '{}')
      if (!askId) throw new Error('askId 必填')
      const ok = cancel
        ? agent.cancelQuestion(askId, reason ?? '用户放弃回答')
        : agent.answerQuestion(askId, String(answer ?? ''))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      // ok=false 不是错误:两条应答通道是竞速的,后到的那条静默 no-op。
      res.end(JSON.stringify({ ok, note: ok ? undefined : '该提问已被回答或已失效' }))
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: err?.message ?? String(err) }))
    }
    return
  }

  // 重置会话
  if (req.method === 'POST' && req.url === '/reset') {
    agent.reset()
    // 重建 Agent,而不是只 reset()。`reset()` 会取消在跑的 subagent,但 AgentRegistry
    // 按 `retainCompleted` 保留已完成的 handle(这是设计:`send_message` 还能唤醒它们),
    // 所以只 reset 的话"新会话"面板里会挂着上一轮那批 agent。对一个叫"新会话"的按钮来说
    // 那是假象。
    agent = createAgent(currentStrategy)
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end('{"ok":true}')
    return
  }

  // 切换执行策略
  if (req.method === 'POST' && req.url === '/strategy') {
    let body = ''
    for await (const chunk of req) body += chunk
    const { strategy } = JSON.parse(body)
    agent = createAgent(strategy)
    console.log(`策略切换为: ${strategy}`)
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({ ok: true, strategy: currentStrategy }))
    return
  }

  // 获取当前策略
  if (req.method === 'GET' && req.url === '/strategy') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({ strategy: currentStrategy }))
    return
  }

  // 当前挂载的 MCP 工具状态(供前端徽章展示)
  if (req.method === 'GET' && req.url === '/mcp-status') {
    const connections = []
    for (const [name, entry] of mcpConnections) {
      const serializedTools = entry.tools.map((t) => serializeMcpToolForBrowser(t))
      connections.push({
        name,
        toolCount: entry.tools.length,
        toolNames: serializedTools.map((t) => t.name),
        toolSummaries: entry.tools.map((t) => formatMcpToolSummary(t)),
        tools: serializedTools.map((t) => ({
          name: t.name,
          title: t.title,
          rawName: t.rawName,
          serverName: t.serverName,
          taskSupport: t.execution?.taskSupport,
          outputSchema: t.outputSchema,
        })),
        command: entry.spec.command,
      })
    }
    const allTools = getAllMcpTools()
    const allSerializedTools = allTools.map((t) => serializeMcpToolForBrowser(t))
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({
      connected: mcpConnections.size > 0,
      connections,
      toolCount: allTools.length,
      toolNames: allSerializedTools.map((t) => t.name),
      toolSummaries: allTools.map((t) => formatMcpToolSummary(t)),
      serverName: connections.length === 1 ? connections[0].name : undefined,
      presets: MCP_PRESETS,
    }))
    return
  }

  // 浏览器面板:挂载一个 MCP server(追加,不影响已有)
  if (req.method === 'POST' && req.url === '/mcp-connect') {
    let body = ''
    for await (const chunk of req) body += chunk
    res.setHeader('Access-Control-Allow-Origin', '*')
    try {
      const parsed = JSON.parse(body || '{}')
      let spec
      if (parsed.preset) {
        const p = MCP_PRESETS.find((x) => x.id === parsed.preset)
        if (!p) throw new Error(`未知预设: ${parsed.preset}`)
        spec = { command: p.command, args: p.args, name: p.name, env: p.env }
      } else {
        spec = parsed
      }
      const tools = await connectMcp(spec)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        ok: true,
        serverName: spec.name,
        toolCount: tools.length,
        toolNames: tools.map((t) => t.name),
        toolSummaries: tools.map((t) => formatMcpToolSummary(t)),
        tools: tools.map((t) => serializeMcpToolForBrowser(t)),
        totalConnections: mcpConnections.size,
      }))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: err?.message ?? String(err) }))
    }
    return
  }

  // 浏览器面板:卸载 MCP server。body: { name? } 不传则卸载全部
  if (req.method === 'POST' && req.url === '/mcp-disconnect') {
    let body = ''
    for await (const chunk of req) body += chunk
    res.setHeader('Access-Control-Allow-Origin', '*')
    try {
      const parsed = JSON.parse(body || '{}')
      await disconnectMcp(parsed.name || undefined)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, remaining: mcpConnections.size }))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: err?.message ?? String(err) }))
    }
    return
  }

  // 浏览器端 MCP 工具代理 —— 返回所有已挂载 server 的工具清单。
  if (req.method === 'GET' && req.url === '/mcp-tools') {
    const allTools = getAllMcpTools()
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({
      tools: allTools.map((t) => serializeMcpToolForBrowser(t)),
    }))
    return
  }

  // 浏览器端 MCP 工具代理 —— 转发 execute 调用。
  if (req.method === 'POST' && req.url === '/mcp-call') {
    let body = ''
    for await (const chunk of req) body += chunk
    res.setHeader('Access-Control-Allow-Origin', '*')
    try {
      const { name, arguments: args } = JSON.parse(body)
      const allTools = getAllMcpTools()
      const tool = allTools.find((t) => t.name === name)
      if (!tool) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `MCP tool not found: ${name}` }))
        return
      }
      const result = await tool.execute(args ?? {})
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ result }))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err?.message ?? String(err) }))
    }
    return
  }

  // 当前会话的累计指标（Session_Metrics）
  if (req.method === 'GET' && req.url === '/metrics') {
    const session = agent.getSessionMetrics()
    const lastRun = agent.getLastRunMetrics()
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({ lastRun, session }))
    return
  }

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    })
    res.end()
    return
  }

  res.writeHead(404)
  res.end('Not Found')
})

// 先加载 MCP 工具(如果配置了),再启动 HTTP 服务。这样 agent 构造时就能
// 拿到正确的 tools 数组;未配置 MCP_SERVER_CMD 时 loadMcpFromEnv 直接 return,
// 对向后兼容无影响。connectMcp 内部已重建 agent。
await loadMcpFromEnv()

// 启动 HTTP server —— 端口被占时自动 +1 重试(最多试 10 次)
function startServer(port, retries = 10) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && retries > 0) {
      console.warn(`端口 ${port} 已被占用,尝试 ${port + 1}...`)
      startServer(port + 1, retries - 1)
    } else {
      console.error(`无法启动 server: ${err.message}`)
      process.exit(1)
    }
  })
  server.listen(port, () => {
    const actualPort = server.address().port
    console.log(`Demo 运行中: http://localhost:${actualPort}`)
    console.log(`  • 服务端 Agent: http://localhost:${actualPort}/`)
    console.log(`  • 浏览器端 Agent: http://localhost:${actualPort}/browser`)
    if (PROVIDER && API_KEY) console.log(`供应商: ${PROVIDER}, 模型: ${MODEL}`)
    console.log(`默认策略: ${currentStrategy}`)
    if (mcpConnections.size > 0) {
      const names = [...mcpConnections.keys()].join(', ')
      console.log(`MCP: 已挂载 ${getAllMcpTools().length} 个工具 (servers: ${names})`)
    } else {
      console.log(`MCP: 未挂载 (可从浏览器面板一键挂载,或设置 MCP_SERVER_CMD 环境变量)`)
    }
    console.log(`动态 MCP (load_mcp_server 元工具): ${ENABLE_DYNAMIC_MCP ? '已启用 (LLM 可在对话中自主加载)' : '未启用 (设 DYNAMIC_MCP=1 开启)'}`)
    if (!ENABLE_SUBAGENTS) {
      console.log('Subagent: 未启用 (SUBAGENTS=0)')
    } else if (!agent) {
      // 没有 key 就没有服务端 Agent,类型也就没被注册过 —— 这时候报"已启用"
      // 会让人对着一个不存在的 agent 找问题。
      console.log('Subagent: 配置已开启,但服务端 Agent 未创建(缺 API Key);/browser 页面里的 Agent 不受影响')
    } else {
      console.log(`Subagent: 已启用 —— ${SUBAGENT_TOOL_NAMES.length} 个元工具, `
        + `类型: ${listAgentTypes().map(t => t.name).join(', ')} (设 SUBAGENTS=0 关闭)`)
    }
  })
}
startServer(PORT)

// 优雅关机:关闭所有 MCP client 避免子进程泄漏
async function shutdown() {
  await disconnectMcp()  // 卸载全部面板/环境变量挂载的 MCP server
  // 关闭 LLM 通过 load_mcp_server 运行时加载的 MCP client(enableDynamicMCP 启用时)
  try { await agent?.closeMCPClients?.() } catch { /* ignore */ }
  // 后台 subagent 会跨 chat() 存活,不收尾进程不会自然退出;同时 reject 掉所有
  // 待答提问,避免悬挂的 Promise 卡住退出。
  try { await agent?.closeSubagents?.() } catch { /* ignore */ }
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// 防止未捕获的异常导致服务器崩溃
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message)
})
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err.message || err)
})
