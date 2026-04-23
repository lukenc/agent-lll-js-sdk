/**
 * 基础用法示例 — 3 行代码创建一个能调用工具的 Agent
 *
 * 运行：OPENAI_API_KEY=sk-xxx node examples/basic.js
 */
import { Agent, defineTool } from '../src/index.js'

// 定义工具
const getCurrentTime = defineTool({
  name: 'get_current_time',
  description: '获取当前时间',
  parameters: { type: 'object', properties: {} },
  execute: async () => new Date().toISOString(),
})

const calculate = defineTool({
  name: 'calculate',
  description: '计算数学表达式',
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: '数学表达式，如 2+3*4' },
    },
    required: ['expression'],
  },
  execute: async ({ expression }) => {
    // 简单的安全计算（生产环境应使用 mathjs 等库）
    const result = Function(`"use strict"; return (${expression})`)()
    return String(result)
  },
})

// 创建 Agent
const agent = new Agent({
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4',
  systemPrompt: '你是一个有用的助手，可以查询时间和做数学计算。',
  tools: [getCurrentTime, calculate],
})

// 同步对话
console.log('--- 同步对话 ---')
const reply = await agent.chat('现在几点了？然后帮我算一下 123 * 456')
console.log('Agent:', reply)

// 流式对话
console.log('\n--- 流式对话 ---')
agent.reset()
for await (const event of agent.stream('先告诉我现在的时间，再算 2^10')) {
  switch (event.type) {
    case 'delta':
      process.stdout.write(event.content)
      break
    case 'tool_start':
      console.log(`\n[调用工具: ${event.name}]`)
      break
    case 'tool_end':
      console.log(`[工具结果: ${event.result}]`)
      break
    case 'done':
      console.log('\n--- 完成 ---')
      break
  }
}
