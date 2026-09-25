#!/usr/bin/env node
/**
 * Image Chart MCP Server —— 返回 `image` 内容部件的最小 MCP server，演示"MCP 工具回灌图片"。
 *
 * 零依赖(Node 18+ 内置 readline + zlib),stdio JSON-RPC。
 * 工具 render_bar_chart:画红/蓝/绿三根柱子。柱高取环境变量 CHART_HEIGHTS
 * (逗号分隔的三个 1..220 整数,依次对应 red,blue,green),缺省 90,210,150。
 * 文字部分**不透露**哪根最高 —— 答案只在图里,模型必须看图。
 *
 *   CHART_HEIGHTS=150,90,210 node demo/mcp-servers/image-chart.js
 */
import readline from 'node:readline'
import { barChartPng } from '../lib/png.js'

const PROTOCOL_VERSION = '2025-11-25'
const HEIGHTS = parseHeights(process.env.CHART_HEIGHTS)

function parseHeights(raw) {
  const hs = String(raw ?? '').split(',').map(Number)
  return hs.length === 3 && hs.every(h => Number.isInteger(h) && h >= 1 && h <= 220) ? hs : [90, 210, 150]
}

const TOOLS = [{
  name: 'render_bar_chart',
  title: 'Render Bar Chart',
  description: '渲染本季度红/蓝/绿三个产品线的销售柱状图,返回 PNG 图片。',
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true, idempotentHint: true },
}]

function handle(msg) {
  if (msg == null || msg.id == null) return null
  switch (msg.method) {
    case 'initialize':
      return { jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: { name: 'image-chart', version: '1.0.0' },
        capabilities: { tools: {} },
      } }
    case 'tools/list':
      return { jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } }
    case 'tools/call':
      if (msg.params?.name !== 'render_bar_chart') {
        return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `未知工具: ${msg.params?.name}` }], isError: true } }
      }
      return { jsonrpc: '2.0', id: msg.id, result: { content: [
        { type: 'text', text: '柱状图已渲染:红、蓝、绿三根柱子。' },
        { type: 'image', mimeType: 'image/png', data: barChartPng(HEIGHTS).toString('base64') },
      ] } }
    default:
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } }
  }
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line) return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  const response = handle(msg)
  if (response) process.stdout.write(JSON.stringify(response) + '\n')
})
rl.on('close', () => process.exit(0))
