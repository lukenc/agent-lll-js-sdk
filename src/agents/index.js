/**
 * Subagent 系统的公开面。
 *
 * 导出的是**注册表与错误类**，不是实现件：`handle.js` / `registry.js` /
 * `runner.js` / `graph.js` / `mailbox.js` / `ask.js` / `isolation.js` /
 * `mirror.js` 都由 `createSubagentRuntime` 自己装配持有，形状还会随需求走，
 * 一导出就等于冻结。取舍与 `mcp/index.js`（只出 `createMCPClient` +
 * `registerTransport` + 错误类）、`skills/index.js` 一致。
 *
 * 契约测试在 `index.test.js`：那里逐一点名了不得外泄的内部件。
 */
export { createSubagentRuntime } from './runtime.js'
export {
  registerAgentType,
  getAgentType,
  listAgentTypes,
  unregisterAgentType,
  resetAgentTypes,
  AGENT_TYPE_NAME_RE,
  INITIAL_AGENT_TYPES,
} from './types.js'
export { registerA2ATransport, RESERVED_A2A_TRANSPORTS } from './a2a/index.js'
export { SUBAGENT_TOOL_NAMES } from './tools.js'
export {
  SubagentError,
  AgentTypeError,
  AgentGraphError,
  A2AError,
  WorktreeIsolationError,
} from './errors.js'
