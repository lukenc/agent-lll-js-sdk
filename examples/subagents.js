/**
 * Subagent 系统的集成示例 —— 也是这个仓库的「新旧功能同场」验收用例。
 *
 * 它一次跑完 7 幕，前 3 幕是**既有功能**（工具调用 / Skill / MCP），后 4 幕是
 * **subagent 系统**（后台派发 + keep-alive、DAG 编排、产物轨与历史检索、提问路由）。
 * 前 3 幕的存在不是凑数：subagent 会往 Agent 的工具集、system 消息、轮边界注入、
 * ask_user 通道上各插一脚，这几处恰好是既有功能的落点，一起跑才看得出有没有被碰坏。
 *
 * 运行（需要真实 API Key）:
 *
 *   OPENAI_API_KEY=sk-xxx node examples/subagents.js
 *   DEEPSEEK_API_KEY=sk-xxx node examples/subagents.js
 *   MODEL=gpt-4o SIMPLE_MODEL=gpt-4o-mini OPENAI_API_KEY=sk-xxx node examples/subagents.js
 *   DEBUG=1 OPENAI_API_KEY=sk-xxx node examples/subagents.js   # 逐条打印带归属的事件
 *
 * 终端进度条的实现在同目录的 subagent-render.js —— 拷贝这个示例时两个文件一起拷。
 *
 * 每一幕结束后会断言若干关键事实（工具被调到、subagent 真的跑起来了、图节点走完、
 * 产物落轨、提问被路由回来），任一条不成立以非 0 退出 —— 所以它可以直接当回归脚本用。
 *
 * 断言判的都是**发生了什么**（有没有派出 agent、图节点是不是都到了 succeeded、
 * 产物轨上有没有记录），不是模型的措辞。模型只要照着指令做，这些就该成立；不成立
 * 说明集成真的断了，而不是模型换了个说法。
 */
import {
  Agent,
  defineTool,
  TokenAwareMemory,
  KnowledgeBase,
  createKnowledgeEntry,
  createLocalSkillProvider,
  createMCPClient,
  registerBaseTool,
  listAgentTypes,
} from '../src/index.js'
import { createRenderer, formatSettled } from './subagent-render.js'

const HERE = new URL('.', import.meta.url).pathname

// ---------------------------------------------------------------------------
// 0. 配置
// ---------------------------------------------------------------------------

const API_KEY = process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY
if (!API_KEY) {
  console.error('需要 API Key:')
  console.error('  OPENAI_API_KEY=sk-xxx node examples/subagents.js')
  console.error('  DEEPSEEK_API_KEY=sk-xxx node examples/subagents.js')
  process.exit(1)
}

const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true'
const render = createRenderer()
/** agentId -> { label, detail, ms, startedAt } —— 只放**在跑**的，落终态即移除 */
const live = new Map()
let ticker = null

function startTicker() {
  if (ticker) return
  ticker = setInterval(() => {
    const now = Date.now()
    render.update([...live.values()].map(v => ({ label: v.label, detail: v.detail, ms: now - v.startedAt })))
    if (live.size === 0) { clearInterval(ticker); ticker = null; render.update([]) }
  }, 100)
  ticker.unref?.()
}

// Ctrl-C 也要清活动区并恢复光标，否则终端留残影、光标可能一直是隐藏的。
process.on('SIGINT', () => { render.done(); process.exit(130) })

const PROVIDER = process.env.PROVIDER
  || (process.env.DEEPSEEK_API_KEY && !process.env.OPENAI_API_KEY ? 'deepseek' : 'openai')
const MODEL = process.env.MODEL || (PROVIDER === 'deepseek' ? 'deepseek-chat' : 'gpt-4o')
// subagent 的 `model: 'fast'` 别名解析到这里；不配就与主模型同一套。
const SIMPLE_MODEL = process.env.SIMPLE_MODEL || MODEL

// ---------------------------------------------------------------------------
// 1. 既有能力：自定义工具 + 一份"项目笔记"（给 subagent 一点真东西可读）
// ---------------------------------------------------------------------------

