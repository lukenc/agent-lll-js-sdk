#!/usr/bin/env node
/**
 * examples/spill.js —— 工具输出限长与转存取回（spill）综合示例
 *
 * 这是一个**综合用例**：既覆盖本次新增的 spill，也覆盖此前已有的关键功能
 * （memory 策略、工具调用、意图识别 + 工具过滤、子代理），
 * 用来证明新功能没有把旧功能带坏。
 *
 * 打的是**真实供应商**，需要 API Key：
 *   OPENAI_API_KEY=sk-xxx   node examples/spill.js
 *   DEEPSEEK_API_KEY=sk-xxx node examples/spill.js
 *   PROVIDER=qwen DASHSCOPE_API_KEY=sk-xxx node examples/spill.js
 *   PROVIDER=<任意> LLM_API_KEY=sk-xxx LLM_URL=https://... node examples/spill.js
 *
 * 每一幕都断言**实际发生了什么**（内容有没有真被转存、模型有没有真读回、
 * 上限有没有被突破），而不是模型把话说得漂不漂亮。任一幕失败即非零退出。
 */

import { Agent, defineTool, SlidingWindowMemory } from '../src/index.js'
import { createNodeSpillStore, utf8Bytes, SPILL_READ_TOOL_NAME, SPILL_SEARCH_TOOL_NAME } from '../src/index.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  openai: 'gpt-4o',
  deepseek: 'deepseek-chat',
  qwen: 'qwen-plus',
  moonshot: 'moonshot-v1-8k',
  zhipu: 'glm-4',
  'x-grok': 'grok-2-latest',
}
const PROVIDER = process.env.PROVIDER
  || Object.keys(KEY_BY_PROVIDER).find(p => KEY_BY_PROVIDER[p])
  || 'openai'
const API_KEY = KEY_BY_PROVIDER[PROVIDER] || process.env.LLM_API_KEY
if (!API_KEY) {
  console.error(`需要 API Key（当前 provider: ${PROVIDER}）：`)
  console.error('  OPENAI_API_KEY=sk-xxx node examples/spill.js')
  console.error('  DEEPSEEK_API_KEY=sk-xxx node examples/spill.js')
  console.error('  PROVIDER=<任意> LLM_API_KEY=sk-xxx node examples/spill.js')
  process.exit(1)
}
const MODEL = process.env.MODEL || DEFAULT_MODEL_BY_PROVIDER[PROVIDER] || 'gpt-4o'
const BASE = { provider: PROVIDER, apiKey: API_KEY, model: MODEL }
if (process.env.LLM_URL) BASE.url = process.env.LLM_URL

// ---------------------------------------------------------------- 小工具

let failures = 0
const ok = (cond, msg) => {
  if (cond) { console.log(`   ✅ ${msg}`) } else { failures++; console.log(`   ❌ ${msg}`) }
}
const act = (n, title) => console.log(`\n\x1b[1m── 第 ${n} 幕：${title}\x1b[0m`)

/** 造一份「像真的构建日志」的大输出：结论在尾部，这是 headTail 策略的意义所在 */
function buildLog({ lines = 4000, marker = 'ERROR_AT_LINE_2317' } = {}) {
  const out = ['=== BUILD START ===', 'Resolving dependencies...']
  for (let i = 0; i < lines; i++) {
    out.push(i === 2317
      ? `[${i}] ${marker}: cannot find module 'left-pad'`
      : `[${i}] compiling module_${i}.ts ... ok`)
  }
  out.push('=== BUILD FAILED ===', 'EXIT_CODE=1')
  return out.join('\n')
}

const BIG_LOG = buildLog()
const CAP = 1200 // 模型可见的单条工具结果上限（字节）

const dumpLog = defineTool({
  name: 'read_build_log',
  description: '读取最近一次构建的完整日志。输出可能非常大。',
  parameters: { type: 'object', properties: {} },
  execute: async () => BIG_LOG,
})

