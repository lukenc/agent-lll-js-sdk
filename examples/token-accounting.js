#!/usr/bin/env node
/**
 * examples/token-accounting.js —— token 计量准确性综合示例
 *
 * 这是一个**综合用例**：既覆盖本次改动（结构开销 + usage 锚定），也覆盖
 * 此前已有的关键功能（memory 策略、工具调用、意图识别、spill），
 * 用来证明新计价没有把旧功能带坏。
 *
 * 打的是**真实供应商**（需要真实 usage 回传才能验证锚定）：
 *   OPENAI_API_KEY=sk-xxx   node examples/token-accounting.js
 *   DEEPSEEK_API_KEY=sk-xxx node examples/token-accounting.js
 *   PROVIDER=<任意> LLM_API_KEY=sk-xxx LLM_URL=https://... node examples/token-accounting.js
 *
 * 断言的是**可核对的事实**（估算与真实用量的偏差率、置信度有没有切换、
 * 信封变化后有没有失效），而不是模型说了什么。任一失败即非零退出。
 */

import {
  Agent, defineTool, SlidingWindowMemory,
  estimateMessageTokens, estimateToolsTokens, headerFingerprint,
  defaultTokenBudget, estimateTokens,
} from '../src/index.js'

// ---------------------------------------------------------------- 0. 配置

const KEY_BY_PROVIDER = {
  openai: process.env.OPENAI_API_KEY,
  deepseek: process.env.DEEPSEEK_API_KEY,
  qwen: process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY,
  moonshot: process.env.MOONSHOT_API_KEY,
  zhipu: process.env.ZHIPU_API_KEY,
  'x-grok': process.env.XAI_API_KEY || process.env.GROK_API_KEY,
}
const DEFAULT_MODEL_BY_PROVIDER = {
  openai: 'gpt-4o', deepseek: 'deepseek-chat', qwen: 'qwen-plus',
  moonshot: 'moonshot-v1-8k', zhipu: 'glm-4', 'x-grok': 'grok-2-latest',
}
const PROVIDER = process.env.PROVIDER
  || Object.keys(KEY_BY_PROVIDER).find(p => KEY_BY_PROVIDER[p]) || 'openai'
const API_KEY = KEY_BY_PROVIDER[PROVIDER] || process.env.LLM_API_KEY
if (!API_KEY) {
  console.error(`需要 API Key（当前 provider: ${PROVIDER}）：`)
  console.error('  OPENAI_API_KEY=sk-xxx node examples/token-accounting.js')
  console.error('  PROVIDER=<任意> LLM_API_KEY=sk-xxx node examples/token-accounting.js')
  process.exit(1)
}
const MODEL = process.env.MODEL || DEFAULT_MODEL_BY_PROVIDER[PROVIDER] || 'gpt-4o'
const BASE = { provider: PROVIDER, apiKey: API_KEY, model: MODEL }
if (process.env.LLM_URL) BASE.url = process.env.LLM_URL

// ---------------------------------------------------------------- 小工具

let failures = 0
const ok = (cond, msg) => {
  if (cond) console.log(`   ✅ ${msg}`)
  else { failures++; console.log(`   ❌ ${msg}`) }
}
const act = (n, t) => console.log(`\n\x1b[1m── 第 ${n} 幕：${t}\x1b[0m`)
const pct = (a, b) => b === 0 ? 0 : Math.abs(a - b) / b * 100

const searchTool = defineTool({
  name: 'search_docs',
  description: '在项目文档里检索关键词，返回匹配的段落',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '检索关键词' },
      limit: { type: 'number', description: '最多返回几条，默认 5' },
      section: { type: 'string', enum: ['api', 'guide', 'faq'], description: '限定文档分区' },
    },
    required: ['query'],
  },
  execute: async ({ query }) => `找到 3 条关于「${query}」的记录：A、B、C。`,
})

const timeTool = defineTool({
  name: 'get_time',
  description: '获取当前时间',
  parameters: { type: 'object', properties: {} },
  execute: async () => new Date().toISOString(),
})

let exitCode = 0