const NOTES = {
  'error-handling': [
    '# 错误处理约定（ERR-CONV-01）',
    '- 对外 API 一律返回软失败字符串，不 throw；throw 只留给编程错误。',
    '- 错误类构造函数只接受白名单标量字段，避免 apiKey 泄进 err.message。',
    '- 传输层错误重试，语义层错误不重试。',
  ].join('\n'),
  modules: [
    '# 模块清单（MOD-01）',
    'agent.js / context-manager.js / memory.js / tool-filter.js / mcp / skills / agents',
  ].join('\n'),
  changelog: [
    '# 变更记录（CHG-01）',
    '- 0.5.0 引入 MCP 客户端',
    '- 0.5.1 引入 Skill 系统',
    '- 0.6.0 引入 Subagent 系统',
  ].join('\n'),
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
    properties: { expression: { type: 'string', description: '数学表达式，如 (17+25)*3' } },
    required: ['expression'],
  },
  execute: async ({ expression }) => String(Function(`"use strict"; return (${expression})`)()),
})

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

// ---------------------------------------------------------------------------
// 2. Subagent 类型
// ---------------------------------------------------------------------------
//
// `tools` 只列**任务**工具就够了：artifact_write / artifact_list / history_search /
// history_get / send_message / ask_user 是固定的基础设施 floor，框架会与父 agent 实际
// 拥有的工具取交集后自动带上。
const SUBAGENT_TYPES = [
  {
    name: 'explorer',
    description: '只读检索：读项目笔记、汇报事实，不做任何修改。',
    systemPrompt: '你是一个只读检索子 agent。用 read_note 找到事实，'
      + '用 artifact_write 把结论登记到产物轨（key 用文件路径形式），'
      + '最后一条消息就是你交回去的报告：先给结论，再给证据，不要复述过程。',
    model: 'fast',
    tools: ['read_note'],
    maxRounds: 10,
  },
  {
    name: 'interviewer',
    description: '需要用户拍板时，替编排者去问一个具体问题。',
    systemPrompt: '你负责替编排者向用户问一个具体问题：先用 ask_user 提问，'
      + '拿到回答后把用户的原话带回去。不要自行猜测答案。',
    model: 'fast',
    tools: [],
    maxRounds: 8,
  },
]

// ---------------------------------------------------------------------------
// 3. 断言
// ---------------------------------------------------------------------------

const checks = []
function check(label, ok, detail = '') {
  checks.push({ label, ok: !!ok, detail })
  render.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
}

function section(title) {
  render.log(`\n${'━'.repeat(72)}\n${title}\n${'━'.repeat(72)}`)
}

// ---------------------------------------------------------------------------
// 4. 组装
// ---------------------------------------------------------------------------

render.log(`[llm] ${PROVIDER} / ${MODEL}（fast 别名: ${SIMPLE_MODEL}）\n`)

// MCP：挂上仓库自带的 stdio mock MCP server（既有功能；它是 MCP 协议的测试桩，
// 与 LLM 无关，提供 echo / add 两个工具）
let mcpClient = null
let mcpTools = []
try {
  mcpClient = await createMCPClient({
    transport: 'stdio',
    command: 'node',
    args: [new URL('../src/mcp/__fixtures__/mock-mcp-server.js', import.meta.url).pathname],
    name: 'mock',
  })
  mcpTools = await mcpClient.listTools()
  // 开了 enableIntentRecognition 之后 ToolFilter 会按意图裁工具，MCP 工具不注册成
  // base tool 就可能在需要它的那一轮被裁掉。
  mcpTools.forEach(t => registerBaseTool(t.name))
  render.log(`[mcp] 已挂载 ${mcpTools.length} 个工具: ${mcpTools.map(t => t.name).join(', ')}`)
} catch (err) {
  render.log(`[mcp] 挂载失败（本幕将跳过）: ${err.message}`)
}

// 知识库（既有功能）
const knowledgeBase = new KnowledgeBase()
knowledgeBase.addEntry(createKnowledgeEntry(
  'ARCHITECTURE',
  'lll-web-agent',
  '一个 JS 的 LLM Agent SDK，管线为 意图识别 → 工具过滤 → 上下文装配 → ReAct 循环。',
))

