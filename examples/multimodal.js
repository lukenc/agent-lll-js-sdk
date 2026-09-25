#!/usr/bin/env node
/**
 * examples/multimodal.js —— 多模态（图片输入）综合示例
 *
 * 这是一个**综合用例**：既覆盖本次新增的图片输入（用户发图、自定义工具回灌图、
 * MCP 工具回灌图、历史保留与卸载、非视觉模型的报错路径），也覆盖此前已有的关键
 * 功能（工具调用、SummarizingMemory 摘要、意图识别 + 工具过滤、tokenBudget 计量、
 * MCP），用来证明新功能没有把旧功能带坏。
 *
 * 打的是**真实供应商**，需要能看图的模型：
 *   OPENAI_API_KEY=sk-xxx node examples/multimodal.js                 # 默认 gpt-4o-mini
 *   PROVIDER=xiaomi MIMO_API_KEY=sk-xxx node examples/multimodal.js   # 默认 mimo-v2.5
 *   MODEL=<视觉模型> 覆盖默认模型；LLM_URL 指向 OpenAI 兼容端点
 *
 * 测试图由 demo/lib/png.js 现场画出（色块个数、柱高随机），答案只在图里。
 * 每一幕断言**实际发生了什么**（请求体里有没有图、模型通过工具提交的答案对不对），
 * 而不是模型的措辞。任一幕失败即非零退出。
 *
 * 请求记录器只**包一层**真实 fetch 做记录，不替换任何响应。
 */

import { fileURLToPath } from 'node:url'
import {
  Agent, defineTool, SlidingWindowMemory, createMCPClient, defaultTokenBudget,
  imagePart, contentResult, UnsupportedContentError,
} from '../src/index.js'
import { squaresPng, barChartPng, BAR_COLORS } from '../demo/lib/png.js'

// ---------------------------------------------------------------- 0. 配置

const KEY_BY_PROVIDER = {
  openai: process.env.OPENAI_API_KEY,
  xiaomi: process.env.MIMO_API_KEY,
}
const DEFAULT_MODEL_BY_PROVIDER = { openai: 'gpt-4o-mini', xiaomi: 'mimo-v2.5' }
const PROVIDER = process.env.PROVIDER
  || Object.keys(KEY_BY_PROVIDER).find(p => KEY_BY_PROVIDER[p])
  || 'openai'
const API_KEY = KEY_BY_PROVIDER[PROVIDER] || process.env.LLM_API_KEY
if (!API_KEY) {
  console.error(`需要能看图的模型的 API Key（当前 provider: ${PROVIDER}）：`)
  console.error('  OPENAI_API_KEY=sk-xxx node examples/multimodal.js')
  console.error('  PROVIDER=xiaomi MIMO_API_KEY=sk-xxx node examples/multimodal.js')
  process.exit(1)
}
const MODEL = process.env.MODEL || DEFAULT_MODEL_BY_PROVIDER[PROVIDER] || 'gpt-4o-mini'
const BASE = { provider: PROVIDER, apiKey: API_KEY, model: MODEL, temperature: 0 }
if (process.env.LLM_URL) BASE.url = process.env.LLM_URL

// ---------------------------------------------------------------- 小工具

let failures = 0
const ok = (cond, msg) => {
  if (cond) { console.log(`   ✅ ${msg}`) } else { failures++; console.log(`   ❌ ${msg}`) }
}
const act = (n, title) => console.log(`\n\x1b[1m── 第 ${n} 幕：${title}\x1b[0m`)

const realFetch = globalThis.fetch
const requests = []
globalThis.fetch = async (url, init) => {
  try { requests.push(JSON.parse(init?.body ?? 'null')) } catch { /* 非 JSON 请求不记录 */ }
  return realFetch(url, init)
}
const bodyText = body => JSON.stringify(body)
const SUMMARIZE_PREFIX = 'Summarize the following conversation'
const INTENT_PREFIX = 'You are an intent analyzer'
const systemOf = body => (typeof body?.messages?.[0]?.content === 'string' ? body.messages[0].content : '')
const isSidecar = body => systemOf(body).startsWith(SUMMARIZE_PREFIX) || systemOf(body).startsWith(INTENT_PREFIX)

/** 让模型通过工具提交答案 —— 断言看工具参数，不看措辞。 */
function answerTool(name, description, properties) {
  const calls = []
  const tool = defineTool({
    name, description,
    parameters: { type: 'object', properties, required: Object.keys(properties) },
    execute: async (args) => { calls.push(args); return 'recorded' },
  })
  return { tool, calls, last: () => calls.at(-1) }
}
const countTool = () => answerTool('report_count', '提交图中红色方块的数量', { count: { type: 'integer' } })
const colorTool = () => answerTool('submit_answer', '提交最高那根柱子的颜色', { color: { type: 'string', enum: BAR_COLORS } })