try {
  console.log(`\x1b[2m供应商 ${PROVIDER} / 模型 ${MODEL}\x1b[0m`)

  // ===================================================================
  act(1, '结构开销 —— 纯文本估算漏掉了什么')
  // ===================================================================
  {
    const plain = { role: 'user', content: 'abcd' }
    ok(estimateMessageTokens(plain) === 9,
      `校准锚点：4 字符消息 = 9 tokens（校准基准），实得 ${estimateMessageTokens(plain)}`)

    const withCall = {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_docs', arguments: '{"query":"token","limit":5}' } }],
    }
    const naive = estimateTokens(withCall.content)
    const real = estimateMessageTokens(withCall)
    console.log(`   一条工具调用消息：纯文本估算 ${naive} → 含结构开销 ${real}`)
    ok(real > naive, '带工具调用的消息，纯文本估算严重低估')

    const toolsNaive = estimateTokens(`### ${searchTool.name}\n${searchTool.description}`)
    const toolsReal = estimateToolsTokens([searchTool])
    console.log(`   一个工具的 schema：按描述估 ${toolsNaive} → 按真实 JSON 估 ${toolsReal}`)
    ok(toolsReal > toolsNaive * 2, '工具 schema 的真实体积远大于描述文本')
  }

  // ===================================================================
  act(2, '第一轮 —— 没有锚点，纯估算')
  // ===================================================================
  const agent = new Agent({
    ...BASE,
    memory: new SlidingWindowMemory(40),
    tools: [searchTool, timeTool],
    systemPrompt: '你是文档助手。回答要简短。',
    tokenBudget: defaultTokenBudget(),
    maxRounds: 4,
  })

  const assembled = []
  agent.on('context.assembled', e => assembled.push(e))

  {
    await agent.chat('你好，简单介绍一下你能做什么。')
    const first = assembled[0]
    ok(!!first, '产生了 context.assembled 事件')
    ok(first?.tokenConfidence === 'estimated', `第一轮必然是纯估算，实得 ${first?.tokenConfidence}`)
    console.log(`   第一轮估算：${first?.totalTokens} tokens`)

    const anchor = agent.getTokenAnchor()
    ok(!!anchor, '一轮之后产生了锚点（说明真实 usage 被接住了）')
    if (anchor) {
      console.log(`   真实用量：${anchor.totalTokens} tokens（估算 ${anchor.estimatedAtAnchor}）`)
      const deviation = pct(anchor.estimatedAtAnchor, anchor.totalTokens)
      console.log(`   首轮估算偏差：${deviation.toFixed(1)}%`)
      ok(Number.isFinite(deviation), '偏差可计算')
    }
  }

  // ===================================================================
  act(3, '第二轮 —— 锚点生效，置信度切到 usage')
  // ===================================================================
  {
    const before = assembled.length
    await agent.chat('搜索一下 token 相关的文档。')
    const rounds = assembled.slice(before)
    ok(rounds.length > 0, '第二轮产生了组装事件')

    const usageRounds = rounds.filter(r => r.tokenConfidence === 'usage')
    console.log(`   本轮 ${rounds.length} 次组装，其中 ${usageRounds.length} 次基于真实用量`)
    ok(usageRounds.length > 0,
      '锚点生效，至少一次组装的置信度是 usage —— 这是本次改动的核心')

    for (const r of usageRounds) {
      const gap = pct(r.estimatedTokens, r.totalTokens)
      console.log(`     锚定值 ${r.totalTokens} vs 纯估算 ${r.estimatedTokens}（差 ${gap.toFixed(1)}%）`)
    }
    ok(usageRounds.every(r => r.totalTokens > 0), '锚定值为正')
  }

  // ===================================================================
  act(4, '锚点跟随最新一次调用')
  // ===================================================================
  {
    const a1 = agent.getTokenAnchor()
    await agent.chat('再说一句话就好。')
    const a2 = agent.getTokenAnchor()
    ok(!!a2, '仍有锚点')
    ok(a2.totalTokens !== a1.totalTokens || a2.historyTokens !== a1.historyTokens,
      '锚点随对话推进而更新，不是停在第一轮')
    console.log(`   锚点变化：${a1.totalTokens} → ${a2.totalTokens} tokens`)
  }

  // ===================================================================
  act(5, '信封变化让锚点失效')
  // ===================================================================
  {
    const fpBefore = headerFingerprint(agent.systemPrompt, agent.tools)
    // 挂一个新工具 —— 等价于运行时挂载 MCP 服务器
    agent.tools = [...agent.tools, defineTool({
      name: 'newly_mounted',
      description: '模拟运行时挂载的新工具',
      parameters: { type: 'object', properties: { x: { type: 'string' } } },
      execute: async () => 'ok',
    })]
    const fpAfter = headerFingerprint(agent.systemPrompt, agent.tools)
    ok(fpBefore !== fpAfter, '加载新工具后信封指纹变化')

    const before = assembled.length
    await agent.chat('现在几点？')
    const rounds = assembled.slice(before)
    ok(rounds.length > 0 && rounds[0].tokenConfidence === 'estimated',
      `信封变了，第一次组装必须退回估算，实得 ${rounds[0]?.tokenConfidence}`)
    console.log(`   信封变化后：${rounds.map(r => r.tokenConfidence).join(' → ')}`)

    // 锚点是在**调用之后**才建立的，所以要再问一轮才能看到它重新生效。
    // （这一轮若只有一次组装，那次必然还是 estimated —— 上面刚断言过。）
    const before2 = assembled.length
    await agent.chat('再确认一次时间。')
    const rounds2 = assembled.slice(before2)
    ok(rounds2.some(r => r.tokenConfidence === 'usage'),
      `新信封下拿到真实用量后，下一轮锚点重新建立，实得 ${rounds2.map(r => r.tokenConfidence).join(',')}`)
    console.log(`   再下一轮：${rounds2.map(r => r.tokenConfidence).join(' → ')}`)
  }

  // ===================================================================
  act(6, '与已有功能同场 —— 意图识别（注意：会让锚点更容易失效）')
  // ===================================================================
  {
    const a2 = new Agent({
      ...BASE,
      memory: new SlidingWindowMemory(40),
      tools: [searchTool, timeTool],
      systemPrompt: '你是助手。回答简短。',
      tokenBudget: defaultTokenBudget(),
      enableIntentRecognition: true,   // 已有功能
      maxRounds: 4,
    })
    const evs = []
    a2.on('context.assembled', e => evs.push(e))
    await a2.chat('现在几点？')
    await a2.chat('搜一下文档')
    ok(evs.length > 0, '意图识别开启时计量照常工作')
    ok(evs.every(e => Number.isFinite(e.totalTokens) && e.totalTokens > 0),
      '所有组装都报出了有效的 token 数')
    ok(evs.every(e => e.toolsTokens >= 0), '工具计价非负')

    // 这里不断言一定出现 usage —— 意图识别每轮可能给出不同的工具子集，
    // 工具集不同就是请求体不同，锚点随之失效是**正确**行为。
    // 把实际分布打出来，让使用方看到这个权衡。
    const dist = evs.reduce((m, e) => (m[e.tokenConfidence] = (m[e.tokenConfidence] || 0) + 1, m), {})
    console.log(`   置信度分布：${JSON.stringify(dist)}`)
    console.log(`   （意图切换时工具集变化 → 锚点失效，这是语义正确的；`)
    console.log(`     关闭意图识别可获得稳定锚定）`)
  }

  // ===================================================================
  act(7, '与已有功能同场 —— 预算裁剪仍然正确')
  // ===================================================================
  {
    const tight = new Agent({
      ...BASE,
      memory: new SlidingWindowMemory(40),
      tools: [searchTool, timeTool],
      systemPrompt: '你是助手。',
      // 故意给一个很小的预算，逼出裁剪路径
      tokenBudget: { totalTokens: 800, systemPromptRatio: .15, knowledgeRatio: .2, historyRatio: .45, toolsRatio: .2 },
      maxRounds: 3,
    })
    const evs = []
    tight.on('context.assembled', e => evs.push(e))
    // 先灌一段长历史
    tight.memory.add({ role: 'user', content: '背景资料：' + 'x'.repeat(6000) })
    await tight.chat('一句话总结。')
    ok(evs.some(e => e.trimmed), '小预算下确实触发了裁剪')
    ok(evs.every(e => e.historyTokens >= 0), '裁剪后历史计价有效')
    console.log(`   裁剪后各段：sys=${evs[0].systemPromptTokens} hist=${evs[0].historyTokens} tools=${evs[0].toolsTokens}`)
  }

  // ===================================================================
  act(8, 'reset() 清掉锚点')
  // ===================================================================
  {
    ok(!!agent.getTokenAnchor(), 'reset 前有锚点')
    agent.reset()
    ok(agent.getTokenAnchor() === null, 'reset 后锚点被清掉（新会话不带旧基准）')
  }
} catch (err) {
  failures++
  console.error('\n\x1b[31m运行中抛出未捕获异常：\x1b[0m', err?.stack || err)
}

console.log('\n' + '─'.repeat(60))
if (failures === 0) console.log('\x1b[32m全部断言通过。\x1b[0m')
else { console.log(`\x1b[31m有 ${failures} 条断言失败。\x1b[0m`); exitCode = 1 }
process.exit(exitCode)