const agent = new Agent({
  provider: PROVIDER,
  apiKey: API_KEY,
  model: MODEL,
  simpleModel: SIMPLE_MODEL,
  systemPrompt: '你是一个工程助手。可以查时间、算数、读项目笔记，也可以把成块的活派给 subagent。'
    + '用户明确要求用某个能力时（派 subagent、声明依赖图、列产物、让 agent 来问他）就照做，不要自己改用别的方式。'
    + '请用中文回答。',
  tools: [getCurrentTime, calculate, readNote, ...mcpTools],
  // 既有功能：token 感知记忆 + 知识库 + 意图识别
  //（意图识别开着才验证得到"subagent 元工具没被 ToolFilter 裁掉"）
  memory: new TokenAwareMemory(30000),
  knowledgeBase,
  enableIntentRecognition: true,
  maxRounds: 20,
  // 既有功能：Skill 系统
  skills: {
    providers: [createLocalSkillProvider({ dir: `${HERE}skills` })],
    runtime: 'node',
  },
  // 新功能：Subagent 系统
  subagents: {
    types: SUBAGENT_TYPES,
    maxConcurrent: 2,
    maxDepth: 2,
    artifacts: { policy: 'warn' },
    keepAlive: true,
    keepAliveTimeoutMs: 180_000,
    ask: { timeoutMs: 120_000 },
  },
})

// 遥测（既有功能 + subagent 的新事件）
const seen = { spawn: 0, succeeded: 0, failed: 0, artifacts: 0, graphNodes: 0, asks: 0, toolCalls: 0 }
agent.on('tool.call', (p) => {
  seen.toolCalls++
  if (p.agentId && live.has(p.agentId)) live.get(p.agentId).detail = p.name
  if (DEBUG) render.log(`    · [tool.call] ${p.name} ${p.ok === false ? '✗ ' + p.errorKind : ''} @${p.agentName ?? 'main'}`)
})
agent.on('round.start', (p) => {
  if (DEBUG) render.log(`    · [round.start] #${p.round} @${p.agentName ?? 'main'}`)
})
agent.on('llm.call', (p) => {
  if (DEBUG) {
    render.log(`    · [llm.call] ${p['gen_ai.usage.input_tokens'] ?? '—'}↓/${p['gen_ai.usage.output_tokens'] ?? '—'}↑ @${p.agentName ?? 'main'}`)
  }
})
agent.on('agent.spawn', (p) => {
  seen.spawn++
  // payload 的字段名是 agentName（不是 name），且一定带 agentId。
  live.set(p.agentId, { label: p.nodeId ?? p.agentName, detail: '启动中', startedAt: Date.now() })
  render.log(`🤖 派出 ${p.agentName}（${p.type ?? '?'}）`)
  startTicker()
})
agent.on('agent.succeeded', (p) => {
  seen.succeeded++
  live.delete(p.agentId)
  const u = p.usage || {}
  render.settle(formatSettled({
    label: p.agentName, rounds: p.rounds,
    tokens: (u.input_tokens || 0) + (u.output_tokens || 0),
    ms: p.wallClockMs, ok: true,
  }))
})
agent.on('agent.failed', (p) => {
  seen.failed++
  live.delete(p.agentId)
  // 注意：`agent.failed` 的 payload 与 `agent.succeeded` **不同构** —— 它只有
  // { agentId, agentName, parentAgentId, failureKind, attempts, lastError }，
  // 没有 rounds / usage / wallClockMs。照着成功那条抄会渲染出一串 undefined。
  // 另外这里的 `attempts` 是**数字**（第几次尝试），而 `toStatus().attempts` 是
  // 数组，名字撞了但类型不同，别混用。
  render.settle(`✗ ${p.agentName}  ${p.failureKind ?? '失败'}（尝试 ${p.attempts} 次）`)
  if (p.lastError) render.log(`    · ${String(p.lastError).slice(0, 120)}`)
})
agent.on('agent.cancelled', (p) => { live.delete(p.agentId) })
agent.on('artifact.write', (p) => {
  seen.artifacts++
  render.log(`    · 产物 ${p.key} sha:${p.sha} by ${p.agentName}`)
})
agent.on('graph.node.settled', (p) => { seen.graphNodes++ })
agent.on('ask.user', () => { seen.asks++ })
agent.on('run.keep_alive.timeout', (p) => render.log(`    · keep-alive 等了 ${Math.round(p.waitedMs)}ms`))

