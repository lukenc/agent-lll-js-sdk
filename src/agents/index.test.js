/**
 * Subagent 系统的公开面契约。
 *
 * 这个文件是"什么算公开 API"的唯一裁决处：`agents/index.js` 与 `src/index.js`
 * 必须导出同一批名字，内部件必须一个都不外泄。照 `mcp/index.js` / `skills/index.js`
 * 的取舍 —— 主机需要的是注册表与错误类，不是 handle / registry / runner / graph
 * 这些实现件（它们的形状还会改，导出即冻结）。
 */
import test from 'node:test'
import assert from 'node:assert'
import * as agents from './index.js'
import * as sdk from '../index.js'

/** 公开面。加一个名字进这里 = 承诺它此后不再随意改。 */
const EXPECTED = [
  'createSubagentRuntime',
  'registerAgentType', 'getAgentType', 'listAgentTypes', 'unregisterAgentType', 'resetAgentTypes',
  'AGENT_TYPE_NAME_RE', 'INITIAL_AGENT_TYPES',
  'registerA2ATransport', 'RESERVED_A2A_TRANSPORTS',
  'SUBAGENT_TOOL_NAMES',
  'SubagentError', 'AgentTypeError', 'AgentGraphError', 'A2AError', 'WorktreeIsolationError',
]

/**
 * 内部件。列在这里的名字**必须**不可从公开面拿到 —— 逐一点名而不是只测一个
 * 哨兵，因为漏导出一个内部件是无声的：它会一直能用，直到某天它的形状要改。
 */
const INTERNAL = [
  // handle / registry / runner / graph / mailbox / ask / mirror / isolation
  'AgentHandle', 'AgentRegistry', 'SubagentRunner', 'AgentGraph', 'Mailbox', 'AskRegistry',
  'ArtifactTrack', 'wrapMemoryForMirror', 'createWorktree', 'removeWorktree',
  // 工具工厂与 contract 常量：由 runtime 自己装配，主机不该手搓
  'createSubagentTools', 'renderContract', 'AGENT_TOOL_DESCRIPTION', 'AGENT_GRAPH_DESCRIPTION',
  'GRAPH_CLOSE_DESCRIPTION', 'GRAPH_REACTIVATE_DESCRIPTION',
  // a2a 内部：解析器与内部注册入口
  'encodeEnvelope', 'decodeEnvelope', 'resolveA2ATransport', '_setBuiltinTransport',
  'createLocalTransport',
  // 其余实现细节
  'searchHistory', 'getHistoryEvent', 'fnv1a32', 'classifyFailure', 'cancelHandle',
  'resolveModel', 'resolveModelAliases', 'modelEnum',
]

test('agents barrel 导出齐全', () => {
  for (const name of EXPECTED) {
    assert.notStrictEqual(agents[name], undefined, `agents/index.js 缺少 ${name}`)
  }
})

test('SDK 顶层同样导出', () => {
  for (const name of EXPECTED) {
    assert.notStrictEqual(sdk[name], undefined, `src/index.js 缺少 ${name}`)
  }
})

test('两处导出的是同一个绑定', () => {
  for (const name of EXPECTED) {
    assert.strictEqual(sdk[name], agents[name], `${name} 在两处不是同一个绑定`)
  }
})

test('内部件不外泄', () => {
  for (const name of INTERNAL) {
    assert.strictEqual(agents[name], undefined, `agents/index.js 泄露了内部件 ${name}`)
    assert.strictEqual(sdk[name], undefined, `src/index.js 泄露了内部件 ${name}`)
  }
})

test('测试替身不外泄', () => {
  assert.strictEqual(agents.fakeAgentFactory, undefined)
})

test('公开面没有多余导出', () => {
  const extra = Object.keys(agents).filter(k => !EXPECTED.includes(k))
  assert.deepStrictEqual(extra, [], `agents/index.js 有未登记的导出：${extra.join(', ')}`)
})

test('导出的东西类型正确', () => {
  for (const name of [
    'createSubagentRuntime', 'registerAgentType', 'getAgentType', 'listAgentTypes',
    'unregisterAgentType', 'resetAgentTypes', 'registerA2ATransport',
  ]) {
    assert.strictEqual(typeof agents[name], 'function', `${name} 应该是函数`)
  }
  for (const name of ['SubagentError', 'AgentTypeError', 'AgentGraphError', 'A2AError', 'WorktreeIsolationError']) {
    assert.strictEqual(typeof agents[name], 'function', `${name} 应该是 class`)
    assert.ok(Object.create(agents[name].prototype) instanceof Error, `${name} 应该继承 Error`)
  }
  assert.ok(agents.AGENT_TYPE_NAME_RE instanceof RegExp)
  assert.ok(Array.isArray(agents.INITIAL_AGENT_TYPES))
  assert.ok(agents.RESERVED_A2A_TRANSPORTS instanceof Set)
  assert.ok(Array.isArray(agents.SUBAGENT_TOOL_NAMES))
})

test('SUBAGENT_TOOL_NAMES 就是 12 个元工具', () => {
  assert.deepStrictEqual([...agents.SUBAGENT_TOOL_NAMES].sort(), [
    'agent', 'agent_cancel', 'agent_graph', 'agent_status',
    'artifact_list', 'artifact_write',
    'graph_close', 'graph_reactivate', 'graph_start',
    'history_get', 'history_search', 'send_message',
  ])
})
