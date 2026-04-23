/**
 * DeepSeek 供应商示例 — 演示多供应商支持
 *
 * 运行：DEEPSEEK_API_KEY=sk-xxx node examples/deepseek.js
 */
import { Agent, defineTool } from '../src/index.js'
import { readFile } from 'fs/promises'

const readFileTool = defineTool({
  name: 'read_file',
  description: '读取指定路径的文件内容',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
    },
    required: ['path'],
  },
  execute: async ({ path }) => {
    try {
      return await readFile(path, 'utf-8')
    } catch (err) {
      return `Error reading file: ${err.message}`
    }
  },
})

const agent = new Agent({
  provider: 'deepseek',
  apiKey: process.env.DEEPSEEK_API_KEY,
  model: 'deepseek-chat',
  systemPrompt: '你是一个代码分析助手。',
  tools: [readFileTool],
})

const reply = await agent.chat('读取 package.json 并告诉我这个项目的名称和版本')
console.log(reply)