// 提问路由的**命令式通道**（Web 服务端最常用的接法）：不在 hook 里 await，
// 而是轮询 pendingQuestions() 再 answerQuestion()。
const answerPoller = setInterval(() => {
  for (const q of agent.pendingQuestions()) {
    render.log(`    · [ask] ${q.agentName} 问: ${q.question}`)
    agent.answerQuestion(q.askId, '定在本周四晚上 22:00，走灰度发布。')
  }
}, 200)
answerPoller.unref?.()

await agent.loadSkills()
render.log(`[skills] 可用 skill: ${agent.skills.list().map(s => s.name).join(', ') || '(无)'}`)
render.log(`[types] 可用 agent type: ${listAgentTypes().map(t => t.name).join(', ')}`)

async function act(title, message) {
  section(title)
  render.log(`> ${message}\n`)
  const reply = await agent.chat(message)
  const m = agent.getLastRunMetrics()
  render.log(`\nAgent: ${reply}`)
  render.log(`  (rounds=${m.totalRounds} stop=${agent.lastStopReason} keepAliveTimeout=${agent.lastKeepAliveTimedOut})\n`)
  return reply
}

/** 本轮实际调过的工具名（扫 model 轨上的 assistant.tool_calls）。 */
async function toolsCalledSince(mark) {
  const model = await agent.getHistory('model')
  return model.slice(mark).flatMap(m => (m?.tool_calls ?? []).map(tc => tc.function?.name)).filter(Boolean)
}