const SYSTEM = '你是一个看图助手。回答图片相关问题时，必须调用题目指定的工具提交答案，然后用一句话确认。'
const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1))
function shuffledHeights() {
  const hs = [90, 150, 210]
  for (let i = hs.length - 1; i > 0; i--) { const j = randInt(0, i); [hs[i], hs[j]] = [hs[j], hs[i]] }
  return hs
}
const tallestOf = hs => BAR_COLORS[hs.indexOf(Math.max(...hs))]
const ask = (text, png) => [{ type: 'text', text }, imagePart(png)]

console.log(`供应商: ${PROVIDER}，模型: ${MODEL}`)

// ---------------------------------------------------------------- 1. 用户发图

act(1, '用户消息带图 —— 数红色方块（同时覆盖工具调用）')
const N = randInt(2, 7)
const count1 = countTool()
const agentA = new Agent({ ...BASE, vision: true, systemPrompt: SYSTEM, memory: new SlidingWindowMemory(50), tools: [count1.tool] })
const before1 = requests.length
await agentA.chat(ask('图里有几个红色方块？调用 report_count 提交数量。', squaresPng(N)))
ok(requests.slice(before1).some(b => !isSidecar(b) && bodyText(b).includes('"image_url"')), '请求体里带着 image_url 部件')
ok(count1.last()?.count === N, `数出 ${N} 个方块（模型提交 ${count1.last()?.count}）`)

// ---------------------------------------------------------------- 2. 自定义工具回灌图

act(2, '工具返回图片 —— render_chart 回灌柱状图')
const heights2 = shuffledHeights()
const answer2 = colorTool()
const renderChart = defineTool({
  name: 'render_chart',
  description: '渲染本季度红/蓝/绿三个产品线的销售柱状图，返回图片',
  parameters: { type: 'object', properties: {} },
  execute: async () => contentResult([
    { type: 'text', text: '柱状图已渲染：红、蓝、绿三根柱子。' },
    imagePart(barChartPng(heights2)),
  ]),
})
const agentB = new Agent({ ...BASE, vision: true, systemPrompt: SYSTEM, memory: new SlidingWindowMemory(50), tools: [renderChart, answer2.tool] })
const before2 = requests.length
await agentB.chat('先调用 render_chart 看图，再调用 submit_answer 提交最高那根柱子的颜色。')
const followUp2 = requests.slice(before2).find(b => (b.messages ?? []).some(m => m.role === 'tool' && m.name === 'render_chart'))
const t2 = followUp2 ? followUp2.messages.findIndex(m => m.role === 'tool' && m.name === 'render_chart') : -1
ok(t2 >= 0 && typeof followUp2.messages[t2].content === 'string', 'tool 消息只带文字')
// 模型可能并行调用 render_chart 与 submit_answer：submit_answer 的 tool 消息会夹在中间
// （toWireMessages 把图片挪到那一整串连续 tool 消息之后），所以跳过所有紧邻的 tool 消息再看。
const next2 = t2 >= 0 ? (() => { let i = t2 + 1; while (i < followUp2.messages.length && followUp2.messages[i].role === 'tool') i++; return i })() : -1
ok(next2 >= 0 && followUp2.messages[next2]?.role === 'user' && bodyText(followUp2.messages[next2]).includes('image_url'), '图片跟在 tool 结果之后，作为 user 消息发出')
ok(answer2.last()?.color === tallestOf(heights2), `最高柱是 ${tallestOf(heights2)}（模型提交 ${answer2.last()?.color}）`)

// ---------------------------------------------------------------- 3. MCP 工具回灌图

act(3, 'MCP 工具返回 image 部件')
const heights3 = shuffledHeights()
const answer3 = colorTool()
const mcp = await createMCPClient({
  transport: 'stdio',
  command: process.execPath,
  args: [fileURLToPath(new URL('../demo/mcp-servers/image-chart.js', import.meta.url))],
  name: 'chart',
  env: { ...process.env, CHART_HEIGHTS: heights3.join(',') },
})
try {
  const agentC = new Agent({ ...BASE, vision: true, systemPrompt: SYSTEM, memory: new SlidingWindowMemory(50), tools: [...await mcp.listTools(), answer3.tool] })
  await agentC.chat('先调用 mcp__chart__render_bar_chart 看图，再调用 submit_answer 提交最高那根柱子的颜色。')
  ok(answer3.last()?.color === tallestOf(heights3), `MCP 图里最高柱是 ${tallestOf(heights3)}（模型提交 ${answer3.last()?.color}）`)
} finally {
  await mcp.close()
}

// ---------------------------------------------------------------- 4. 追问与卸载

