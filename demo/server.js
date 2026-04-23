/**
 * Demo 代理服务器 — 转发浏览器请求到 LLM API
 * 运行：OPENAI_API_KEY=sk-xxx node demo/server.js
 * 然后打开 http://localhost:3000
 */
import { createServer } from 'http'
import { readFile } from 'fs/promises'
import { Agent, defineTool } from '../src/index.js'

const PORT = 3000
const API_KEY = process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY
const PROVIDER = process.env.PROVIDER || (process.env.DEEPSEEK_API_KEY ? 'deepseek' : 'openai')
const MODEL = process.env.MODEL || (PROVIDER === 'deepseek' ? 'deepseek-chat' : 'gpt-4')

if (!API_KEY) {
  console.error('请设置环境变量: OPENAI_API_KEY=sk-xxx 或 DEEPSEEK_API_KEY=sk-xxx')
  process.exit(1)
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

let currentStrategy = 'react'

function createAgent(strategy) {
  currentStrategy = strategy || 'react'
  return new Agent({
    provider: PROVIDER,
    apiKey: API_KEY,
    model: MODEL,
    systemPrompt: '你是一个有用的助手，可以查询时间和做数学计算。请用中文回答。',
    tools: [getCurrentTime, calculate],
    strategy: currentStrategy,
  })
}

let agent = createAgent('react')

const server = createServer(async (req, res) => {
  // 静态页面
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const html = await readFile(new URL('./index.html', import.meta.url), 'utf-8')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
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

    try {
      for await (const event of agent.stream(message)) {
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      }
    } catch (err) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`)
    }
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }

  // 重置会话
  if (req.method === 'POST' && req.url === '/reset') {
    agent.reset()
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

server.listen(PORT, () => {
  console.log(`Demo 运行中: http://localhost:${PORT}`)
  console.log(`供应商: ${PROVIDER}, 模型: ${MODEL}`)
  console.log(`默认策略: ${currentStrategy}`)
})

// 防止未捕获的异常导致服务器崩溃
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message)
})
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err.message || err)
})