const smallTool = defineTool({
  name: 'get_version',
  description: '获取当前项目版本号',
  parameters: { type: 'object', properties: {} },
  execute: async () => 'v0.9.0',
})

// ---------------------------------------------------------------- 主流程

let spillRoot
let exitCode = 0

try {
  spillRoot = await mkdtemp(join(tmpdir(), 'lll-spill-example-'))
  console.log(`\x1b[2m供应商 ${PROVIDER} / 模型 ${MODEL}\x1b[0m`)
  console.log(`\x1b[2m转存目录 ${spillRoot}\x1b[0m`)
  console.log(`\x1b[2m日志体积 ${(utf8Bytes(BIG_LOG) / 1024).toFixed(0)} KB，上限 ${CAP} 字节\x1b[0m`)

  // ===================================================================
  act(1, '不开 spill —— 复现「大输出挤垮上下文」')
  // ===================================================================
  {
    const agent = new Agent({
      ...BASE,
      memory: new SlidingWindowMemory(30),
      tools: [dumpLog, smallTool],
      systemPrompt: '你是构建助手。用户问构建情况时，先调用 read_build_log。',
      maxRounds: 4,
    })
    await agent.chat('看一下最近的构建日志，构建成功了吗？')
    const toolMsg = agent.memory.messages.find(m => m.role === 'tool')
    const bytes = utf8Bytes(toolMsg?.content ?? '')
    console.log(`   工具结果进入历史：${(bytes / 1024).toFixed(0)} KB`)
    ok(bytes === utf8Bytes(BIG_LOG), '未开启时工具结果逐字节原样进入历史（旧行为不变）')
    ok(bytes > 50000, `确认这是个会挤垮上下文的体量（${(bytes / 1024).toFixed(0)} KB）`)
  }

  // ===================================================================
  act(2, '开启 spill —— 限长 + 转存，且模型仍能拿到关键信息')
  // ===================================================================
  let locatorFromAct2 = null
  {
    const store = createNodeSpillStore({ root: spillRoot })
    const warns = []
    const agent = new Agent({
      ...BASE,
      memory: new SlidingWindowMemory(30),
      tools: [dumpLog, smallTool],
      systemPrompt: '你是构建助手。用户问构建情况时，先调用 read_build_log。',
      maxRounds: 4,
      spill: { maxToolResultBytes: CAP, store, onWarn: m => warns.push(m) },
    })

    const reply = await agent.chat('看一下最近的构建日志，构建成功了吗？直接回答成功或失败。')
    const toolMsg = agent.memory.messages.find(m => m.role === 'tool')
    const content = toolMsg?.content ?? ''
    const bytes = utf8Bytes(content)

    console.log(`   工具结果进入历史：${bytes} 字节（原始 ${(utf8Bytes(BIG_LOG) / 1024).toFixed(0)} KB）`)
    ok(bytes <= CAP, `不超过配置上限 ${CAP} 字节（实得 ${bytes}）`)
    ok(bytes < utf8Bytes(BIG_LOG) / 10, '相比原文大幅缩减')
    ok(content.includes('BUILD START'), '保留了头部（能看到命令开始执行）')
    ok(content.includes('EXIT_CODE=1'), '保留了尾部 —— 退出码这类结论通常在最后')
    ok(!content.includes('�'), '截断处没有产生乱码字符')
    ok(/spill:\/\//.test(content), '提示语里给出了可取回的地址')
    ok(warns.length === 0, `没有触发降级（降级告警 ${warns.length} 条）`)

    locatorFromAct2 = content.match(/spill:\/\/[^\s]+/)?.[0] ?? null
    ok(!!locatorFromAct2, '能从提示语里解析出 locator')

    console.log(`   模型回答：${String(reply).slice(0, 80).replace(/\n/g, ' ')}`)
    ok(/失败|failed|不成功|没有成功|错误/i.test(String(reply)),
      '模型基于头尾摘要正确判断出「构建失败」')

    // 完整内容必须仍可原样取回 —— 这是 spill 与「单纯截断」的本质区别
    const full = await store.readText(locatorFromAct2)
    ok(full === BIG_LOG, '完整内容被无损转存，可原样取回')
  }

  // ===================================================================
  act(3, '模型用 spill_search 定位 + spill_read 精读')
  // ===================================================================
  {
    const store = createNodeSpillStore({ root: spillRoot })
    const agent = new Agent({
      ...BASE,
      memory: new SlidingWindowMemory(30),
      tools: [dumpLog, smallTool],
      systemPrompt:
        '你是构建助手。先调用 read_build_log 查看日志。'
        + '如果结果提示内容被转存（含 spill:// 地址），'
        + `请先用 ${SPILL_SEARCH_TOOL_NAME} 搜索关键词（如 ERROR）定位，`
        + `再按需用 ${SPILL_READ_TOOL_NAME} 精读附近内容。不要从头顺序读整个文件。`,
      maxRounds: 8,
      spill: { maxToolResultBytes: CAP, store },
    })

    ok(agent.tools.some(t => t.name === SPILL_READ_TOOL_NAME), 'spill_read 已自动注入')
    ok(agent.tools.some(t => t.name === SPILL_SEARCH_TOOL_NAME), 'spill_search 已自动注入')

    const reply = await agent.chat('构建失败了，具体是哪一行报的错？把报错内容告诉我。')

    const callsOf = name => agent.memory.messages.filter(
      m => m.role === 'assistant' && m.tool_calls?.some(c => c.function?.name === name),
    ).length
    const nSearch = callsOf(SPILL_SEARCH_TOOL_NAME)
    const nRead = callsOf(SPILL_READ_TOOL_NAME)
    console.log(`   spill_search ${nSearch} 次 / spill_read ${nRead} 次`)
    ok(nSearch + nRead > 0, '模型确实去取回了细节（闭环成立）')

    // 关键：搜索存在的意义就是别线性扫。没有它时实测要 19 轮才能扫完 150KB。
    ok(nRead <= 6, `没有退化成线性扫（spill_read ${nRead} 次，超过 6 次说明在顺序读）`)
    ok(String(reply) !== '[max rounds exceeded]', '在轮次上限内完成，没有耗尽轮次')

    // 每条取回结果自身也必须受限，否则绕一圈又把大内容倒回上下文
    for (const r of agent.memory.messages.filter(m => m.role === 'tool')) {
      if (r.content?.includes('[spill ') || r.content?.includes('处匹配')) {
        ok(utf8Bytes(r.content) < 70000, `取回结果自身受限（${utf8Bytes(r.content)} 字节）`)
      }
    }

    console.log(`   模型回答：${String(reply).slice(0, 140).replace(/\n/g, ' ')}`)
    ok(/2317|left-pad/.test(String(reply)), '模型找到了真正的报错位置或内容')
  }

  // ===================================================================
  act(4, '与已有功能同场 —— 意图识别 + 工具过滤下 spill_read 不被裁掉')
  // ===================================================================
  {
    const store = createNodeSpillStore({ root: spillRoot })
    const agent = new Agent({
      ...BASE,
      memory: new SlidingWindowMemory(30),
      tools: [dumpLog, smallTool],
      systemPrompt: '你是构建助手。',
      maxRounds: 4,
      enableIntentRecognition: true, // 已有功能：开启后 ToolFilter 会裁剪工具
      spill: { maxToolResultBytes: CAP, store },
    })
    await agent.chat('项目版本号是多少？')
    // 关键：意图识别会按「与本次意图相关」裁剪工具集，但 spill_read 是基础工具，
    // 必须始终在场 —— 否则提示语让模型去调它，工具却没了。
    const { filteredTools } = await agent._runPipeline('随便问点什么')
    const names = (filteredTools ?? agent.tools).map(t => t.name)
    ok(names.includes(SPILL_READ_TOOL_NAME),
      'spill_read 作为基础工具，在意图过滤后仍然在场')
  }

  // ===================================================================
  act(5, '与已有功能同场 —— 子代理的大输出同样受限')
  // ===================================================================
  {
    const store = createNodeSpillStore({ root: spillRoot })
    const agent = new Agent({
      ...BASE,
      memory: new SlidingWindowMemory(30),
      tools: [dumpLog, smallTool],
      systemPrompt: '你是构建助手。需要独立子任务时可以派生子代理。',
      maxRounds: 6,
      spill: { maxToolResultBytes: CAP, store },
      subagents: { maxConcurrent: 2, maxDepth: 1 },
    })
    ok(agent.tools.some(t => t.name === 'agent'), '子代理元工具与 spill 可以共存')
    ok(agent.tools.some(t => t.name === SPILL_READ_TOOL_NAME), 'spill_read 未被子代理元工具挤掉')
    await agent.chat('版本号是多少？')
    ok(true, '子代理系统 + spill 同时开启时，常规对话正常完成')
    await agent.closeSubagents()
  }

  // ===================================================================
  act(6, '降级路径 —— 存储故障不能影响工具调用')
  // ===================================================================
  {
    const broken = {
      async saveText() { throw new Error('模拟磁盘故障') },
      async readText() { throw new Error('unavailable') },
      async clear() {},
    }
    const warns = []
    const agent = new Agent({
      ...BASE,
      memory: new SlidingWindowMemory(30),
      tools: [dumpLog, smallTool],
      systemPrompt: '你是构建助手。用户问构建情况时，先调用 read_build_log。',
      maxRounds: 4,
      spill: { maxToolResultBytes: CAP, store: broken, onWarn: m => warns.push(m) },
    })
    const reply = await agent.chat('构建成功了吗？只回答成功或失败。')
    const toolMsg = agent.memory.messages.find(m => m.role === 'tool')
    ok(toolMsg?.content === BIG_LOG, '存储故障时保留完整内容（不丢数据）')
    ok(warns.length > 0, `记录了降级告警（${warns.length} 条）`)
    ok(!!reply && String(reply).length > 0, '工具调用与对话照常完成，未因 spill 故障而失败')
  }

  // ===================================================================
  act(7, '生命周期 —— reset() 清理转存内容')
  // ===================================================================
  {
    const store = createNodeSpillStore({ root: spillRoot })
    const agent = new Agent({
      ...BASE,
      memory: new SlidingWindowMemory(30),
      tools: [dumpLog],
      systemPrompt: '你是构建助手。用户提到日志就调用 read_build_log。',
      maxRounds: 4,
      spill: { maxToolResultBytes: CAP, store },
    })
    await agent.chat('看下构建日志')
    const loc = agent.memory.messages.find(m => m.role === 'tool')?.content?.match(/spill:\/\/[^\s]+/)?.[0]
    ok(!!loc, '产生了转存记录')
    if (loc) {
      ok((await store.readText(loc)) === BIG_LOG, 'reset 前可以读到')
      agent.reset()
      await new Promise(r => setTimeout(r, 50)) // reset 同步返回、异步清理
      let cleared = false
      try { await store.readText(loc) } catch { cleared = true }
      ok(cleared, 'reset() 之后旧会话的转存内容已被清理')
    }
  }
} catch (err) {
  failures++
  console.error('\n\x1b[31m运行中抛出未捕获异常：\x1b[0m', err?.stack || err)
} finally {
  if (spillRoot) await rm(spillRoot, { recursive: true, force: true }).catch(() => {})
}

console.log('\n' + '─'.repeat(60))
if (failures === 0) {
  console.log('\x1b[32m全部断言通过。\x1b[0m')
} else {
  console.log(`\x1b[31m有 ${failures} 条断言失败。\x1b[0m`)
  exitCode = 1
}
process.exit(exitCode)