act(4, '追问与保留 —— 历史里的图还在；上限调小后最老的图被卸载')
const before4 = requests.length
await agentA.chat('刚才那张图里有几个红色方块？再调用一次 report_count 提交。')
ok(requests.slice(before4).some(b => !isSidecar(b) && bodyText(b).includes('data:image/png')), '追问的请求里仍带着第一张图')
ok(count1.last()?.count === N, `追问仍答对 ${N}（模型提交 ${count1.last()?.count}）`)

const count4 = countTool()
const agentD = new Agent({ ...BASE, vision: true, systemPrompt: SYSTEM, memory: new SlidingWindowMemory(50), tools: [count4.tool], imageLimits: { maxImages: 1 } })
await agentD.chat(ask('这是第一张图，先记住，不用调用工具，简短回复即可。', squaresPng(3)))
const M = randInt(2, 7)
const before4b = requests.length
await agentD.chat(ask('这是第二张图。图里有几个红色方块？调用 report_count 提交。', squaresPng(M)))
const first4b = requests.slice(before4b).find(b => !isSidecar(b))
ok(bodyText(first4b).includes('image omitted to fit request image limits'), '第一张图在请求里换成了卸载占位')
ok((bodyText(first4b).match(/data:image\/png/g) || []).length === 1, '请求里只剩一张图')
ok(count4.last()?.count === M, `第二张图数出 ${M}（模型提交 ${count4.last()?.count}）`)

// ---------------------------------------------------------------- 5. 旧功能同场

act(5, '旧功能同场 —— SummarizingMemory 摘要、意图识别 + 工具过滤、tokenBudget')
const count5 = countTool()
const assembled = []
const agentE = new Agent({
  ...BASE, vision: true, systemPrompt: SYSTEM, tools: [count5.tool],
  enableIntentRecognition: true,
  tokenBudget: defaultTokenBudget(),
  memoryOpts: { threshold: 4, keepRecent: 2 },
})
agentE.on('context.assembled', p => assembled.push(p))
// K 取 5..7，强制两行图（440×240）：一行图（K<=4，440×140）在 MiMo 估算器下只值 56 token，
// 会让下面的 100-token 校验对着一个正确的 SDK 失败。
const K = randInt(5, 7)
const before5 = requests.length
await agentE.chat(ask('图里有几个红色方块？调用 report_count 提交。', squaresPng(K)))
ok(count5.last()?.count === K, `意图识别开启时仍答对 ${K}（模型提交 ${count5.last()?.count}）`)
const maxHistory = Math.max(0, ...assembled.map(p => p.historyTokens))
ok(maxHistory >= 100, `context.assembled 计入了图片 token（最大 historyTokens=${maxHistory}）`)
await agentE.chat('再用一句话描述这些方块的排列方式。')
await agentE.chat('好的，谢谢。')
await agentE.chat('最后，用一个词说明方块的颜色。')
const sent5 = requests.slice(before5)
const summaries = sent5.filter(b => systemOf(b).startsWith(SUMMARIZE_PREFIX))
ok(summaries.length > 0, '摘要被触发')
ok(summaries.every(b => !bodyText(b).includes('data:image')), '摘要请求里没有 base64')
ok(summaries.some(b => bodyText(b).includes('[image png')), '摘要输入用占位代表图片')
const intents = sent5.filter(b => systemOf(b).startsWith(INTENT_PREFIX))
ok(intents.length > 0 && intents.every(b => !bodyText(b).includes('data:image')), '意图识别只收到文字')

// ---------------------------------------------------------------- 6. 报错路径

act(6, '报错路径 —— vision:false')
const agentF = new Agent({ ...BASE, vision: false, systemPrompt: SYSTEM, memory: new SlidingWindowMemory(50) })
const before6 = requests.length
let err6 = null
try { await agentF.chat(ask('看图', squaresPng(2))) } catch (e) { err6 = e }
ok(err6 instanceof UnsupportedContentError && err6.code === 'vision_disabled', '发图被拒：UnsupportedContentError(vision_disabled)')
ok(requests.length === before6, '被拒时没有发出任何请求')
ok((await agentF.getHistory()).filter(m => m.role !== 'system').length === 0, 'memory 里没有留下这条消息')

const toolCalls6 = []
const errors6 = []
const agentG = new Agent({
  ...BASE, vision: false, systemPrompt: '需要看图表时调用 render_chart。', memory: new SlidingWindowMemory(50),
  tools: [renderChart], hooks: { onError: e => errors6.push(e) },
})
agentG.on('tool.call', p => toolCalls6.push(p))
const reply6 = await agentG.chat('调用 render_chart，然后告诉我结果。')
ok(toolCalls6.some(p => p.name === 'render_chart' && p.errorKind === 'unsupported_content'), 'render_chart 以 unsupported_content 工具级失败')
ok(errors6.some(e => e instanceof UnsupportedContentError), 'onError 收到 UnsupportedContentError')
ok(typeof reply6 === 'string', 'run 正常结束')

// ---------------------------------------------------------------- 收尾

globalThis.fetch = realFetch
console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
