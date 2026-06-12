#!/usr/bin/env node
/**
 * SearXNG MCP Server — 对接本地 SearXNG 实例做实时多引擎搜索
 *
 * SearXNG 是开源的元搜索引擎,聚合 Google/Bing/DuckDuckGo/Brave/百度 等几十个
 * 引擎的结果,本地 Docker 一键起,免 API Key,实时搜索。
 *
 * 本 MCP server 零依赖(只用 Node 18+ 内置 fetch + readline),通过 stdio
 * JSON-RPC 与 MCP Client 通信。它把 SearXNG 的 /search?format=json 接口
 * 包装成 MCP 的 search / fetch_page 工具。
 *
 * 环境变量:
 *   SEARXNG_URL  — SearXNG 实例地址,默认 http://localhost:8888
 *
 * 启动:
 *   SEARXNG_URL=http://localhost:8888 node demo/mcp-servers/searxng-search.js
 * 或通过 demo server 的 MCP 面板选"SearXNG 搜索"预设自动启动。
 */

import readline from 'node:readline'

const PROTOCOL_VERSION = '2025-03-26'
const SEARXNG_URL = (process.env.SEARXNG_URL || 'http://localhost:8888').replace(/\/$/, '')
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// ==================== 工具实现 ====================

/**
 * 调 SearXNG 的 JSON API 搜索。返回标题/URL/摘要/来源引擎。
 */
async function search(query, limit = 5) {
  const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json`
  let res
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
    })
  } catch (err) {
    return `搜索失败: 无法连接 SearXNG (${SEARXNG_URL}). 请确认 SearXNG 已启动. 原因: ${err.message}`
  }
  if (!res.ok) {
    return `搜索失败: SearXNG 返回 HTTP ${res.status}. 如果是 403,请确认 settings.yml 里 formats 含 json.`
  }

  const data = await res.json()
  const results = (data.results || []).slice(0, limit).map((r) => ({
    title: r.title,
    url: r.url,
    description: (r.content || '').slice(0, 300),
    engine: r.engine,
  }))

  if (results.length === 0) {
    return JSON.stringify({
      query,
      totalResults: 0,
      note: '无结果. 可能所有引擎都超时(国内网络下 Google/DDG 常超时),或搜索词太特殊.',
      results: [],
    }, null, 2)
  }

  return JSON.stringify({
    query,
    totalResults: results.length,
    results,
  }, null, 2)
}

/**
 * 抓取网页内容 —— 去 HTML 标签返回纯文本。
 */
async function fetchPage(url, maxChars = 8000) {
  let res
  try {
    res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow' })
  } catch (err) {
    return `抓取失败: ${err.message}`
  }
  if (!res.ok) return `抓取失败: HTTP ${res.status} ${res.statusText}`

  const html = await res.text()
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()

  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n...(已截断)'
  return text
}

// ==================== MCP 协议 ====================

const TOOLS = [
  {
    name: 'search',
    description: '网络搜索 — 通过 SearXNG 聚合 Google/Bing/DuckDuckGo/百度 等多引擎的实时搜索结果,返回标题、URL、摘要。免费,无需 API Key。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        limit: { type: 'number', description: '返回结果数量(默认 5,最多 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'fetch_page',
    description: '抓取网页内容 — 获取指定 URL 的文本内容(去 HTML 标签)。适合读取搜索结果里的具体页面。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要抓取的网页 URL' },
        maxChars: { type: 'number', description: '最大返回字符数(默认 8000)' },
      },
      required: ['url'],
    },
  },
]

function handleMessage(msg) {
  if (msg == null || msg.id == null) return null
  switch (msg.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          serverInfo: { name: 'searxng-search', version: '1.0.0' },
          capabilities: { tools: {} },
          instructions: `SearXNG 多引擎搜索 MCP Server (后端: ${SEARXNG_URL})`,
        },
      }
    case 'tools/list':
      return { jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } }
    case 'tools/call':
      return null  // 异步处理
    default:
      return {
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `Method not found: ${msg.method}` },
      }
  }
}

async function handleToolCall(msg) {
  const toolName = msg.params?.name
  const args = msg.params?.arguments ?? {}
  try {
    let text
    switch (toolName) {
      case 'search': {
        const limit = Math.min(Math.max(args.limit || 5, 1), 10)
        text = await search(args.query || '', limit)
        break
      }
      case 'fetch_page':
        text = await fetchPage(args.url || '', args.maxChars || 8000)
        break
      default:
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: `未知工具: ${toolName}` }], isError: true },
        }
    }
    return {
      jsonrpc: '2.0',
      id: msg.id,
      result: { content: [{ type: 'text', text }], isError: false },
    }
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id: msg.id,
      result: { content: [{ type: 'text', text: `工具执行出错: ${err.message}` }], isError: true },
    }
  }
}

// ==================== stdio ====================

const rl = readline.createInterface({ input: process.stdin })

rl.on('line', async (line) => {
  if (!line) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.method === 'tools/call' && msg.id != null) {
    const response = await handleToolCall(msg)
    if (response) process.stdout.write(JSON.stringify(response) + '\n')
    return
  }
  const response = handleMessage(msg)
  if (response) process.stdout.write(JSON.stringify(response) + '\n')
})

rl.on('close', () => process.exit(0))
