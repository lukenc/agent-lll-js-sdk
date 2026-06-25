// Feature: mcp-client-integration, Task 16.3: regression SMOKE test for src/index.js exports
//
// Asserts that:
//   - All existing symbols exported before this feature landed are still exported (Req 9.4).
//   - All new MCP-related symbols (Task 16.2 / 7.1) are exported and have the right shape.
//   - All new BASE_TOOLS CRUD symbols (Task 19.5) are exported with reference identity
//     preserved across the re-export chain (pkg.X === toolFilter.X).
//
// Requirements: 9.4 (plus 10.1-10.4 indirectly via the error-class checks,
// and 11.1 via the BASE_TOOLS CRUD reference identity check).

import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import * as pkg from './index.js'
import * as filterMod from './tool-filter.js'

const EXISTING_SYMBOLS = [
  'Agent',
  'defineTool', 'formatToolsForOpenAI', 'parseToolCalls', 'formatToolResult',
  'SlidingWindowMemory', 'SummarizingMemory', 'TokenAwareMemory',
  'resolveProviderUrl', 'registerProvider',
  'IntentRecognizer', 'defaultIntentResult',
  'ToolFilter', 'BASE_TOOLS',
  'KnowledgeBase', 'createKnowledgeEntry',
  'ContextManager', 'defaultTokenBudget', 'estimateTokens',
  'streamChat', 'syncChat', 'streamChatIter', 'LlmApiError', 'withRetry',
  'PlanAndExecuteStrategy', 'PlanStep', 'StepStatus', 'parsePlan',
  'TelemetryBus', 'newTraceId', 'newSpanId', 'childContext', 'extractUsage', 'utf8ByteLength',
]

const NEW_MCP_SYMBOLS = [
  'createMCPClient', 'registerTransport', 'MCP_Client',
  'UnsupportedTransportError', 'MCPClosedError', 'MCPRequestError', 'MCPProtocolError',
  'MCP_TOOL_METADATA_KEYS', 'attachMcpToolMetadata', 'describeMcpToolForModel',
  'formatMcpToolSummary', 'readMcpToolMetadata', 'serializeMcpToolForBrowser',
  'summarizeMcpOutputSchema',
]

const NEW_BASE_TOOLS_SYMBOLS = [
  'INITIAL_BASE_TOOLS',
  'registerBaseTool', 'unregisterBaseTool',
  'setBaseTools', 'clearBaseTools', 'resetBaseTools',
  'isBaseTool', 'getBaseTools',
]

test('[SMOKE] src/index.js — all existing symbols still exported (Req 9.4)', () => {
  for (const sym of EXISTING_SYMBOLS) {
    assert.notEqual(
      typeof pkg[sym], 'undefined',
      `missing existing export: ${sym}`
    )
  }
})

test('[SMOKE] src/index.js — new MCP symbols exported', () => {
  for (const sym of NEW_MCP_SYMBOLS) {
    assert.notEqual(
      typeof pkg[sym], 'undefined',
      `missing new MCP export: ${sym}`
    )
  }
  assert.equal(typeof pkg.createMCPClient, 'function', 'createMCPClient should be a function')
  assert.equal(typeof pkg.registerTransport, 'function', 'registerTransport should be a function')
})

test('[SMOKE] MCP error classes are Error subclasses with expected fields', () => {
  const u = new pkg.UnsupportedTransportError('foo', ['stdio', 'http'])
  assert.ok(u instanceof Error)
  assert.ok(u.message.includes('foo'), 'UnsupportedTransportError.message should contain requested name')

  const c = new pkg.MCPClosedError()
  assert.ok(c instanceof Error)

  const r = new pkg.MCPRequestError('tools/call timed out', { code: -32000, toolName: 'echo' })
  assert.ok(r instanceof Error)
  assert.equal(r.code, -32000)
  assert.equal(r.toolName, 'echo')

  const p = new pkg.MCPProtocolError('bad frame', { kind: 'malformed_frame' })
  assert.ok(p instanceof Error)
  assert.equal(p.kind, 'malformed_frame')
})

test('[SMOKE] BASE_TOOLS CRUD exports are present and share reference identity with tool-filter.js', () => {
  for (const sym of NEW_BASE_TOOLS_SYMBOLS) {
    assert.notEqual(
      typeof pkg[sym], 'undefined',
      `missing new BASE_TOOLS CRUD export: ${sym}`
    )
  }
  // Reference identity — the exports from src/index.js must be the same
  // bindings as tool-filter.js, guaranteeing transparent re-export semantics
  // (so tests / consumers can rely on live mutations being visible everywhere).
  assert.equal(pkg.BASE_TOOLS, filterMod.BASE_TOOLS, 'BASE_TOOLS must be the same Set reference')
  for (const sym of NEW_BASE_TOOLS_SYMBOLS) {
    assert.equal(
      pkg[sym], filterMod[sym],
      `${sym} should be the same reference as exported from tool-filter.js`
    )
  }
})

test('[SMOKE] INITIAL_BASE_TOOLS is a frozen array of exactly 6 initial names', () => {
  assert.ok(Array.isArray(pkg.INITIAL_BASE_TOOLS), 'INITIAL_BASE_TOOLS must be an array')
  assert.equal(pkg.INITIAL_BASE_TOOLS.length, 6)
  assert.ok(Object.isFrozen(pkg.INITIAL_BASE_TOOLS), 'INITIAL_BASE_TOOLS must be Object.frozen')
  const expected = ['keyword_search', 'read_file', 'write_file', 'shell_exec', 'project_tree', 'ask_user']
  assert.deepEqual(
    [...pkg.INITIAL_BASE_TOOLS].sort(),
    expected.sort(),
    'INITIAL_BASE_TOOLS must contain exactly the 6 documented names'
  )
})

test('[SMOKE] src/index.js — runtime history and memory policy APIs exported', () => {
  for (const name of [
    'RuntimeHistory',
    'SlidingWindowPolicy',
    'TokenBudgetPolicy',
    'SummaryPolicy',
    'estimateMessageTokens',
  ]) {
    assert.ok(name in pkg, `${name} should be exported`)
  }
})
