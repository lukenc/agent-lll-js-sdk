import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createMCPClient } from './index.js'
import { normalizeCallToolResult } from './normalize.js'
import { isContentResult, imageMeta } from '../content/index.js'

const PNG_B64 = 'iVBORw0KGgo='  // 仅用于 normalize 单测；不解码

describe('normalizeCallToolResult with image parts', () => {
  it('whitelisted image parts become a contentResult; other parts keep their placeholders', () => {
    const r = normalizeCallToolResult({ content: [
      { type: 'text', text: 'hello' },
      { type: 'image', mimeType: 'image/PNG', data: PNG_B64 },
      { type: 'audio', mimeType: 'audio/wav', data: 'x' },
    ] }, 'raw')
    assert.ok(isContentResult(r))
    assert.deepEqual(r.parts, [
      { type: 'text', text: 'hello' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } },
      { type: 'text', text: '[mcp:audio mimeType=audio/wav]' },
    ])
  })
  it('non-whitelisted images keep the legacy placeholder and the result stays a string', () => {
    assert.equal(
      normalizeCallToolResult({ content: [{ type: 'image', mimeType: 'image/svg+xml', data: 'x' }] }, 'raw'),
      '[mcp:image mimeType=image/svg+xml]',
    )
  })
  it('isError results stay strings even with images', () => {
    const r = normalizeCallToolResult({ isError: true, content: [{ type: 'image', mimeType: 'image/png', data: PNG_B64 }] }, 'raw')
    assert.equal(r, 'Error from MCP tool "raw": [mcp:image mimeType=image/png]')
  })
  it('text-only results are byte-identical to before', () => {
    assert.equal(normalizeCallToolResult({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }, 'raw'), 'a\nb')
  })
})

describe('demo image-chart MCP server (real stdio)', () => {
  it('returns a PNG the SDK can read', async () => {
    const server = fileURLToPath(new URL('../../demo/mcp-servers/image-chart.js', import.meta.url))
    const client = await createMCPClient({
      transport: 'stdio', command: process.execPath, args: [server], name: 'chart',
      requestTimeoutMs: 5000, env: { ...process.env, CHART_HEIGHTS: '90,210,150' },
    })
    try {
      const [tool] = await client.listTools()
      assert.equal(tool.name, 'mcp__chart__render_bar_chart')
      const r = await tool.execute({})
      assert.ok(isContentResult(r))
      const meta = imageMeta(r.parts.find(p => p.type === 'image_url').image_url.url)
      assert.deepEqual([meta.mediaType, meta.width, meta.height], ['image/png', 360, 260])
    } finally {
      await client.close()
    }
  })
})
