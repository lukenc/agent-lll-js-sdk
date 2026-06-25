import test from 'node:test'
import assert from 'node:assert/strict'

import {
  attachMcpToolMetadata,
  describeMcpToolForModel,
  serializeMcpToolForBrowser,
} from './metadata.js'

const outputSchema = {
  type: 'object',
  properties: {
    results: { type: 'array' },
    totalResults: { type: 'number' },
  },
  required: ['results'],
}

const icons = [
  { src: 'https://example.test/search.png', mimeType: 'image/png', sizes: ['48x48'] },
]

test('describeMcpToolForModel folds official MCP metadata into an LLM-readable description', () => {
  const text = describeMcpToolForModel({
    name: 'mcp__web__search',
    description: 'Search the web.',
    title: 'Web Search',
    outputSchema,
    execution: { taskSupport: 'optional' },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  })

  assert.match(text, /^Search the web\./)
  assert.match(text, /title=Web Search/)
  assert.match(text, /taskSupport=optional/)
  assert.match(text, /outputSchema=object/)
  assert.match(text, /properties: results, totalResults/)
  assert.match(text, /readOnlyHint=true/)
  assert.match(text, /idempotentHint=true/)
  assert.match(text, /openWorldHint=true/)
})

test('serializeMcpToolForBrowser returns proxy-safe fields plus title/icons/outputSchema/execution/annotations', () => {
  const tool = {
    name: 'mcp__web__search',
    description: 'Search the web.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    title: 'Web Search',
    icons,
    outputSchema,
    execution: { taskSupport: 'optional' },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    _mcp: { rawName: 'search', serverName: 'web', rawDescription: 'Search the web.' },
  }

  const serialized = serializeMcpToolForBrowser(tool)

  assert.equal(serialized.name, 'mcp__web__search')
  assert.equal(serialized.rawName, 'search')
  assert.equal(serialized.serverName, 'web')
  assert.equal(serialized.title, 'Web Search')
  assert.equal(serialized.icons, icons)
  assert.equal(serialized.outputSchema, outputSchema)
  assert.deepEqual(serialized.execution, { taskSupport: 'optional' })
  assert.deepEqual(serialized.annotations, { readOnlyHint: true, idempotentHint: true, openWorldHint: true })
  assert.equal(serialized.rawDescription, 'Search the web.')
  assert.equal(serialized.description, serialized.modelDescription)
  assert.match(serialized.modelDescription, /taskSupport=optional/)
})

test('attachMcpToolMetadata preserves official metadata as non-enumerable browser tool properties', () => {
  const toolDef = {
    name: 'mcp__web__search',
    description: 'Search the web.',
    parameters: { type: 'object', properties: {} },
    execute: async () => '',
  }

  const returned = attachMcpToolMetadata(toolDef, {
    rawName: 'search',
    serverName: 'web',
    rawDescription: 'Search the web.',
    title: 'Web Search',
    icons,
    outputSchema,
    execution: { taskSupport: 'optional' },
    annotations: { readOnlyHint: true },
  })

  assert.equal(returned, toolDef)
  assert.equal(toolDef.title, 'Web Search')
  assert.equal(toolDef.icons, icons)
  assert.equal(toolDef.outputSchema, outputSchema)
  assert.deepEqual(toolDef.execution, { taskSupport: 'optional' })
  assert.deepEqual(toolDef.annotations, { readOnlyHint: true })
  assert.deepEqual(
    Object.keys(toolDef).sort(),
    ['description', 'execute', 'name', 'parameters'],
    'metadata must not become enumerable SDK tool fields'
  )
  assert.deepEqual(toolDef._mcp, {
    serverName: 'web',
    rawName: 'search',
    rawDescription: 'Search the web.',
    title: 'Web Search',
    icons,
    outputSchema,
    execution: { taskSupport: 'optional' },
    annotations: { readOnlyHint: true },
  })
})