try {
  // ===================== 既有功能 =====================
  let mark = (await agent.getHistory('model')).length
  const r1 = await act('第 1 幕 · 既有功能：工具调用 + 记忆 + 知识库',
    '现在几点了？另外帮我算一下 (17+25)*3 等于多少。')
  const t1 = await toolsCalledSince(mark)
  check('时间与计算工具都被调到', t1.includes('get_current_time') && t1.includes('calculate'), t1.join(', '))
  check('计算结果正确（126 出现在回复里）', /126/.test(r1), r1.slice(0, 50))

  mark = (await agent.getHistory('model')).length
  const r2 = await act('第 2 幕 · 既有功能：Skill 系统',
    '用 incident-report 这个 skill，给昨晚的登录超时故障列一份复盘提纲。')
  const t2 = await toolsCalledSince(mark)
  check('skill 元工具被调用（Level 2 正文注入）', t2.includes('skill'), t2.join(', '))
  check('回复按 skill 的五段式组织', /时间线/.test(r2) && /根因/.test(r2), r2.slice(0, 60))

  if (mcpTools.length > 0) {
    mark = (await agent.getHistory('model')).length
    const r3 = await act('第 3 幕 · 既有功能：MCP 工具',
      '用 MCP 提供的 add 工具，把 40 和 2 加起来。')
    const t3 = await toolsCalledSince(mark)
    check('MCP 工具可用且未被 ToolFilter 裁掉', t3.some(n => n.startsWith('mcp__mock__')), t3.join(', '))
    check('MCP 计算结果正确（42）', /42/.test(r3), r3.slice(0, 50))
  }

  // ===================== 新功能：subagent =====================
  const r4 = await act('第 4 幕 · 新功能：后台派 subagent + keep-alive',
    '用一个 explorer 类型的 subagent 在后台调研这个仓库的错误处理约定'
    + '（run_in_background 用默认的 true），等它回来后把它的结论转述给我。')
  check('subagent 被派出去了', seen.spawn >= 1, `spawn=${seen.spawn}`)
  check('subagent 跑完并成功', seen.succeeded >= 1, `succeeded=${seen.succeeded} failed=${seen.failed}`)
  check('后台结果经轮边界注入回到主 agent（回复里带 ERR-CONV-01 的内容）',
    /ERR-CONV-01|软失败|不 ?throw|白名单/.test(r4), r4.slice(0, 80))

  const r5 = await act('第 5 幕 · 新功能：DAG 编排（2 个并行上游 + 1 个确认闸门）',
    '用 agent_graph 声明一张依赖图来做发布说明：两个互不依赖的节点分别统计模块清单、'
    + '读取变更记录（都用 explorer 类型、on_ready 用 auto），第三个节点依赖前两个、'
    + '负责汇总成 0.6.0 的发布说明。上游跑完后你用 graph_start 给汇总节点写契约并启动它；'
    + '整张图跑完后用 graph_close 收尾。')
  const graphs = [...agent.subagents.graphs.values()]
  const nodeStates = graphs.flatMap(g => [...g.graph.nodes.keys()].map((id) => {
    const n = g.graph.get(id)
    return `${n.nodeId}:${n.state}`
  }))
  check('图被声明出来了（至少 3 个节点）', nodeStates.length >= 3, nodeStates.join(' '))
  check('所有图节点都走到 succeeded',
    nodeStates.length > 0 && nodeStates.every(s => s.endsWith(':succeeded')), nodeStates.join(' '))
  check('图在任务收尾时被关闭', graphs.some(g => g.state === 'closed'),
    graphs.map(g => `${g.graphId}:${g.state}`).join(' '))
  check('汇总结果回到主 agent', /0\.6\.0|发布说明|release/i.test(r5), r5.slice(0, 60))

  mark = (await agent.getHistory('model')).length
  const r6 = await act('第 6 幕 · 新功能：产物轨 + 全量历史检索',
    '用 artifact_list 把目前产物轨上的记录列出来，再用 history_search 在整个会话历史里'
    + '搜一下 "ERR-CONV-01"，告诉我搜到了什么。')
  const t6 = await toolsCalledSince(mark)
  const artifacts = await agent.getArtifacts()
  check('产物轨记下了各 subagent 的产出', artifacts.length >= 3,
    `${artifacts.length} 条: ${artifacts.map(a => a.key).join(', ')}`)
  check('artifact_list / history_search 都被调到',
    t6.includes('artifact_list') && t6.includes('history_search'), t6.join(', '))
  check('第 6 幕正常收尾', typeof r6 === 'string' && r6.length > 0)

  const r7 = await act('第 7 幕 · 新功能：提问路由（subagent 反问用户）',
    '派一个 interviewer 类型的 subagent（run_in_background 设为 false），'
    + '让它替你问我 0.6.0 的发布窗口定在什么时候，然后把我的原话告诉我。')
  check('子 agent 的提问被路由到主机并被应答', seen.asks >= 1, `ask=${seen.asks}`)
  check('用户的回答带回了主 agent', /周四|22:00|灰度/.test(r7), r7.slice(0, 60))

  // ===================== 汇总 =====================
  section('汇总')
  const model = await agent.getHistory('model')
  const all = await agent.getHistory('all')
  const visible = await agent.getHistory('visible')
  render.log(`RuntimeHistory 轨道: all=${all.length} visible=${visible.length} model=${model.length} artifacts=${artifacts.length}`)
  check('subagent 的消息没有污染主对话的 model 轨',
    !model.some(m => typeof m?.content === 'string' && m.content.includes('只读检索子 agent')))

  const session = agent.getSessionMetrics()
  render.log(`会话指标: runs=${session.totalRuns} rounds=${session.totalRounds} `
    + `llmCalls=${session.totalLlmCalls} toolCalls=${session.totalToolCalls} `
    + `tokens(in/out)=${session.usage.input_tokens}/${session.usage.output_tokens}`)
  render.log(`事件计数: ${JSON.stringify(seen)}`)
} finally {
  if (ticker) clearInterval(ticker)
  render.done()
  clearInterval(answerPoller)
  // 后台 agent 会跨 chat() 存活；不收尾进程不会自然退出。
  await agent.closeSubagents()
  await agent.closeMCPClients?.()
  if (mcpClient) await mcpClient.close().catch(() => {})
}

// ---------------------------------------------------------------------------
// 5. 退出码
// ---------------------------------------------------------------------------

// render 已经在 finally 里 done() 了（之后的调用全是 no-op），这一段收尾
// 打印必须看得见，所以直接走原生 console，不经过 section()/render.log。
const failed = checks.filter(c => !c.ok)
console.log(`\n${'━'.repeat(72)}\n断言：${checks.length - failed.length}/${checks.length} 通过\n${'━'.repeat(72)}`)
if (failed.length > 0) {
  for (const f of failed) console.error(`  ❌ ${f.label}${f.detail ? ` — ${f.detail}` : ''}`)
  console.error('\n断言判的是"发生了什么"，不是模型的措辞 —— 挂了说明集成有回归，'
    + '先看上面对应那一幕的事件流是断在哪一步。')
  process.exitCode = 1
} else {
  console.log('\n全部通过：既有功能与 subagent 系统在同一个会话里同时可用。')
}
