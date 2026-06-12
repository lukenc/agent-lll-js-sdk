#!/usr/bin/env node
/**
 * 内置 MCP Server: 网络搜索 + 网页抓取
 *
 * 零依赖(只用 Node 18+ 内置 fetch + readline),零 API Key。
 * 通过 stdio JSON-RPC 与 MCP Client 通信。
 *
 * 提供 3 个工具:
 *   - search: 用 Bing 搜索,返回标题/URL/摘要
 *   - fetch_page: 抓取指定 URL 的文本内容(去 HTML 标签)
 *   - get_time: 获取当前时间(演示用)
 *
 * 启动: node demo/mcp-servers/web-search.js
 * 或通过 demo server 的 MCP 面板选"内置搜索"预设自动启动。
 */

import readline from 'node:readline'

const PROTOCOL_VERSION = '2025-03-26'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// ==================== 工具实现 ====================

/**
 * 搜狗搜索 —— 请求搜狗 HTML 页面,用正则提取结果。
 * 不需要 API key,国内直连,服务端渲染(不需要 Playwright)。
 */
async function searchWeb(query, limit = 5) {
  const url = `https://www.sogou.com/web?query=${encodeURIComponent(query)}&num=${limit}`
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    redirect: 'follow',
  })
  if (!res.ok) return [{ title: `搜索失败: HTTP ${res.status}`, url: '', description: '' }]

  const html = await res.text()
  const results = []

  // 搜狗结果标题在 <h3> > <a href="...">...</a>
  const h3Regex = /<h3[^>]*>\s*<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h3>/g
  let match
  while ((match = h3Regex.exec(html)) !== null && results.length < limit) {
    const resultUrl = match[1]
    const title = match[2]
      .replace(/<!--.*?-->/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!title) continue

    // 摘要:h3 后面的文本块
    const afterH3 = html.slice(match.index + match[0].length, match.index + match[0].length + 1000)
    const descMatch = afterH3.match(/<p[^>]*>([\s\S]*?)<\/p>/)
      || afterH3.match(/<div[^>]*class="[^"]*(?:ft|abstract|space-txt)[^"]*"[^>]*>([\s\S]*?)<\/div>/)
    const description = descMatch
      ? descMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 200)
      : ''

    results.push({ title, url: resultUrl, description })
  }

  if (results.length === 0) {
    return [{ title: '未找到结果', url: '', description: '可能是网络问题或搜索词过于特殊' }]
  }
  return results
}

/**
 * 抓取网页内容 —— 去掉 HTML 标签,返回纯文本(截断到 maxChars)。
 */
async function fetchPage(url, maxChars = 8000) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    redirect: 'follow',
  })
  if (!res.ok) return `抓取失败: HTTP ${res.status} ${res.statusText}`

  const html = await res.text()
  // 去 script/style/标签,保留文本
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()

  if (text.length > maxChars) {
    text = text.slice(0, maxChars) + '\n...(已截断)'
  }
  return text
}

// ==================== MCP 协议处理 ====================

const TOOLS = [
  {
    name: 'search',
    description: '网络搜索 — 使用搜狗搜索引擎查找信息,返回标题、URL 和摘要。免费,无需 API Key,国内直连。',
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
    description: '抓取网页内容 — 获取指定 URL 的文本内容(自动去除 HTML 标签)。适合读取搜索结果中的具体页面。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要抓取的网页 URL' },
        maxChars: { type: 'number', description: '最大返回字符数(默认 8000)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'get_time',
    description: '获取当前日期和时间',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
]

function handleMessage(msg) {
  // 通知(无 id)忽略
  if (msg == null || msg.id == null) return null

  switch (msg.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          serverInfo: { name: 'builtin-web-search', version: '1.0.0' },
          capabilities: { tools: {} },
          instructions: '内置网络搜索 MCP Server — 支持 Bing 搜索和网页抓取,零 API Key。',
        },
      }

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: { tools: TOOLS },
      }

    case 'tools/call':
      // 异步处理,返回 null 表示稍后发送
      return null

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
        const results = await searchWeb(args.query || '', limit)
        text = JSON.stringify(results, null, 2)
        break
      }
      case 'fetch_page': {
        text = await fetchPage(args.url || '', args.maxChars || 8000)
        break
      }
      case 'get_time': {
        text = new Date().toLocaleString('zh-CN', { dateStyle: 'full', timeStyle: 'medium' })
        break
      }
      default:
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [{ type: 'text', text: `未知工具: ${toolName}` }],
            isError: true,
          },
        }
    }
    return {
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        content: [{ type: 'text', text }],
        isError: false,
      },
    }
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        content: [{ type: 'text', text: `工具执行出错: ${err.message}` }],
        isError: true,
      },
    }
  }
}

// ==================== stdio 通信 ====================

const rl = readline.createInterface({ input: process.stdin })

rl.on('line', async (line) => {
  if (!line) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }

  // tools/call 是异步的
  if (msg.method === 'tools/call' && msg.id != null) {
    const response = await handleToolCall(msg)
    if (response) process.stdout.write(JSON.stringify(response) + '\n')
    return
  }

  const response = handleMessage(msg)
  if (response) process.stdout.write(JSON.stringify(response) + '\n')
})

rl.on('close', () => process.exit(0))
