/**
 * PlanAndExecute 执行策略示例 — 复杂任务的分步规划与执行
 *
 * 运行：OPENAI_API_KEY=sk-xxx node examples/plan-and-execute.js
 */
import { Agent, PlanAndExecuteStrategy, defineTool } from '../src/index.js'
import { readFile, writeFile, readdir } from 'fs/promises'

// ==================== 工具定义 ====================

const readFileTool = defineTool({
  name: 'read_file',
  description: '读取指定路径的文件内容',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: '文件路径' } },
    required: ['path'],
  },
  execute: async ({ path }) => {
    try { return await readFile(path, 'utf-8') }
    catch (err) { return `Error: ${err.message}` }
  },
})

const listDirTool = defineTool({
  name: 'list_dir',
  description: '列出目录下的文件和子目录',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: '目录路径' } },
    required: ['path'],
  },
  execute: async ({ path }) => {
    try { return (await readdir(path, { withFileTypes: true })).map(d => `${d.isDirectory() ? '📁' : '📄'} ${d.name}`).join('\n') }
    catch (err) { return `Error: ${err.message}` }
  },
})

const writeFileTool = defineTool({
  name: 'write_file',
  description: '写入文件内容',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      content: { type: 'string', description: '文件内容' },
    },
    required: ['path', 'content'],
  },
  execute: async ({ path, content }) => {
    try { await writeFile(path, content, 'utf-8'); return `Written to ${path}` }
    catch (err) { return `Error: ${err.message}` }
  },
})

const tools = [readFileTool, listDirTool, writeFileTool]

// ==================== 示例 1: 通过 Agent 使用 ====================

async function example1_agentChat() {
  console.log('=== 示例 1: 通过 Agent 使用 PlanAndExecute ===\n')

  const agent = new Agent({
    provider: 'openai',
    apiKey: process.env.OPENAI_API_KEY,
    model: 'gpt-4',
    tools,
    strategy: 'plan_and_execute',   // ← 切换到 PlanAndExecute 策略
    planAndExecuteOpts: {
      maxPlanSteps: 10,
      stepMaxRounds: 15,
    },
  })

  const reply = await agent.chat('读取 package.json，分析项目依赖，然后列出 src 目录结构')
  console.log('Agent 回复:', reply)
}

// ==================== 示例 2: 流式 + 进度事件 ====================

async function example2_agentStream() {
  console.log('\n=== 示例 2: 流式对话 + 进度事件 ===\n')

  const agent = new Agent({
    provider: 'openai',
    apiKey: process.env.OPENAI_API_KEY,
    model: 'gpt-4',
    tools,
    strategy: 'plan_and_execute',
  })

  for await (const event of agent.stream('分析 src 目录下所有 JS 文件的导出结构')) {
    switch (event.type) {
      case 'phase':
        console.log(`\n📋 [${event.phase}] ${event.message}`)
        break
      case 'plan_generated':
        console.log('\n📝 执行计划:')
        event.plan.forEach(s => console.log(`   ${s.index + 1}. ${s.description}`))
        break
      case 'step_start':
        console.log(`\n▶ Step ${event.index + 1}: ${event.description}`)
        break
      case 'step_complete':
        console.log(`${event.success ? '✅' : '❌'} Step ${event.index + 1} (${event.duration}ms)`)
        break
      case 'plan_revised':
        console.log('\n🔄 计划已修订:')
        event.plan.forEach(s => console.log(`   ${s.index + 1}. ${s.description} [${s.status}]`))
        break
      case 'done':
        console.log('\n📌 最终结果:\n', event.content)
        break
    }
  }
}

// ==================== 示例 3: 独立使用 PlanAndExecuteStrategy ====================

async function example3_standalone() {
  console.log('\n=== 示例 3: 独立使用 PlanAndExecuteStrategy ===\n')

  const strategy = new PlanAndExecuteStrategy({
    url: 'https://api.openai.com/v1/chat/completions',
    apiKey: process.env.OPENAI_API_KEY,
    model: 'gpt-4',
    tools,
    maxPlanSteps: 8,
    stepMaxRounds: 10,
    maxReplanAttempts: 1,

    // 进度回调
    onPhase: (phase, msg) => console.log(`[${phase}] ${msg}`),
    onPlanGenerated: (steps) => {
      console.log('执行计划:')
      steps.forEach(s => console.log(`  ${s.index + 1}. ${s.description}`))
    },
    onStepStart: (idx, desc) => console.log(`▶ 步骤 ${idx + 1}: ${desc}`),
    onStepComplete: (idx, ok, result, step) => {
      const icon = ok ? '✅' : '❌'
      console.log(
        `${icon} 步骤 ${idx + 1}: ${result?.substring(0, 100)}... ` +
        `(${step.durationMs}ms, rounds=${step.rounds}, tools=${step.toolCalls.length})`
      )
    },
    onPlanRevised: (steps) => console.log(`🔄 计划修订，剩余 ${steps.length} 步`),
  })

  const { content, plan, toolCallHistory } = await strategy.execute('读取 package.json 和 README.md，总结项目信息')
  console.log('\n最终结果:', content)
  console.log('\n步骤摘要:')
  plan.forEach(s => {
    const icon = s.status === 'completed' ? '✅' : '❌'
    console.log(
      `  ${icon} ${s.description} ` +
      `(rounds=${s.rounds}, tools=${s.toolCalls.length}, ` +
      `tokens=${s.usage.input_tokens + s.usage.output_tokens})`
    )
  })
  console.log(`\n跨步工具调用共 ${toolCallHistory.length} 次`)
}

// ==================== 示例 4: 动态策略选择 ====================

async function example4_dynamicStrategy() {
  console.log('\n=== 示例 4: 根据任务复杂度动态选择策略 ===\n')

  function chooseStrategy(message) {
    const complexKeywords = ['重构', '迁移', '分析整个', '批量修改', '全面检查', '所有文件']
    return complexKeywords.some(k => message.includes(k)) ? 'plan_and_execute' : 'react'
  }

  const messages = [
    '读取 package.json',                    // → react
    '分析整个项目架构并生成文档',              // → plan_and_execute
    '现在几点了',                            // → react
    '批量修改所有文件中的废弃 API 调用',       // → plan_and_execute
  ]

  for (const msg of messages) {
    const strategy = chooseStrategy(msg)
    console.log(`"${msg}" → 策略: ${strategy}`)
  }
}

// ==================== 运行 ====================

// 示例 4 不需要 API Key，可以直接运行
await example4_dynamicStrategy()

// 以下示例需要 API Key
if (process.env.OPENAI_API_KEY) {
  await example1_agentChat()
  await example2_agentStream()
  await example3_standalone()
} else {
  console.log('\n提示: 设置 OPENAI_API_KEY 环境变量以运行完整示例')
}
