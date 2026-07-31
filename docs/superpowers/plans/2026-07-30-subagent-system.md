# Subagent 系统实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `lll-web-agent` 加上 subagent 能力：主 agent 通过一个普通工具派发明确单一的任务给独立 agent 实例，可并行可排队、可 DAG 惰性编排、可互发消息、可多路向用户提问、产物按 agent 归属记账、失败结构化上抛由主 agent 决策。

**Architecture:** 新目录 `src/agents/`，与 `src/mcp/` `src/skills/` 平级同构。subagent 用**组合**方式复用现有 `Agent` 类（`new Agent({ memory: 镜像包装后的新实例 })`），因此 ReAct 循环、工具执行分类、telemetry、重试、skill/MCP 全部白拿。`agent.js` 只有 7 处增量触点，`tool.js` / `memory.js` / `context-manager.js` / `plan-and-execute.js` 零改动。

**Tech Stack:** 纯 ESM JavaScript（无 TypeScript、无转译）、Node >=18 内置能力（`fetch` / `child_process`）、native `node:test` + `node:assert` 测试、`fast-check` 做调度器性质测试（已是 devDependency）。

**设计依据：** `docs/superpowers/specs/2026-07-30-subagent-system-design.md`。本计划中的章节号引用（§N）均指该 spec。

## Global Constraints

- **零新增运行时依赖。** 只用 Node 18+ 内置能力。`fast-check` 仅用于测试。
- **纯 ESM。** 用 `import` / `export`，不用 `require`。
- **无 TypeScript。** 普通 JavaScript + JSDoc 注解。
- **无 linter / formatter。** 跟随周边文件的既有风格（2 空格缩进、无分号结尾风格与文件内保持一致 —— 现有代码**不用**行尾分号，照抄邻近文件）。
- **未配置 `opts.subagents` 时行为与当前版本逐字节一致。** 无新工具、无新事件、无新消息。
- **`lastStopReason` 取值集合不变**（`'completed'` / `'max_rounds'`，跨包契约，见 CHANGELOG）。keep-alive 超时用新增的独立字段与事件暴露。
- **错误类构造函数只接受白名单标量字段**（`agentId` / `agentName` / `nodeId` / `failureKind` / `cause` 等），绝不接受原始 options 对象 —— 防 apiKey 泄进 `err.message`。照 `src/mcp/errors.js`。
- **入参 `description` 是 3-8 词短标签**（列表显示 / agent 命名 / 日志），**不承载任务内容**；**Task Contract 是自然语言，唯一写在入参 `prompt` 里**；`Tool_Def.description` 指工具自身的说明文字，全文写全称不简称。
- **`agent` 工具的 input_schema 严格固定**为：`description`(required) / `prompt`(required) / `subagent_type` / `model` / `run_in_background` / `isolation`，`additionalProperties: false`。不得增删字段。
- **工具的软失败风格**：入参非法、类型未注册、节点状态不对等情况**返回错误说明字符串**让模型自行纠正，**不 throw**。只有编程错误（如内部不变量破坏）才抛异常。
- **`sha` 用 FNV-1a 32 位十六进制**，用途是变更/冲突检测，非加密，JSDoc 必须标注。
- **并发槽按 depth 分层计数**（`maxConcurrent` 默认 4，每层独立槽池），否则父辈等孙辈会死锁。
- 测试文件与源码同目录（`src/agents/foo.test.js`），所有 HTTP 调用 mock，不需要真实 key。
- 每个任务结束时 `npm test` 全绿（基线 354 个测试）。

## File Structure

**新建（全部在 `src/agents/`）：**

| 文件 | 责任 |
|---|---|
| `errors.js` | 5 个错误类，白名单字段 |
| `types.js` | Agent_Type 注册表 + 内置 `general-purpose` |
| `models.js` | 模型别名表解析（alias → `{ model, apiKey, url }`） |
| `contract.js` | `AGENT_TOOL_DESCRIPTION` 常量 + 渲染子 agent 首条消息 |
| `handle.js` | `AgentHandle` + 状态机迁移校验 |
| `registry.js` | id/name 分配、按 depth 分层槽池、完成态 LRU |
| `mirror.js` | memory 镜像包装（子 agent 消息进共享历史轨） |
| `artifacts.js` | `fnv1a32` + 产物轨写入 + 冲突检测 |
| `history-search.js` | 共享历史轨检索 |
| `runner.js` | 造子 `Agent`、跑、重试、结果格式化、遥测转发 |
| `mailbox.js` | 收件箱 + 注入文本格式化 |
| `a2a/index.js` | Envelope 编解码 + transport 注册表 |
| `a2a/local.js` | 进程内 transport |
| `ask.js` | `AskRegistry` 提问路由 |
| `graph.js` | 节点声明、环检测、ready 集、惰性 spawn、失败传播 |
| `isolation.js` | worktree 隔离（Node-only） |
| `tools.js` | 10 个元工具定义 |
| `runtime.js` | `createSubagentRuntime` 组装全部部件 |
| `index.js` | barrel 导出 |

**修改：**

| 文件 | 改动 |
|---|---|
| `src/agent.js` | 7 处触点（§4）：构造函数配置与工具注入、`enqueueMessage` + 轮边界排空、`ask_user` 升级、`_withSubagentTypesNote`、`ctx` 扩展、keep-alive、`closeSubagents` |
| `src/index.js` | 追加 subagent 导出 |
| `CLAUDE.md` / `README.md` / `CHANGELOG.md` | 文档 |

**阶段划分（每阶段结束时全绿且可用）：**

- **Phase 1（Task 1-8）**：能派 subagent、能查状态、能取消、产物记账、历史检索。
- **Phase 2（Task 9-11）**：轮边界注入、A2A 邮箱与 `send_message`、多路提问路由。
- **Phase 3（Task 12-13）**：DAG 声明与惰性调度、keep-alive。
- **Phase 4（Task 14）**：worktree 隔离。
- **Phase 5（Task 15）**：导出与文档。

---

## Phase 1 — 核心运行时

### Task 1: 错误类与 Agent_Type 注册表

**Files:**
- Create: `src/agents/errors.js`
- Create: `src/agents/types.js`
- Test: `src/agents/errors.test.js`
- Test: `src/agents/types.test.js`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces:
  - `class SubagentError extends Error` — `new SubagentError(message, { agentId?, agentName?, nodeId?, failureKind?, cause? })`，`name = 'SubagentError'`
  - `class AgentTypeError extends Error` — `new AgentTypeError(message, { typeName?, cause? })`
  - `class AgentGraphError extends Error` — `new AgentGraphError(message, { nodeId?, cycle?, cause? })`（`cycle` 是字符串数组）
  - `class A2AError extends Error` — `new A2AError(message, { kind?, transport?, cause? })`
  - `class WorktreeIsolationError extends Error` — `new WorktreeIsolationError(message, { reason?, cause? })`
  - `AGENT_TYPE_NAME_RE = /^[a-z0-9-]{1,64}$/`
  - `INITIAL_AGENT_TYPES` — `Object.freeze` 的内置类型数组（只含 `general-purpose`）
  - `registerAgentType(def) -> Agent_Type`（返回归一化后的副本）
  - `getAgentType(name) -> Agent_Type | null`
  - `listAgentTypes() -> Agent_Type[]`（注册顺序）
  - `unregisterAgentType(name) -> boolean`（内置类型返回 `false` 且不删）
  - `resetAgentTypes() -> void`（回到只有内置类型的状态）
  - Agent_Type 归一化后字段：`{ name, description, systemPrompt, model, tools, maxRounds, maxAttempts, temperature, canSpawn, enableIntentRecognition }`

- [ ] **Step 1: 写 errors.js 的失败测试**

```js
// src/agents/errors.test.js
import test from 'node:test'
import assert from 'node:assert'
import {
  SubagentError, AgentTypeError, AgentGraphError, A2AError, WorktreeIsolationError,
} from './errors.js'

test('SubagentError 只吸收白名单字段', () => {
  const err = new SubagentError('boom', {
    agentId: 'agt_1', agentName: 'explorer-1', nodeId: 'n1',
    failureKind: 'rate_limited',
    apiKey: 'sk-secret', headers: { Authorization: 'Bearer sk-secret' },
  })
  assert.strictEqual(err.name, 'SubagentError')
  assert.strictEqual(err.message, 'boom')
  assert.strictEqual(err.agentId, 'agt_1')
  assert.strictEqual(err.failureKind, 'rate_limited')
  assert.strictEqual(err.apiKey, undefined)
  assert.strictEqual(err.headers, undefined)
  assert.ok(!JSON.stringify({ ...err, message: err.message }).includes('sk-secret'))
})

test('每个错误类都是 Error 且 name 固定', () => {
  const cases = [
    [new AgentTypeError('a', { typeName: 'x' }), 'AgentTypeError'],
    [new AgentGraphError('b', { nodeId: 'n1', cycle: ['n1', 'n2', 'n1'] }), 'AgentGraphError'],
    [new A2AError('c', { kind: 'malformed_frame', transport: 'local' }), 'A2AError'],
    [new WorktreeIsolationError('d', { reason: 'not_a_git_repo' }), 'WorktreeIsolationError'],
  ]
  for (const [err, name] of cases) {
    assert.ok(err instanceof Error)
    assert.strictEqual(err.name, name)
  }
})

test('AgentGraphError 的 cycle 被复制而非引用', () => {
  const cycle = ['n1', 'n2', 'n1']
  const err = new AgentGraphError('cycle', { cycle })
  cycle.push('mutated')
  assert.deepStrictEqual(err.cycle, ['n1', 'n2', 'n1'])
})

test('cause 被保留', () => {
  const root = new Error('root')
  assert.strictEqual(new SubagentError('wrapped', { cause: root }).cause, root)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/agents/errors.test.js`
Expected: FAIL —— `Cannot find module './errors.js'`

- [ ] **Step 3: 实现 errors.js**

```js
/**
 * Subagent 系统的错误类。
 *
 * 与 `mcp/errors.js` 同一策略：构造函数**只**吸收白名单标量字段，绝不接受
 * 原始 options / transport 配置对象 —— 否则 apiKey、Authorization 头、env
 * 变量会顺着 `err.message` 或错误对象的枚举属性泄进日志。
 */

/** @param {Error} err @param {object} fields */
function assign(err, fields) {
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) err[key] = value
  }
}

export class SubagentError extends Error {
  /**
   * @param {string} message
   * @param {object} [opts]
   * @param {string} [opts.agentId]
   * @param {string} [opts.agentName]
   * @param {string} [opts.nodeId]
   * @param {string} [opts.failureKind]
   * @param {unknown} [opts.cause]
   */
  constructor(message, { agentId, agentName, nodeId, failureKind, cause } = {}) {
    super(message)
    this.name = 'SubagentError'
    assign(this, { agentId, agentName, nodeId, failureKind, cause })
  }
}

export class AgentTypeError extends Error {
  constructor(message, { typeName, cause } = {}) {
    super(message)
    this.name = 'AgentTypeError'
    assign(this, { typeName, cause })
  }
}

export class AgentGraphError extends Error {
  /** @param {object} [opts] @param {string[]} [opts.cycle] 环路径（会被浅复制） */
  constructor(message, { nodeId, cycle, cause } = {}) {
    super(message)
    this.name = 'AgentGraphError'
    assign(this, { nodeId, cause })
    if (Array.isArray(cycle)) this.cycle = [...cycle]
  }
}

export class A2AError extends Error {
  constructor(message, { kind, transport, cause } = {}) {
    super(message)
    this.name = 'A2AError'
    assign(this, { kind, transport, cause })
  }
}

export class WorktreeIsolationError extends Error {
  constructor(message, { reason, cause } = {}) {
    super(message)
    this.name = 'WorktreeIsolationError'
    assign(this, { reason, cause })
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/agents/errors.test.js`
Expected: PASS（4 个测试）

- [ ] **Step 5: 写 types.js 的失败测试**

```js
// src/agents/types.test.js
import test from 'node:test'
import assert from 'node:assert'
import {
  registerAgentType, getAgentType, listAgentTypes,
  unregisterAgentType, resetAgentTypes, AGENT_TYPE_NAME_RE,
} from './types.js'
import { AgentTypeError } from './errors.js'

test.beforeEach(() => resetAgentTypes())
test.after(() => resetAgentTypes())

test('内置 general-purpose 存在且带默认值', () => {
  const t = getAgentType('general-purpose')
  assert.strictEqual(t.name, 'general-purpose')
  assert.strictEqual(t.tools, '*')
  assert.strictEqual(t.model, 'main')
  assert.strictEqual(t.canSpawn, false)
  assert.strictEqual(t.enableIntentRecognition, false)
  assert.strictEqual(t.maxRounds, 60)
  assert.strictEqual(t.maxAttempts, 3)
  assert.ok(t.description.length > 0)
  assert.ok(t.systemPrompt.length > 0)
})

test('注册后可查、可列，顺序为注册顺序', () => {
  registerAgentType({ name: 'explorer', description: '只读检索', systemPrompt: 'read only' })
  registerAgentType({ name: 'writer', description: '写文档', systemPrompt: 'write' })
  assert.deepStrictEqual(listAgentTypes().map(t => t.name),
    ['general-purpose', 'explorer', 'writer'])
  assert.strictEqual(getAgentType('explorer').description, '只读检索')
})

test('未注册的类型返回 null', () => {
  assert.strictEqual(getAgentType('nope'), null)
})

test('缺失字段默认继承：model/tools 未给时为 null/"*"', () => {
  const t = registerAgentType({ name: 'x', description: 'd', systemPrompt: 's' })
  assert.strictEqual(t.model, null)   // null = 继承父模型
  assert.strictEqual(t.tools, '*')
})

test('非法 name 抛 AgentTypeError', () => {
  for (const bad of ['', 'Has-Upper', 'has_underscore', 'a'.repeat(65), 'has space']) {
    assert.throws(() => registerAgentType({ name: bad, description: 'd', systemPrompt: 's' }),
      AgentTypeError)
  }
  assert.ok(AGENT_TYPE_NAME_RE.test('ok-name-1'))
})

test('description / systemPrompt 必填', () => {
  assert.throws(() => registerAgentType({ name: 'a', systemPrompt: 's' }), AgentTypeError)
  assert.throws(() => registerAgentType({ name: 'a', description: 'd' }), AgentTypeError)
})

test('tools 必须是 "*" 或字符串数组', () => {
  assert.throws(() => registerAgentType({ name: 'a', description: 'd', systemPrompt: 's', tools: 'read_file' }),
    AgentTypeError)
  const t = registerAgentType({ name: 'b', description: 'd', systemPrompt: 's', tools: ['read_file'] })
  assert.deepStrictEqual(t.tools, ['read_file'])
})

test('内置类型不可覆盖也不可删除', () => {
  assert.throws(() => registerAgentType({ name: 'general-purpose', description: 'd', systemPrompt: 's' }),
    AgentTypeError)
  assert.strictEqual(unregisterAgentType('general-purpose'), false)
  assert.ok(getAgentType('general-purpose'))
})

test('同名自定义类型重复注册 = 替换', () => {
  registerAgentType({ name: 'x', description: 'v1', systemPrompt: 's' })
  registerAgentType({ name: 'x', description: 'v2', systemPrompt: 's' })
  assert.strictEqual(getAgentType('x').description, 'v2')
  assert.strictEqual(listAgentTypes().filter(t => t.name === 'x').length, 1)
})

test('返回值是副本，改它不影响注册表', () => {
  registerAgentType({ name: 'x', description: 'd', systemPrompt: 's', tools: ['a'] })
  const t = getAgentType('x')
  t.description = 'mutated'
  t.tools.push('b')
  assert.strictEqual(getAgentType('x').description, 'd')
  assert.deepStrictEqual(getAgentType('x').tools, ['a'])
})

test('unregister 自定义类型返回 true 且移除', () => {
  registerAgentType({ name: 'x', description: 'd', systemPrompt: 's' })
  assert.strictEqual(unregisterAgentType('x'), true)
  assert.strictEqual(getAgentType('x'), null)
  assert.strictEqual(unregisterAgentType('x'), false)
})
```

- [ ] **Step 6: 运行测试确认失败**

Run: `node --test src/agents/types.test.js`
Expected: FAIL —— `Cannot find module './types.js'`

- [ ] **Step 7: 实现 types.js**

```js
/**
 * Agent_Type 注册表 —— subagent 的"类型"定义（对应 `agent` 工具的
 * `subagent_type` 入参）。类型里定义 systemPrompt、默认模型、可用工具子集。
 *
 * 与 `mcp/transports/index.js` 的保留 transport 名、`skills/provider.js` 的
 * 保留 provider 类型同一策略：内置类型不可被用户代码覆盖或删除。
 */
import { AgentTypeError } from './errors.js'

export const AGENT_TYPE_NAME_RE = /^[a-z0-9-]{1,64}$/

/**
 * 内置类型。`tools: '*'` 表示继承父工具集（但始终排除 agent / agent_graph /
 * graph_start，除非 canSpawn 为 true）。`model: 'main'` 指向模型别名表里的
 * main 别名。
 */
export const INITIAL_AGENT_TYPES = Object.freeze([
  Object.freeze({
    name: 'general-purpose',
    description:
      '通用 agent。适合研究复杂问题、跨文件搜索、执行多步任务。当你不确定该用哪个类型时用它。',
    systemPrompt:
      'You are a focused subagent. You were given one specific task by an orchestrating agent.\n'
      + 'You do NOT share the parent conversation history — everything you need is in the task '
      + 'description, plus whatever you discover with your tools. When project context is missing, '
      + 'use history_search to retrieve it from the session history, or read the project docs.\n'
      + 'Do the task, then reply with your final report. Your final message IS your return value: '
      + 'it goes straight into the orchestrating agent\'s context, so lead with the conclusion and '
      + 'the evidence for it, not a narration of your process.',
    model: 'main',
    tools: '*',
    maxRounds: 60,
    maxAttempts: 3,
    temperature: 0.6,
    canSpawn: false,
    enableIntentRecognition: false,
  }),
])

const BUILTIN_NAMES = new Set(INITIAL_AGENT_TYPES.map(t => t.name))

/** @type {Map<string, object>} 保持插入顺序 = 注册顺序 */
let TYPES = new Map()

function seed() {
  TYPES = new Map(INITIAL_AGENT_TYPES.map(t => [t.name, normalize(t)]))
}

/** 深拷贝到一份可安全外发的普通对象（tools 数组也复制）。 */
function clone(type) {
  return { ...type, tools: Array.isArray(type.tools) ? [...type.tools] : type.tools }
}

function normalize(def) {
  if (!def || typeof def !== 'object') {
    throw new AgentTypeError('registerAgentType: def must be an object')
  }
  const { name } = def
  if (typeof name !== 'string' || !AGENT_TYPE_NAME_RE.test(name)) {
    throw new AgentTypeError(
      `registerAgentType: name must match ${AGENT_TYPE_NAME_RE} (got ${JSON.stringify(name)})`,
      { typeName: typeof name === 'string' ? name : undefined },
    )
  }
  if (typeof def.description !== 'string' || def.description.length === 0) {
    throw new AgentTypeError('registerAgentType: description must be a non-empty string', { typeName: name })
  }
  if (typeof def.systemPrompt !== 'string' || def.systemPrompt.length === 0) {
    throw new AgentTypeError('registerAgentType: systemPrompt must be a non-empty string', { typeName: name })
  }
  const tools = def.tools ?? '*'
  const toolsOk = tools === '*'
    || (Array.isArray(tools) && tools.every(t => typeof t === 'string' && t.length > 0))
  if (!toolsOk) {
    throw new AgentTypeError('registerAgentType: tools must be "*" or an array of tool names', { typeName: name })
  }
  return {
    name,
    description: def.description,
    systemPrompt: def.systemPrompt,
    // null = 未指定 → 运行时继承父模型（见 models.js）
    model: def.model ?? null,
    tools: Array.isArray(tools) ? [...tools] : tools,
    maxRounds: def.maxRounds ?? 60,
    maxAttempts: def.maxAttempts ?? 3,
    temperature: def.temperature ?? 0.6,
    canSpawn: def.canSpawn ?? false,
    enableIntentRecognition: def.enableIntentRecognition ?? false,
  }
}

/** 注册（或替换）一个自定义类型。返回归一化后的副本。 */
export function registerAgentType(def) {
  const type = normalize(def)
  if (BUILTIN_NAMES.has(type.name)) {
    throw new AgentTypeError(
      `registerAgentType: "${type.name}" is a built-in agent type and cannot be overridden`,
      { typeName: type.name },
    )
  }
  TYPES.set(type.name, type)
  return clone(type)
}

export function getAgentType(name) {
  const type = TYPES.get(name)
  return type ? clone(type) : null
}

export function listAgentTypes() {
  return [...TYPES.values()].map(clone)
}

export function unregisterAgentType(name) {
  if (BUILTIN_NAMES.has(name)) return false
  return TYPES.delete(name)
}

export function resetAgentTypes() {
  seed()
}

seed()
```

- [ ] **Step 8: 运行测试确认通过**

Run: `node --test src/agents/types.test.js`
Expected: PASS（11 个测试）

- [ ] **Step 9: 跑全量测试确认无回归**

Run: `npm test`
Expected: 354 + 15 = 369 pass, 0 fail

- [ ] **Step 10: Commit**

```bash
git add src/agents/errors.js src/agents/errors.test.js src/agents/types.js src/agents/types.test.js
git commit -m "feat(agents): add error classes and Agent_Type registry

Whitelist-only error constructors (same pattern as mcp/errors.js) so
credentials cannot leak through err.message. Agent_Type registry with a
built-in general-purpose type that cannot be overridden or removed."
```

---

### Task 2: 模型别名解析与 Task Contract 渲染

**Files:**
- Create: `src/agents/models.js`
- Create: `src/agents/contract.js`
- Test: `src/agents/models.test.js`
- Test: `src/agents/contract.test.js`

**Interfaces:**
- Consumes: `AgentTypeError`（`./errors.js`）
- Produces:
  - `resolveModelAliases(parent, configured) -> Record<string, { model, apiKey, url }>` —— `parent` 是形如 `{ model, apiKey, url, simpleModel, simpleApiKey, simpleUrl }` 的对象（实际传入 `Agent` 实例）。未配置时返回 `{ fast: {...simple 三件套}, main: {...主三件套} }`。
  - `modelEnum(aliases) -> string[]` —— 别名键数组，供 `agent` 工具 schema 用
  - `resolveModel({ requested, type, aliases, parent }) -> { alias, model, apiKey, url }` —— 优先级：入参 `model` > `type.model` > 继承父模型（`alias: null`）。未知别名抛 `AgentTypeError`。
  - `AGENT_TOOL_DESCRIPTION` —— `agent` 工具的 `Tool_Def.description` 字符串常量
  - `renderContract({ description, prompt, inputs, cwd }) -> string` —— 子 agent 首条 user 消息

- [ ] **Step 1: 写 models.js 的失败测试**

```js
// src/agents/models.test.js
import test from 'node:test'
import assert from 'node:assert'
import { resolveModelAliases, modelEnum, resolveModel } from './models.js'
import { AgentTypeError } from './errors.js'

const parent = {
  model: 'gpt-4o', apiKey: 'sk-main', url: 'https://main.example/v1/chat/completions',
  simpleModel: 'gpt-4o-mini', simpleApiKey: 'sk-simple', simpleUrl: 'https://simple.example/v1/chat/completions',
}

test('未配置时默认给出 fast / main 两个别名', () => {
  const aliases = resolveModelAliases(parent, undefined)
  assert.deepStrictEqual(Object.keys(aliases), ['fast', 'main'])
  assert.deepStrictEqual(aliases.fast,
    { model: 'gpt-4o-mini', apiKey: 'sk-simple', url: 'https://simple.example/v1/chat/completions' })
  assert.deepStrictEqual(aliases.main,
    { model: 'gpt-4o', apiKey: 'sk-main', url: 'https://main.example/v1/chat/completions' })
  assert.deepStrictEqual(modelEnum(aliases), ['fast', 'main'])
})

test('主机配置的别名替换默认表，缺失字段回退父配置', () => {
  const aliases = resolveModelAliases(parent, {
    haiku: { model: 'claude-haiku-4-5', apiKey: 'sk-anthropic', url: 'https://api.anthropic.com/v1/messages' },
    cheap: { model: 'deepseek-chat' },   // 只给 model → apiKey/url 回退父主配置
  })
  assert.deepStrictEqual(modelEnum(aliases), ['haiku', 'cheap'])
  assert.strictEqual(aliases.cheap.apiKey, 'sk-main')
  assert.strictEqual(aliases.cheap.url, 'https://main.example/v1/chat/completions')
  assert.strictEqual(aliases.haiku.model, 'claude-haiku-4-5')
})

test('resolveModel 优先级：入参 > 类型 > 继承父', () => {
  const aliases = resolveModelAliases(parent, undefined)
  const type = { model: 'main' }

  const byArg = resolveModel({ requested: 'fast', type, aliases, parent })
  assert.strictEqual(byArg.alias, 'fast')
  assert.strictEqual(byArg.model, 'gpt-4o-mini')

  const byType = resolveModel({ requested: undefined, type, aliases, parent })
  assert.strictEqual(byType.alias, 'main')
  assert.strictEqual(byType.model, 'gpt-4o')

  const inherited = resolveModel({ requested: undefined, type: { model: null }, aliases, parent })
  assert.strictEqual(inherited.alias, null)
  assert.strictEqual(inherited.model, 'gpt-4o')
  assert.strictEqual(inherited.apiKey, 'sk-main')
})

test('未知别名抛 AgentTypeError 且消息列出可用别名', () => {
  const aliases = resolveModelAliases(parent, undefined)
  assert.throws(
    () => resolveModel({ requested: 'opus', type: { model: null }, aliases, parent }),
    (err) => err instanceof AgentTypeError && err.message.includes('fast') && err.message.includes('main'),
  )
})

test('解析结果不把 apiKey 暴露在 alias 枚举里', () => {
  const aliases = resolveModelAliases(parent, undefined)
  assert.ok(!JSON.stringify(modelEnum(aliases)).includes('sk-'))
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/agents/models.test.js`
Expected: FAIL —— `Cannot find module './models.js'`

- [ ] **Step 3: 实现 models.js**

```js
/**
 * 模型别名解析。
 *
 * `agent` 工具的 `model` 入参形状恒为 `{ type: 'string', enum: [...] }`（对齐
 * 参考实现），但 enum 内容由主机配置的别名表生成 —— 本 SDK 是多供应商的，
 * 写死 Claude 型号对 DeepSeek / Qwen 用户毫无意义。
 *
 * 默认两个别名：
 *   fast → Agent 的 simpleModel / simpleApiKey / simpleUrl（既有 sidecar 三件套）
 *   main → Agent 的 model / apiKey / url
 */
import { AgentTypeError } from './errors.js'

/**
 * @param {{ model: string, apiKey: string, url: string,
 *           simpleModel: string, simpleApiKey: string, simpleUrl: string }} parent
 * @param {Record<string, { model?: string, apiKey?: string, url?: string }>|undefined} configured
 * @returns {Record<string, { model: string, apiKey: string, url: string }>}
 */
export function resolveModelAliases(parent, configured) {
  if (!configured || Object.keys(configured).length === 0) {
    return {
      fast: { model: parent.simpleModel, apiKey: parent.simpleApiKey, url: parent.simpleUrl },
      main: { model: parent.model, apiKey: parent.apiKey, url: parent.url },
    }
  }
  /** @type {Record<string, { model: string, apiKey: string, url: string }>} */
  const out = {}
  for (const [alias, spec] of Object.entries(configured)) {
    out[alias] = {
      model: spec?.model ?? parent.model,
      apiKey: spec?.apiKey ?? parent.apiKey,
      url: spec?.url ?? parent.url,
    }
  }
  return out
}

/** 别名键数组，用于 `agent` / `graph_start` 工具 schema 的 enum。不含任何凭据。 */
export function modelEnum(aliases) {
  return Object.keys(aliases)
}

/**
 * 优先级：调用入参 `model` > `Agent_Type.model` > 继承父模型。
 * @returns {{ alias: string|null, model: string, apiKey: string, url: string }}
 */
export function resolveModel({ requested, type, aliases, parent }) {
  const alias = requested ?? type?.model ?? null
  if (alias == null) {
    return { alias: null, model: parent.model, apiKey: parent.apiKey, url: parent.url }
  }
  const spec = aliases[alias]
  if (!spec) {
    throw new AgentTypeError(
      `unknown model alias "${alias}". Available: ${modelEnum(aliases).join(', ')}`,
    )
  }
  return { alias, model: spec.model, apiKey: spec.apiKey, url: spec.url }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/agents/models.test.js`
Expected: PASS（5 个测试）

- [ ] **Step 5: 写 contract.js 的失败测试**

```js
// src/agents/contract.test.js
import test from 'node:test'
import assert from 'node:assert'
import { AGENT_TOOL_DESCRIPTION, renderContract } from './contract.js'

test('Tool_Def.description 讲清两个字段的分工', () => {
  const d = AGENT_TOOL_DESCRIPTION
  // description 是标签，prompt 才是契约
  assert.match(d, /3-8 word/)
  assert.match(d, /`prompt`/)
  // 必须提到子 agent 不继承对话历史（否则模型写不全背景）
  assert.match(d, /does not (inherit|share)|不继承/i)
  // 必须提到 history_search 这条找回项目上下文的路
  assert.match(d, /history_search/)
  // 必须给出快/主力模型的选择指导
  assert.match(d, /model/)
  assert.ok(d.length > 400, 'description 太短，不足以约束契约质量')
})

test('renderContract 输出包含 prompt 原文', () => {
  const text = renderContract({ description: 'Audit auth', prompt: '检查 src/auth 的越权风险，产出问题清单。' })
  assert.ok(text.includes('检查 src/auth 的越权风险，产出问题清单。'))
})

test('renderContract 是确定性的', () => {
  const args = { description: 'd', prompt: 'p' }
  assert.strictEqual(renderContract(args), renderContract(args))
})

test('cwd 存在时作为工作目录事实注入', () => {
  const text = renderContract({ description: 'd', prompt: 'p', cwd: '/tmp/wt/agent-1' })
  assert.ok(text.includes('/tmp/wt/agent-1'))
  assert.match(text, /working directory|工作目录/i)
})

test('cwd 缺失时不出现空的工作目录段', () => {
  const text = renderContract({ description: 'd', prompt: 'p' })
  assert.ok(!/working directory|工作目录/i.test(text))
})

test('inputs 渲染为上游产物段，含 key 与摘要', () => {
  const text = renderContract({
    description: 'd', prompt: 'p',
    inputs: [
      { key: 'docs/findings.md', agentName: 'explorer-1', summary: '6 处问题', sha: 'a1b2c3d4' },
      { key: 'src/probe.js', agentName: 'explorer-2', summary: '探针脚本', sha: 'd4e5f6a7' },
    ],
  })
  assert.ok(text.includes('docs/findings.md'))
  assert.ok(text.includes('explorer-1'))
  assert.ok(text.includes('6 处问题'))
  assert.ok(text.includes('src/probe.js'))
})

test('inputs 为空数组时不出现上游产物段', () => {
  const text = renderContract({ description: 'd', prompt: 'p', inputs: [] })
  assert.ok(!text.includes('upstream'))
})
```

- [ ] **Step 6: 运行测试确认失败**

Run: `node --test src/agents/contract.test.js`
Expected: FAIL —— `Cannot find module './contract.js'`

- [ ] **Step 7: 实现 contract.js**

```js
/**
 * Task Contract 的两件事：
 *
 * 1. `AGENT_TOOL_DESCRIPTION` —— `agent` 工具自身的 `Tool_Def.description`
 *    （模型在工具列表里读到的那段文字）。这是**唯一**引导主 agent 把完整契约
 *    写进入参 `prompt` 的地方，措辞直接决定契约质量。
 * 2. `renderContract` —— 把入参渲染成子 agent 的首条 user 消息。
 *
 * 术语（全文严格区分）：
 *   入参 `description` = 3-8 词短标签，只用于列表显示 / 命名 / 日志，不含任务内容。
 *   入参 `prompt`      = Task Contract 的唯一所在，自然语言。
 */

export const AGENT_TOOL_DESCRIPTION = `Launch a new agent to handle a complex, multi-step task. Each agent type has specific capabilities and tools available to it.

Available agent types are listed in the system prompt. Pass one via subagent_type; if omitted, the general-purpose agent is used.

## When to use

Reach for this when the task matches an available agent type, when you have independent work to run in parallel, or when answering would mean reading across several files — delegate it and you keep the conclusion, not the file dumps. For a single-fact lookup where you already know the file, symbol, or value, search directly. Once you've delegated a search, don't also run it yourself — wait for the result.

## The two text fields are NOT interchangeable

- \`description\`: a 3-8 word label, e.g. "Audit auth flow". It is used for status listings, the agent's name, and logs. It carries NO task content.
- \`prompt\`: the entire task contract, in natural language. This is the only thing the subagent gets.

The subagent does not inherit your conversation history. It starts with its type's system prompt, your \`prompt\`, and its tools — nothing else. A vague prompt produces a subagent that guesses. Write the contract so that a competent stranger could execute it with no further questions:

1. **One single objective.** If you find yourself writing "and then also", split it into two agents instead.
2. **The background it needs.** Names, paths, prior decisions, constraints you already know. Do not make it rediscover what you already have.
3. **The deliverable.** What to produce and where it goes: "return a markdown list of findings" / "write the migration to db/migrations/, then report the file path".
4. **Acceptance criteria.** How it knows it is done and correct.
5. **Constraints and prohibitions.** What it must not touch, change, or assume.

If the subagent needs project context you cannot easily paste, tell it to use \`history_search\` to retrieve it from the session history (including content your own context has since compacted away), or to read the project's docs itself.

## Model choice

Pick with \`model\`. Use the fast tier for mechanical, enumerable work whose result is easy to verify (grep-and-list, mass renames, reading a known file). Use the main tier for design judgement, cross-file reasoning, or anything whose output you will adopt directly. If omitted, the agent type's model is used; if the type declares none, the parent's model is inherited.

## Notes

- The subagent's final report is not shown to the user — relay what matters.
- Subagents run in the background by default; you will be notified when one completes. Pass run_in_background: false for a synchronous run when you need the result before continuing.
- Use send_message with the agent's name or id to continue a previously spawned agent with its context intact; a new agent call starts fresh.
- Never fabricate or predict a pending agent's result. If it has not reported yet, say it is still running.`

/**
 * 渲染子 agent 的首条 user 消息。确定性：同样入参恒得同样文本。
 *
 * @param {object} args
 * @param {string} args.description 3-8 词标签（进标题行，便于子 agent 自我定位）
 * @param {string} args.prompt Task Contract 原文
 * @param {Array<{ key: string, agentName?: string, summary?: string, sha?: string }>} [args.inputs]
 *        上游产物引用（图节点场景）
 * @param {string|null} [args.cwd] worktree 隔离时的工作目录
 * @returns {string}
 */
export function renderContract({ description, prompt, inputs, cwd } = {}) {
  const parts = [`# Task: ${description}`, '', String(prompt ?? '')]

  if (Array.isArray(inputs) && inputs.length > 0) {
    parts.push('', '## Upstream artifacts', '',
      'These were produced by earlier agents in this workflow. Read them before starting.', '')
    for (const input of inputs) {
      const bits = [`- \`${input.key}\``]
      if (input.agentName) bits.push(`by ${input.agentName}`)
      if (input.sha) bits.push(`(sha:${input.sha})`)
      if (input.summary) bits.push(`— ${input.summary}`)
      parts.push(bits.join(' '))
    }
  }

  if (cwd) {
    parts.push('', '## Working directory', '',
      `Your working directory is \`${cwd}\`. All relative paths resolve against it. `
      + 'You are working on an isolated copy of the repository; changes here do not affect '
      + 'other agents.')
  }

  return parts.join('\n')
}
```

- [ ] **Step 8: 运行测试确认通过**

Run: `node --test src/agents/contract.test.js`
Expected: PASS（7 个测试）

- [ ] **Step 9: 跑全量测试**

Run: `npm test`
Expected: 381 pass, 0 fail

- [ ] **Step 10: Commit**

```bash
git add src/agents/models.js src/agents/models.test.js src/agents/contract.js src/agents/contract.test.js
git commit -m "feat(agents): add model alias resolution and Task Contract rendering

The agent tool's model enum is generated from the host's alias table
(default fast/main mapping to the existing simpleModel and main triples),
so multi-provider setups don't inherit Claude-specific model names.

AGENT_TOOL_DESCRIPTION is the only thing steering contract quality, so it
spells out that description is a 3-8 word label and prompt is the whole
contract, and that the subagent inherits no conversation history."
```

---

### Task 3: AgentHandle 与状态机

**Files:**
- Create: `src/agents/handle.js`
- Test: `src/agents/handle.test.js`

**Interfaces:**
- Consumes: `SubagentError`（`./errors.js`）
- Produces:
  - `AGENT_STATES` —— `['pending','queued','running','waiting_input','succeeded','failed','cancelled']`
  - `TERMINAL_STATES = new Set(['succeeded','failed','cancelled'])`
  - `VALID_TRANSITIONS` —— `Record<state, string[]>`
  - `class AgentHandle`，构造 `new AgentHandle({ agentId, name, type, description, parentAgentId, depth, nodeId, model, isolation })`
  - 方法：`transition(to)`（非法迁移抛 `SubagentError`）、`beginAttempt()`、`endAttempt({ failureKind, error })`、`toStatus()`（纯数据，**不含 apiKey**）、`isTerminal()`
  - 字段：`state` / `attempt` / `attempts[]` / `result` / `metrics` / `artifactKeys[]` / `createdAt` / `startedAt` / `endedAt`

- [ ] **Step 1: 写失败测试**

```js
// src/agents/handle.test.js
import test from 'node:test'
import assert from 'node:assert'
import { AgentHandle, TERMINAL_STATES } from './handle.js'
import { SubagentError } from './errors.js'

function make(overrides = {}) {
  return new AgentHandle({
    agentId: 'agt_1', name: 'general-purpose-1', type: 'general-purpose',
    description: 'Audit auth flow', parentAgentId: 'main', depth: 1,
    model: { alias: 'fast', model: 'gpt-4o-mini', apiKey: 'sk-secret', url: 'https://x/v1' },
    ...overrides,
  })
}

test('初始状态是 pending，attempt 从 0 开始', () => {
  const h = make()
  assert.strictEqual(h.state, 'pending')
  assert.strictEqual(h.attempt, 0)
  assert.deepStrictEqual(h.attempts, [])
  assert.strictEqual(h.result, null)
  assert.ok(h.createdAt > 0)
})

test('合法迁移链走通', () => {
  const h = make()
  for (const s of ['queued', 'running', 'waiting_input', 'running', 'succeeded']) h.transition(s)
  assert.strictEqual(h.state, 'succeeded')
  assert.ok(h.isTerminal())
})

test('非法迁移抛 SubagentError 且带 agentId', () => {
  const h = make()
  assert.throws(() => h.transition('succeeded'), (err) =>
    err instanceof SubagentError && err.agentId === 'agt_1' && /pending.*succeeded/.test(err.message))
})

test('终态不可再迁移', () => {
  const h = make()
  h.transition('queued'); h.transition('running'); h.transition('cancelled')
  assert.throws(() => h.transition('running'), SubagentError)
})

test('未知状态名抛错', () => {
  assert.throws(() => make().transition('nope'), SubagentError)
})

test('beginAttempt / endAttempt 记录每次尝试', () => {
  const h = make()
  h.transition('queued'); h.transition('running')
  h.beginAttempt()
  assert.strictEqual(h.attempt, 1)
  assert.ok(h.startedAt > 0)
  h.endAttempt({ failureKind: 'rate_limited', error: '429 Too Many Requests' })
  h.beginAttempt()
  h.endAttempt({})
  assert.strictEqual(h.attempt, 2)
  assert.strictEqual(h.attempts.length, 2)
  assert.strictEqual(h.attempts[0].failureKind, 'rate_limited')
  assert.strictEqual(h.attempts[0].error, '429 Too Many Requests')
  assert.strictEqual(h.attempts[1].failureKind, null)
  assert.ok(h.attempts[0].endedAt >= h.attempts[0].startedAt)
})

test('toStatus 是纯数据且绝不含 apiKey', () => {
  const h = make()
  h.transition('queued'); h.transition('running'); h.beginAttempt()
  h.artifactKeys.push('docs/x.md')
  const s = h.toStatus()
  const json = JSON.stringify(s)
  assert.ok(!json.includes('sk-secret'))
  assert.strictEqual(s.model.alias, 'fast')
  assert.strictEqual(s.model.model, 'gpt-4o-mini')
  assert.strictEqual(s.model.apiKey, undefined)
  assert.strictEqual(s.name, 'general-purpose-1')
  assert.strictEqual(s.state, 'running')
  assert.deepStrictEqual(s.artifactKeys, ['docs/x.md'])
  // 快照不与内部数组共享引用
  s.artifactKeys.push('mutated')
  assert.deepStrictEqual(h.artifactKeys, ['docs/x.md'])
})

test('TERMINAL_STATES 就是三个终态', () => {
  assert.deepStrictEqual([...TERMINAL_STATES].sort(), ['cancelled', 'failed', 'succeeded'])
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/agents/handle.test.js`
Expected: FAIL —— `Cannot find module './handle.js'`

- [ ] **Step 3: 实现 handle.js**

```js
/**
 * AgentHandle —— 一个 subagent 实例的身份、状态与度量。
 *
 * 状态机（§2 / §7）：
 *   pending → queued → running → succeeded | failed | cancelled
 *   running ⇄ waiting_input（向用户提问期间）
 * 终态不可再迁移。非法迁移抛 SubagentError —— 这是编程错误，不该软失败。
 */
import { SubagentError } from './errors.js'

export const AGENT_STATES = [
  'pending', 'queued', 'running', 'waiting_input', 'succeeded', 'failed', 'cancelled',
]

export const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled'])

export const VALID_TRANSITIONS = Object.freeze({
  pending: ['queued', 'cancelled'],
  queued: ['running', 'cancelled'],
  running: ['waiting_input', 'succeeded', 'failed', 'cancelled'],
  waiting_input: ['running', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
})

export class AgentHandle {
  constructor({
    agentId, name, type, description,
    parentAgentId = 'main', depth = 1, nodeId = null,
    model = null, isolation = null, now = () => Date.now(),
  }) {
    this.agentId = agentId
    this.name = name
    this.type = type
    this.description = description
    this.parentAgentId = parentAgentId
    this.depth = depth
    this.nodeId = nodeId
    /** @type {{ alias: string|null, model: string, apiKey: string, url: string }|null} */
    this.model = model
    this.isolation = isolation

    this.state = 'pending'
    this.attempt = 0
    /** @type {Array<{ attempt: number, failureKind: string|null, error: string|null, startedAt: number, endedAt: number|null }>} */
    this.attempts = []
    this.result = null
    this.metrics = { rounds: 0, llmCalls: 0, toolCalls: 0, usage: null, wallClockMs: 0 }
    /** @type {string[]} */
    this.artifactKeys = []

    this._now = now
    this.createdAt = now()
    this.startedAt = null
    this.endedAt = null
  }

  isTerminal() {
    return TERMINAL_STATES.has(this.state)
  }

  transition(to) {
    if (!AGENT_STATES.includes(to)) {
      throw new SubagentError(`unknown agent state "${to}"`, { agentId: this.agentId, agentName: this.name })
    }
    const allowed = VALID_TRANSITIONS[this.state]
    if (!allowed.includes(to)) {
      throw new SubagentError(
        `illegal agent state transition ${this.state} -> ${to}`,
        { agentId: this.agentId, agentName: this.name },
      )
    }
    this.state = to
    if (TERMINAL_STATES.has(to)) this.endedAt = this._now()
    return this
  }

  beginAttempt() {
    this.attempt += 1
    const startedAt = this._now()
    if (this.startedAt == null) this.startedAt = startedAt
    this.attempts.push({ attempt: this.attempt, failureKind: null, error: null, startedAt, endedAt: null })
    return this
  }

  /** @param {{ failureKind?: string|null, error?: string|null }} [outcome] */
  endAttempt({ failureKind = null, error = null } = {}) {
    const current = this.attempts[this.attempts.length - 1]
    if (current) {
      current.failureKind = failureKind
      current.error = error
      current.endedAt = this._now()
    }
    return this
  }

  /**
   * 纯数据快照，供 `agent_status` 工具与主机使用。
   * **apiKey 被显式剔除** —— handle 会被序列化进工具结果与事件 payload。
   */
  toStatus() {
    return {
      agentId: this.agentId,
      name: this.name,
      type: this.type,
      description: this.description,
      parentAgentId: this.parentAgentId,
      depth: this.depth,
      nodeId: this.nodeId,
      state: this.state,
      attempt: this.attempt,
      attempts: this.attempts.map(a => ({ ...a })),
      model: this.model ? { alias: this.model.alias, model: this.model.model } : null,
      isolation: this.isolation ? { ...this.isolation } : null,
      metrics: { ...this.metrics },
      artifactKeys: [...this.artifactKeys],
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/agents/handle.test.js`
Expected: PASS（8 个测试）

- [ ] **Step 5: 跑全量测试并 Commit**

```bash
npm test
git add src/agents/handle.js src/agents/handle.test.js
git commit -m "feat(agents): add AgentHandle with an explicit state machine

toStatus() strips apiKey because handles get serialized into tool results
and event payloads."
```

---

### Task 4: AgentRegistry — 命名、分层槽池、完成态 LRU

**Files:**
- Create: `src/agents/registry.js`
- Test: `src/agents/registry.test.js`

**Interfaces:**
- Consumes: `AgentHandle`（`./handle.js`）
- Produces:
  - `class AgentRegistry`，构造 `new AgentRegistry({ maxConcurrent = 4, retainCompleted = 20, now })`
  - `allocateName(type) -> string` —— `<type>-<n>`，n 从 1 递增；已存在则继续加，永不重名
  - `create({ type, description, parentAgentId, depth, nodeId, model, isolation }) -> AgentHandle`
  - `get(idOrName) -> AgentHandle | null` —— 先按 agentId 查，再按 name 查；**重名取最新创建者**
  - `list({ includeFinished = false }) -> AgentHandle[]`
  - `acquireSlot(depth, { signal }) -> Promise<() => void>` —— 返回释放函数；按 depth 分层，槽满时排队（FIFO）
  - `slotsInUse(depth) -> number`
  - `settle(handle)` —— 登记终态并触发完成态 LRU 淘汰（淘汰只丢弃 `_child` 引用，handle 本身保留供 `agent_status --include_finished` 用）
  - `evicted(agentId) -> boolean`

- [ ] **Step 1: 写失败测试**

```js
// src/agents/registry.test.js
import test from 'node:test'
import assert from 'node:assert'
import { AgentRegistry } from './registry.js'

const base = { type: 'general-purpose', description: 'd', parentAgentId: 'main', depth: 1, model: null }

test('agentId 唯一，name 按类型递增', () => {
  const r = new AgentRegistry()
  const a = r.create(base)
  const b = r.create(base)
  assert.notStrictEqual(a.agentId, b.agentId)
  assert.strictEqual(a.name, 'general-purpose-1')
  assert.strictEqual(b.name, 'general-purpose-2')
  assert.match(a.agentId, /^agt_[0-9a-f]{8}$/)
})

test('突发创建不产生 agentId 碰撞（时钟静止也不行）', () => {
  // 回归测试：曾用 (now() & 0xffffff) * 256 + (SEQ & 0xff) 生成 id，只给计数器
  // 留 8 位 —— 同一毫秒内第 257 个 agent 静默覆盖第 1 个，`_byId` 里早先那个
  // handle 再也查不到且不报错。图调度器一次物化多个节点就能触发。
  const r = new AgentRegistry({ now: () => 1700000000000 })
  const ids = new Set()
  const handles = []
  for (let i = 0; i < 1000; i++) {
    const h = r.create(base)
    ids.add(h.agentId)
    handles.push(h)
  }
  assert.strictEqual(ids.size, 1000, 'agentId 必须互不相同')
  assert.strictEqual(r.list({ includeFinished: true }).length, 1000, '不能有 handle 被静默覆盖')
  for (const h of handles) assert.strictEqual(r.get(h.agentId), h)
})

test('不同类型各自计数', () => {
  const r = new AgentRegistry()
  assert.strictEqual(r.create({ ...base, type: 'explorer' }).name, 'explorer-1')
  assert.strictEqual(r.create({ ...base, type: 'writer' }).name, 'writer-1')
  assert.strictEqual(r.create({ ...base, type: 'explorer' }).name, 'explorer-2')
})

test('get 支持 agentId 与 name', () => {
  const r = new AgentRegistry()
  const a = r.create(base)
  assert.strictEqual(r.get(a.agentId), a)
  assert.strictEqual(r.get('general-purpose-1'), a)
  assert.strictEqual(r.get('nope'), null)
})

test('list 默认只给未终态，includeFinished 给全部', () => {
  const r = new AgentRegistry()
  const a = r.create(base)
  const b = r.create(base)
  a.transition('queued'); a.transition('running'); a.transition('succeeded')
  r.settle(a)
  assert.deepStrictEqual(r.list().map(h => h.name), ['general-purpose-2'])
  assert.strictEqual(r.list({ includeFinished: true }).length, 2)
  assert.ok(b)
})

test('槽位：超出 maxConcurrent 的请求排队，释放后 FIFO 放行', async () => {
  const r = new AgentRegistry({ maxConcurrent: 2 })
  const r1 = await r.acquireSlot(1)
  const r2 = await r.acquireSlot(1)
  assert.strictEqual(r.slotsInUse(1), 2)

  let thirdGranted = false
  const third = r.acquireSlot(1).then(release => { thirdGranted = true; return release })
  await new Promise(resolve => setImmediate(resolve))
  assert.strictEqual(thirdGranted, false, '槽满时不应立即放行')

  r1()
  const release3 = await third
  assert.strictEqual(thirdGranted, true)
  r2(); release3()
  assert.strictEqual(r.slotsInUse(1), 0)
})

test('槽位按 depth 分层：depth 1 占满不阻塞 depth 2（防父等孙死锁）', async () => {
  const r = new AgentRegistry({ maxConcurrent: 1 })
  const releaseDepth1 = await r.acquireSlot(1)
  // depth 1 已满。若共用槽池，下面这句会永远挂起。
  const releaseDepth2 = await Promise.race([
    r.acquireSlot(2),
    new Promise((_, reject) => setTimeout(() => reject(new Error('deadlock: depth 2 被 depth 1 阻塞')), 200)),
  ])
  assert.strictEqual(r.slotsInUse(1), 1)
  assert.strictEqual(r.slotsInUse(2), 1)
  releaseDepth1(); releaseDepth2()
})

test('释放函数幂等', async () => {
  const r = new AgentRegistry({ maxConcurrent: 1 })
  const release = await r.acquireSlot(1)
  release(); release()
  assert.strictEqual(r.slotsInUse(1), 0)
})

test('acquireSlot 支持 abort', async () => {
  const r = new AgentRegistry({ maxConcurrent: 1 })
  const release = await r.acquireSlot(1)
  const ac = new AbortController()
  const pending = r.acquireSlot(1, { signal: ac.signal })
  ac.abort()
  await assert.rejects(pending, (err) => err.name === 'AbortError')
  release()
})

test('完成态超过 retainCompleted 时最旧的被淘汰上下文', () => {
  const r = new AgentRegistry({ retainCompleted: 2 })
  const made = []
  for (let i = 0; i < 3; i++) {
    const h = r.create(base)
    h._child = { fake: 'agent instance' }
    h.transition('queued'); h.transition('running'); h.transition('succeeded')
    r.settle(h)
    made.push(h)
  }
  assert.strictEqual(r.evicted(made[0].agentId), true)
  assert.strictEqual(made[0]._child, null)
  assert.strictEqual(r.evicted(made[2].agentId), false)
  assert.ok(made[2]._child)
  // handle 本身仍可查
  assert.ok(r.get(made[0].agentId))
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/agents/registry.test.js`
Expected: FAIL —— `Cannot find module './registry.js'`

- [ ] **Step 3: 实现 registry.js**

```js
/**
 * AgentRegistry —— subagent 的身份分配、并发槽与完成态保留。
 *
 * **并发槽按 depth 分层**（§7）。若全局共用一个槽池，maxConcurrent=4 时 4 个
 * depth 1 的 agent 各自同步派一个 depth 2 的孙 agent，槽会被父辈全占着、孙辈
 * 永远等不到，而父辈又在等孙辈返回 —— 死锁。每层独立槽池让这种死锁在结构上
 * 不可能发生。
 */
import { AgentHandle } from './handle.js'

let SEQ = 0

/**
 * 生成 `agt_` + 8 位十六进制的进程内唯一 id。
 *
 * **纯单调计数器，不混时间位。** 混时间位的写法（`(now() & 0xffffff) * 256 +
 * (SEQ & 0xff)`）只给计数器留 8 位，同一毫秒内第 257 个 agent 就会拿到与第 1 个
 * 相同的 id，而 `_byId.set` 会静默覆盖 —— 早先那个 handle 从此再也查不到，且不
 * 报任何错。图调度器一次物化多个节点就能触发。handle 自己带 `createdAt`，id 里
 * 再编一份创建时间本就是多余的，而正是这份多余挤掉了计数器的位。
 */
function newAgentId() {
  SEQ = (SEQ + 1) >>> 0
  return `agt_${SEQ.toString(16).padStart(8, '0')}`
}

export class AgentRegistry {
  constructor({ maxConcurrent = 4, retainCompleted = 20, now = () => Date.now() } = {}) {
    this.maxConcurrent = maxConcurrent
    this.retainCompleted = retainCompleted
    this._now = now
    /** @type {Map<string, AgentHandle>} agentId → handle（插入序 = 创建序） */
    this._byId = new Map()
    /** @type {Map<string, string>} name → agentId（重名后写覆盖 = 最新者胜） */
    this._byName = new Map()
    /** @type {Map<string, number>} type → 已分配序号 */
    this._nameSeq = new Map()
    /** @type {Map<number, { used: number, queue: Array<{ resolve, reject, signal, onAbort }> }>} */
    this._slots = new Map()
    /** @type {string[]} 终态 agentId，按 settle 顺序 */
    this._completed = []
    /** @type {Set<string>} 已被淘汰上下文的 agentId */
    this._evicted = new Set()
  }

  allocateName(type) {
    let n = (this._nameSeq.get(type) ?? 0) + 1
    let name = `${type}-${n}`
    while (this._byName.has(name)) {
      n += 1
      name = `${type}-${n}`
    }
    this._nameSeq.set(type, n)
    return name
  }

  create({ type, description, parentAgentId = 'main', depth = 1, nodeId = null, model = null, isolation = null }) {
    const agentId = newAgentId()
    const name = this.allocateName(type)
    const handle = new AgentHandle({
      agentId, name, type, description, parentAgentId, depth, nodeId, model, isolation, now: this._now,
    })
    /** 子 Agent 实例，供 send_message 续跑；被 LRU 淘汰后置 null。 */
    handle._child = null
    this._byId.set(agentId, handle)
    this._byName.set(name, agentId)
    return handle
  }

  get(idOrName) {
    if (typeof idOrName !== 'string') return null
    const direct = this._byId.get(idOrName)
    if (direct) return direct
    const viaName = this._byName.get(idOrName)
    return viaName ? this._byId.get(viaName) ?? null : null
  }

  list({ includeFinished = false } = {}) {
    const all = [...this._byId.values()]
    return includeFinished ? all : all.filter(h => !h.isTerminal())
  }

  _slotPool(depth) {
    let pool = this._slots.get(depth)
    if (!pool) {
      pool = { used: 0, queue: [] }
      this._slots.set(depth, pool)
    }
    return pool
  }

  slotsInUse(depth) {
    return this._slotPool(depth).used
  }

  /**
   * 取一个该 depth 层的并发槽。返回释放函数（幂等）。
   * @param {number} depth
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {Promise<() => void>}
   */
  acquireSlot(depth, { signal } = {}) {
    const pool = this._slotPool(depth)

    const makeRelease = () => {
      let released = false
      return () => {
        if (released) return
        released = true
        pool.used -= 1
        this._pump(depth)
      }
    }

    if (signal?.aborted) return Promise.reject(abortError())
    if (pool.used < this.maxConcurrent) {
      pool.used += 1
      return Promise.resolve(makeRelease())
    }

    return new Promise((resolve, reject) => {
      const waiter = { resolve: () => resolve(makeRelease()), reject, signal, onAbort: null }
      if (signal) {
        waiter.onAbort = () => {
          const idx = pool.queue.indexOf(waiter)
          if (idx >= 0) pool.queue.splice(idx, 1)
          reject(abortError())
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      pool.queue.push(waiter)
    })
  }

  _pump(depth) {
    const pool = this._slotPool(depth)
    while (pool.used < this.maxConcurrent && pool.queue.length > 0) {
      const waiter = pool.queue.shift()
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort)
      pool.used += 1
      waiter.resolve()
    }
  }

  /** 登记终态并淘汰最旧的完成态上下文（handle 本身保留，只丢子 Agent 实例）。 */
  settle(handle) {
    if (!this._completed.includes(handle.agentId)) this._completed.push(handle.agentId)
    while (this._completed.length > this.retainCompleted) {
      const victimId = this._completed.shift()
      const victim = this._byId.get(victimId)
      if (victim) victim._child = null
      this._evicted.add(victimId)
    }
  }

  evicted(agentId) {
    return this._evicted.has(agentId)
  }
}

function abortError() {
  const err = new Error('slot acquisition aborted')
  err.name = 'AbortError'
  return err
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/agents/registry.test.js`
Expected: PASS（9 个测试）

- [ ] **Step 5: 跑全量测试并 Commit**

```bash
npm test
git add src/agents/registry.js src/agents/registry.test.js
git commit -m "feat(agents): add AgentRegistry with per-depth concurrency pools

Slots are pooled per depth level. A single global pool deadlocks: with
maxConcurrent=4, four depth-1 agents each spawning a depth-2 agent
synchronously hold every slot while waiting on children that can never
get one."
```

---

### Task 5: memory 镜像与历史检索

**Files:**
- Create: `src/agents/mirror.js`
- Create: `src/agents/history-search.js`
- Test: `src/agents/mirror.test.js`
- Test: `src/agents/history-search.test.js`

**Interfaces:**
- Consumes: `RuntimeHistory`（`../runtime-history.js`，已存在）
- Produces:
  - `wrapMemoryForMirror(inner, { sharedHistory, agentId }) -> memoryLike` —— 代理对象：`add()` 先调 `inner.add()` 再镜像进 `sharedHistory`；其余属性/方法透传 `inner`
  - `agentTrackName(agentId) -> string` —— `agent:<agentId>`
  - `searchHistory(sharedHistory, { query, regex, agentId, role, track, since, until, limit }) -> Array<{ eventId, ts, agentId, role, snippet }>`
  - `getHistoryEvent(sharedHistory, { eventId, before, after }) -> { target, before: [], after: [] } | null`
  - `SNIPPET_RADIUS = 120` / `MAX_SNIPPET = 400` / `DEFAULT_LIMIT = 20` / `MAX_CONTEXT = 10`

- [ ] **Step 1: 写 mirror 的失败测试**

```js
// src/agents/mirror.test.js
import test from 'node:test'
import assert from 'node:assert'
import { RuntimeHistory } from '../runtime-history.js'
import { wrapMemoryForMirror, agentTrackName } from './mirror.js'

function fakeMemory() {
  const added = []
  return {
    added,
    add(msg) { added.push(msg) },
    async getMessages() { return added },
    someField: 42,
  }
}

test('add 先落 inner 再镜像进共享轨', () => {
  const shared = new RuntimeHistory()
  const inner = fakeMemory()
  const m = wrapMemoryForMirror(inner, { sharedHistory: shared, agentId: 'agt_1' })
  m.add({ role: 'user', content: 'hello' })
  assert.strictEqual(inner.added.length, 1)
  assert.strictEqual(shared.size, 1)
  const [event] = shared.getEvents('all')
  assert.strictEqual(event.topicId, 'agt_1')
  assert.ok(event.tracks.includes('internal'))
  assert.ok(event.tracks.includes(agentTrackName('agt_1')))
})

test('子 agent 的消息不进 model 轨（不污染主 agent 的对话投影）', () => {
  const shared = new RuntimeHistory()
  const m = wrapMemoryForMirror(fakeMemory(), { sharedHistory: shared, agentId: 'agt_1' })
  m.add({ role: 'user', content: 'child message' })
  m.add({ role: 'assistant', content: 'child reply' })
  assert.strictEqual(shared.getEvents('model').length, 0)
  assert.strictEqual(shared.projectMessages('model').length, 0)
})

test('回归：摘要消息也不能进 model 轨', () => {
  // RuntimeHistory.appendMessage 遇到 _isSummary 会转调 appendSummary，
  // 而那条路径不透传 meta.tracks，tracks 会落回默认值 ['all','model','internal']。
  // mirror 必须自己判断并直接调 appendSummary。
  const shared = new RuntimeHistory()
  const m = wrapMemoryForMirror(fakeMemory(), { sharedHistory: shared, agentId: 'agt_1' })
  m.add({ role: 'system', content: '[Previous conversation summary]: child compacted', _isSummary: true })
  const events = shared.getEvents('all')
  assert.strictEqual(events.length, 1)
  assert.strictEqual(events[0].type, 'summary')
  assert.ok(!events[0].tracks.includes('model'), '子 agent 摘要泄进了 model 轨')
  assert.strictEqual(events[0].topicId, 'agt_1')
})

test('其余属性与方法透传 inner', async () => {
  const inner = fakeMemory()
  const m = wrapMemoryForMirror(inner, { sharedHistory: new RuntimeHistory(), agentId: 'agt_1' })
  m.add({ role: 'user', content: 'x' })
  assert.strictEqual(m.someField, 42)
  assert.deepStrictEqual(await m.getMessages(), inner.added)
})

test('sharedHistory 为 null 时退化为纯透传', () => {
  const inner = fakeMemory()
  const m = wrapMemoryForMirror(inner, { sharedHistory: null, agentId: 'agt_1' })
  m.add({ role: 'user', content: 'x' })
  assert.strictEqual(inner.added.length, 1)
})

test('镜像写入失败不影响子 agent 自己的 memory', () => {
  const broken = { appendMessage() { throw new Error('disk on fire') }, appendSummary() { throw new Error('nope') } }
  const inner = fakeMemory()
  const m = wrapMemoryForMirror(inner, { sharedHistory: broken, agentId: 'agt_1' })
  m.add({ role: 'user', content: 'x' })
  assert.strictEqual(inner.added.length, 1, '镜像失败不该阻断子 agent')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/agents/mirror.test.js`
Expected: FAIL —— `Cannot find module './mirror.js'`

- [ ] **Step 3: 实现 mirror.js**

```js
/**
 * 把子 agent 的消息**单向镜像**进父 agent 的 RuntimeHistory，让
 * `history_search` 能检索整个会话（含所有 subagent 的轨迹），而子 agent 自己
 * 仍持有独立的 memory（不继承父上下文）。
 *
 * `memory.js` 零改动 —— 这里用代理对象包一层。
 */

export function agentTrackName(agentId) {
  return `agent:${agentId}`
}

function isSummaryMessage(message) {
  return message?.role === 'system' && message._isSummary === true
}

/**
 * @param {object} inner 真正的 memory 实例
 * @param {{ sharedHistory: object|null, agentId: string }} opts
 * @returns {object} 与 `inner` 接口一致的代理
 */
export function wrapMemoryForMirror(inner, { sharedHistory, agentId }) {
  if (!sharedHistory) return inner

  const tracks = ['all', 'internal', agentTrackName(agentId)]

  const mirror = (message) => {
    try {
      if (isSummaryMessage(message)) {
        // 必须显式走 appendSummary：appendMessage 的摘要分支不透传 meta.tracks，
        // tracks 会落回默认值 ['all','model','internal'] —— 子 agent 的摘要就
        // 泄进 model 轨了。当前它只是靠 projectMessages 的 topicId 过滤侥幸不
        // 出事，那是隐式依赖，不能指望。
        sharedHistory.appendSummary({
          content: String(message.content ?? '').replace(/^\[Previous conversation summary\]:\s*/, ''),
          sourceEventIds: [],
          topicId: agentId,
          tracks,
        })
        return
      }
      sharedHistory.appendMessage(message, { topicId: agentId, tracks })
    } catch (err) {
      // 镜像是可观测性设施，不是子 agent 的关键路径。写不进去就算了，
      // 绝不能让它把子 agent 的 memory.add 打断。
      console.warn(`[agents] history mirror failed for ${agentId}:`, err?.message || err)
    }
  }

  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'add') {
        return (message) => {
          const out = target.add(message)
          mirror(message)
          return out
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/agents/mirror.test.js`
Expected: PASS（6 个测试）

- [ ] **Step 5: 写 history-search 的失败测试**

```js
// src/agents/history-search.test.js
import test from 'node:test'
import assert from 'node:assert'
import { RuntimeHistory } from '../runtime-history.js'
import { searchHistory, getHistoryEvent, MAX_SNIPPET } from './history-search.js'

function seed() {
  const h = new RuntimeHistory()
  // 注意：匹配是大小写不敏感的，所以 fixture 里刻意只让 user 那条含 "oauth"
  // 字样，assistant / tool 两条改用别的词 —— 否则 "命中 1 条" 与 "role 过滤后
  // 0 条" 这两个断言会互相矛盾（三条都会命中）。
  h.appendMessage({ role: 'user', content: '帮我看看 OAuth 回调的实现' })
  h.appendMessage({ role: 'assistant', content: '我先读 src/auth/callback.js' })
  h.appendMessage({ role: 'tool', name: 'read_file', content: 'export function handleCallback() { /* 回调入口 */ }' })
  h.appendMessage({ role: 'user', content: '换个话题：数据库迁移' }, { topicId: 'agt_1', tracks: ['all', 'internal'] })
  return h
}

test('子串命中，返回 eventId 与片段', () => {
  const hits = searchHistory(seed(), { query: 'OAuth' })
  assert.strictEqual(hits.length, 1)
  assert.ok(hits[0].eventId)
  assert.strictEqual(hits[0].role, 'user')
  assert.ok(hits[0].snippet.includes('OAuth'))
  assert.ok(hits[0].ts > 0)
})

test('大小写不敏感', () => {
  // fixture 里只有 user 那条含 "OAuth"；用全小写查也应命中它。
  const hits = searchHistory(seed(), { query: 'oauth' })
  assert.strictEqual(hits.length, 1)
  assert.strictEqual(hits[0].role, 'user')
})

test('regex 模式', () => {
  const hits = searchHistory(seed(), { query: 'handle[A-Z]\\w+', regex: true })
  assert.strictEqual(hits.length, 1)
  assert.ok(hits[0].snippet.includes('handleCallback'))
})

test('非法正则降级为子串且不抛', () => {
  const hits = searchHistory(seed(), { query: '(unclosed', regex: true })
  assert.deepStrictEqual(hits, [])
})

test('按 agentId 过滤（topicId）', () => {
  const hits = searchHistory(seed(), { query: '迁移', agentId: 'agt_1' })
  assert.strictEqual(hits.length, 1)
  assert.strictEqual(hits[0].agentId, 'agt_1')
  assert.strictEqual(searchHistory(seed(), { query: '迁移', agentId: 'agt_other' }).length, 0)
})

test('按 role 过滤', () => {
  // "callback" 在 assistant（src/auth/callback.js）与 tool（handleCallback）
  // 两条里都出现，正好用来验证 role 过滤真的在起作用。
  assert.strictEqual(searchHistory(seed(), { query: 'callback' }).length, 2)
  assert.strictEqual(searchHistory(seed(), { query: 'callback', role: 'tool' }).length, 1)
  assert.strictEqual(searchHistory(seed(), { query: 'callback', role: 'assistant' }).length, 1)
  assert.strictEqual(searchHistory(seed(), { query: 'callback', role: 'user' }).length, 0)
})

test('limit 生效，默认 20', () => {
  const h = new RuntimeHistory()
  for (let i = 0; i < 30; i++) h.appendMessage({ role: 'user', content: `needle ${i}` })
  assert.strictEqual(searchHistory(h, { query: 'needle' }).length, 20)
  assert.strictEqual(searchHistory(h, { query: 'needle', limit: 3 }).length, 3)
})

test('片段被截断到 MAX_SNIPPET', () => {
  const h = new RuntimeHistory()
  h.appendMessage({ role: 'user', content: `${'x'.repeat(2000)}needle${'y'.repeat(2000)}` })
  const [hit] = searchHistory(h, { query: 'needle' })
  assert.ok(hit.snippet.length <= MAX_SNIPPET)
  assert.ok(hit.snippet.includes('needle'))
})

test('被 summary 压缩过的原始事件仍可检出（找回记忆）', () => {
  const h = new RuntimeHistory()
  const e1 = h.appendMessage({ role: 'user', content: '早期的关键决定：用 JWT 不用 session' })
  h.appendMessage({ role: 'assistant', content: '好的' })
  h.appendSummary({ content: '讨论了鉴权方案', sourceEventIds: [e1.id] })
  // 投影里原事件已被摘要覆盖
  assert.ok(!h.projectMessages('model').some(m => String(m.content).includes('JWT')))
  // 但检索仍能找到
  const hits = searchHistory(h, { query: 'JWT' })
  assert.strictEqual(hits.length, 1)
})

test('getHistoryEvent 展开前后文，受 MAX_CONTEXT 限制', () => {
  const h = new RuntimeHistory()
  const ids = []
  for (let i = 0; i < 25; i++) ids.push(h.appendMessage({ role: 'user', content: `m${i}` }).id)
  const got = getHistoryEvent(h, { eventId: ids[12], before: 2, after: 3 })
  assert.strictEqual(got.target.message.content, 'm12')
  assert.deepStrictEqual(got.before.map(e => e.message.content), ['m10', 'm11'])
  assert.deepStrictEqual(got.after.map(e => e.message.content), ['m13', 'm14', 'm15'])

  const clamped = getHistoryEvent(h, { eventId: ids[12], before: 999, after: 999 })
  assert.strictEqual(clamped.before.length, 10)
  assert.strictEqual(clamped.after.length, 10)
})

test('getHistoryEvent 未知 id 返回 null', () => {
  assert.strictEqual(getHistoryEvent(seed(), { eventId: 'nope' }), null)
})
```

- [ ] **Step 6: 运行测试确认失败**

Run: `node --test src/agents/history-search.test.js`
Expected: FAIL —— `Cannot find module './history-search.js'`

- [ ] **Step 7: 实现 history-search.js**

```js
/**
 * 共享历史轨的检索。
 *
 * 搜的是 RuntimeHistory 的**原始事件**，不是投影 —— 所以被 SummarizingMemory
 * 压缩掉的内容照样能捞回来（摘要只影响 projectMessages 的跳过逻辑，原事件仍在）。
 * 这是"找回记忆"的实现基础，也是 subagent 不必继承父上下文的前提。
 */

export const SNIPPET_RADIUS = 120
export const MAX_SNIPPET = 400
export const DEFAULT_LIMIT = 20
export const MAX_CONTEXT = 10

/** 把一个事件压成可搜索的纯文本。 */
function searchableText(event) {
  if (event.type === 'summary') return String(event.content ?? '')
  const msg = event.message
  if (!msg) return ''
  const parts = [String(msg.content ?? '')]
  if (msg.name) parts.push(String(msg.name))
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      parts.push(String(tc?.function?.name ?? ''), String(tc?.function?.arguments ?? ''))
    }
  }
  return parts.filter(Boolean).join('\n')
}

function makeSnippet(text, index, length) {
  const start = Math.max(0, index - SNIPPET_RADIUS)
  const end = Math.min(text.length, index + length + SNIPPET_RADIUS)
  let snippet = text.slice(start, end)
  if (start > 0) snippet = `…${snippet}`
  if (end < text.length) snippet = `${snippet}…`
  return snippet.length > MAX_SNIPPET ? `${snippet.slice(0, MAX_SNIPPET - 1)}…` : snippet
}

/**
 * @param {object} sharedHistory RuntimeHistory 实例
 * @param {object} opts
 * @param {string} opts.query 子串或正则源
 * @param {boolean} [opts.regex=false]
 * @param {string} [opts.agentId] 按 topicId 过滤（子 agent 的 topicId 就是 agentId）
 * @param {string} [opts.role]
 * @param {string} [opts.track='all']
 * @param {number} [opts.since] 时间下界（含）
 * @param {number} [opts.until] 时间上界（含）
 * @param {number} [opts.limit=20]
 * @returns {Array<{ eventId: string, ts: number, agentId: string|null, role: string|null, snippet: string }>}
 */
export function searchHistory(sharedHistory, {
  query, regex = false, agentId, role, track = 'all', since, until, limit = DEFAULT_LIMIT,
} = {}) {
  if (!sharedHistory || typeof sharedHistory.getEvents !== 'function') return []
  if (typeof query !== 'string' || query.length === 0) return []

  /** @type {RegExp|null} */
  let re = null
  if (regex) {
    try {
      re = new RegExp(query, 'gi')
    } catch {
      // 正则编译失败 → 降级为子串。返回空结果好过抛错打断子 agent。
      re = null
      if (!query.replace(/[.*+?^${}()|[\]\\]/g, '').trim()) return []
    }
  }
  const needle = query.toLowerCase()

  const out = []
  for (const event of sharedHistory.getEvents(track)) {
    if (out.length >= limit) break
    if (agentId != null && event.topicId !== agentId) continue
    if (since != null && event.timestamp < since) continue
    if (until != null && event.timestamp > until) continue
    const eventRole = event.type === 'summary' ? 'system' : (event.message?.role ?? null)
    if (role != null && eventRole !== role) continue

    const text = searchableText(event)
    if (!text) continue

    let index = -1
    let matchLength = query.length
    if (re) {
      re.lastIndex = 0
      const m = re.exec(text)
      if (m) { index = m.index; matchLength = m[0].length }
    } else {
      index = text.toLowerCase().indexOf(needle)
    }
    if (index < 0) continue

    out.push({
      eventId: event.id,
      ts: event.timestamp,
      agentId: event.topicId ?? null,
      role: eventRole,
      snippet: makeSnippet(text, index, matchLength),
    })
  }
  return out
}

/**
 * 按 eventId 取完整事件并展开前后文。
 * @returns {{ target: object, before: object[], after: object[] }|null}
 */
export function getHistoryEvent(sharedHistory, { eventId, before = 3, after = 3 } = {}) {
  if (!sharedHistory || typeof sharedHistory.getEvents !== 'function') return null
  const events = sharedHistory.getEvents('all')
  const index = events.findIndex(e => e.id === eventId)
  if (index < 0) return null
  const b = Math.max(0, Math.min(MAX_CONTEXT, Number(before) || 0))
  const a = Math.max(0, Math.min(MAX_CONTEXT, Number(after) || 0))
  return {
    target: events[index],
    before: events.slice(Math.max(0, index - b), index),
    after: events.slice(index + 1, index + 1 + a),
  }
}
```

- [ ] **Step 8: 运行测试确认通过**

Run: `node --test src/agents/history-search.test.js`
Expected: PASS（11 个测试）

- [ ] **Step 9: 跑全量测试并 Commit**

```bash
npm test
git add src/agents/mirror.js src/agents/mirror.test.js src/agents/history-search.js src/agents/history-search.test.js
git commit -m "feat(agents): mirror subagent messages into shared history, add search

Subagent messages land on the internal and agent:<id> tracks, never on
model, so the parent's conversation projection stays clean. Summary
messages must go through appendSummary explicitly — appendMessage's
summary branch drops meta.tracks and would leak them onto the model track.

Search runs over raw events, so content the summarizer compacted away is
still retrievable."
```

---

### Task 6: 产物轨与冲突检测

**Files:**
- Create: `src/agents/artifacts.js`
- Test: `src/agents/artifacts.test.js`

**Interfaces:**
- Consumes: `RuntimeHistory`（`appendArtifact` / `project('artifacts')`）、`utf8ByteLength`（`../telemetry.js`，已存在，**不要重写一份**）
- Produces:
  - `fnv1a32(str) -> string` —— 8 位十六进制
  - `class ArtifactTrack`，构造 `new ArtifactTrack({ sharedHistory, policy = 'warn', now })`
  - `write({ key, kind, summary, path, content, supersedes, agentId, agentName, nodeId, attempt }) -> { ok, record, conflict }` —— `conflict` 为 `null` 或 `{ ownerAgentId, ownerAgentName, ownerSha, ownerTs }`；`policy: 'deny'` 且冲突时 `ok: false` 且不写入
  - `list({ agentId, key, since, limit }) -> Artifact_Record[]`
  - `latest(key) -> Artifact_Record | null`

- [ ] **Step 1: 写失败测试**

```js
// src/agents/artifacts.test.js
import test from 'node:test'
import assert from 'node:assert'
import { RuntimeHistory } from '../runtime-history.js'
import { ArtifactTrack, fnv1a32 } from './artifacts.js'

const A = { agentId: 'agt_1', agentName: 'explorer-1', nodeId: null, attempt: 1 }
const B = { agentId: 'agt_2', agentName: 'writer-1', nodeId: null, attempt: 1 }

test('fnv1a32 稳定、定长、内容敏感', () => {
  assert.strictEqual(fnv1a32('hello'), fnv1a32('hello'))
  assert.notStrictEqual(fnv1a32('hello'), fnv1a32('hello!'))
  assert.match(fnv1a32('hello'), /^[0-9a-f]{8}$/)
  assert.match(fnv1a32(''), /^[0-9a-f]{8}$/)
  assert.match(fnv1a32('中文内容'), /^[0-9a-f]{8}$/)
})

test('写入产生带归属的记录并落进 artifacts 轨', () => {
  const shared = new RuntimeHistory()
  const track = new ArtifactTrack({ sharedHistory: shared })
  const { ok, record, conflict } = track.write({
    ...A, key: 'docs/findings.md', kind: 'file', summary: '6 处问题', content: 'body',
  })
  assert.strictEqual(ok, true)
  assert.strictEqual(conflict, null)
  assert.strictEqual(record.agentName, 'explorer-1')
  assert.strictEqual(record.key, 'docs/findings.md')
  assert.strictEqual(record.sha, fnv1a32('body'))
  assert.strictEqual(record.bytes, 4)
  assert.match(record.artifactId, /^art_/)
  assert.strictEqual(shared.project('artifacts').length, 1)
})

test('同一 agent 重复写同一 key 不算冲突', () => {
  const track = new ArtifactTrack({ sharedHistory: new RuntimeHistory() })
  track.write({ ...A, key: 'k', kind: 'text', summary: 's', content: 'v1' })
  const second = track.write({ ...A, key: 'k', kind: 'text', summary: 's', content: 'v2' })
  assert.strictEqual(second.conflict, null)
  assert.strictEqual(second.ok, true)
})

test('另一个 agent 写同 key：warn 策略允许写入但报告 owner', () => {
  const track = new ArtifactTrack({ sharedHistory: new RuntimeHistory(), policy: 'warn' })
  track.write({ ...A, key: 'k', kind: 'text', summary: 's', content: 'v1' })
  const second = track.write({ ...B, key: 'k', kind: 'text', summary: 's', content: 'v2' })
  assert.strictEqual(second.ok, true)
  assert.strictEqual(second.conflict.ownerAgentName, 'explorer-1')
  assert.strictEqual(second.conflict.ownerSha, fnv1a32('v1'))
})

test('deny 策略下拒绝写入且轨道不增长', () => {
  const shared = new RuntimeHistory()
  const track = new ArtifactTrack({ sharedHistory: shared, policy: 'deny' })
  track.write({ ...A, key: 'k', kind: 'text', summary: 's', content: 'v1' })
  const second = track.write({ ...B, key: 'k', kind: 'text', summary: 's', content: 'v2' })
  assert.strictEqual(second.ok, false)
  assert.strictEqual(second.record, null)
  assert.ok(second.conflict)
  assert.strictEqual(shared.project('artifacts').length, 1)
})

test('显式 supersedes 指向对方最新版时不告警', () => {
  const track = new ArtifactTrack({ sharedHistory: new RuntimeHistory(), policy: 'deny' })
  const first = track.write({ ...A, key: 'k', kind: 'text', summary: 's', content: 'v1' })
  const second = track.write({
    ...B, key: 'k', kind: 'text', summary: 's', content: 'v2', supersedes: first.record.artifactId,
  })
  assert.strictEqual(second.ok, true)
  assert.strictEqual(second.conflict, null)
})

test('supersedes 指向过期版本仍算冲突', () => {
  const track = new ArtifactTrack({ sharedHistory: new RuntimeHistory() })
  const first = track.write({ ...A, key: 'k', kind: 'text', summary: 's', content: 'v1' })
  track.write({ ...A, key: 'k', kind: 'text', summary: 's', content: 'v2' })
  const third = track.write({
    ...B, key: 'k', kind: 'text', summary: 's', content: 'v3', supersedes: first.record.artifactId,
  })
  assert.ok(third.conflict, '引用的不是最新版，仍应告警')
})

test('轨道只追加：历史版本全部保留且有序', () => {
  const track = new ArtifactTrack({ sharedHistory: new RuntimeHistory() })
  track.write({ ...A, key: 'k', kind: 'text', summary: 's', content: 'v1' })
  track.write({ ...B, key: 'k', kind: 'text', summary: 's', content: 'v2' })
  const all = track.list({ key: 'k' })
  assert.strictEqual(all.length, 2)
  assert.strictEqual(all[0].sha, fnv1a32('v1'))
  assert.strictEqual(track.latest('k').sha, fnv1a32('v2'))
})

test('list 按 agentId / key / limit 过滤', () => {
  const track = new ArtifactTrack({ sharedHistory: new RuntimeHistory() })
  track.write({ ...A, key: 'k1', kind: 'text', summary: 's', content: 'a' })
  track.write({ ...B, key: 'k2', kind: 'text', summary: 's', content: 'b' })
  assert.strictEqual(track.list({ agentId: 'agt_1' }).length, 1)
  assert.strictEqual(track.list({ key: 'k2' })[0].agentName, 'writer-1')
  assert.strictEqual(track.list({ limit: 1 }).length, 1)
})

test('无 content 时 sha 由 path 派生，bytes 为 null', () => {
  const track = new ArtifactTrack({ sharedHistory: new RuntimeHistory() })
  const { record } = track.write({ ...A, key: 'k', kind: 'file', summary: 's', path: 'docs/x.md' })
  assert.strictEqual(record.sha, fnv1a32('path:docs/x.md'))
  assert.strictEqual(record.bytes, null)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/agents/artifacts.test.js`
Expected: FAIL —— `Cannot find module './artifacts.js'`

- [ ] **Step 3: 实现 artifacts.js**

```js
/**
 * 产物轨 —— 每个 agent 把自己的产出登记到共享的 RuntimeHistory `artifacts` 轨，
 * 记清楚谁产出了什么、什么时候、内容指纹是多少。
 *
 * **这是记账约定，不是强制隔离**：绕过 artifact_write、直接用 shell_exec 改
 * 文件的行为框架检测不到。需要硬保证时用 isolation: 'worktree'。
 */
import { utf8ByteLength } from '../telemetry.js'

/**
 * FNV-1a 32 位哈希，输出 8 位十六进制。
 *
 * **用途是变更/冲突检测，不是加密**：抗碰撞性不足以做完整性校验，选它是因为
 * 零依赖且 Node 与浏览器同实现（node:crypto 浏览器没有，SubtleCrypto 是异步的）。
 * @param {string} str
 * @returns {string}
 */
export function fnv1a32(str) {
  let hash = 0x811c9dc5
  const s = String(str)
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

let SEQ = 0

export class ArtifactTrack {
  /**
   * @param {{ sharedHistory: object, policy?: 'warn'|'deny', now?: () => number }} opts
   */
  constructor({ sharedHistory, policy = 'warn', now = () => Date.now() }) {
    this.sharedHistory = sharedHistory
    this.policy = policy === 'deny' ? 'deny' : 'warn'
    this._now = now
    /** @type {Map<string, object>} key → 最新记录 */
    this._latest = new Map()
    /** @type {object[]} 追加序 */
    this._records = []
  }

  latest(key) {
    return this._latest.get(key) ?? null
  }

  /**
   * @returns {{ ok: boolean, record: object|null,
   *             conflict: { ownerAgentId, ownerAgentName, ownerSha, ownerTs }|null }}
   */
  write({
    key, kind = 'text', summary = '', path = null, content = null, supersedes = null,
    agentId, agentName, nodeId = null, attempt = 1,
  }) {
    const previous = this._latest.get(key) ?? null
    const conflictingOwner = previous
      && previous.agentId !== agentId
      && supersedes !== previous.artifactId
    const conflict = conflictingOwner
      ? {
          ownerAgentId: previous.agentId,
          ownerAgentName: previous.agentName,
          ownerSha: previous.sha,
          ownerTs: previous.ts,
        }
      : null

    if (conflict && this.policy === 'deny') {
      return { ok: false, record: null, conflict }
    }

    SEQ = (SEQ + 1) >>> 0
    const record = {
      artifactId: `art_${SEQ.toString(16).padStart(6, '0')}`,
      key,
      agentId,
      agentName,
      nodeId,
      attempt,
      kind,
      path,
      sha: content != null ? fnv1a32(content) : fnv1a32(`path:${path ?? key}`),
      bytes: content != null ? utf8ByteLength(content) : null,
      summary,
      supersedes: supersedes ?? (previous ? previous.artifactId : null),
      ts: this._now(),
    }

    this._records.push(record)
    this._latest.set(key, record)
    try {
      this.sharedHistory?.appendArtifact?.(record)
    } catch (err) {
      console.warn('[agents] artifact track append failed:', err?.message || err)
    }
    return { ok: true, record, conflict }
  }

  list({ agentId, key, since, limit = 50 } = {}) {
    let out = this._records
    if (agentId != null) out = out.filter(r => r.agentId === agentId)
    if (key != null) out = out.filter(r => r.key === key)
    if (since != null) out = out.filter(r => r.ts >= since)
    return out.slice(0, limit).map(r => ({ ...r }))
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/agents/artifacts.test.js`
Expected: PASS（10 个测试）

- [ ] **Step 5: 跑全量测试并 Commit**

```bash
npm test
git add src/agents/artifacts.js src/agents/artifacts.test.js
git commit -m "feat(agents): add artifact track with ownership and conflict detection

Append-only: every version is kept. A write to a key last owned by a
different agent reports the owner and prior sha (policy warn) or is
refused (policy deny). FNV-1a is advisory change detection, not crypto."
```

---

### Task 7: SubagentRunner — 执行、重试、结果格式化

**Files:**
- Create: `src/agents/runner.js`
- Test: `src/agents/runner.test.js`

**Interfaces:**
- Consumes: `AgentHandle` / `AgentRegistry` / `ArtifactTrack` / `wrapMemoryForMirror` / `renderContract` / `resolveModel` / `getAgentType` / `SubagentError`
- Produces:
  - `RETRYABLE_KINDS = new Set(['rate_limited','llm_error','network','timeout'])`
  - `classifyFailure(err) -> string` —— 见下表
  - `class SubagentRunner`，构造：

    ```js
    new SubagentRunner({
      parent,          // 父 Agent 实例（读 provider/apiKey/url/knowledgeBase/hooks/tools）
      registry, artifacts, sharedHistory,
      aliases,         // resolveModelAliases 的产物
      opts,            // { retry: { maxAttempts, attemptTimeoutMs }, maxDepth }
      emit,            // (eventType, payload) => void
      createAgent,     // 可注入的工厂，默认 (o) => new Agent(o)；测试用它替身
    })
    ```
  - `run(handle, { prompt, inputs, signal }) -> Promise<string>` —— 返回 `Agent_Result` 字符串，**永不 throw**（异常已被分类为失败结果）
  - `formatResult(handle) -> string`
  - `buildChildOptions(handle, { prompt, inputs }) -> object` —— 暴露出来便于测试断言继承关系

  `classifyFailure` 映射：

  | 判据 | failureKind |
  |---|---|
  | `err.status === 429` | `rate_limited` |
  | `err.status >= 500` | `llm_error` |
  | `err.name === 'LlmStreamIncompleteError'` | `llm_error` |
  | `err.name === 'AbortError'` | `aborted` |
  | `/fetch failed\|ECONNRESET\|ENOTFOUND\|network/i.test(err.message)` | `network` |
  | `err.name === 'TimeoutError'` 或 message 含 `timed out` | `timeout` |
  | 其余 | `tool_error`（**不重试** —— 未知错误重跑多半同样结果，纯烧 token） |

- [ ] **Step 1: 写失败测试**

```js
// src/agents/runner.test.js
import test from 'node:test'
import assert from 'node:assert'
import { RuntimeHistory } from '../runtime-history.js'
import { AgentRegistry } from './registry.js'
import { ArtifactTrack } from './artifacts.js'
import { SubagentRunner, classifyFailure, RETRYABLE_KINDS } from './runner.js'
import { resolveModelAliases } from './models.js'
import { getAgentType } from './types.js'

const parent = {
  _providerName: 'openai',
  model: 'gpt-4o', apiKey: 'sk-main', url: 'https://main/v1',
  simpleModel: 'gpt-4o-mini', simpleApiKey: 'sk-simple', simpleUrl: 'https://simple/v1',
  knowledgeBase: { entries: ['kb'] },
  tokenBudget: { totalTokens: 1000 },
  validateStreamCompletion: false,
  tools: [
    { name: 'read_file', description: 'r', parameters: {}, execute: async () => 'x' },
    { name: 'write_file', description: 'w', parameters: {}, execute: async () => 'x' },
    { name: 'agent', description: 'a', parameters: {}, execute: async () => 'x' },
  ],
  hooks: { beforeToolCall: () => true, afterToolCall: () => {} },
}

/** 造一个可控的假子 Agent。 */
function fakeAgentFactory(script) {
  const calls = []
  let i = 0
  const factory = (options) => {
    calls.push(options)
    const step = script[Math.min(i, script.length - 1)]
    i += 1
    return {
      options,
      lastStopReason: null,
      _bus: { on() {}, off() {} },
      on() { return this }, off() { return this },
      getLastRunMetrics: () => ({ totalRounds: 3, totalLlmCalls: 3, totalToolCalls: 1, usage: { input_tokens: 10, output_tokens: 5 }, wallClockMs: 12 }),
      async chat() {
        if (typeof step === 'function') return step(this)
        return step
      },
      async closeMCPClients() {},
    }
  }
  factory.calls = calls
  return factory
}

function makeRunner(script, opts = {}) {
  const sharedHistory = new RuntimeHistory()
  const registry = new AgentRegistry({ maxConcurrent: 4 })
  const artifacts = new ArtifactTrack({ sharedHistory })
  const events = []
  const createAgent = fakeAgentFactory(script)
  const runner = new SubagentRunner({
    parent, registry, artifacts, sharedHistory,
    aliases: resolveModelAliases(parent, undefined),
    opts: { retry: { maxAttempts: 3, attemptTimeoutMs: 5000 }, maxDepth: 2, ...opts },
    emit: (type, payload) => events.push({ type, payload }),
    createAgent,
  })
  return { runner, registry, artifacts, sharedHistory, events, createAgent }
}

function makeHandle(registry, overrides = {}) {
  return registry.create({
    type: 'general-purpose', description: 'Audit auth flow',
    parentAgentId: 'main', depth: 1,
    model: { alias: 'fast', model: 'gpt-4o-mini', apiKey: 'sk-simple', url: 'https://simple/v1' },
    ...overrides,
  })
}

test('classifyFailure 覆盖各类错误', () => {
  const api429 = Object.assign(new Error('LLM API error 429'), { status: 429 })
  const api500 = Object.assign(new Error('LLM API error 503'), { status: 503 })
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
  const stream = Object.assign(new Error('stream cut'), { name: 'LlmStreamIncompleteError' })
  assert.strictEqual(classifyFailure(api429), 'rate_limited')
  assert.strictEqual(classifyFailure(api500), 'llm_error')
  assert.strictEqual(classifyFailure(abort), 'aborted')
  assert.strictEqual(classifyFailure(stream), 'llm_error')
  assert.strictEqual(classifyFailure(new TypeError('fetch failed')), 'network')
  assert.strictEqual(classifyFailure(new Error('Operation timed out after 5000ms')), 'timeout')
  assert.strictEqual(classifyFailure(new Error('something odd')), 'tool_error')
  assert.strictEqual(RETRYABLE_KINDS.has('tool_error'), false)
  assert.strictEqual(RETRYABLE_KINDS.has('rate_limited'), true)
})

test('成功路径：返回带头部的 Agent_Result，状态迁到 succeeded', async () => {
  const { runner, registry } = makeRunner(['子 agent 的最终报告'])
  const handle = makeHandle(registry)
  const out = await runner.run(handle, { prompt: '检查越权' })
  assert.match(out, /^\[agent:general-purpose-1 succeeded\]/m)
  assert.ok(out.includes('attempts=1'))
  assert.ok(out.includes('model=fast'))
  assert.ok(out.includes('子 agent 的最终报告'))
  assert.strictEqual(handle.state, 'succeeded')
  assert.strictEqual(handle.attempt, 1)
})

test('子 agent 继承 knowledgeBase / tokenBudget / hooks，但不继承 memory 与 systemPrompt', async () => {
  const { runner, registry, createAgent } = makeRunner(['ok'])
  await runner.run(makeHandle(registry), { prompt: 'p' })
  const [childOpts] = createAgent.calls
  assert.strictEqual(childOpts.knowledgeBase, parent.knowledgeBase)
  assert.strictEqual(childOpts.tokenBudget, parent.tokenBudget)
  assert.strictEqual(childOpts.validateStreamCompletion, false)
  assert.strictEqual(typeof childOpts.hooks.beforeToolCall, 'function')
  assert.strictEqual(childOpts.systemPrompt, getAgentType('general-purpose').systemPrompt)
  assert.strictEqual(childOpts.strategy, 'react')
  assert.ok(childOpts.memory, '必须显式传入镜像包装后的 memory')
  assert.strictEqual(childOpts.model, 'gpt-4o-mini')
  assert.strictEqual(childOpts.apiKey, 'sk-simple')
})

test('tools: "*" 继承父工具集但剔除 agent（canSpawn 为 false）', async () => {
  const { runner, registry, createAgent } = makeRunner(['ok'])
  await runner.run(makeHandle(registry), { prompt: 'p' })
  const names = createAgent.calls[0].tools.map(t => t.name)
  assert.ok(names.includes('read_file'))
  assert.ok(!names.includes('agent'), 'canSpawn=false 的类型不应拿到 agent 工具')
})

test('可重试失败：重试到成功，每次都是全新实例', async () => {
  const rateLimited = () => { throw Object.assign(new Error('LLM API error 429'), { status: 429 }) }
  const { runner, registry, createAgent, events } = makeRunner([rateLimited, rateLimited, '第三次成功'])
  const handle = makeHandle(registry)
  const out = await runner.run(handle, { prompt: 'p' })
  assert.ok(out.includes('succeeded'))
  assert.ok(out.includes('attempts=3'))
  assert.strictEqual(createAgent.calls.length, 3, '每次重试都要新建实例，不复用被污染的上下文')
  assert.strictEqual(events.filter(e => e.type === 'agent.retry').length, 2)
})

test('重试用尽：返回结构化失败结果，不抛异常', async () => {
  const rateLimited = () => { throw Object.assign(new Error('429 Too Many Requests'), { status: 429 }) }
  const { runner, registry, events } = makeRunner([rateLimited])
  const handle = makeHandle(registry)
  const out = await runner.run(handle, { prompt: 'p' })
  assert.match(out, /^\[agent:general-purpose-1 failed\]/m)
  assert.ok(out.includes('failureKind=rate_limited'))
  assert.ok(out.includes('attempts=3'))
  assert.ok(out.includes('429 Too Many Requests'))
  assert.strictEqual(handle.state, 'failed')
  assert.strictEqual(events.filter(e => e.type === 'agent.failed').length, 1)
})

test('退避期间被取消：仍然返回结构化结果，不把 AbortError 抛给父 agent', async () => {
  // 回归测试：`await sleep(delayMs, signal)` 曾直接放在 catch 块里，signal 在
  // 退避中途 abort 时 sleep 的 rejection 会穿透 run()，违反"run() 永不 throw"
  // 的契约 —— 而退避正是系统看起来卡住、用户最可能按取消的时刻。
  const rateLimited = () => { throw Object.assign(new Error('429 Too Many Requests'), { status: 429 }) }
  const { runner, registry } = makeRunner([rateLimited], { retry: { maxAttempts: 3, backoffMs: () => 50 } })
  const handle = makeHandle(registry)
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 10)
  const out = await runner.run(handle, { prompt: 'p', signal: ac.signal })
  assert.match(out, /^\[agent:general-purpose-1 failed\]/m)
  assert.ok(out.includes('failureKind=aborted'), '退避中途取消应归类为 aborted')
  assert.strictEqual(handle.state, 'failed')
})

test('不可重试失败：只跑一次', async () => {
  const boom = () => { throw new Error('tool blew up') }
  const { runner, registry, createAgent } = makeRunner([boom])
  const out = await runner.run(makeHandle(registry), { prompt: 'p' })
  assert.ok(out.includes('failureKind=tool_error'))
  assert.ok(out.includes('attempts=1'))
  assert.strictEqual(createAgent.calls.length, 1)
})

test('超轮：识别为 max_rounds 且不重试', async () => {
  const { runner, registry, createAgent } = makeRunner([
    (child) => { child.lastStopReason = 'max_rounds'; return '[max rounds exceeded]' },
  ])
  const out = await runner.run(makeHandle(registry), { prompt: 'p' })
  assert.ok(out.includes('failureKind=max_rounds'))
  assert.strictEqual(createAgent.calls.length, 1)
})

test('depth 超限：直接失败，不构造任何实例', async () => {
  const { runner, registry, createAgent } = makeRunner(['ok'], { maxDepth: 1 })
  const handle = makeHandle(registry, { depth: 2 })
  const out = await runner.run(handle, { prompt: 'p' })
  assert.ok(out.includes('failureKind=depth_exceeded'))
  assert.strictEqual(createAgent.calls.length, 0)
})

test('产物出现在结果尾部并记进 handle', async () => {
  const { runner, registry, artifacts } = makeRunner([
    function () {
      artifacts.write({
        agentId: this.options._agentId, agentName: this.options._agentName, attempt: 1,
        key: 'docs/x.md', kind: 'file', summary: 's', content: 'body',
      })
      return '报告正文'
    },
  ])
  const handle = makeHandle(registry)
  const out = await runner.run(handle, { prompt: 'p' })
  assert.ok(out.includes('--- artifacts (1) ---'))
  assert.ok(out.includes('docs/x.md'))
  assert.deepStrictEqual(handle.artifactKeys, ['docs/x.md'])
})

test('失败结果里带上已产出的部分产物', async () => {
  const { runner, registry, artifacts } = makeRunner([
    function () {
      artifacts.write({
        agentId: this.options._agentId, agentName: this.options._agentName, attempt: 1,
        key: 'docs/partial.md', kind: 'file', summary: 's', content: 'half',
      })
      throw new Error('gave up')
    },
  ])
  const out = await runner.run(makeHandle(registry), { prompt: 'p' })
  assert.ok(out.includes('--- partial artifacts (1) ---'))
  assert.ok(out.includes('docs/partial.md'))
})

test('emit 了 spawn / state / succeeded 事件且带归属', async () => {
  const { runner, registry, events } = makeRunner(['ok'])
  const handle = makeHandle(registry)
  await runner.run(handle, { prompt: 'p' })
  const spawn = events.find(e => e.type === 'agent.spawn')
  assert.strictEqual(spawn.payload.agentId, handle.agentId)
  assert.strictEqual(spawn.payload.parentAgentId, 'main')
  assert.strictEqual(spawn.payload.type, 'general-purpose')
  assert.ok(!JSON.stringify(events).includes('sk-simple'), '事件里不能出现 apiKey')
  assert.ok(events.some(e => e.type === 'agent.succeeded'))
})

test('子 agent 首条消息是渲染后的契约（含标题行与 prompt 原文）', async () => {
  let received = null
  const { runner, registry, createAgent } = makeRunner(['ok'])
  const handle = makeHandle(registry)
  await runner.run(handle, { prompt: '检查 src/auth 的越权风险' })
  received = createAgent.calls[0]._contract
  assert.ok(received.includes('# Task: Audit auth flow'))
  assert.ok(received.includes('检查 src/auth 的越权风险'))
  assert.strictEqual(runner.lastRenderedContract, received)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/agents/runner.test.js`
Expected: FAIL —— `Cannot find module './runner.js'`

- [ ] **Step 3: 实现 runner.js**

```js
/**
 * SubagentRunner —— 造子 Agent、跑、按失败类型重试、把终态渲染成 Agent_Result。
 *
 * 用**组合**而非继承：子 agent 就是一个普通的 `Agent` 实例，因此 ReAct 循环、
 * 工具执行的分类与容错、telemetry、skill / MCP 全部白拿，不复制一份必然分叉的
 * 循环代码。
 *
 * `run()` **永不 throw** —— 任何异常都被分类成 failureKind 并渲染成结构化失败
 * 结果回给主 agent，由主 agent 决定换模型 / 缩范围 / 放弃（§2）。
 */
import { getAgentType } from './types.js'
import { resolveModel } from './models.js'
import { renderContract } from './contract.js'
import { wrapMemoryForMirror } from './mirror.js'
import { SlidingWindowMemory } from '../memory.js'

// 注意：**不要**在这里静态 import `Agent` —— agent.js → runtime.js → runner.js
// 已经构成引用环，静态 import 会让求值顺序变得脆弱。默认工厂改用动态 import，
// 在第一次真正要造子 agent 时才解析。

/** 可重试的失败类型。其余重跑多半同样结果，纯烧 token。 */
export const RETRYABLE_KINDS = new Set(['rate_limited', 'llm_error', 'network', 'timeout'])

/** 子 agent 永远拿不到的元工具（除非其类型 canSpawn）。 */
const SPAWN_TOOLS = new Set(['agent', 'agent_graph', 'graph_start'])

export function classifyFailure(err) {
  if (!err) return 'tool_error'
  // _runOnce 抛的 MaxRoundsError 自带分类，优先采信。
  if (typeof err._failureKind === 'string') return err._failureKind
  const status = typeof err.status === 'number' ? err.status : null
  if (status === 429) return 'rate_limited'
  if (status != null && status >= 500) return 'llm_error'
  if (err.name === 'LlmStreamIncompleteError') return 'llm_error'
  if (err.name === 'AbortError') return 'aborted'
  if (err.name === 'TimeoutError') return 'timeout'
  const message = String(err.message ?? '')
  if (/timed out/i.test(message)) return 'timeout'
  if (/fetch failed|ECONNRESET|ENOTFOUND|ECONNREFUSED|network/i.test(message)) return 'network'
  return 'tool_error'
}

/** 默认退避：指数增长，上限 8s。可经 `opts.retry.backoffMs` 注入（测试用）。 */
function backoffMs(attempt) {
  return Math.min(2 ** attempt * 1000, 8000)
}
export class SubagentRunner {
  constructor({
    parent, registry, artifacts, sharedHistory, aliases, opts = {}, emit = () => {},
    createAgent = async (options) => {
      const { Agent } = await import('../agent.js')
      return new Agent(options)
    },
    ask = null, mailbox = null,
  }) {
    this.parent = parent
    this.registry = registry
    this.artifacts = artifacts
    this.sharedHistory = sharedHistory
    this.aliases = aliases
    this.opts = opts
    this.emit = emit
    this.createAgent = createAgent
    this.ask = ask
    this.mailbox = mailbox
    /** 最近一次渲染出的契约，便于调试与测试断言。 */
    this.lastRenderedContract = null
  }

  /**
   * 派生子 agent 的构造参数。独立成方法便于测试断言继承关系。
   */
  buildChildOptions(handle, { prompt, inputs }) {
    const type = getAgentType(handle.type)
    const parent = this.parent

    const inherited = type.tools === '*'
      ? parent.tools
      : parent.tools.filter(t => type.tools.includes(t.name))
    const tools = type.canSpawn ? [...inherited] : inherited.filter(t => !SPAWN_TOOLS.has(t.name))

    const contract = renderContract({
      description: handle.description,
      prompt,
      inputs,
      cwd: handle.isolation?.path ?? null,
    })
    this.lastRenderedContract = contract

    return {
      // Agent 构造函数要求 provider 必填（它用来解析默认 URL）。父 Agent 在
      // Task 9 里记住了自己的 provider 名，这里原样传下去；url 显式覆盖，因此
      // 别名可以指向另一个供应商的端点。
      provider: this.parent._providerName,
      url: handle.model.url,
      apiKey: handle.model.apiKey,
      model: handle.model.model,
      systemPrompt: type.systemPrompt,
      tools,
      strategy: 'react',
      maxRounds: type.maxRounds,
      temperature: type.temperature,
      enableIntentRecognition: type.enableIntentRecognition,
      knowledgeBase: parent.knowledgeBase,
      tokenBudget: parent.tokenBudget,
      validateStreamCompletion: parent.validateStreamCompletion,
      hooks: this._childHooks(handle),
      // 给假实例/调试用的归属信息（Agent 会忽略未知选项）
      _agentId: handle.agentId,
      _agentName: handle.name,
      _contract: contract,
    }
  }

  _childHooks(handle) {
    const parentHooks = this.parent.hooks ?? {}
    const hooks = {}
    // 转发主机的工具管控策略 —— 不转发等于子 agent 绕过了主机的安全边界。
    if (parentHooks.beforeToolCall) hooks.beforeToolCall = parentHooks.beforeToolCall
    if (parentHooks.afterToolCall) hooks.afterToolCall = parentHooks.afterToolCall
    if (parentHooks.onError) hooks.onError = parentHooks.onError
    if (this.ask) {
      hooks.onAskUser = (question) => this.ask.ask({
        agentId: handle.agentId,
        agentName: handle.name,
        parentAgentId: handle.parentAgentId,
        nodeId: handle.nodeId,
        taskDescription: handle.description,
        question,
      })
    } else if (parentHooks.onAskUser) {
      hooks.onAskUser = parentHooks.onAskUser
    }
    return hooks
  }

  /**
   * @returns {Promise<string>} Agent_Result 字符串。永不 reject。
   */
  async run(handle, { prompt, inputs = [], signal } = {}) {
    const type = getAgentType(handle.type)
    const maxDepth = this.opts.maxDepth ?? 2
    const maxAttempts = this.opts.retry?.maxAttempts ?? type.maxAttempts ?? 3

    if (handle.depth > maxDepth) {
      handle.transition('queued'); handle.transition('running')
      handle.beginAttempt()
      handle.endAttempt({ failureKind: 'depth_exceeded', error: `depth ${handle.depth} exceeds maxDepth ${maxDepth}` })
      return this._finishFailed(handle, 'depth_exceeded', `depth ${handle.depth} exceeds maxDepth ${maxDepth}`)
    }

    this.emit('agent.spawn', {
      agentId: handle.agentId, agentName: handle.name, parentAgentId: handle.parentAgentId,
      type: handle.type, description: handle.description, depth: handle.depth,
      nodeId: handle.nodeId, model: handle.model?.alias ?? null,
      isolation: handle.isolation ? handle.isolation.mode : null,
    })

    if (handle.state === 'pending') handle.transition('queued')
    handle.transition('running')
    this._emitState(handle, 'queued', 'running')

    let lastKind = 'tool_error'
    let lastError = 'unknown error'

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      handle.beginAttempt()
      try {
        const text = await this._runOnce(handle, { prompt, inputs, signal })
        handle.endAttempt({})
        return this._finishSucceeded(handle, text)
      } catch (err) {
        const kind = classifyFailure(err)
        lastKind = kind
        lastError = String(err?.message ?? err)
        handle.endAttempt({ failureKind: kind, error: lastError })

        const retryable = RETRYABLE_KINDS.has(kind) && attempt < maxAttempts && !signal?.aborted
        if (!retryable) break

        const delayMs = this._backoffMs(attempt)
        this.emit('agent.retry', {
          agentId: handle.agentId, agentName: handle.name, parentAgentId: handle.parentAgentId,
          attempt, failureKind: kind, delayMs,
        })
        // `sleep` 在 signal abort 时 reject。它必须被接住 —— 裸 await 会让这个
        // rejection 穿透 run()，违反"run() 永不 throw"的契约，而退避正是系统看
        // 起来卡住、用户最可能按取消的时刻。
        try {
          await sleep(delayMs, signal)
        } catch (abortErr) {
          lastKind = classifyFailure(abortErr)
          lastError = String(abortErr?.message ?? abortErr)
          break
        }
      }
    }

    return this._finishFailed(handle, lastKind, lastError)
  }

  async _runOnce(handle, { prompt, inputs, signal }) {
    const options = this.buildChildOptions(handle, { prompt, inputs })
    // `createAgent` 默认是异步的（动态 import 打破引用环）；测试注入的同步工厂
    // 被 await 一视同仁。
    const child = await this.createAgent({
      ...options,
      memory: this._makeChildMemory(handle),
    })
    handle._child = child
    child._toolContextExtra = {
      agentId: handle.agentId, agentName: handle.name,
      depth: handle.depth, cwd: handle.isolation?.path ?? null,
    }
    this._forwardTelemetry(handle, child)

    const text = await child.chat(options._contract, { signal })
    if (child.lastStopReason === 'max_rounds') {
      const err = new Error('subagent exhausted its round budget')
      err.name = 'MaxRoundsError'
      err._failureKind = 'max_rounds'
      throw err
    }
    const metrics = child.getLastRunMetrics?.()
    if (metrics) {
      handle.metrics = {
        rounds: metrics.totalRounds ?? 0,
        llmCalls: metrics.totalLlmCalls ?? 0,
        toolCalls: metrics.totalToolCalls ?? 0,
        usage: metrics.usage ?? null,
        wallClockMs: metrics.wallClockMs ?? 0,
      }
    }
    return text
  }

  /**
   * 子 agent 的 memory：全新实例 + 镜像包装（不继承父上下文）。
   * 用 SlidingWindowMemory 而非默认的 SummarizingMemory —— 子 agent 的任务已经
   * 收窄，让它为了压缩再去打一轮 sidecar LLM 不划算。
   */
  _makeChildMemory(handle) {
    const inner = new SlidingWindowMemory(60)
    return wrapMemoryForMirror(inner, { sharedHistory: this.sharedHistory, agentId: handle.agentId })
  }

  _forwardTelemetry(handle, child) {
    if (typeof child.on !== 'function') return
    for (const eventType of ['llm.call', 'tool.call', 'round.start', 'round.end']) {
      child.on(eventType, (payload) => {
        this.emit(eventType, {
          ...payload,
          agentId: handle.agentId,
          agentName: handle.name,
          parentAgentId: handle.parentAgentId,
        })
      })
    }
  }

  _emitState(handle, from, to) {
    this.emit('agent.state', {
      agentId: handle.agentId, agentName: handle.name, parentAgentId: handle.parentAgentId, from, to,
    })
  }

  _collectArtifacts(handle) {
    const records = this.artifacts?.list?.({ agentId: handle.agentId }) ?? []
    handle.artifactKeys = [...new Set(records.map(r => r.key))]
    return records
  }

  _finishSucceeded(handle, text) {
    const records = this._collectArtifacts(handle)
    handle.result = { status: 'succeeded', text }
    handle.transition('succeeded')
    this._emitState(handle, 'running', 'succeeded')
    this.registry.settle(handle)
    this.emit('agent.succeeded', {
      agentId: handle.agentId, agentName: handle.name, parentAgentId: handle.parentAgentId,
      rounds: handle.metrics.rounds, usage: handle.metrics.usage,
      wallClockMs: handle.metrics.wallClockMs, artifactKeys: handle.artifactKeys,
    })
    return this.formatResult(handle, { text, records })
  }

  _finishFailed(handle, failureKind, lastError) {
    const records = this._collectArtifacts(handle)
    handle.result = { status: 'failed', failureKind, lastError }
    if (!handle.isTerminal()) handle.transition('failed')
    this._emitState(handle, 'running', 'failed')
    this.registry.settle(handle)
    this.emit('agent.failed', {
      agentId: handle.agentId, agentName: handle.name, parentAgentId: handle.parentAgentId,
      failureKind, attempts: handle.attempt, lastError,
    })
    return this.formatResult(handle, { records })
  }

  /**
   * 渲染 Agent_Result（§2）。头部机器可读，正文人可读 —— 主 agent 的后续决策
   * 完全依赖这个头部。
   *
   * `text` 缺省时回落到 `handle.result.text`：单参数形式 `formatResult(handle)`
   * 属于声明的接口（Task 8 的 agent_status 之类要重新渲染一个已 settle 的
   * handle），若只默认成空串就会静默丢掉子 agent 的整份报告。
   */
  formatResult(handle, { text, records = null } = {}) {
    const body = text ?? handle.result?.text ?? ''
    const rows = records ?? this.artifacts?.list?.({ agentId: handle.agentId }) ?? []
    const artifactLine = rows.length > 0
      ? rows.map(r => `${r.key} (sha:${r.sha}${r.attempt > 1 ? `, attempt=${r.attempt}` : ''})`).join(' · ')
      : null

    if (handle.result?.status === 'succeeded') {
      const m = handle.metrics
      const usage = m.usage ?? {}
      const lines = [
        `[agent:${handle.name} succeeded] type=${handle.type} model=${handle.model?.alias ?? 'inherited'} `
        + `attempts=${handle.attempt} rounds=${m.rounds}`,
        `usage: in=${usage.input_tokens ?? 0} out=${usage.output_tokens ?? 0}  wall=${(m.wallClockMs / 1000).toFixed(1)}s`,
        body,
      ]
      if (artifactLine) lines.push(`--- artifacts (${rows.length}) ---`, artifactLine)
      if (handle.isolation?.dirty) {
        lines.push('--- worktree ---',
          `path=${handle.isolation.path} branch=${handle.isolation.branch} `
          + `changed=${handle.isolation.changedFiles} files (已保留，未自动清理)`)
      }
      return lines.join('\n')
    }

    const { failureKind, lastError } = handle.result ?? {}
    const retried = handle.attempt > 1 ? ` (retried ${handle.attempt - 1}x)` : ''
    const lines = [
      `[agent:${handle.name} failed] failureKind=${failureKind} attempts=${handle.attempt}${retried}`,
      `lastError: ${lastError}`,
    ]
    if (artifactLine) lines.push(`--- partial artifacts (${rows.length}) ---`, artifactLine)
    lines.push('下一步由你决定：换 model 重发、缩小任务范围重发、或跳过该任务继续。')
    return lines.join('\n')
  }
}

async function sleep(ms, signal) {
  if (ms <= 0) return
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    if (signal) {
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(abortError()) }, { once: true })
    }
  })
}

function abortError() {
  const err = new Error('subagent retry aborted')
  err.name = 'AbortError'
  return err
}
```

**依赖 Task 9 的一行改动：** `buildChildOptions` 读 `this.parent._providerName`。Task 9 会在 `Agent` 构造函数里加 `this._providerName = opts.provider`（一行）。在 Task 7 的测试里，假 parent 对象直接给 `_providerName: 'openai'` 即可 —— 记得在 `runner.test.js` 顶部的 `parent` 常量里加上这个字段。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/agents/runner.test.js`
Expected: PASS（13 个测试）

- [ ] **Step 5: 跑全量测试并 Commit**

```bash
npm test
git add src/agents/runner.js src/agents/runner.test.js
git commit -m "feat(agents): add SubagentRunner with typed failure classification

run() never throws: every exception is classified into a failureKind and
rendered into a structured Agent_Result for the parent to act on. Only
rate_limited/llm_error/network/timeout retry, each with a fresh instance
so a poisoned context is never carried into the retry.

Host tool-gating hooks are forwarded to children — not forwarding them
would let subagents bypass the host's security boundary."
```

---

### Task 8: SubagentRuntime 与第一批元工具

**Files:**
- Create: `src/agents/runtime.js`
- Create: `src/agents/tools.js`
- Test: `src/agents/tools.test.js`

**Interfaces:**
- Consumes: 前 7 个任务的全部产物
- Produces:
  - `createSubagentRuntime(opts) -> SubagentRuntime`。**完整签名一次定好，后续任务只填实现不改签名**：

    ```js
    createSubagentRuntime({
      parent,                       // 父 Agent 实例
      types = [],                   // 追加注册的 Agent_Type
      defaultType = 'general-purpose',
      maxConcurrent = 4,            // 每 depth 层的槽数
      maxDepth = 2,
      modelAliases,                 // undefined → { fast, main }
      retry = {},                   // { maxAttempts = 3, attemptTimeoutMs = 600000 }
      artifacts = {},               // { policy: 'warn' | 'deny' }
      retainCompleted = 20,
      keepAlive = true,             // Task 15 用
      keepAliveTimeoutMs = 600000,  // Task 15 用
      ask = {},                     // { timeoutMs: null }  Task 12 用
      isolation = {},               // { worktreeBaseDir: '.worktrees', branchPrefix: 'subagent/' }  Task 16 用
      a2a = {},                     // { transport: 'local' }  Task 11 用
      createAgent,                  // 可注入的子 Agent 工厂，仅测试用
    })
    ```
  - `SubagentRuntime` 字段/方法：`registry` / `artifacts` / `runner` / `graph`(Task 14) / `ask`(Task 12) / `mailbox`(Task 11) / `sharedHistory` / `aliases` / `keepAlive` / `keepAliveTimeoutMs` / `tools` / `typesNote()` / `hasPending()` / `drain()` / `close()` / `nextEvent()`(Task 15) / `sendMessage()`(Task 11) / `_startNode()`(Task 14) / `_signalEvent()`(Task 15)
  - `spawn({ description, prompt, subagentType, model, background, isolation, nodeId, inputs, depth, parentAgentId, signal, onHandle })` —— `onHandle(handle)` 在 handle 创建后、执行开始前同步调用（图调度用它把 `agentId` 回填到节点）
  - `createSubagentTools(runtime) -> Tool_Def[]`
  - `SUBAGENT_TOOL_NAMES -> string[]`（本任务 7 个；Task 11 加 `send_message`，Task 14 加 `agent_graph` / `graph_start`，共 10 个）

- [ ] **Step 1: 写失败测试**

```js
// src/agents/tools.test.js
import test from 'node:test'
import assert from 'node:assert'
import { RuntimeHistory } from '../runtime-history.js'
import { createSubagentRuntime } from './runtime.js'
import { SUBAGENT_TOOL_NAMES } from './tools.js'
import { resetAgentTypes, registerAgentType } from './types.js'

function fakeParent(reply = '子 agent 报告') {
  const memory = { runtimeHistory: new RuntimeHistory(), add() {} }
  return {
    _providerName: 'openai',
    model: 'gpt-4o', apiKey: 'sk-main', url: 'https://main/v1',
    simpleModel: 'gpt-4o-mini', simpleApiKey: 'sk-simple', simpleUrl: 'https://simple/v1',
    tools: [{ name: 'read_file', description: 'r', parameters: {}, execute: async () => 'x' }],
    hooks: {}, knowledgeBase: null, tokenBudget: null, validateStreamCompletion: true,
    memory,
    _events: [],
    emit(type, payload) { this._events.push({ type, payload }) },
    // Task 11 起 _onBackgroundSettled 会调它 —— 现在就补上，免得那时回头改测试
    _injected: [],
    enqueueMessage(msg) { this._injected.push(msg) },
    _reply: reply,
  }
}

function makeRuntime(parent, extra = {}) {
  return createSubagentRuntime({
    parent,
    createAgent: () => ({
      lastStopReason: null,
      on() { return this }, off() { return this },
      getLastRunMetrics: () => ({ totalRounds: 1, totalLlmCalls: 1, totalToolCalls: 0, usage: { input_tokens: 1, output_tokens: 1 }, wallClockMs: 5 }),
      async chat() { return parent._reply },
    }),
    ...extra,
  })
}

const byName = (tools, name) => tools.find(t => t.name === name)

test.beforeEach(() => resetAgentTypes())

test('注入的工具名与 SUBAGENT_TOOL_NAMES 一致', () => {
  const rt = makeRuntime(fakeParent())
  assert.deepStrictEqual(rt.tools.map(t => t.name).sort(), [...SUBAGENT_TOOL_NAMES].sort())
  assert.ok(SUBAGENT_TOOL_NAMES.includes('agent'))
  assert.ok(SUBAGENT_TOOL_NAMES.includes('agent_status'))
})

test('agent 工具的 schema 严格对齐参考实现', () => {
  const tool = byName(makeRuntime(fakeParent()).tools, 'agent')
  const p = tool.parameters
  assert.strictEqual(p.additionalProperties, false)
  assert.deepStrictEqual(p.required, ['description', 'prompt'])
  assert.deepStrictEqual(Object.keys(p.properties).sort(),
    ['description', 'isolation', 'model', 'prompt', 'run_in_background', 'subagent_type'])
  assert.deepStrictEqual(p.properties.model.enum, ['fast', 'main'])
  assert.deepStrictEqual(p.properties.isolation.enum, ['worktree', 'remote'])
  assert.strictEqual(p.properties.run_in_background.type, 'boolean')
  assert.match(tool.description, /3-8 word/)
})

test('model enum 跟随主机别名表', () => {
  const rt = makeRuntime(fakeParent(), {
    modelAliases: { haiku: { model: 'claude-haiku-4-5' }, opus: { model: 'claude-opus-5' } },
  })
  assert.deepStrictEqual(byName(rt.tools, 'agent').parameters.properties.model.enum, ['haiku', 'opus'])
})

test('同步调用返回完整 Agent_Result', async () => {
  const rt = makeRuntime(fakeParent('审计结论：3 处越权'))
  const out = await byName(rt.tools, 'agent').execute({
    description: 'Audit auth flow', prompt: '检查越权', run_in_background: false,
  })
  assert.match(out, /^\[agent:general-purpose-1 succeeded\]/m)
  assert.ok(out.includes('审计结论：3 处越权'))
})

test('后台调用立即返回 started 行，结果随后可查', async () => {
  const rt = makeRuntime(fakeParent())
  const out = await byName(rt.tools, 'agent').execute({ description: 'd', prompt: 'p' })
  assert.match(out, /^\[agent:general-purpose-1 started\]/m)
  assert.ok(out.includes('background'))
  await rt.drain()
  const status = await byName(rt.tools, 'agent_status').execute({ include_finished: true })
  assert.ok(status.includes('succeeded'))
})

test('未注册的 subagent_type 软失败并列出可用类型', async () => {
  const rt = makeRuntime(fakeParent())
  const out = await byName(rt.tools, 'agent').execute({
    description: 'd', prompt: 'p', subagent_type: 'nope', run_in_background: false,
  })
  assert.ok(out.toLowerCase().includes('unknown'))
  assert.ok(out.includes('general-purpose'))
  assert.ok(!out.includes('[agent:'), '不该真的起 agent')
})

test('未知 model 别名软失败', async () => {
  const rt = makeRuntime(fakeParent())
  const out = await byName(rt.tools, 'agent').execute({
    description: 'd', prompt: 'p', model: 'nope', run_in_background: false,
  })
  assert.ok(out.includes('fast'))
  assert.ok(out.includes('main'))
})

test('缺 prompt 时软失败而非抛异常', async () => {
  const rt = makeRuntime(fakeParent())
  const out = await byName(rt.tools, 'agent').execute({ description: 'd', run_in_background: false })
  assert.ok(/prompt/i.test(out))
})

test('agent_status 列出活跃 agent 与并发占用', async () => {
  const rt = makeRuntime(fakeParent())
  const out = await byName(rt.tools, 'agent_status').execute({})
  assert.ok(out.includes('no active agents') || out.includes('0'))
})

test('agent_cancel 未知 id 软失败', async () => {
  const rt = makeRuntime(fakeParent())
  const out = await byName(rt.tools, 'agent_cancel').execute({ agent_id: 'nope' })
  assert.ok(/not found|unknown/i.test(out))
})

test('artifact_write 记账并在冲突时告警', async () => {
  const rt = makeRuntime(fakeParent())
  const write = byName(rt.tools, 'artifact_write')
  const first = await write.execute(
    { key: 'docs/x.md', kind: 'file', summary: 's', content: 'v1' },
    { agentId: 'agt_a', agentName: 'writer-1' },
  )
  assert.ok(first.includes('recorded'))
  const second = await write.execute(
    { key: 'docs/x.md', kind: 'file', summary: 's', content: 'v2' },
    { agentId: 'agt_b', agentName: 'writer-2' },
  )
  assert.ok(second.includes('writer-1'), '必须点名上一版的归属者')
  const listed = await byName(rt.tools, 'artifact_list').execute({ key: 'docs/x.md' })
  assert.ok(listed.includes('writer-1') && listed.includes('writer-2'))
})

test('history_search / history_get 走通', async () => {
  const parent = fakeParent()
  parent.memory.runtimeHistory.appendMessage({ role: 'user', content: '早期决定：用 JWT' })
  const rt = makeRuntime(parent)
  const hits = await byName(rt.tools, 'history_search').execute({ query: 'JWT' })
  assert.ok(hits.includes('JWT'))
  const eventId = parent.memory.runtimeHistory.getEvents('all')[0].id
  const got = await byName(rt.tools, 'history_get').execute({ event_id: eventId })
  assert.ok(got.includes('JWT'))
  const miss = await byName(rt.tools, 'history_search').execute({ query: 'zzz-not-present' })
  assert.ok(/no match/i.test(miss))
})

test('canSpawn 的类型出现在类型清单里，供模型选型', () => {
  registerAgentType({ name: 'lead', description: 'd', systemPrompt: 's', canSpawn: true })
  const rt = makeRuntime(fakeParent())
  assert.ok(rt.typesNote().includes('lead'))
  assert.ok(rt.typesNote().includes('general-purpose'))
  assert.ok(rt.typesNote().includes('Available agent types'))
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/agents/tools.test.js`
Expected: FAIL —— `Cannot find module './runtime.js'`

- [ ] **Step 3: 实现 runtime.js**

```js
/**
 * SubagentRuntime —— 组装 subagent 系统的全部部件，并暴露给 `Agent` 的
 * 单一入口。`Agent` 只认这一个对象，不直接碰 registry / runner / graph。
 */
import { AgentRegistry } from './registry.js'
import { ArtifactTrack } from './artifacts.js'
import { SubagentRunner } from './runner.js'
import { resolveModelAliases, resolveModel } from './models.js'
import { getAgentType, listAgentTypes, registerAgentType } from './types.js'
import { createSubagentTools } from './tools.js'

export function createSubagentRuntime({
  parent,
  types = [],
  defaultType = 'general-purpose',
  maxConcurrent = 4,
  maxDepth = 2,
  modelAliases,
  retry = {},
  artifacts: artifactOpts = {},
  retainCompleted = 20,
  createAgent,
} = {}) {
  for (const type of types) registerAgentType(type)

  const sharedHistory = parent?.memory?.runtimeHistory ?? null
  const registry = new AgentRegistry({ maxConcurrent, retainCompleted })
  const artifacts = new ArtifactTrack({
    sharedHistory,
    policy: artifactOpts.policy ?? 'warn',
  })
  const aliases = resolveModelAliases(parent, modelAliases)
  const emit = (type, payload) => parent.emit(type, payload)

  const runner = new SubagentRunner({
    parent, registry, artifacts, sharedHistory, aliases,
    opts: { retry: { maxAttempts: retry.maxAttempts ?? 3, attemptTimeoutMs: retry.attemptTimeoutMs ?? 600000 }, maxDepth },
    emit,
    ...(createAgent ? { createAgent } : {}),
  })

  /** @type {Set<Promise<unknown>>} 在跑的后台任务 */
  const inflight = new Set()

  const runtime = {
    parent, registry, artifacts, runner, sharedHistory, aliases, defaultType, maxDepth,
    /** 供 `Agent` 注入的工具集 */
    tools: [],

    /** Level 1 清单：注入 system 消息，让模型知道 subagent_type 能填什么。 */
    typesNote() {
      const lines = listAgentTypes().map((t) => {
        const tools = t.tools === '*' ? 'all' : t.tools.join(', ')
        return `- ${t.name}: ${t.description} (model: ${t.model ?? 'inherited'}, tools: ${tools})`
      })
      return `Available agent types for the \`agent\` tool:\n${lines.join('\n')}`
    },

    /**
     * 起一个 subagent。`background: true` 时立即返回 started 行，结果稍后经
     * 轮边界注入（Task 10 接上）。
     */
    async spawn({
      description, prompt, subagentType, model, background = true, isolation = null,
      nodeId = null, inputs = [], depth = 1, parentAgentId = 'main', signal, onHandle,
    }) {
      const typeName = subagentType ?? defaultType
      const type = getAgentType(typeName)
      if (!type) {
        return `Error: unknown subagent_type "${typeName}". Available types: `
          + `${listAgentTypes().map(t => t.name).join(', ')}. Pick one of these and retry.`
      }
      let resolved
      try {
        resolved = resolveModel({ requested: model, type, aliases, parent })
      } catch (err) {
        return `Error: ${err.message}`
      }

      const handle = registry.create({
        type: typeName, description, parentAgentId, depth, nodeId,
        model: resolved, isolation,
      })
      // 图调度用它把 agentId 回填到节点。Task 16 会在这之后插入 worktree 创建。
      onHandle?.(handle)

      // 每个 agent 一个 AbortController，agent_cancel 就是 abort 它。父的 signal
      // 一旦 abort，子也跟着停。
      const controller = new AbortController()
      handle._abort = controller
      if (signal) {
        if (signal.aborted) controller.abort(signal.reason)
        else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
      }
      const childSignal = controller.signal

      const task = (async () => {
        const release = await registry.acquireSlot(depth, { signal: childSignal })
        try {
          return await runner.run(handle, { prompt, inputs, signal: childSignal })
        } finally {
          release()
        }
      })()

      if (!background) return task

      const tracked = task.then(
        (result) => { runtime._onBackgroundSettled(handle, result); return result },
        (err) => { runtime._onBackgroundSettled(handle, `[agent:${handle.name} failed] ${err?.message ?? err}`) },
      ).finally(() => inflight.delete(tracked))
      inflight.add(tracked)

      return `[agent:${handle.name} started] background; 完成后会通知你。用 agent_status 查看进度。`
    },

    /** Task 10 用注入替换掉这个默认实现。 */
    _onBackgroundSettled() {},

    hasPending() {
      return inflight.size > 0 || registry.list().length > 0
    },

    /** 等全部后台任务 settle。测试与 closeSubagents 用。 */
    async drain() {
      while (inflight.size > 0) await Promise.allSettled([...inflight])
    },

    async close() {
      for (const handle of registry.list()) {
        if (!handle.isTerminal()) {
          handle.transition('cancelled')
          emit('agent.cancelled', {
            agentId: handle.agentId, agentName: handle.name,
            parentAgentId: handle.parentAgentId, reason: 'runtime closed',
          })
        }
      }
      await runtime.drain()
    },
  }

  runtime.tools = createSubagentTools(runtime)
  return runtime
}
```

- [ ] **Step 4: 实现 tools.js**

```js
/**
 * subagent 系统的元工具。全部遵循本仓库的**软失败**风格：入参非法、类型未注册、
 * 目标不存在等情况返回说明字符串让模型自行纠正，不 throw。
 */
import { AGENT_TOOL_DESCRIPTION } from './contract.js'
import { modelEnum } from './models.js'
import { searchHistory, getHistoryEvent } from './history-search.js'

export const SUBAGENT_TOOL_NAMES = [
  'agent', 'agent_status', 'agent_cancel',
  'artifact_write', 'artifact_list',
  'history_search', 'history_get',
]

export function createSubagentTools(runtime) {
  return [
    {
      name: 'agent',
      description: AGENT_TOOL_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'A short (3-8 word) description of the task' },
          prompt: { type: 'string', description: 'The task for the agent to perform' },
          subagent_type: { type: 'string', description: 'The type of specialized agent to use for this task' },
          model: {
            type: 'string',
            enum: modelEnum(runtime.aliases),
            description: 'Optional model override. If omitted, uses the agent type\'s model, or inherits from the parent.',
          },
          run_in_background: {
            type: 'boolean',
            description: 'Agents run in the background by default; you will be notified when one completes. '
              + 'Set to false to run this agent synchronously when you need the result before continuing.',
          },
          isolation: {
            type: 'string',
            enum: ['worktree', 'remote'],
            description: 'Isolation mode. "worktree" gives the agent its own git worktree.',
          },
        },
        required: ['description', 'prompt'],
        additionalProperties: false,
      },
      execute: async (params = {}, ctx = {}) => {
        const { description, prompt, subagent_type: subagentType, model, run_in_background: bg, isolation } = params
        if (typeof description !== 'string' || description.trim() === '') {
          return 'Error: `description` is required — a 3-8 word label for this task (not the task itself).'
        }
        if (typeof prompt !== 'string' || prompt.trim() === '') {
          return 'Error: `prompt` is required — it carries the entire task contract in natural language.'
        }
        if (isolation === 'remote') {
          return 'Error: isolation "remote" is not available (no non-local A2A transport is registered). '
            + 'Retry without the isolation parameter, or with isolation "worktree".'
        }
        return runtime.spawn({
          description,
          prompt,
          subagentType,
          model,
          isolation: isolation === 'worktree' ? { mode: 'worktree' } : null,
          background: bg !== false,
          depth: (ctx.depth ?? 0) + 1,
          parentAgentId: ctx.agentId ?? 'main',
          signal: ctx.signal,
        })
      },
    },

    {
      name: 'agent_status',
      description: 'List spawned agents and their current state. Use this to check on background agents '
        + 'before assuming anything about their results.',
      parameters: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'Inspect one agent by id or name' },
          include_finished: { type: 'boolean', description: 'Include agents that already finished' },
        },
      },
      execute: async ({ agent_id: agentId, include_finished: includeFinished = false } = {}) => {
        if (agentId) {
          const handle = runtime.registry.get(agentId)
          if (!handle) return `Error: agent "${agentId}" not found.`
          return JSON.stringify(handle.toStatus(), null, 2)
        }
        const handles = runtime.registry.list({ includeFinished })
        if (handles.length === 0) return 'no active agents (0 running, 0 queued)'
        const lines = handles.map(h =>
          `${h.name} [${h.state}] type=${h.type} model=${h.model?.alias ?? 'inherited'} `
          + `attempt=${h.attempt} — ${h.description}`)
        return `${handles.length} agent(s):\n${lines.join('\n')}`
      },
    },

    {
      name: 'agent_cancel',
      description: 'Cancel a running agent. The agent stops at its next checkpoint and reports as cancelled.',
      parameters: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'Agent id or name' },
          reason: { type: 'string', description: 'Why it is being cancelled' },
        },
        required: ['agent_id'],
      },
      execute: async ({ agent_id: agentId, reason = 'cancelled by orchestrator' } = {}) => {
        const handle = runtime.registry.get(agentId)
        if (!handle) return `Error: agent "${agentId}" not found.`
        if (handle.isTerminal()) return `agent ${handle.name} already finished (${handle.state}); nothing to cancel.`
        handle._abort?.abort(reason)
        return `agent ${handle.name} cancellation requested (${reason}).`
      },
    },

    {
      name: 'artifact_write',
      description: 'Record an artifact you produced on the shared artifact track, so other agents can see '
        + 'who produced what. Recording is bookkeeping — it does not write the file for you.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Stable identifier, usually the file path' },
          kind: { type: 'string', enum: ['file', 'text', 'json', 'patch', 'url'] },
          summary: { type: 'string', description: 'One line: what this artifact is' },
          path: { type: 'string' },
          content: { type: 'string', description: 'Content, when the artifact is not a file on disk' },
          supersedes: { type: 'string', description: 'artifactId this replaces, when deliberately overwriting' },
        },
        required: ['key', 'summary'],
      },
      execute: async (params = {}, ctx = {}) => {
        const { ok, record, conflict } = runtime.artifacts.write({
          ...params,
          kind: params.kind ?? 'text',
          agentId: ctx.agentId ?? 'main',
          agentName: ctx.agentName ?? 'main',
          nodeId: ctx.nodeId ?? null,
          attempt: ctx.attempt ?? 1,
        })
        if (!ok) {
          runtime.parent.emit('artifact.conflict', { key: params.key, owner: conflict.ownerAgentName, policy: 'deny' })
          return `Refused: artifact key "${params.key}" is owned by ${conflict.ownerAgentName} `
            + `(sha:${conflict.ownerSha}). Coordinate with them, or use a different key.`
        }
        runtime.parent.emit('artifact.write', {
          artifactId: record.artifactId, key: record.key, sha: record.sha, bytes: record.bytes,
          agentId: record.agentId, agentName: record.agentName,
        })
        if (conflict) {
          runtime.parent.emit('artifact.conflict', { key: record.key, owner: conflict.ownerAgentName, policy: 'warn' })
          return `recorded ${record.key} (sha:${record.sha}) — warning: the previous version belonged to `
            + `${conflict.ownerAgentName} (sha:${conflict.ownerSha}). If this was not a deliberate overwrite, coordinate first.`
        }
        return `recorded ${record.key} (sha:${record.sha}, id:${record.artifactId})`
      },
    },

    {
      name: 'artifact_list',
      description: 'List artifacts on the shared track, with who produced each one.',
      parameters: {
        type: 'object',
        properties: {
          agent_id: { type: 'string' },
          key: { type: 'string' },
          limit: { type: 'number' },
        },
      },
      execute: async ({ agent_id: agentId, key, limit } = {}) => {
        const rows = runtime.artifacts.list({ agentId, key, limit })
        if (rows.length === 0) return 'no artifacts recorded yet'
        return rows.map(r =>
          `${r.key} (sha:${r.sha}) by ${r.agentName}${r.attempt > 1 ? ` attempt=${r.attempt}` : ''} — ${r.summary}`,
        ).join('\n')
      },
    },

    {
      name: 'history_search',
      description: 'Search the full session history — every message from every agent, including content that '
        + 'has since been compacted out of the active context. Use this to recover project context instead of '
        + 'guessing, or when you were told something earlier that you no longer have.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Substring (default) or regular expression source' },
          regex: { type: 'boolean' },
          agent_id: { type: 'string', description: 'Restrict to one agent\'s messages' },
          role: { type: 'string', enum: ['user', 'assistant', 'tool', 'system'] },
          since: { type: 'number', description: 'Epoch ms lower bound' },
          until: { type: 'number', description: 'Epoch ms upper bound' },
          limit: { type: 'number', description: 'Max hits (default 20)' },
        },
        required: ['query'],
      },
      execute: async ({ query, regex, agent_id: agentId, role, since, until, limit } = {}) => {
        if (!runtime.sharedHistory) {
          return 'history search unavailable: this agent\'s memory implementation does not expose a RuntimeHistory.'
        }
        const hits = searchHistory(runtime.sharedHistory, { query, regex, agentId, role, since, until, limit })
        if (hits.length === 0) return `no match for ${JSON.stringify(query)}`
        return hits.map(h =>
          `[${h.eventId}] ${new Date(h.ts).toISOString()} ${h.agentId ?? 'main'}/${h.role}: ${h.snippet}`,
        ).join('\n')
      },
    },

    {
      name: 'history_get',
      description: 'Expand one history event found via history_search, with surrounding messages.',
      parameters: {
        type: 'object',
        properties: {
          event_id: { type: 'string' },
          before: { type: 'number', description: 'How many preceding events (max 10)' },
          after: { type: 'number', description: 'How many following events (max 10)' },
        },
        required: ['event_id'],
      },
      execute: async ({ event_id: eventId, before, after } = {}) => {
        if (!runtime.sharedHistory) return 'history unavailable for this memory implementation.'
        const got = getHistoryEvent(runtime.sharedHistory, { eventId, before, after })
        if (!got) return `Error: event "${eventId}" not found.`
        const render = (e) => {
          const body = e.type === 'summary' ? e.content : (e.message?.content ?? '')
          const role = e.type === 'summary' ? 'summary' : (e.message?.role ?? '?')
          return `[${e.id}] ${role}: ${body}`
        }
        return [...got.before.map(render), `>>> ${render(got.target)}`, ...got.after.map(render)].join('\n')
      },
    },
  ]
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test src/agents/tools.test.js`
Expected: PASS（13 个测试）

- [ ] **Step 6: 跑全量测试并 Commit**

```bash
npm test
git add src/agents/runtime.js src/agents/tools.js src/agents/tools.test.js
git commit -m "feat(agents): add subagent runtime and the first seven meta-tools

The agent tool's input_schema is pinned to the reference shape
(additionalProperties: false); the model enum is generated from the host's
alias table. Every tool soft-fails with a corrective message rather than
throwing, matching the ToolFilter/skill precedent."
```

---

### Task 9: 接入 `Agent` —— 配置、工具注入、类型清单、ctx 扩展

**Files:**
- Modify: `src/agent.js`（构造函数、`_withSubagentTypesNote`、工具执行 ctx、`closeSubagents`、`reset`）
- Test: `src/agent-subagents.test.js`

**Interfaces:**
- Consumes: `createSubagentRuntime` / `SUBAGENT_TOOL_NAMES`
- Produces（`Agent` 新增公开面）：
  - `opts.subagents` 配置（见 spec §4.1）
  - `this.subagents` —— `SubagentRuntime` 或 `null`
  - `this._providerName` —— 构造时记住的 provider 名（`SubagentRunner` 要用）
  - `this._toolContextExtra` —— 合并进 `tool.execute` 第二参的字段
  - `closeSubagents()`
  - `getArtifacts({ agentId })` 增加过滤参数

- [ ] **Step 1: 写失败测试**

```js
// src/agent-subagents.test.js
import test from 'node:test'
import assert from 'node:assert'
import { Agent } from './agent.js'
import { SUBAGENT_TOOL_NAMES } from './agents/tools.js'
import { BASE_TOOLS, resetBaseTools } from './tool-filter.js'
import { resetAgentTypes } from './agents/types.js'

const baseOpts = { provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o' }

test.beforeEach(() => { resetAgentTypes(); resetBaseTools() })
test.after(() => { resetAgentTypes(); resetBaseTools() })

test('未配置 subagents 时行为不变：无新工具、subagents 为 null', () => {
  const agent = new Agent({ ...baseOpts })
  assert.strictEqual(agent.subagents, null)
  for (const name of SUBAGENT_TOOL_NAMES) {
    assert.ok(!agent.getTools().some(t => t.name === name), `不该注入 ${name}`)
  }
})

test('配置后注入全部元工具并注册为 base tool', () => {
  const agent = new Agent({ ...baseOpts, subagents: {} })
  const names = agent.getTools().map(t => t.name)
  for (const name of SUBAGENT_TOOL_NAMES) {
    assert.ok(names.includes(name), `缺少工具 ${name}`)
    assert.ok(BASE_TOOLS.has(name), `${name} 未注册为 base tool，开启意图识别后会被过滤掉`)
  }
})

test('_providerName 被记住，供子 agent 构造用', () => {
  assert.strictEqual(new Agent({ ...baseOpts, subagents: {} })._providerName, 'openai')
})

test('类型清单被合并进 system 消息', () => {
  const agent = new Agent({
    ...baseOpts,
    subagents: { types: [{ name: 'explorer', description: '只读检索', systemPrompt: 's' }] },
  })
  const messages = agent._withSubagentTypesNote([
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'hi' },
  ])
  assert.strictEqual(messages.length, 2)
  assert.ok(messages[0].content.includes('You are helpful.'))
  assert.ok(messages[0].content.includes('Available agent types'))
  assert.ok(messages[0].content.includes('explorer'))
  assert.ok(messages[0].content.includes('general-purpose'))
  assert.strictEqual(messages[1].content, 'hi')
})

test('无 system 消息时类型清单不丢失', () => {
  const agent = new Agent({ ...baseOpts, subagents: {} })
  const messages = agent._withSubagentTypesNote([{ role: 'user', content: 'hi' }])
  assert.strictEqual(messages[0].role, 'system')
  assert.ok(messages[0].content.includes('Available agent types'))
})

test('未配置 subagents 时 _withSubagentTypesNote 原样返回', () => {
  const agent = new Agent({ ...baseOpts })
  const input = [{ role: 'system', content: 'sys' }]
  assert.deepStrictEqual(agent._withSubagentTypesNote(input), input)
})

test('工具执行 ctx 带上 agentId / depth，且不影响既有工具', async () => {
  let seenCtx = null
  const agent = new Agent({
    ...baseOpts,
    subagents: {},
    tools: [{
      name: 'probe', description: 'p', parameters: { type: 'object', properties: {} },
      execute: async (_args, ctx) => { seenCtx = ctx; return 'ok' },
    }],
  })
  const probe = agent.getTools().find(t => t.name === 'probe')
  await probe.execute({}, { ...agent._toolContextExtra, signal: undefined })
  assert.strictEqual(seenCtx.agentId, 'main')
  assert.strictEqual(seenCtx.depth, 0)
  assert.strictEqual(seenCtx.cwd, null)
})

test('closeSubagents 取消未完成 agent 且可重复调用', async () => {
  const agent = new Agent({ ...baseOpts, subagents: {} })
  await agent.closeSubagents()
  await agent.closeSubagents()
  assert.ok(true)
})

test('getArtifacts 支持 agentId 过滤', async () => {
  const agent = new Agent({ ...baseOpts, subagents: {} })
  agent.subagents.artifacts.write({
    agentId: 'agt_1', agentName: 'a-1', key: 'k1', kind: 'text', summary: 's', content: 'x',
  })
  agent.subagents.artifacts.write({
    agentId: 'agt_2', agentName: 'a-2', key: 'k2', kind: 'text', summary: 's', content: 'y',
  })
  assert.strictEqual((await agent.getArtifacts()).length, 2)
  assert.strictEqual((await agent.getArtifacts({ agentId: 'agt_1' })).length, 1)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/agent-subagents.test.js`
Expected: FAIL —— `agent.subagents` 是 `undefined`

- [ ] **Step 3: 改 `src/agent.js`**

在 import 区加：

```js
import { createSubagentRuntime } from './agents/runtime.js'
import { SUBAGENT_TOOL_NAMES } from './agents/tools.js'
```

构造函数里 `this.url = resolveProviderUrl(...)` 之后加一行：

```js
    /** 记住 provider 名 —— SubagentRunner 构造子 Agent 时要原样传下去。 */
    this._providerName = opts.provider
```

构造函数末尾（skill 系统那一段之后）加：

```js
    // ---- Subagent 系统 ----
    // `opts.subagents` 配置后创建 SubagentRuntime 并注入元工具。未配置时
    // `this.subagents` 恒为 null，全部相关行为与旧版本逐字节一致。
    this.subagents = null
    /** 合并进 `tool.execute(args, ctx)` 第二参的归属字段。 */
    this._toolContextExtra = { agentId: 'main', agentName: 'main', depth: 0, cwd: null }
    if (opts.subagents) {
      this.subagents = createSubagentRuntime({ parent: this, ...opts.subagents })
      this.tools = [...this.tools, ...this.subagents.tools]
      // 与 `skill` 同一理由：开启意图识别后 ToolFilter 会裁剪工具集，元工具被
      // 裁掉时 system prompt 里的类型清单就指向了模型调不到的工具。
      for (const name of SUBAGENT_TOOL_NAMES) registerBaseTool(name)
    }
```

新增方法（放在 `_withSkillListingNote` 旁边）：

```js
  /**
   * 把 agent 类型清单合并进 system 消息（Level 1，与 skill 清单同一手法）。
   * 未配置 subagents 时原样返回入参。
   * @param {object[]} messages
   * @returns {object[]}
   */
  _withSubagentTypesNote(messages) {
    if (!this.subagents) return messages
    const note = this.subagents.typesNote()
    const out = [...messages]
    const systemIndex = out.findIndex(m => m.role === 'system')
    if (systemIndex >= 0) {
      out[systemIndex] = { ...out[systemIndex], content: `${out[systemIndex].content}\n\n${note}` }
    } else {
      out.unshift({ role: 'system', content: note })
    }
    return out
  }

  /**
   * 取消全部在跑的 subagent 并等待它们 settle。幂等。
   * @returns {Promise<void>}
   */
  async closeSubagents() {
    if (!this.subagents) return
    await this.subagents.close()
  }
```

`_buildSimpleBody` / `_runPipeline` 里组装 messages 的位置，在已有的 `_withSkillListingNote(...)` 外面再包一层 `this._withSubagentTypesNote(...)`。

`getArtifacts` 改成：

```js
  async getArtifacts({ agentId } = {}) {
    const rh = this.memory?.runtimeHistory
    if (!rh || typeof rh.project !== 'function') return []
    const rows = rh.project('artifacts')
    return agentId == null ? rows : rows.filter(r => r.agentId === agentId)
  }
```

两处 `tool.execute(call.arguments, { signal })`（`_reactLoop` 与 `_reactLoopStream`）改成：

```js
result = await tool.execute(call.arguments, { ...this._toolContextExtra, signal })
```

`reset()` 里加一行 `void this.closeSubagents()`（不 await —— `reset` 是同步方法，这里只触发取消）。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/agent-subagents.test.js`
Expected: PASS（9 个测试）

- [ ] **Step 5: 跑全量测试，确认既有 354 个测试无回归**

Run: `npm test`
Expected: 0 fail。**任何既有测试挂掉都说明触点破坏了向后兼容，必须修到全绿再提交。**

- [ ] **Step 6: Commit**

```bash
git add src/agent.js src/agent-subagents.test.js
git commit -m "feat(agent): wire the subagent runtime into Agent

Opt-in via opts.subagents. Meta-tools are registered as base tools so
ToolFilter cannot strip them out from under the system-prompt type
listing, the way it once did to skill. Tool execution context gains
agentId/agentName/depth/cwd; existing tools ignore the extra fields."
```

**Phase 1 完成** —— 此时已经可以派 subagent、查状态、取消、记账产物、检索历史。

---

## Phase 2 — 消息投递与提问路由

### Task 10: 轮边界注入机制

**Files:**
- Modify: `src/agent.js`（`enqueueMessage` / `_pendingInjections` / `_drainPendingInjections` / 两个 ReAct 循环）
- Test: `src/agent-injection.test.js`

**Interfaces:**
- Produces:
  - `Agent#enqueueMessage(message) -> this` —— `message` 为 `{ role, content }`；FIFO 入队，**不立即写 memory**
  - `Agent#_pendingInjections: object[]`
  - `Agent#_drainPendingInjections() -> number` —— 排空并写入 memory，返回写入条数；>5 条时合并为一条
  - `INJECTION_MERGE_THRESHOLD = 5`（`src/agents/mailbox.js` 导出，本任务先在 `agent.js` 里用常量，Task 11 移过去）
  - `INJECTABLE_ROLES = new Set(['user', 'system'])` —— `enqueueMessage` 的 role 白名单。`'tool'` 必须被拒：一条没有 `tool_call_id` 的孤儿 tool 消息正是本机制要防的破坏。`'assistant'` 也拒 —— 伪造一轮助手发言会让模型误以为自己说过那句话。

- [ ] **Step 1: 写失败测试**

```js
// src/agent-injection.test.js
import test from 'node:test'
import assert from 'node:assert'
import { Agent } from './agent.js'

const baseOpts = { provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o' }

test('enqueueMessage 入队但不立即进 memory', async () => {
  const agent = new Agent({ ...baseOpts })
  agent.enqueueMessage({ role: 'user', content: '<agent-notification>done</agent-notification>' })
  assert.strictEqual(agent._pendingInjections.length, 1)
  const history = await agent.getHistory('model')
  assert.ok(!history.some(m => String(m.content).includes('agent-notification')))
})

test('_drainPendingInjections 写入 memory 并清空队列', async () => {
  const agent = new Agent({ ...baseOpts })
  agent.enqueueMessage({ role: 'user', content: 'first' })
  agent.enqueueMessage({ role: 'user', content: 'second' })
  assert.strictEqual(agent._drainPendingInjections(), 2)
  assert.strictEqual(agent._pendingInjections.length, 0)
  const history = await agent.getHistory('model')
  const contents = history.map(m => String(m.content))
  assert.ok(contents.includes('first'))
  assert.ok(contents.includes('second'))
})

test('队列为空时 drain 是无副作用的 0', async () => {
  const agent = new Agent({ ...baseOpts })
  const before = (await agent.getHistory('model')).length
  assert.strictEqual(agent._drainPendingInjections(), 0)
  assert.strictEqual((await agent.getHistory('model')).length, before)
})

test('超过 5 条时合并为单条消息', async () => {
  const agent = new Agent({ ...baseOpts })
  for (let i = 0; i < 7; i++) agent.enqueueMessage({ role: 'user', content: `note ${i}` })
  assert.strictEqual(agent._drainPendingInjections(), 1)
  const history = await agent.getHistory('model')
  const merged = history[history.length - 1]
  assert.strictEqual(merged.role, 'user')
  for (let i = 0; i < 7; i++) assert.ok(String(merged.content).includes(`note ${i}`))
})

test('注入发生在轮边界：不破坏 assistant(tool_calls) → tool 的配对', async () => {
  const agent = new Agent({ ...baseOpts })
  agent.memory.add({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'probe', arguments: '{}' } }] })
  agent.memory.add({ role: 'tool', tool_call_id: 'c1', name: 'probe', content: 'result' })
  agent.enqueueMessage({ role: 'user', content: 'notification' })
  agent._drainPendingInjections()

  const history = await agent.getHistory('model')
  const toolCallIndex = history.findIndex(m => Array.isArray(m.tool_calls))
  const toolResultIndex = history.findIndex(m => m.role === 'tool')
  const injectedIndex = history.findIndex(m => m.content === 'notification')
  assert.strictEqual(toolResultIndex, toolCallIndex + 1, 'tool 结果必须紧跟其 assistant 消息')
  assert.ok(injectedIndex > toolResultIndex, '注入必须落在整组工具调用之后')
})

test('非法入参被忽略而不是抛异常', () => {
  const agent = new Agent({ ...baseOpts })
  agent.enqueueMessage(null)
  agent.enqueueMessage('not an object')
  agent.enqueueMessage({ role: 'user' })
  assert.strictEqual(agent._pendingInjections.length, 0)
})

test('role 白名单：tool / assistant 被拒，不会写出孤儿 tool 消息', () => {
  // 回归测试：`role: message.role ?? 'user'` 只挡 null/undefined。显式传 'tool'
  // 会被原样入队，drain 时直接 memory.add，产生一条没有 tool_call_id 的孤儿
  // tool 消息 —— 正是本机制存在的理由所要防的那类破坏。
  const agent = new Agent({ ...baseOpts })
  agent.enqueueMessage({ role: 'tool', content: 'orphan' })
  agent.enqueueMessage({ role: 'assistant', content: 'fake turn' })
  assert.strictEqual(agent._pendingInjections.length, 0, 'tool / assistant 必须被拒')

  agent.enqueueMessage({ role: 'user', content: 'ok' })
  agent.enqueueMessage({ role: 'system', content: 'also ok' })
  assert.deepStrictEqual(agent._pendingInjections.map(m => m.role), ['user', 'system'])
})

test('合并阈值边界：恰好 5 条不合并，6 条合并', async () => {
  const five = new Agent({ ...baseOpts })
  for (let i = 0; i < 5; i++) five.enqueueMessage({ role: 'user', content: `m${i}` })
  assert.strictEqual(five._drainPendingInjections(), 5, '恰好 5 条应逐条写入')

  const six = new Agent({ ...baseOpts })
  for (let i = 0; i < 6; i++) six.enqueueMessage({ role: 'user', content: `m${i}` })
  assert.strictEqual(six._drainPendingInjections(), 1, '6 条应合并为 1 条')
  const history = await six.getHistory('model')
  const merged = history[history.length - 1]
  for (let i = 0; i < 6; i++) assert.ok(String(merged.content).includes(`m${i}`))
})

test('reset() 清空待注入队列，旧会话的通知不漏进新会话', () => {
  const agent = new Agent({ ...baseOpts })
  agent.enqueueMessage({ role: 'user', content: '<agent-notification>stale</agent-notification>' })
  agent.reset()
  assert.strictEqual(agent._pendingInjections.length, 0)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/agent-injection.test.js`
Expected: FAIL —— `agent.enqueueMessage is not a function`

- [ ] **Step 3: 改 `src/agent.js`**

构造函数里加：

```js
    /**
     * 待注入消息队列。后台 subagent 完成通知、图节点就绪通知、A2A 投递三者
     * 共用这一个机制 —— 都不打断正在执行的工具，只在轮边界汇入。
     * @type {object[]}
     */
    this._pendingInjections = []
```

模块顶层加 role 白名单常量（紧邻 `INJECTION_MERGE_THRESHOLD`）：

```js
/**
 * 允许注入的 role。`'tool'` 必须被拒 —— 一条没有 `tool_call_id` 的孤儿 tool
 * 消息正是轮边界注入这套机制要防的破坏；`'assistant'` 也拒，伪造一轮助手发言
 * 会让模型误以为自己说过那句话。
 */
const INJECTABLE_ROLES = new Set(['user', 'system'])
```

`reset()` 里在清 memory 的同时清空队列（一行）：

```js
    this._pendingInjections = []
```
> 上一个会话的通知不该漏进新会话 —— `reset()` 清了 memory 与 history，队列却还留着，下一轮跑到 round 1 就会把陈旧通知注入全新的对话。

新增两个方法：

```js
  /**
   * 把一条消息排入待注入队列。它会在**下一个 ReAct 轮边界**写进 memory，
   * 而不是立刻写 —— 轮中间插消息会切断 `assistant(tool_calls)` 与其 `tool`
   * 结果的配对，`memory-policy.js` 的裁剪逻辑依赖这个不变量。
   * @param {{ role: string, content: string }} message
   * @returns {this}
   */
  enqueueMessage(message) {
    if (!message || typeof message !== 'object') return this
    if (typeof message.content !== 'string' || message.content.length === 0) return this
    // role 必须在白名单内。注入的消息会被直接 memory.add，一条 role:'tool' 且没有
    // tool_call_id 的孤儿消息正是本机制要防的那类破坏 —— 而 `role ?? 'user'` 只挡
    // null/undefined，挡不住显式传进来的 'tool'。A2A / 图调度这些外部发送方的入参
    // 不该被当成可信输入。
    if (!INJECTABLE_ROLES.has(message.role ?? 'user')) {
      console.warn(`[agent] enqueueMessage: dropping message with role "${message.role}" `
        + `(injectable roles: ${[...INJECTABLE_ROLES].join(', ')})`)
      return this
    }
    this._pendingInjections.push({ role: message.role ?? 'user', content: message.content })
    return this
  }

  /**
   * 排空待注入队列写进 memory。返回实际写入的消息条数。
   * 超过 5 条时合并为一条 —— 连续多条 user 消息会被部分供应商拒绝。
   * @returns {number}
   */
  _drainPendingInjections() {
    const pending = this._pendingInjections
    if (pending.length === 0) return 0
    this._pendingInjections = []
    if (pending.length <= 5) {
      for (const message of pending) this.memory.add(message)
      return pending.length
    }
    this.memory.add({ role: 'user', content: pending.map(m => m.content).join('\n\n') })
    return 1
  }
```

在 `_reactLoop` 的 `try {` 之后、`let body` 之前插入：

```js
        // 轮边界：先排空待注入消息，再构建本轮请求体。此刻上一轮的
        // assistant(tool_calls) 与全部 tool 结果都已成对落盘。
        if (round > 0) this._drainPendingInjections()
```

`_reactLoopStream` 同一位置插同一句。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/agent-injection.test.js && npm test`
Expected: PASS（6 个新测试），全量 0 fail

- [ ] **Step 5: Commit**

```bash
git add src/agent.js src/agent-injection.test.js
git commit -m "feat(agent): add round-boundary message injection

enqueueMessage queues; the ReAct loop drains at the round boundary, after
the previous round's tool_calls/tool results are paired on disk. Injecting
mid-round would break the pairing invariant memory-policy.js relies on.

One mechanism serves three senders: background completion notices, graph
ready notices, and A2A deliveries."
```

---

### Task 11: A2A 协议、邮箱与 `send_message`

**Files:**
- Create: `src/agents/a2a/index.js`
- Create: `src/agents/a2a/local.js`
- Create: `src/agents/mailbox.js`
- Modify: `src/agents/tools.js`（加 `send_message`）、`src/agents/runtime.js`（接邮箱与完成通知）
- Test: `src/agents/a2a.test.js`
- Test: `src/agents/mailbox.test.js`

**Interfaces:**
- Produces:
  - `encodeEnvelope(envelope) -> string` / `decodeEnvelope(line) -> object`（畸形帧抛 `A2AError({ kind: 'malformed_frame' })`）
  - `registerA2ATransport(name, factory)` / `resolveA2ATransport(config)` / `RESERVED_A2A_TRANSPORTS = new Set(['local','http','grpc'])`
  - `createLocalTransport({ mailbox, registry })`
  - `class Mailbox`：`deliver(envelope)` / `drain(agentId) -> object[]` / `size(agentId)` / `formatForInjection(envelope) -> string`
  - `INJECTION_MERGE_THRESHOLD = 5`

- [ ] **Step 1: 写 a2a 的失败测试**

```js
// src/agents/a2a.test.js
import test from 'node:test'
import assert from 'node:assert'
import {
  encodeEnvelope, decodeEnvelope, registerA2ATransport, resolveA2ATransport,
  RESERVED_A2A_TRANSPORTS,
} from './a2a/index.js'
import { A2AError } from './errors.js'

const sample = {
  jsonrpc: '2.0', id: 'env_1', method: 'message/send',
  params: {
    from: { agentId: 'agt_1', name: 'planner-1' },
    to: { agentId: 'agt_2' },
    kind: 'message', correlationId: null, body: 'hello', meta: {},
  },
}

test('编解码往返', () => {
  assert.deepStrictEqual(decodeEnvelope(encodeEnvelope(sample)), sample)
})

test('编码是单行（为远程 transport 的行分帧预留）', () => {
  assert.ok(!encodeEnvelope(sample).includes('\n'))
})

test('畸形帧抛 A2AError 且 kind 为 malformed_frame', () => {
  for (const bad of ['', '{', 'null', '[]', '{"jsonrpc":"1.0"}', '{"jsonrpc":"2.0"}']) {
    assert.throws(() => decodeEnvelope(bad),
      (err) => err instanceof A2AError && err.kind === 'malformed_frame', `应拒绝: ${bad}`)
  }
})

test('缺 params.to / params.from 被拒', () => {
  assert.throws(() => decodeEnvelope(JSON.stringify({ jsonrpc: '2.0', method: 'message/send', params: {} })), A2AError)
})

test('未知 method 被拒', () => {
  const bad = { ...sample, method: 'agent/nope' }
  assert.throws(() => decodeEnvelope(JSON.stringify(bad)), A2AError)
})

test('保留 transport 名不可覆盖', () => {
  for (const name of RESERVED_A2A_TRANSPORTS) {
    assert.throws(() => registerA2ATransport(name, () => ({})), A2AError)
  }
})

test('自定义 transport 可注册与解析', () => {
  registerA2ATransport('test-transport', () => ({ tag: 'custom' }))
  assert.strictEqual(resolveA2ATransport({ transport: 'test-transport' }).tag, 'custom')
})

test('未知 transport 名解析时抛错', () => {
  assert.throws(() => resolveA2ATransport({ transport: 'nope' }), A2AError)
})
```

- [ ] **Step 2: 运行测试确认失败，然后实现 `a2a/index.js`**

Run: `node --test src/agents/a2a.test.js` → FAIL

```js
/**
 * A2A（Agent-to-Agent）信封与 transport 注册表。
 *
 * 形状是 JSON-RPC 2.0，为将来接远程 agent 预留。v1 只实现进程内 `local`
 * transport —— 但**即使不需要序列化也走一遍 encode/decode**，让形状错误在
 * 本地就暴露，而不是等接远程时才炸。
 */
import { A2AError } from '../errors.js'

export const A2A_METHODS = new Set(['message/send', 'message/notify'])
export const A2A_KINDS = new Set(['message', 'question', 'answer', 'notice', 'result'])
export const RESERVED_A2A_TRANSPORTS = new Set(['local', 'http', 'grpc'])

/** @type {Map<string, (config: object) => object>} */
const TRANSPORTS = new Map()

export function encodeEnvelope(envelope) {
  return JSON.stringify(envelope)
}

export function decodeEnvelope(line) {
  let parsed
  try {
    parsed = JSON.parse(line)
  } catch (err) {
    throw new A2AError('malformed A2A frame: not valid JSON', { kind: 'malformed_frame', cause: err })
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new A2AError('malformed A2A frame: not an object', { kind: 'malformed_frame' })
  }
  if (parsed.jsonrpc !== '2.0') {
    throw new A2AError('malformed A2A frame: jsonrpc must be "2.0"', { kind: 'malformed_frame' })
  }
  if (!A2A_METHODS.has(parsed.method)) {
    throw new A2AError(`malformed A2A frame: unknown method ${JSON.stringify(parsed.method)}`, { kind: 'malformed_frame' })
  }
  const params = parsed.params
  if (!params || typeof params !== 'object') {
    throw new A2AError('malformed A2A frame: missing params', { kind: 'malformed_frame' })
  }
  if (!params.from || !params.to) {
    throw new A2AError('malformed A2A frame: params.from and params.to are required', { kind: 'malformed_frame' })
  }
  if (!A2A_KINDS.has(params.kind)) {
    throw new A2AError(`malformed A2A frame: unknown kind ${JSON.stringify(params.kind)}`, { kind: 'malformed_frame' })
  }
  return parsed
}

/** 内部：内置 transport 自注册用，绕过保留名检查。 */
export function _setBuiltinTransport(name, factory) {
  TRANSPORTS.set(name, factory)
}

export function registerA2ATransport(name, factory) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new A2AError('registerA2ATransport: name must be a non-empty string')
  }
  if (RESERVED_A2A_TRANSPORTS.has(name)) {
    throw new A2AError(`registerA2ATransport: "${name}" is a reserved transport name`, { transport: name })
  }
  if (typeof factory !== 'function') {
    throw new A2AError('registerA2ATransport: factory must be a function', { transport: name })
  }
  TRANSPORTS.set(name, factory)
}

export function resolveA2ATransport(config = {}) {
  const name = config.transport ?? 'local'
  const factory = TRANSPORTS.get(name)
  if (!factory) {
    throw new A2AError(
      `unknown A2A transport "${name}". Registered: ${[...TRANSPORTS.keys()].join(', ')}`,
      { transport: name },
    )
  }
  return factory(config)
}
```

`a2a/local.js`：

```js
/** 进程内 transport：按 agentId 路由到目标 mailbox。 */
import { _setBuiltinTransport, encodeEnvelope, decodeEnvelope } from './index.js'

export function createLocalTransport({ mailbox, registry }) {
  return {
    name: 'local',
    /**
     * 即使同进程也走 encode/decode —— 形状错误要在本地暴露。
     * @returns {{ ok: boolean, reason?: string }}
     */
    send(envelope) {
      const decoded = decodeEnvelope(encodeEnvelope(envelope))
      const targetId = decoded.params.to.agentId
      const handle = targetId === 'main' ? null : registry.get(targetId)
      if (targetId !== 'main' && !handle) return { ok: false, reason: 'unknown_target' }
      mailbox.deliver(decoded)
      return { ok: true }
    },
  }
}

_setBuiltinTransport('local', createLocalTransport)
```

- [ ] **Step 3: 运行测试确认通过**

Run: `node --test src/agents/a2a.test.js`
Expected: PASS（8 个测试）

- [ ] **Step 4: 写 mailbox 的失败测试**

```js
// src/agents/mailbox.test.js
import test from 'node:test'
import assert from 'node:assert'
import { Mailbox } from './mailbox.js'

const envelope = (to, body, from = { agentId: 'agt_1', name: 'planner-1' }) => ({
  jsonrpc: '2.0', id: `env_${body}`, method: 'message/send',
  params: { from, to: { agentId: to }, kind: 'message', correlationId: null, body, meta: {} },
})

test('投递后可按 agentId 排空，FIFO', () => {
  const mb = new Mailbox()
  mb.deliver(envelope('agt_2', 'first'))
  mb.deliver(envelope('agt_2', 'second'))
  assert.strictEqual(mb.size('agt_2'), 2)
  const drained = mb.drain('agt_2')
  assert.deepStrictEqual(drained.map(e => e.params.body), ['first', 'second'])
  assert.strictEqual(mb.size('agt_2'), 0)
  assert.deepStrictEqual(mb.drain('agt_2'), [])
})

test('收件箱按 agent 隔离', () => {
  const mb = new Mailbox()
  mb.deliver(envelope('agt_2', 'for-2'))
  mb.deliver(envelope('agt_3', 'for-3'))
  assert.strictEqual(mb.drain('agt_2').length, 1)
  assert.strictEqual(mb.drain('agt_3')[0].params.body, 'for-3')
})

test('注入文本点名发信人', () => {
  const mb = new Mailbox()
  const text = mb.formatForInjection(envelope('agt_2', '上游产物在 docs/x.md'))
  assert.ok(text.includes('planner-1'))
  assert.ok(text.includes('上游产物在 docs/x.md'))
  assert.ok(text.includes('agent-message'))
})

test('main 也能收件', () => {
  const mb = new Mailbox()
  mb.deliver(envelope('main', 'to parent'))
  assert.strictEqual(mb.drain('main').length, 1)
})
```

- [ ] **Step 5: 实现 `mailbox.js`**

```js
/**
 * 每个 agent 一个收件箱。消息**不打断**正在执行的工具 —— 只在目标 agent 的
 * ReAct 轮边界被排空注入（复用 Agent#enqueueMessage）。
 */

export const INJECTION_MERGE_THRESHOLD = 5

export class Mailbox {
  constructor() {
    /** @type {Map<string, object[]>} agentId → 待读信封 */
    this._boxes = new Map()
  }

  deliver(envelope) {
    const to = envelope.params.to.agentId
    const box = this._boxes.get(to) ?? []
    box.push(envelope)
    this._boxes.set(to, box)
    return envelope
  }

  size(agentId) {
    return this._boxes.get(agentId)?.length ?? 0
  }

  drain(agentId) {
    const box = this._boxes.get(agentId) ?? []
    this._boxes.set(agentId, [])
    return box
  }

  formatForInjection(envelope) {
    const from = envelope.params.from.name ?? envelope.params.from.agentId
    return `<agent-message from="${from}">\n${envelope.params.body}\n</agent-message>`
  }
}
```

- [ ] **Step 6: 在 `tools.js` 加 `send_message`，在 `runtime.js` 接上邮箱**

`tools.js` 的 `SUBAGENT_TOOL_NAMES` 加 `'send_message'`，并追加工具定义：

```js
    {
      name: 'send_message',
      description: 'Send a message to another agent. The message does not interrupt what that agent is '
        + 'doing — it lands in its context at its next round boundary. Sending to an agent that already '
        + 'finished resumes it with its context intact. Use "parent" or "main" to reach the orchestrator.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Target agent id or name, or "parent" / "main"' },
          message: { type: 'string' },
          summary: { type: 'string', description: 'Optional 5-10 word preview for the UI' },
        },
        required: ['to', 'message'],
      },
      execute: async ({ to, message, summary } = {}, ctx = {}) =>
        runtime.sendMessage({
          to, body: message, summary,
          from: { agentId: ctx.agentId ?? 'main', name: ctx.agentName ?? 'main' },
        }),
    },
```

`runtime.js` 里加：

```js
  const mailbox = new Mailbox()
  const transport = resolveA2ATransport({ transport: a2a.transport ?? 'local', mailbox, registry })
```

并给 runtime 对象加两个方法：

```js
    /** A2A 发信。目标已终态且上下文仍在 → 续跑。 */
    async sendMessage({ to, body, summary, from }) {
      const targetId = (to === 'parent' || to === 'main') ? 'main' : (registry.get(to)?.agentId ?? null)
      if (!targetId) return `Error: agent "${to}" not found. Use agent_status to list agents.`

      const envelope = {
        jsonrpc: '2.0', id: `env_${Date.now().toString(16)}`, method: 'message/send',
        params: { from, to: { agentId: targetId }, kind: 'message', correlationId: null, body, meta: { summary } },
      }
      const sent = transport.send(envelope)
      if (!sent.ok) return `Error: could not deliver to "${to}" (${sent.reason}).`
      emit('a2a.delivered', {
        envelopeId: envelope.id, from: from.agentId, to: targetId, kind: 'message',
      })

      if (targetId === 'main') {
        for (const env of mailbox.drain('main')) parent.enqueueMessage({ role: 'user', content: mailbox.formatForInjection(env) })
        return `delivered to main; it will read this at its next round boundary.`
      }

      const handle = registry.get(targetId)
      if (handle.isTerminal()) {
        if (registry.evicted(handle.agentId) || !handle._child) {
          return `Error: agent ${handle.name} already finished (${handle.state}) and its context has been `
            + 'evicted. Start a new agent instead.'
        }
        return runtime._resume(handle)
      }
      return `delivered to ${handle.name}; it will read this at its next round boundary.`
    },

    /** 向已结束的 agent 发消息 = 用它保留的 memory 续跑一轮。 */
    async _resume(handle) {
      const pending = mailbox.drain(handle.agentId)
      const text = pending.map(env => mailbox.formatForInjection(env)).join('\n\n')
      // 这里**故意**绕过 handle.transition() —— 状态机不允许离开终态（那是为了
      // 拦住并发路径上的非法迁移），而续跑是主 agent 明确要求的、单线程的复活。
      handle.state = 'running'
      handle.endedAt = null
      try {
        const reply = await handle._child.chat(text)
        handle.state = 'succeeded'
        handle.result = { status: 'succeeded', text: reply }
        return runner.formatResult(handle, { text: reply })
      } catch (err) {
        handle.state = 'failed'
        handle.result = { status: 'failed', failureKind: 'llm_error', lastError: String(err?.message ?? err) }
        return runner.formatResult(handle)
      }
    },
```

子 agent 在轮边界读收件箱：`SubagentRunner._runOnce` 里给子 `Agent` 注册 `hooks.onRoundStart`，回调中把 `mailbox.drain(handle.agentId)` 的信封 `child.enqueueMessage(...)`。为此 `SubagentRunner` 构造参数加 `mailbox`，`runtime.js` 传入。

后台完成通知：把 `runtime._onBackgroundSettled` 实现为

```js
    _onBackgroundSettled(handle, result) {
      parent.enqueueMessage({
        role: 'user',
        content: `<agent-notification agent="${handle.name}" state="${handle.state}">\n${result}\n</agent-notification>`,
      })
    },
```

- [ ] **Step 7: 补一个端到端测试到 `src/agents/mailbox.test.js`**

```js
test('后台 agent 完成后，通知进了父的待注入队列', async () => {
  const { createSubagentRuntime } = await import('./runtime.js')
  const { RuntimeHistory } = await import('../runtime-history.js')
  const injected = []
  const parent = {
    _providerName: 'openai', model: 'm', apiKey: 'k', url: 'u',
    simpleModel: 'm', simpleApiKey: 'k', simpleUrl: 'u',
    tools: [], hooks: {}, knowledgeBase: null, tokenBudget: null, validateStreamCompletion: true,
    memory: { runtimeHistory: new RuntimeHistory(), add() {} },
    emit() {},
    enqueueMessage(msg) { injected.push(msg) },
  }
  const rt = createSubagentRuntime({
    parent,
    createAgent: () => ({
      lastStopReason: null, on() { return this }, off() { return this },
      getLastRunMetrics: () => ({ totalRounds: 1, totalLlmCalls: 1, totalToolCalls: 0, usage: {}, wallClockMs: 1 }),
      async chat() { return '后台任务完成' },
    }),
  })
  await rt.spawn({ description: 'd', prompt: 'p' })
  await rt.drain()
  assert.strictEqual(injected.length, 1)
  assert.ok(injected[0].content.includes('agent-notification'))
  assert.ok(injected[0].content.includes('后台任务完成'))
})
```

- [ ] **Step 8: 运行测试确认通过并 Commit**

Run: `node --test src/agents/a2a.test.js src/agents/mailbox.test.js && npm test`

```bash
git add src/agents/a2a src/agents/mailbox.js src/agents/tools.js src/agents/runtime.js src/agents/runner.js src/agents/a2a.test.js src/agents/mailbox.test.js
git commit -m "feat(agents): add A2A envelopes, mailboxes, and send_message

The local transport round-trips every envelope through encode/decode even
though it never leaves the process, so shape bugs surface here rather than
when a remote transport is first plugged in.

Messages never interrupt a running tool: they land at the target's next
round boundary. Sending to a finished agent resumes it from its retained
context."
```

---

### Task 12: 多路提问路由

**Files:**
- Create: `src/agents/ask.js`
- Modify: `src/agent.js`（`ask_user` 注入条件、hook 签名、三个新公开方法）、`src/agents/runtime.js`
- Test: `src/agents/ask.test.js`
- Test: `src/agent-ask-routing.test.js`

**Interfaces:**
- Produces:
  - `class AskRegistry`，构造 `new AskRegistry({ timeoutMs = null, emit, onStateChange })`
  - `ask({ agentId, agentName, parentAgentId, nodeId, taskDescription, question }) -> Promise<string>`
  - `pending() -> Ask_Record[]`（按提问时间排序，不含函数）
  - `answer(askId, answer) -> boolean` / `cancel(askId, reason) -> boolean` / `cancelAll(reason) -> number`
  - `Agent#pendingQuestions()` / `Agent#answerQuestion(askId, answer)` / `Agent#cancelQuestion(askId, reason)`

- [ ] **Step 1: 写 ask.js 的失败测试**

```js
// src/agents/ask.test.js
import test from 'node:test'
import assert from 'node:assert'
import { AskRegistry } from './ask.js'

const who = (n) => ({
  agentId: `agt_${n}`, agentName: `explorer-${n}`, parentAgentId: 'main',
  nodeId: null, taskDescription: `task ${n}`,
})

test('提问登记归属，回答定向送回', async () => {
  const reg = new AskRegistry({})
  const p1 = reg.ask({ ...who(1), question: '用哪个数据库？' })
  const p2 = reg.ask({ ...who(2), question: '要不要加索引？' })

  const pending = reg.pending()
  assert.strictEqual(pending.length, 2)
  assert.strictEqual(pending[0].agentName, 'explorer-1')
  assert.strictEqual(pending[0].question, '用哪个数据库？')
  assert.ok(pending[0].askId)

  // 乱序回答：先答第二个
  assert.strictEqual(reg.answer(pending[1].askId, 'PostgreSQL 加索引'), true)
  assert.strictEqual(await p2, 'PostgreSQL 加索引')
  assert.strictEqual(reg.answer(pending[0].askId, '用 Postgres'), true)
  assert.strictEqual(await p1, '用 Postgres')
  assert.strictEqual(reg.pending().length, 0)
})

test('pending 快照不含函数，可安全序列化', () => {
  const reg = new AskRegistry({})
  reg.ask({ ...who(1), question: 'q' })
  const [record] = reg.pending()
  assert.doesNotThrow(() => JSON.stringify(record))
  assert.strictEqual(record.resolve, undefined)
  assert.strictEqual(record.state, 'pending')
})

test('重复回答同一 askId 是 no-op，不抛错', async () => {
  const reg = new AskRegistry({})
  const p = reg.ask({ ...who(1), question: 'q' })
  const [{ askId }] = reg.pending()
  assert.strictEqual(reg.answer(askId, 'first'), true)
  assert.strictEqual(reg.answer(askId, 'second'), false)
  assert.strictEqual(await p, 'first')
})

test('未知 askId 回答返回 false', () => {
  assert.strictEqual(new AskRegistry({}).answer('nope', 'x'), false)
})

test('cancel 让等待方拿到取消说明而不是挂死', async () => {
  const reg = new AskRegistry({})
  const p = reg.ask({ ...who(1), question: 'q' })
  const [{ askId }] = reg.pending()
  reg.cancel(askId, 'agent cancelled')
  const result = await p
  assert.match(result, /cancelled/i)
  assert.match(result, /agent cancelled/)
})

test('cancelAll 清空并返回条数', async () => {
  const reg = new AskRegistry({})
  const ps = [reg.ask({ ...who(1), question: 'a' }), reg.ask({ ...who(2), question: 'b' })]
  assert.strictEqual(reg.cancelAll('shutting down'), 2)
  for (const p of ps) assert.match(await p, /cancelled/i)
  assert.strictEqual(reg.pending().length, 0)
})

test('timeoutMs 到点后返回未回答说明', async () => {
  const reg = new AskRegistry({ timeoutMs: 30 })
  const answer = await reg.ask({ ...who(1), question: 'q' })
  assert.match(answer, /did not answer|未在/i)
  assert.strictEqual(reg.pending().length, 0)
})

test('emit 了 ask.user 与 ask.answered，且 answered 标注来源', async () => {
  const events = []
  const reg = new AskRegistry({ emit: (type, payload) => events.push({ type, payload }) })
  const p = reg.ask({ ...who(1), question: 'q' })
  const [{ askId }] = reg.pending()
  reg.answer(askId, 'a', { via: 'api' })
  await p
  assert.strictEqual(events[0].type, 'ask.user')
  assert.strictEqual(events[0].payload.agentName, 'explorer-1')
  assert.strictEqual(events[1].type, 'ask.answered')
  assert.strictEqual(events[1].payload.via, 'api')
})

test('onStateChange 在提问/回答时报告 waiting_input 切换', async () => {
  const changes = []
  const reg = new AskRegistry({ onStateChange: (agentId, waiting) => changes.push([agentId, waiting]) })
  const p = reg.ask({ ...who(1), question: 'q' })
  assert.deepStrictEqual(changes[0], ['agt_1', true])
  reg.answer(reg.pending()[0].askId, 'a')
  await p
  assert.deepStrictEqual(changes[1], ['agt_1', false])
})
```

- [ ] **Step 2: 实现 `ask.js`**

```js
/**
 * AskRegistry —— 多路提问路由。
 *
 * 多个 subagent 可能同时向用户提问。每个问题拿一个 askId 并登记提问者，用户的
 * 回答按 askId 定向送回对应的等待方 —— 主机因此可以乱序回答。
 *
 * 两条应答通道**竞速**，先到先赢，后到者 no-op：
 *   1. hooks.onAskUser(question, meta) 的返回值
 *   2. agent.answerQuestion(askId, answer)
 */

let SEQ = 0

export class AskRegistry {
  /**
   * @param {object} opts
   * @param {number|null} [opts.timeoutMs=null] null = 永不超时（与现有 onAskUser 行为一致）
   * @param {(type: string, payload: object) => void} [opts.emit]
   * @param {(agentId: string, waiting: boolean) => void} [opts.onStateChange]
   */
  constructor({ timeoutMs = null, emit = () => {}, onStateChange = () => {} } = {}) {
    this.timeoutMs = timeoutMs
    this.emit = emit
    this.onStateChange = onStateChange
    /** @type {Map<string, object>} askId → 内部记录（含 settle 函数） */
    this._pending = new Map()
  }

  ask({ agentId, agentName, parentAgentId = 'main', nodeId = null, taskDescription = '', question }) {
    SEQ = (SEQ + 1) >>> 0
    const askId = `ask_${SEQ.toString(16).padStart(6, '0')}`
    const askedAt = Date.now()

    return new Promise((resolve) => {
      let settled = false
      let timer = null
      const settle = (value) => {
        if (settled) return false
        settled = true
        if (timer) clearTimeout(timer)
        this._pending.delete(askId)
        this.onStateChange(agentId, false)
        resolve(value)
        return true
      }

      this._pending.set(askId, {
        askId, agentId, agentName, parentAgentId, nodeId, taskDescription,
        question, askedAt, state: 'pending', settle,
      })
      this.onStateChange(agentId, true)
      this.emit('ask.user', { askId, agentId, agentName, parentAgentId, nodeId, taskDescription, question })

      if (this.timeoutMs != null) {
        timer = setTimeout(() => {
          if (settle(`The user did not answer within ${this.timeoutMs}ms（用户未在 ${this.timeoutMs}ms 内回答）. `
            + 'Decide for yourself: proceed with a clearly-stated assumption, or stop and report that you are blocked.')) {
            this.emit('ask.cancelled', { askId, agentId, reason: 'timeout' })
          }
        }, this.timeoutMs)
        // 不阻止进程退出
        timer.unref?.()
      }
    })
  }

  /** @returns {object[]} 按提问时间排序的纯数据快照 */
  pending() {
    return [...this._pending.values()]
      .sort((a, b) => a.askedAt - b.askedAt)
      .map(({ settle, ...rest }) => ({ ...rest }))
  }

  answer(askId, answer, { via = 'api' } = {}) {
    const record = this._pending.get(askId)
    if (!record) return false
    const ok = record.settle(String(answer))
    if (ok) {
      this.emit('ask.answered', { askId, agentId: record.agentId, agentName: record.agentName, via })
    }
    return ok
  }

  cancel(askId, reason = 'cancelled') {
    const record = this._pending.get(askId)
    if (!record) return false
    const ok = record.settle(`Question cancelled: ${reason}`)
    if (ok) this.emit('ask.cancelled', { askId, agentId: record.agentId, reason })
    return ok
  }

  cancelAll(reason = 'cancelled') {
    let count = 0
    for (const askId of [...this._pending.keys()]) {
      if (this.cancel(askId, reason)) count += 1
    }
    return count
  }
}
```

- [ ] **Step 3: 写 `Agent` 侧的失败测试**

```js
// src/agent-ask-routing.test.js
import test from 'node:test'
import assert from 'node:assert'
import { Agent } from './agent.js'

const baseOpts = { provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o' }
const askTool = (agent) => agent.getTools().find(t => t.name === 'ask_user')

test('配置 subagents 后即使没有 onAskUser 也注入 ask_user', () => {
  assert.ok(askTool(new Agent({ ...baseOpts, subagents: {} })))
  assert.strictEqual(askTool(new Agent({ ...baseOpts })), undefined)
})

test('旧的单参数 onAskUser 继续工作', async () => {
  const agent = new Agent({ ...baseOpts, hooks: { onAskUser: async (q) => `answered: ${q}` } })
  assert.strictEqual(await askTool(agent).execute({ question: 'ping' }), 'answered: ping')
})

test('hook 收到第二个参数 meta，带 askId 与归属', async () => {
  let meta = null
  const agent = new Agent({
    ...baseOpts, subagents: {},
    hooks: { onAskUser: async (_q, m) => { meta = m; return 'ok' } },
  })
  await askTool(agent).execute({ question: 'q' }, { agentId: 'main', agentName: 'main' })
  assert.ok(meta.askId)
  assert.strictEqual(meta.agentId, 'main')
  assert.strictEqual(meta.parentAgentId, 'main')
})

test('answerQuestion 定向应答，pendingQuestions 可列', async () => {
  const agent = new Agent({ ...baseOpts, subagents: {} })
  const pendingPromise = askTool(agent).execute({ question: '选 A 还是 B？' }, { agentId: 'main', agentName: 'main' })
  await new Promise(resolve => setImmediate(resolve))

  const questions = agent.pendingQuestions()
  assert.strictEqual(questions.length, 1)
  assert.strictEqual(questions[0].question, '选 A 还是 B？')
  assert.strictEqual(agent.answerQuestion(questions[0].askId, '选 A'), true)
  assert.strictEqual(await pendingPromise, '选 A')
  assert.strictEqual(agent.pendingQuestions().length, 0)
})

test('hook 与 answerQuestion 竞速，先到先赢', async () => {
  let release
  const agent = new Agent({
    ...baseOpts, subagents: {},
    hooks: { onAskUser: () => new Promise(resolve => { release = resolve }) },
  })
  const p = askTool(agent).execute({ question: 'q' }, { agentId: 'main', agentName: 'main' })
  await new Promise(resolve => setImmediate(resolve))
  const [{ askId }] = agent.pendingQuestions()
  agent.answerQuestion(askId, 'from api')
  release('from hook')
  assert.strictEqual(await p, 'from api')
})

test('closeSubagents 拒掉全部待答提问，不留悬挂 Promise', async () => {
  const agent = new Agent({ ...baseOpts, subagents: {} })
  const p = askTool(agent).execute({ question: 'q' }, { agentId: 'main', agentName: 'main' })
  await new Promise(resolve => setImmediate(resolve))
  await agent.closeSubagents()
  assert.match(await p, /cancelled/i)
})
```

- [ ] **Step 4: 改 `src/agent.js` 与 `runtime.js`**

`runtime.js`：创建 `const ask = new AskRegistry({ timeoutMs: askOpts.timeoutMs ?? null, emit, onStateChange })`，`onStateChange` 把对应 handle 在 `running` / `waiting_input` 之间迁移；传给 `SubagentRunner`；在 runtime 上暴露 `ask`；`close()` 里调 `ask.cancelAll('runtime closed')`。

`agent.js`：

- `ask_user` 注入条件改为 `if (this.hooks.onAskUser || opts.subagents)`。
- 原来那行 `const onAskUser = this.hooks.onAskUser`（在旧的 `if` 内部，此时可能不存在）改为 `const onAskUser = this.hooks.onAskUser ?? null`，并在 `execute` 里对 `onAskUser == null && registry == null` 的情况返回说明字符串（理论上不可达，但别留一个能抛 `TypeError` 的洞）。
- `execute` 改为：

```js
          execute: async (params, ctx = {}) => {
            const question = params.question
            const registry = this.subagents?.ask ?? null
            if (!registry) {
              if (!onAskUser) return 'Error: no user-interaction channel is configured.'
              return await onAskUser(question)
            }

            const promise = registry.ask({
              agentId: ctx.agentId ?? 'main',
              agentName: ctx.agentName ?? 'main',
              parentAgentId: ctx.parentAgentId ?? 'main',
              nodeId: ctx.nodeId ?? null,
              taskDescription: ctx.taskDescription ?? '',
              question,
            })
            // hook 与 answerQuestion 竞速：谁先到算谁的，后到者 no-op。
            const record = registry.pending().find(r => r.question === question && r.agentId === (ctx.agentId ?? 'main'))
            if (this.hooks.onAskUser && record) {
              Promise.resolve(this.hooks.onAskUser(question, {
                askId: record.askId, agentId: record.agentId, agentName: record.agentName,
                parentAgentId: record.parentAgentId, nodeId: record.nodeId,
                taskDescription: record.taskDescription,
              })).then(
                (answer) => { if (answer != null) registry.answer(record.askId, answer, { via: 'hook' }) },
                (err) => registry.cancel(record.askId, `hook failed: ${err?.message ?? err}`),
              )
            }
            return promise
          },
```

- 三个新方法：

```js
  /** 当前全部待答提问（纯数据，可直接给 UI）。 */
  pendingQuestions() {
    return this.subagents?.ask?.pending() ?? []
  }

  /** 定向应答一个提问。返回 false 表示该 askId 不存在或已被应答。 */
  answerQuestion(askId, answer) {
    return this.subagents?.ask?.answer(askId, answer, { via: 'api' }) ?? false
  }

  /** 取消一个提问，等待方会拿到取消说明而不是挂死。 */
  cancelQuestion(askId, reason = 'cancelled by host') {
    return this.subagents?.ask?.cancel(askId, reason) ?? false
  }
```

- [ ] **Step 5: 运行测试确认通过并 Commit**

Run: `node --test src/agents/ask.test.js src/agent-ask-routing.test.js && npm test`

```bash
git add src/agents/ask.js src/agents/ask.test.js src/agents/runtime.js src/agent.js src/agent-ask-routing.test.js
git commit -m "feat(agents): route questions from concurrent agents back to their asker

Every question gets an askId and records who asked, so a host can answer
out of order. Two answer channels race — the onAskUser hook's return value
and answerQuestion(askId) — first one wins, the loser is a no-op.

The single-argument onAskUser signature keeps working; the metadata
arrives as a second argument that old hooks ignore."
```

**Phase 2 完成** —— agent 之间可互发消息、执行中可收消息、多路提问定向应答。

---

## Phase 3 — DAG 编排

### Task 13: AgentGraph — 声明、环检测、惰性就绪

**Files:**
- Create: `src/agents/graph.js`
- Test: `src/agents/graph.test.js`
- Test: `src/agents/graph.property.test.js`

**Interfaces:**
- Consumes: `AgentGraphError`
- Produces:
  - `class AgentGraph`，构造 `new AgentGraph({ onReadyNode, onAutoStart, emit })`
  - `declare(nodes, { maxConcurrent }) -> { accepted: string[] }`（环 / 未知依赖 / `auto` 缺 prompt → 抛 `AgentGraphError`，**整批拒绝**）
  - `tick() -> void` —— 依赖满足的 `blocked` 节点转 `ready`，随后按 `onReady` 分流
  - `onAgentSettled({ nodeId, state }) -> void`
  - `start(nodeId, patch) -> { ok, node?, reason? }`
  - `cancel(nodeId, reason) -> { ok, reason? }`
  - `hasPending() -> boolean` / `get(nodeId)` / `statusTable() -> string`
  - `detectCycle(nodes, existing) -> string[] | null` —— Kahn，返回环路径

- [ ] **Step 1: 写失败测试**

```js
// src/agents/graph.test.js
import test from 'node:test'
import assert from 'node:assert'
import { AgentGraph, detectCycle } from './graph.js'
import { AgentGraphError } from './errors.js'

function makeGraph() {
  const ready = []
  const auto = []
  const graph = new AgentGraph({
    onReadyNode: (node, upstream) => ready.push({ nodeId: node.nodeId, upstream }),
    onAutoStart: (node) => auto.push(node.nodeId),
  })
  return { graph, ready, auto }
}

const n = (nodeId, dependsOn = [], extra = {}) =>
  ({ node_id: nodeId, depends_on: dependsOn, description: `task ${nodeId}`, ...extra })

test('声明后无依赖的节点立即 ready，有依赖的保持 blocked', () => {
  const { graph, ready } = makeGraph()
  graph.declare([n('n1'), n('n2', ['n1'])])
  assert.strictEqual(graph.get('n1').state, 'awaiting_confirm')
  assert.strictEqual(graph.get('n2').state, 'blocked')
  assert.deepStrictEqual(ready.map(r => r.nodeId), ['n1'])
})

test('on_ready:auto 且有 prompt 的节点走自动启动', () => {
  const { graph, auto, ready } = makeGraph()
  graph.declare([n('n1', [], { on_ready: 'auto', prompt: '干活' })])
  assert.deepStrictEqual(auto, ['n1'])
  assert.strictEqual(ready.length, 0)
})

test('on_ready:auto 缺 prompt → 整批拒绝', () => {
  const { graph } = makeGraph()
  assert.throws(() => graph.declare([n('n1', [], { on_ready: 'auto' })]),
    (err) => err instanceof AgentGraphError && /prompt/.test(err.message))
  assert.strictEqual(graph.get('n1'), null, '拒绝必须是整批的，不能留下半个图')
})

test('环被检出且整批拒绝，错误里带环路径', () => {
  const { graph } = makeGraph()
  assert.throws(() => graph.declare([n('a', ['c']), n('b', ['a']), n('c', ['b'])]),
    (err) => err instanceof AgentGraphError && Array.isArray(err.cycle) && err.cycle.length >= 3)
  assert.strictEqual(graph.get('a'), null)
})

test('自环也被检出', () => {
  const { graph } = makeGraph()
  assert.throws(() => graph.declare([n('a', ['a'])]), AgentGraphError)
})

test('依赖未知节点 → 拒绝', () => {
  const { graph } = makeGraph()
  assert.throws(() => graph.declare([n('n1', ['ghost'])]),
    (err) => err instanceof AgentGraphError && /ghost/.test(err.message))
})

test('重复 node_id → 拒绝', () => {
  const { graph } = makeGraph()
  graph.declare([n('n1')])
  assert.throws(() => graph.declare([n('n1')]), AgentGraphError)
})

test('多批声明：新节点可依赖旧节点', () => {
  const { graph, ready } = makeGraph()
  graph.declare([n('n1')])
  graph.declare([n('n2', ['n1'])])
  assert.strictEqual(graph.get('n2').state, 'blocked')
  graph.start('n1', { prompt: 'p' })
  graph.onAgentSettled({ nodeId: 'n1', state: 'succeeded' })
  assert.strictEqual(graph.get('n2').state, 'awaiting_confirm')
  assert.deepStrictEqual(ready.map(r => r.nodeId), ['n1', 'n2'])
})

test('就绪回调带上上游结果，供主 agent 重定契约', () => {
  const { graph, ready } = makeGraph()
  graph.declare([n('n1'), n('n2', ['n1'])])
  graph.start('n1', { prompt: 'p' })
  graph.onAgentSettled({ nodeId: 'n1', state: 'succeeded', agentId: 'agt_1', result: '上游报告' })
  const n2Ready = ready.find(r => r.nodeId === 'n2')
  assert.strictEqual(n2Ready.upstream.length, 1)
  assert.strictEqual(n2Ready.upstream[0].nodeId, 'n1')
  assert.strictEqual(n2Ready.upstream[0].result, '上游报告')
})

test('惰性：blocked / awaiting_confirm 的节点没有 agentId', () => {
  const { graph } = makeGraph()
  graph.declare([n('n1'), n('n2', ['n1'])])
  assert.strictEqual(graph.get('n1').agentId, null)
  assert.strictEqual(graph.get('n2').agentId, null)
})

test('start 只在 ready / awaiting_confirm 状态可用', () => {
  const { graph } = makeGraph()
  graph.declare([n('n1'), n('n2', ['n1'])])
  assert.strictEqual(graph.start('n1', { prompt: 'p' }).ok, true)
  assert.strictEqual(graph.start('n1', { prompt: 'p' }).ok, false, '已启动的不能再启动')
  const blocked = graph.start('n2', { prompt: 'p' })
  assert.strictEqual(blocked.ok, false)
  assert.match(blocked.reason, /blocked/)
})

test('start 时的 patch 覆盖声明期的类型与模型', () => {
  const { graph } = makeGraph()
  graph.declare([n('n1', [], { subagent_type: 'general-purpose', model: 'main' })])
  const started = graph.start('n1', { prompt: '最终契约', subagent_type: 'explorer', model: 'fast' })
  assert.strictEqual(started.node.prompt, '最终契约')
  assert.strictEqual(started.node.subagentType, 'explorer')
  assert.strictEqual(started.node.model, 'fast')
})

test('上游失败：默认 block，下游停在 blocked 并标注原因', () => {
  const { graph, ready } = makeGraph()
  graph.declare([n('n1'), n('n2', ['n1'])])
  graph.start('n1', { prompt: 'p' })
  graph.onAgentSettled({ nodeId: 'n1', state: 'failed' })
  assert.strictEqual(graph.get('n2').state, 'blocked')
  assert.strictEqual(graph.get('n2').blockedReason, 'upstream_failed')
  assert.ok(!ready.some(r => r.nodeId === 'n2'), '上游失败不应触发就绪回调')
})

test('上游失败 + on_upstream_failure:skip → 下游 skipped 并继续传播', () => {
  const { graph } = makeGraph()
  graph.declare([n('n1'), n('n2', ['n1'], { on_upstream_failure: 'skip' }), n('n3', ['n2'], { on_upstream_failure: 'skip' })])
  graph.start('n1', { prompt: 'p' })
  graph.onAgentSettled({ nodeId: 'n1', state: 'failed' })
  assert.strictEqual(graph.get('n2').state, 'skipped')
  assert.strictEqual(graph.get('n3').state, 'skipped')
})

test('cancel 未启动的节点', () => {
  const { graph } = makeGraph()
  graph.declare([n('n1')])
  assert.strictEqual(graph.cancel('n1', '不需要了').ok, true)
  assert.strictEqual(graph.get('n1').state, 'cancelled')
  assert.strictEqual(graph.cancel('nope').ok, false)
})

test('hasPending 反映是否还有活', () => {
  const { graph } = makeGraph()
  assert.strictEqual(graph.hasPending(), false)
  graph.declare([n('n1')])
  assert.strictEqual(graph.hasPending(), true)
  graph.start('n1', { prompt: 'p' })
  graph.onAgentSettled({ nodeId: 'n1', state: 'succeeded' })
  assert.strictEqual(graph.hasPending(), false)
})

test('statusTable 可读且含全部节点', () => {
  const { graph } = makeGraph()
  graph.declare([n('n1'), n('n2', ['n1'])])
  const table = graph.statusTable()
  assert.ok(table.includes('n1'))
  assert.ok(table.includes('n2'))
  assert.ok(table.includes('blocked'))
})

test('detectCycle 直接可用', () => {
  assert.strictEqual(detectCycle([{ nodeId: 'a', dependsOn: [] }], new Map()), null)
  const cycle = detectCycle(
    [{ nodeId: 'a', dependsOn: ['b'] }, { nodeId: 'b', dependsOn: ['a'] }], new Map())
  assert.ok(Array.isArray(cycle) && cycle.length >= 2)
})
```

- [ ] **Step 2: 写性质测试**

```js
// src/agents/graph.property.test.js
import test from 'node:test'
import assert from 'node:assert'
import fc from 'fast-check'
import { AgentGraph } from './graph.js'
import { AgentGraphError } from './errors.js'

/** 生成一个必然无环的 DAG：节点 i 只能依赖 j < i。 */
const dagArb = fc.integer({ min: 1, max: 12 }).chain((size) =>
  fc.tuple(...Array.from({ length: size }, (_, i) =>
    fc.subarray(Array.from({ length: i }, (_, j) => `n${j}`)),
  )).map((depsPerNode) =>
    depsPerNode.map((deps, i) => ({
      node_id: `n${i}`, depends_on: deps, description: `t${i}`,
      on_ready: 'auto', prompt: `p${i}`,
    }))))

test('性质：无环图的启动顺序恒满足拓扑序', () => {
  fc.assert(fc.property(dagArb, (nodes) => {
    const started = []
    const graph = new AgentGraph({
      onReadyNode: () => {},
      onAutoStart: (node) => {
        started.push(node.nodeId)
        graph.onAgentSettled({ nodeId: node.nodeId, state: 'succeeded' })
      },
    })
    graph.declare(nodes)
    const position = new Map(started.map((id, i) => [id, i]))
    for (const node of nodes) {
      for (const dep of node.depends_on) {
        assert.ok(position.get(dep) < position.get(node.node_id),
          `${dep} 必须先于 ${node.node_id} 启动`)
      }
    }
  }), { numRuns: 200 })
})

test('性质：无环图最终全部到达终态', () => {
  fc.assert(fc.property(dagArb, (nodes) => {
    const graph = new AgentGraph({
      onReadyNode: () => {},
      onAutoStart: (node) => graph.onAgentSettled({ nodeId: node.nodeId, state: 'succeeded' }),
    })
    graph.declare(nodes)
    assert.strictEqual(graph.hasPending(), false)
    for (const node of nodes) assert.strictEqual(graph.get(node.node_id).state, 'succeeded')
  }), { numRuns: 200 })
})

test('性质：任何含环的声明都被拒绝，且不留下部分状态', () => {
  const cyclicArb = fc.integer({ min: 2, max: 8 }).map((size) => {
    const nodes = Array.from({ length: size }, (_, i) => ({
      node_id: `n${i}`,
      depends_on: [`n${(i + 1) % size}`],   // 首尾相接 = 必然成环
      description: `t${i}`, on_ready: 'auto', prompt: `p${i}`,
    }))
    return nodes
  })
  fc.assert(fc.property(cyclicArb, (nodes) => {
    const graph = new AgentGraph({ onReadyNode: () => {}, onAutoStart: () => {} })
    assert.throws(() => graph.declare(nodes), AgentGraphError)
    for (const node of nodes) assert.strictEqual(graph.get(node.node_id), null)
  }), { numRuns: 100 })
})
```

- [ ] **Step 3: 运行两个测试确认失败**

Run: `node --test src/agents/graph.test.js src/agents/graph.property.test.js`
Expected: FAIL —— `Cannot find module './graph.js'`

- [ ] **Step 4: 实现 `graph.js`**

```js
/**
 * AgentGraph —— 依赖图的声明与惰性调度。
 *
 * 关键语义（§7）：**声明 ≠ 创建**。blocked / ready / awaiting_confirm 的节点
 * 不占任何运行时资源，只有进入 queued 才真正构造 subagent。默认路径下，节点
 * 就绪时先把上游产物交回主 agent，由主 agent 重写 Task Contract 后再启动 ——
 * 因为前序结果会改变后续决策。
 */
import { AgentGraphError } from './errors.js'

/** Kahn 拓扑排序。返回 null（无环）或一条环路径。 */
export function detectCycle(incoming, existing) {
  /** @type {Map<string, string[]>} nodeId → 依赖 */
  const deps = new Map()
  for (const [nodeId, node] of existing) deps.set(nodeId, node.dependsOn)
  for (const node of incoming) deps.set(node.nodeId, node.dependsOn)

  const indegree = new Map()
  const dependents = new Map()
  for (const [nodeId, nodeDeps] of deps) {
    indegree.set(nodeId, (indegree.get(nodeId) ?? 0) + nodeDeps.length)
    for (const dep of nodeDeps) {
      const list = dependents.get(dep) ?? []
      list.push(nodeId)
      dependents.set(dep, list)
      if (!indegree.has(dep)) indegree.set(dep, 0)
    }
  }

  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id)
  let visited = 0
  while (queue.length > 0) {
    const nodeId = queue.shift()
    visited += 1
    for (const dependent of dependents.get(nodeId) ?? []) {
      const next = indegree.get(dependent) - 1
      indegree.set(dependent, next)
      if (next === 0) queue.push(dependent)
    }
  }
  if (visited === indegree.size) return null

  // 有环：从任一残留节点顺着依赖走回自己，得到一条可读的环路径。
  const remaining = [...indegree.entries()].filter(([, d]) => d > 0).map(([id]) => id)
  const seen = []
  let cursor = remaining[0]
  while (cursor != null && !seen.includes(cursor)) {
    seen.push(cursor)
    cursor = (deps.get(cursor) ?? []).find(d => remaining.includes(d))
  }
  return cursor == null ? seen : [...seen.slice(seen.indexOf(cursor)), cursor]
}

export class AgentGraph {
  /**
   * @param {object} opts
   * @param {(node: object, upstream: object[]) => void} opts.onReadyNode
   *        节点就绪且需要主 agent 确认契约时调用
   * @param {(node: object) => void} opts.onAutoStart on_ready:'auto' 的节点就绪时调用
   * @param {(type: string, payload: object) => void} [opts.emit]
   */
  constructor({ onReadyNode = () => {}, onAutoStart = () => {}, emit = () => {} } = {}) {
    this.onReadyNode = onReadyNode
    this.onAutoStart = onAutoStart
    this.emit = emit
    /** @type {Map<string, object>} */
    this.nodes = new Map()
    this.maxConcurrent = null
  }

  get(nodeId) {
    return this.nodes.get(nodeId) ?? null
  }

  /**
   * 声明一批节点。任何校验失败都**整批拒绝**，不留半个图。
   * @returns {{ accepted: string[] }}
   */
  declare(rawNodes, { maxConcurrent } = {}) {
    if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
      throw new AgentGraphError('agent_graph: nodes must be a non-empty array')
    }
    const staged = []
    const stagedIds = new Set()

    for (const raw of rawNodes) {
      const nodeId = raw?.node_id
      if (typeof nodeId !== 'string' || nodeId.length === 0) {
        throw new AgentGraphError('agent_graph: every node needs a non-empty node_id')
      }
      if (this.nodes.has(nodeId) || stagedIds.has(nodeId)) {
        throw new AgentGraphError(`agent_graph: duplicate node_id "${nodeId}"`, { nodeId })
      }
      if (typeof raw.description !== 'string' || raw.description.length === 0) {
        throw new AgentGraphError(`agent_graph: node "${nodeId}" needs a description`, { nodeId })
      }
      const onReady = raw.on_ready === 'auto' ? 'auto' : 'confirm'
      if (onReady === 'auto' && (typeof raw.prompt !== 'string' || raw.prompt.length === 0)) {
        throw new AgentGraphError(
          `agent_graph: node "${nodeId}" uses on_ready "auto" and therefore needs a prompt`, { nodeId })
      }
      staged.push({
        nodeId,
        dependsOn: Array.isArray(raw.depends_on) ? [...raw.depends_on] : [],
        description: raw.description,
        prompt: raw.prompt ?? null,
        subagentType: raw.subagent_type ?? null,
        model: raw.model ?? null,
        onReady,
        onUpstreamFailure: raw.on_upstream_failure === 'skip' ? 'skip' : 'block',
        state: 'blocked',
        blockedReason: null,
        agentId: null,
        result: null,
        declaredAt: Date.now(),
      })
      stagedIds.add(nodeId)
    }

    for (const node of staged) {
      for (const dep of node.dependsOn) {
        if (!this.nodes.has(dep) && !stagedIds.has(dep)) {
          throw new AgentGraphError(
            `agent_graph: node "${node.nodeId}" depends on unknown node "${dep}"`, { nodeId: node.nodeId })
        }
      }
    }

    const cycle = detectCycle(staged, this.nodes)
    if (cycle) {
      throw new AgentGraphError(
        `agent_graph: dependency cycle detected: ${cycle.join(' -> ')}`, { cycle })
    }

    for (const node of staged) this.nodes.set(node.nodeId, node)
    if (maxConcurrent != null) this.maxConcurrent = maxConcurrent
    this.tick()
    return { accepted: staged.map(n => n.nodeId) }
  }

  /** 把依赖满足的 blocked 节点推进到 ready，然后按 onReady 分流。 */
  tick() {
    for (const node of this.nodes.values()) {
      if (node.state !== 'blocked') continue

      const upstream = node.dependsOn.map(id => this.nodes.get(id))
      if (upstream.some(u => u.state === 'failed' || u.state === 'cancelled')) {
        if (node.onUpstreamFailure === 'skip') {
          node.state = 'skipped'
          this.emit('graph.node.blocked', { nodeId: node.nodeId, reason: 'upstream_failed_skipped' })
          this.tick()   // 继续向下传播
          return
        }
        node.blockedReason = 'upstream_failed'
        this.emit('graph.node.blocked', { nodeId: node.nodeId, reason: 'upstream_failed' })
        continue
      }
      if (!upstream.every(u => u.state === 'succeeded')) continue

      if (node.onReady === 'auto') {
        node.state = 'queued'
        this.onAutoStart(node)
      } else {
        node.state = 'awaiting_confirm'
        this.emit('graph.node.ready', {
          nodeId: node.nodeId,
          upstream: upstream.map(u => ({ nodeId: u.nodeId, agentId: u.agentId, state: u.state })),
        })
        this.onReadyNode(node, upstream.map(u => ({
          nodeId: u.nodeId, agentId: u.agentId, state: u.state, result: u.result,
        })))
      }
    }
  }

  /** 主 agent 确认（可改写）契约并启动一个就绪节点。 */
  start(nodeId, patch = {}) {
    const node = this.nodes.get(nodeId)
    if (!node) return { ok: false, reason: `node "${nodeId}" not found` }
    if (node.state === 'blocked') {
      return { ok: false, reason: `node "${nodeId}" is blocked (${node.blockedReason ?? 'waiting on upstream'})` }
    }
    if (node.state !== 'ready' && node.state !== 'awaiting_confirm') {
      return { ok: false, reason: `node "${nodeId}" is ${node.state}; only ready nodes can be started` }
    }
    if (patch.prompt) node.prompt = patch.prompt
    if (patch.subagent_type) node.subagentType = patch.subagent_type
    if (patch.model) node.model = patch.model
    if (!node.prompt) return { ok: false, reason: `node "${nodeId}" has no prompt; supply one when starting it` }
    node.state = 'queued'
    return { ok: true, node }
  }

  /** subagent 终态回调：登记结果并推进下游。 */
  onAgentSettled({ nodeId, state, agentId = null, result = null }) {
    const node = this.nodes.get(nodeId)
    if (!node) return
    node.state = state
    node.agentId = agentId ?? node.agentId
    node.result = result
    this.tick()
  }

  cancel(nodeId, reason = 'cancelled') {
    const node = this.nodes.get(nodeId)
    if (!node) return { ok: false, reason: `node "${nodeId}" not found` }
    if (['succeeded', 'failed', 'cancelled', 'skipped'].includes(node.state)) {
      return { ok: false, reason: `node "${nodeId}" is already ${node.state}` }
    }
    node.state = 'cancelled'
    node.blockedReason = reason
    this.tick()
    return { ok: true }
  }

  hasPending() {
    for (const node of this.nodes.values()) {
      if (['blocked', 'ready', 'awaiting_confirm', 'queued', 'running'].includes(node.state)) return true
    }
    return false
  }

  statusTable() {
    if (this.nodes.size === 0) return 'no graph declared'
    return [...this.nodes.values()].map((node) => {
      const deps = node.dependsOn.length > 0 ? ` deps=[${node.dependsOn.join(',')}]` : ''
      const why = node.blockedReason ? ` (${node.blockedReason})` : ''
      return `${node.nodeId} [${node.state}]${why}${deps} — ${node.description}`
    }).join('\n')
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test src/agents/graph.test.js src/agents/graph.property.test.js`
Expected: PASS（18 + 3）

- [ ] **Step 6: 跑全量测试并 Commit**

```bash
npm test
git add src/agents/graph.js src/agents/graph.test.js src/agents/graph.property.test.js
git commit -m "feat(agents): add lazy DAG scheduling with a ready-confirm gate

Declaring a node does not create an agent. A ready node hands its upstream
results back to the parent, which rewrites the task contract before the
subagent is spawned — earlier results routinely change later decisions.

Cycles and unknown dependencies reject the whole batch, so a rejected
declaration never leaves half a graph behind."
```

---

### Task 14: 图工具接入 runtime

**Files:**
- Modify: `src/agents/runtime.js`、`src/agents/tools.js`
- Test: `src/agents/graph-tools.test.js`

**Interfaces:**
- Produces：`SUBAGENT_TOOL_NAMES` 补上 `'agent_graph'` / `'graph_start'`；`runtime.graph`；`agent_status` 的 `include_graph` 参数

- [ ] **Step 1: 写失败测试**

```js
// src/agents/graph-tools.test.js
import test from 'node:test'
import assert from 'node:assert'
import { RuntimeHistory } from '../runtime-history.js'
import { createSubagentRuntime } from './runtime.js'
import { resetAgentTypes } from './types.js'

test.beforeEach(() => resetAgentTypes())

function makeRuntime(replies = {}) {
  const injected = []
  const parent = {
    _providerName: 'openai', model: 'm', apiKey: 'k', url: 'u',
    simpleModel: 'm', simpleApiKey: 'k', simpleUrl: 'u',
    tools: [], hooks: {}, knowledgeBase: null, tokenBudget: null, validateStreamCompletion: true,
    memory: { runtimeHistory: new RuntimeHistory(), add() {} },
    emit() {}, enqueueMessage(msg) { injected.push(msg) },
  }
  let seq = 0
  const rt = createSubagentRuntime({
    parent,
    createAgent: () => {
      const id = ++seq
      return {
        lastStopReason: null, on() { return this }, off() { return this },
        getLastRunMetrics: () => ({ totalRounds: 1, totalLlmCalls: 1, totalToolCalls: 0, usage: {}, wallClockMs: 1 }),
        async chat() { return replies[id] ?? `报告 ${id}` },
      }
    },
  })
  return { rt, injected, tool: (name) => rt.tools.find(t => t.name === name) }
}

test('agent_graph 声明后不创建任何 agent', async () => {
  const { rt, tool } = makeRuntime()
  const out = await tool('agent_graph').execute({
    nodes: [
      { node_id: 'n1', description: 'explore' },
      { node_id: 'n2', depends_on: ['n1'], description: 'write' },
    ],
  })
  assert.ok(out.includes('n1'))
  assert.ok(out.includes('n2'))
  assert.strictEqual(rt.registry.list({ includeFinished: true }).length, 0,
    '声明阶段不该创建任何 agent 实例')
})

test('无依赖节点就绪后通知主 agent 而不是直接启动', async () => {
  const { tool, injected, rt } = makeRuntime()
  await tool('agent_graph').execute({ nodes: [{ node_id: 'n1', description: 'explore' }] })
  assert.strictEqual(rt.graph.get('n1').state, 'awaiting_confirm')
  assert.ok(injected.some(m => m.content.includes('n1') && m.content.includes('graph-node-ready')))
})

test('graph_start 用最终契约启动就绪节点', async () => {
  const { tool, rt } = makeRuntime({ 1: '探索结论' })
  await tool('agent_graph').execute({ nodes: [{ node_id: 'n1', description: 'explore' }] })
  const out = await tool('graph_start').execute({ node_id: 'n1', prompt: '最终确定的任务描述', run_in_background: false })
  assert.ok(out.includes('探索结论'))
  assert.strictEqual(rt.graph.get('n1').state, 'succeeded')
})

test('上游完成后下游转 awaiting_confirm，通知里带上游结果', async () => {
  const { tool, injected } = makeRuntime({ 1: '上游产出：3 个接口' })
  await tool('agent_graph').execute({
    nodes: [
      { node_id: 'n1', description: 'explore' },
      { node_id: 'n2', depends_on: ['n1'], description: 'write' },
    ],
  })
  await tool('graph_start').execute({ node_id: 'n1', prompt: 'p', run_in_background: false })
  const readyNote = injected.find(m => m.content.includes('n2'))
  assert.ok(readyNote, '下游就绪必须通知主 agent')
  assert.ok(readyNote.content.includes('上游产出：3 个接口'))
})

test('on_ready:auto 的节点上游一好就自己跑', async () => {
  const { tool, rt } = makeRuntime()
  await tool('agent_graph').execute({
    nodes: [
      { node_id: 'n1', description: 'explore' },
      { node_id: 'n2', depends_on: ['n1'], description: 'write', on_ready: 'auto', prompt: '自动执行' },
    ],
  })
  await tool('graph_start').execute({ node_id: 'n1', prompt: 'p', run_in_background: false })
  await rt.drain()
  assert.strictEqual(rt.graph.get('n2').state, 'succeeded')
})

test('环被拒绝且工具软失败（不抛）', async () => {
  const { tool } = makeRuntime()
  const out = await tool('agent_graph').execute({
    nodes: [
      { node_id: 'a', depends_on: ['b'], description: 'x' },
      { node_id: 'b', depends_on: ['a'], description: 'y' },
    ],
  })
  assert.ok(/cycle/i.test(out))
  assert.ok(out.includes('->'))
})

test('graph_start 打未就绪节点时软失败', async () => {
  const { tool } = makeRuntime()
  await tool('agent_graph').execute({
    nodes: [{ node_id: 'n1', description: 'x' }, { node_id: 'n2', depends_on: ['n1'], description: 'y' }],
  })
  const out = await tool('graph_start').execute({ node_id: 'n2', prompt: 'p' })
  assert.ok(/blocked/i.test(out))
})

test('agent_status include_graph 输出节点表', async () => {
  const { tool } = makeRuntime()
  await tool('agent_graph').execute({ nodes: [{ node_id: 'n1', description: 'explore' }] })
  const out = await tool('agent_status').execute({ include_graph: true })
  assert.ok(out.includes('n1'))
  assert.ok(out.includes('awaiting_confirm'))
})

test('上游失败时下游停在 blocked 并在状态里说明', async () => {
  const { tool, rt } = makeRuntime()
  rt.registry.maxConcurrent = 4
  await tool('agent_graph').execute({
    nodes: [{ node_id: 'n1', description: 'x' }, { node_id: 'n2', depends_on: ['n1'], description: 'y' }],
  })
  rt.graph.start('n1', { prompt: 'p' })
  rt.graph.onAgentSettled({ nodeId: 'n1', state: 'failed' })
  const out = await tool('agent_status').execute({ include_graph: true })
  assert.ok(out.includes('upstream_failed'))
})
```

- [ ] **Step 2: 实现 —— `runtime.js` 里建图并接回调**

```js
  const graph = new AgentGraph({
    emit,
    onReadyNode: (node, upstream) => {
      const lines = upstream.map(u => `- ${u.nodeId} (${u.state}): ${firstLine(u.result)}`)
      parent.enqueueMessage({
        role: 'user',
        content: `<graph-node-ready node="${node.nodeId}">\n`
          + `节点 "${node.nodeId}"（${node.description}）的上游已全部完成：\n${lines.join('\n')}\n\n`
          + '现在决定它到底该做什么：用 graph_start 给出最终的 prompt 契约来启动它，'
          + '或用 agent_cancel 放弃它。\n</graph-node-ready>',
      })
    },
    onAutoStart: (node) => { void runtime._startNode(node, { background: true }) },
  })
```

runtime 上加：

```js
    graph,

    /** 真正把一个 queued 节点变成 subagent。图调度的唯一创建入口。 */
    async _startNode(node, { background = true, signal } = {}) {
      const upstream = node.dependsOn
        .map(id => graph.get(id))
        .filter(Boolean)
        .flatMap(u => artifacts.list({ agentId: u.agentId }).map(r => ({
          key: r.key, agentName: r.agentName, summary: r.summary, sha: r.sha,
        })))

      const settle = (result, state) => {
        graph.onAgentSettled({ nodeId: node.nodeId, state, agentId: node.agentId, result })
      }

      const spawned = runtime.spawn({
        description: node.description,
        prompt: node.prompt,
        subagentType: node.subagentType ?? undefined,
        model: node.model ?? undefined,
        background: false,
        nodeId: node.nodeId,
        inputs: upstream,
        depth: 1,
        signal,
        onHandle: (handle) => { node.agentId = handle.agentId; node.state = 'running' },
      })

      if (!background) {
        const result = await spawned
        settle(result, result.includes(' failed]') ? 'failed' : 'succeeded')
        return result
      }
      const tracked = spawned.then((result) => {
        settle(result, result.includes(' failed]') ? 'failed' : 'succeeded')
        runtime._onBackgroundSettled({ name: node.nodeId, state: 'settled' }, result)
      }).finally(() => inflight.delete(tracked))
      inflight.add(tracked)
      return `[node:${node.nodeId} started] background`
    },
```

`spawn` 增加 `onHandle` 回调（创建 handle 后立刻调用），并在 `hasPending()` 里 `|| graph.hasPending()`，`close()` 里对图上未终态节点 `graph.cancel(...)`。

`firstLine` 辅助函数（放在 `runtime.js` 模块底部）：

```js
/** 取首行并截断 —— 就绪通知里只放上游结果的头部行，正文让主 agent 自己去取。 */
function firstLine(text) {
  const line = String(text ?? '').split('\n').find(l => l.trim().length > 0) ?? '(no output)'
  return line.length > 200 ? `${line.slice(0, 199)}…` : line
}
```

- [ ] **Step 3: 实现 —— `tools.js` 补两个工具**

```js
    {
      name: 'agent_graph',
      description: 'Declare a dependency graph of tasks. Declaring does NOT create agents — nodes are '
        + 'instantiated only when their dependencies have succeeded. By default a ready node hands its '
        + 'upstream results back to you and waits: you then call graph_start with the final prompt, having '
        + 'seen what upstream actually produced. Use on_ready "auto" only when the downstream task is fully '
        + 'determined in advance and cannot be affected by upstream results.',
      parameters: {
        type: 'object',
        properties: {
          nodes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                node_id: { type: 'string' },
                depends_on: { type: 'array', items: { type: 'string' } },
                description: { type: 'string', description: 'A short (3-8 word) label' },
                prompt: { type: 'string', description: 'Required only for on_ready "auto"' },
                subagent_type: { type: 'string' },
                model: { type: 'string', enum: modelEnum(runtime.aliases) },
                on_ready: { type: 'string', enum: ['confirm', 'auto'] },
                on_upstream_failure: { type: 'string', enum: ['block', 'skip'] },
              },
              required: ['node_id', 'description'],
            },
          },
          max_concurrent: { type: 'number' },
        },
        required: ['nodes'],
      },
      execute: async ({ nodes, max_concurrent: maxConcurrent } = {}) => {
        try {
          const { accepted } = runtime.graph.declare(nodes, { maxConcurrent })
          return `declared ${accepted.length} node(s): ${accepted.join(', ')}\n${runtime.graph.statusTable()}`
        } catch (err) {
          return `Error: ${err.message}`
        }
      },
    },

    {
      name: 'graph_start',
      description: 'Start a graph node that is ready, giving it its final task contract. This is where you '
        + 'write the prompt — after seeing what upstream produced, not before.',
      parameters: {
        type: 'object',
        properties: {
          node_id: { type: 'string' },
          prompt: { type: 'string', description: 'The full task contract for this node' },
          subagent_type: { type: 'string' },
          model: { type: 'string', enum: modelEnum(runtime.aliases) },
          run_in_background: { type: 'boolean' },
        },
        required: ['node_id', 'prompt'],
      },
      execute: async ({ node_id: nodeId, prompt, subagent_type: subagentType, model, run_in_background: bg } = {}, ctx = {}) => {
        const started = runtime.graph.start(nodeId, { prompt, subagent_type: subagentType, model })
        if (!started.ok) return `Error: ${started.reason}`
        return runtime._startNode(started.node, { background: bg !== false, signal: ctx.signal })
      },
    },
```

`agent_status` 的 `execute` 末尾加：`if (includeGraph) return `${base}\n\n--- graph ---\n${runtime.graph.statusTable()}``，并给 parameters 加 `include_graph: { type: 'boolean' }`。

`agent_cancel` 扩展为同时接受 `node_id`（spec §5.3）：parameters 里 `agent_id` 从 required 移除，改为"`agent_id` 与 `node_id` 至少给一个"，execute 开头加：

```js
        if (!agentId && !nodeId) return 'Error: give either agent_id or node_id.'
        if (nodeId) {
          const cancelled = runtime.graph.cancel(nodeId, reason)
          if (!cancelled.ok) return `Error: ${cancelled.reason}`
          return `node ${nodeId} cancelled (${reason}).`
        }
```

- [ ] **Step 4: 运行测试确认通过并 Commit**

Run: `node --test src/agents/graph-tools.test.js && npm test`

```bash
git add src/agents/runtime.js src/agents/tools.js src/agents/graph-tools.test.js
git commit -m "feat(agents): expose the DAG through agent_graph and graph_start

agent_graph declares and queues; graph_start is the confirm gate where the
parent writes the node's final contract after seeing upstream output. The
agent tool's schema is untouched — it is pinned to the reference shape and
has no room for node_id/depends_on."
```

---

### Task 15: keep-alive

**Files:**
- Modify: `src/agent.js`（`_reactLoop` / `_reactLoopStream` 的"无工具调用"分支）、`src/agents/runtime.js`（`nextEvent`）
- Test: `src/agent-keepalive.test.js`

**Interfaces:**
- Produces:
  - `runtime.nextEvent({ signal, timeoutMs }) -> Promise<'event'|'timeout'>`
  - `Agent#lastKeepAliveTimedOut: boolean`
  - 事件 `run.keep_alive.timeout`，payload `{ pendingAgents, pendingNodes, waitedMs }`
  - **`lastStopReason` 取值不变**

- [ ] **Step 1: 写失败测试**

```js
// src/agent-keepalive.test.js
import test from 'node:test'
import assert from 'node:assert'
import { Agent } from './agent.js'

const baseOpts = { provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o' }

test('无待办时最终回答直接结束本轮', async () => {
  const agent = new Agent({ ...baseOpts, subagents: {} })
  assert.strictEqual(agent.subagents.hasPending(), false)
  assert.strictEqual(agent.lastKeepAliveTimedOut, false)
})

test('nextEvent 在后台 agent 结束时唤醒', async () => {
  const agent = new Agent({ ...baseOpts, subagents: {} })
  const rt = agent.subagents
  let resolved = false
  const waiting = rt.nextEvent({ timeoutMs: 1000 }).then((r) => { resolved = true; return r })
  await new Promise(resolve => setImmediate(resolve))
  assert.strictEqual(resolved, false)
  rt._signalEvent()
  assert.strictEqual(await waiting, 'event')
})

test('nextEvent 超时返回 timeout 而不是挂死', async () => {
  const agent = new Agent({ ...baseOpts, subagents: {} })
  assert.strictEqual(await agent.subagents.nextEvent({ timeoutMs: 20 }), 'timeout')
})

test('nextEvent 支持 abort', async () => {
  const agent = new Agent({ ...baseOpts, subagents: {} })
  const ac = new AbortController()
  const waiting = agent.subagents.nextEvent({ timeoutMs: 5000, signal: ac.signal })
  ac.abort()
  assert.strictEqual(await waiting, 'aborted')
})

test('keepAlive: false 时 hasPending 不影响收尾', async () => {
  const agent = new Agent({ ...baseOpts, subagents: { keepAlive: false } })
  assert.strictEqual(agent.subagents.keepAlive, false)
})

test('已完成的后台 agent 留下的通知不会被漏读（顺序回归）', async () => {
  // 回归测试：_keepAliveOnce 曾先查 hasPending() 再查 _pendingInjections。
  // 后台 agent 跑完后 hasPending() 为 false，于是 return 'idle'、本轮收尾，
  // 而它的完成通知还在队列里 —— "跑完就通知你"直接失效。
  const agent = new Agent({ ...baseOpts, subagents: {} })
  assert.strictEqual(agent.subagents.hasPending(), false, '前置条件：没有在跑的 agent')
  agent.enqueueMessage({ role: 'user', content: '<agent-notification>done</agent-notification>' })
  assert.strictEqual(await agent._keepAliveOnce(), 'injected')
})

test('keep-alive 超时置 lastKeepAliveTimedOut 且 lastStopReason 仍是 completed', async () => {
  const agent = new Agent({ ...baseOpts, subagents: { keepAliveTimeoutMs: 10 } })
  const events = []
  agent.on('run.keep_alive.timeout', p => events.push(p))

  // 造一个永不结束的后台 agent，触发 keep-alive 等待
  agent.subagents.registry.create({ type: 'general-purpose', description: 'stuck', depth: 1, model: null })
    .transition('queued')
  assert.strictEqual(agent.subagents.hasPending(), true)

  const outcome = await agent._keepAliveOnce()
  assert.strictEqual(outcome, 'timeout')
  assert.strictEqual(agent.lastKeepAliveTimedOut, true)
  assert.strictEqual(events.length, 1)
  assert.strictEqual(events[0].pendingAgents, 1)
  assert.ok(events[0].waitedMs >= 0)
})

test('lastStopReason 的取值集合没有扩张', () => {
  const agent = new Agent({ ...baseOpts, subagents: {} })
  assert.ok([null, 'completed', 'max_rounds'].includes(agent.lastStopReason))
})
```

- [ ] **Step 2: 实现 `runtime.nextEvent`**

```js
  /** @type {Array<(outcome: string) => void>} keep-alive 的等待方 */
  const waiters = []

  // runtime 对象上：
    keepAlive: keepAliveOpt !== false,
    keepAliveTimeoutMs,

    /** 任何 agent/节点状态变化都调它，唤醒 keep-alive 的等待方。 */
    _signalEvent() {
      const pending = waiters.splice(0, waiters.length)
      for (const resolve of pending) resolve('event')
    },

    /**
     * 等下一个 subagent 事件。
     * @returns {Promise<'event'|'timeout'|'aborted'>}
     */
    nextEvent({ signal, timeoutMs = keepAliveTimeoutMs } = {}) {
      if (signal?.aborted) return Promise.resolve('aborted')
      return new Promise((resolve) => {
        let settled = false
        const finish = (outcome) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          const idx = waiters.indexOf(wake)
          if (idx >= 0) waiters.splice(idx, 1)
          resolve(outcome)
        }
        const wake = () => finish('event')
        const timer = setTimeout(() => finish('timeout'), timeoutMs)
        timer.unref?.()
        signal?.addEventListener('abort', () => finish('aborted'), { once: true })
        waiters.push(wake)
      })
    },
```

在 `_onBackgroundSettled`、`graph.onReadyNode`、`ask` 的 `onStateChange` 三处末尾都调 `runtime._signalEvent()`。

- [ ] **Step 3: 实现 `Agent` 侧**

构造函数加 `this.lastKeepAliveTimedOut = false`（`_runWithSession` 入口处重置为 `false`）。

新增方法：

```js
  /**
   * keep-alive 的一次等待。返回 'injected'（有待注入消息，可直接进下一轮）、
   * 'event'（被 subagent 事件唤醒）、'timeout'、'aborted'、'idle'（无待办）。
   * @returns {Promise<string>}
   */
  async _keepAliveOnce({ signal } = {}) {
    if (!this.subagents || this.subagents.keepAlive === false) return 'idle'
    // 待注入消息**先于** hasPending() 判断 —— 顺序颠倒会丢通知：后台 agent 已经
    // 跑完时 hasPending() 为 false，但它的完成通知还在队列里没被读。先查
    // hasPending() 就会 return 'idle'、本轮收尾，通知一直躺到未来某轮跑到 round 1
    // 才被排空 —— 而"跑完就通知你"正是这套机制存在的唯一理由。
    if (this._pendingInjections.length > 0) return 'injected'
    if (!this.subagents.hasPending()) return 'idle'

    const startedAt = performance.now()
    const outcome = await this.subagents.nextEvent({
      signal, timeoutMs: this.subagents.keepAliveTimeoutMs,
    })
    if (outcome === 'timeout') {
      this.lastKeepAliveTimedOut = true
      const pendingAgents = this.subagents.registry.list().length
      const pendingNodes = this.subagents.graph
        ? [...this.subagents.graph.nodes.values()].filter(n =>
            ['blocked', 'ready', 'awaiting_confirm', 'queued', 'running'].includes(n.state)).length
        : 0
      this._safeEmit('run.keep_alive.timeout', {
        pendingAgents, pendingNodes, waitedMs: performance.now() - startedAt,
      })
      this.enqueueMessage({
        role: 'user',
        content: `<agent-notification>还有 ${pendingAgents} 个 agent、${pendingNodes} 个图节点未完成，`
          + `但已等待超过 ${this.subagents.keepAliveTimeoutMs}ms。请收尾：说明哪些工作仍在进行，`
          + '或用 agent_cancel 取消它们。</agent-notification>',
      })
    }
    return outcome
  }
```

在 `_reactLoop` 的 `if (toolCalls.length === 0) { ... }` 分支里改成：

```js
        if (toolCalls.length === 0) {
          this.memory.add({ role: 'assistant', content: textContent })
          // keep-alive：还有 subagent / 图节点没完事就不收尾，等它们的结果回来
          // 再让模型继续决策（§8）。轮次仍受 maxRounds 约束。
          const outcome = await this._keepAliveOnce({ signal })
          if (outcome !== 'idle') continue
          this.lastStopReason = 'completed'
          return textContent
        }
```

`_reactLoopStream` 同理（注入内容不作为 chunk 吐给消费方）。

- [ ] **Step 4: 运行测试确认通过并 Commit**

Run: `node --test src/agent-keepalive.test.js && npm test`

```bash
git add src/agent.js src/agents/runtime.js src/agent-keepalive.test.js
git commit -m "feat(agent): keep the turn alive while subagents are still working

A final answer no longer ends the turn when background agents or graph
nodes are outstanding — the loop waits for the next subagent event and
lets the model decide again with the result in context.

lastStopReason gains no new values (it is a cross-package contract);
keep-alive timeouts surface via lastKeepAliveTimedOut and a
run.keep_alive.timeout event."
```

**Phase 3 完成** —— DAG 惰性调度可用，主 agent 能在一轮里完成编排。

---

## Phase 4 — worktree 隔离

### Task 16: `isolation: 'worktree'`

**Files:**
- Create: `src/agents/isolation.js`
- Modify: `src/agents/runtime.js`（spawn 时建 worktree、结束时收尾）、`src/agents/runner.js`（`ctx.cwd`）
- Test: `src/agents/isolation.test.js`

**Interfaces:**
- Produces:
  - `createWorktree({ agentId, baseDir, branchPrefix, cwd, exec }) -> Promise<{ path, branch }>` —— 失败抛 `WorktreeIsolationError({ reason })`
  - `finalizeWorktree({ path, branch, cwd, exec }) -> Promise<{ removed, changedFiles }>`
  - `reason` 取值：`not_node` / `not_a_git_repo` / `git_unavailable` / `base_dir_not_ignored` / `worktree_add_failed`

- [ ] **Step 1: 写失败测试**

```js
// src/agents/isolation.test.js
import test from 'node:test'
import assert from 'node:assert'
import { createWorktree, finalizeWorktree } from './isolation.js'
import { WorktreeIsolationError } from './errors.js'

/** 假 exec：按命令前缀返回脚本化结果。 */
function fakeExec(script) {
  const calls = []
  return Object.assign(async (cmd, args) => {
    const key = `${cmd} ${args[0] ?? ''}`.trim()
    calls.push([cmd, ...args].join(' '))
    const handler = Object.entries(script).find(([prefix]) => key.startsWith(prefix))?.[1]
    if (!handler) return { stdout: '', stderr: '', code: 0 }
    if (handler instanceof Error) throw handler
    return handler
  }, { calls })
}

const okRepo = {
  'git rev-parse': { stdout: '/repo\n', code: 0 },
  'git check-ignore': { stdout: '.worktrees\n', code: 0 },
  'git worktree': { stdout: '', code: 0 },
  'git branch': { stdout: '', code: 0 },
  'git status': { stdout: '', code: 0 },
}

test('正常路径：建出 worktree 与分支', async () => {
  const exec = fakeExec(okRepo)
  const wt = await createWorktree({ agentId: 'agt_1', baseDir: '.worktrees', branchPrefix: 'subagent/', exec })
  assert.ok(wt.path.includes('agent-agt_1'))
  assert.strictEqual(wt.branch, 'subagent/agt_1')
  assert.ok(exec.calls.some(c => c.includes('worktree add')))
})

test('非 git 仓库 → not_a_git_repo', async () => {
  const exec = fakeExec({ 'git rev-parse': Object.assign(new Error('fatal: not a git repository'), { code: 128 }) })
  await assert.rejects(
    createWorktree({ agentId: 'a', baseDir: '.worktrees', branchPrefix: 'subagent/', exec }),
    (err) => err instanceof WorktreeIsolationError && err.reason === 'not_a_git_repo')
})

test('baseDir 未被 gitignore → 拒绝创建', async () => {
  const exec = fakeExec({
    ...okRepo,
    'git check-ignore': { stdout: '', code: 1 },
  })
  await assert.rejects(
    createWorktree({ agentId: 'a', baseDir: '.worktrees', branchPrefix: 'subagent/', exec }),
    (err) => err instanceof WorktreeIsolationError && err.reason === 'base_dir_not_ignored')
})

test('分支重名时加 _2 后缀', async () => {
  let firstAdd = true
  const exec = fakeExec({
    ...okRepo,
    'git worktree': {
      get stdout() { return '' },
      code: 0,
    },
  })
  const guarded = async (cmd, args) => {
    if (args.includes('add') && firstAdd) {
      firstAdd = false
      throw Object.assign(new Error("fatal: a branch named 'subagent/a' already exists"), { code: 128 })
    }
    return exec(cmd, args)
  }
  const wt = await createWorktree({ agentId: 'a', baseDir: '.worktrees', branchPrefix: 'subagent/', exec: guarded })
  assert.strictEqual(wt.branch, 'subagent/a_2')
})

test('收尾：无改动时移除 worktree 与分支', async () => {
  const exec = fakeExec({ ...okRepo, 'git status': { stdout: '', code: 0 } })
  const out = await finalizeWorktree({ path: '/repo/.worktrees/agent-a', branch: 'subagent/a', exec })
  assert.strictEqual(out.removed, true)
  assert.strictEqual(out.changedFiles, 0)
  assert.ok(exec.calls.some(c => c.includes('worktree remove')))
})

test('收尾：有改动时保留并报告文件数', async () => {
  const exec = fakeExec({
    ...okRepo,
    'git status': { stdout: ' M src/a.js\n?? src/b.js\n M src/c.js\n', code: 0 },
  })
  const out = await finalizeWorktree({ path: '/repo/.worktrees/agent-a', branch: 'subagent/a', exec })
  assert.strictEqual(out.removed, false)
  assert.strictEqual(out.changedFiles, 3)
  assert.ok(!exec.calls.some(c => c.includes('worktree remove')))
})

test('非 Node 运行时 → not_node', async () => {
  await assert.rejects(
    createWorktree({ agentId: 'a', baseDir: '.worktrees', branchPrefix: 'subagent/', exec: null, isNode: false }),
    (err) => err instanceof WorktreeIsolationError && err.reason === 'not_node')
})
```

- [ ] **Step 2: 实现 `isolation.js`**

```js
/**
 * worktree 隔离（Node-only）。
 *
 * **框架不重写工具入参** —— read_file / shell_exec 是主机提供的，框架无权改其
 * 语义；静默重写路径会造成"看起来隔离、实际没隔离"的错觉。工作目录以两种方式
 * 传达：写进子 agent 的首条消息（上下文事实），以及经 `ctx.cwd` 传给工具。
 * 主机工具是否采纳 ctx.cwd 由主机决定。
 */
import { WorktreeIsolationError } from './errors.js'

/** 默认 exec：spawn 一个 git 子进程。仅在 Node 下动态加载。 */
async function defaultExec(cmd, args, { cwd } = {}) {
  const { spawn } = await import('node:child_process')
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr, code })
      else reject(Object.assign(new Error(stderr.trim() || `${cmd} exited ${code}`), { code, stderr }))
    })
  })
}

function isNodeRuntime() {
  return typeof process !== 'undefined' && !!process.versions?.node
}

export async function createWorktree({
  agentId, baseDir = '.worktrees', branchPrefix = 'subagent/', cwd,
  exec = defaultExec, isNode = isNodeRuntime(),
}) {
  if (!isNode) {
    throw new WorktreeIsolationError('worktree isolation requires Node.js', { reason: 'not_node' })
  }

  let repoRoot
  try {
    const { stdout } = await exec('git', ['rev-parse', '--show-toplevel'], { cwd })
    repoRoot = stdout.trim()
  } catch (err) {
    const reason = /not a git repository/i.test(String(err?.message ?? '')) ? 'not_a_git_repo' : 'git_unavailable'
    throw new WorktreeIsolationError(`worktree isolation unavailable: ${err?.message ?? err}`, { reason, cause: err })
  }
  if (!repoRoot) {
    throw new WorktreeIsolationError('worktree isolation unavailable: empty repo root', { reason: 'not_a_git_repo' })
  }

  // baseDir 必须被 gitignore，否则 worktree 内容会被提交进仓库。
  try {
    await exec('git', ['check-ignore', '-q', baseDir], { cwd: repoRoot })
  } catch (err) {
    throw new WorktreeIsolationError(
      `worktree base directory "${baseDir}" is not gitignored — add it to .gitignore first, `
      + 'otherwise the worktree contents get committed into the repository.',
      { reason: 'base_dir_not_ignored', cause: err },
    )
  }

  const path = `${repoRoot}/${baseDir}/agent-${agentId}`
  const candidates = [`${branchPrefix}${agentId}`, `${branchPrefix}${agentId}_2`, `${branchPrefix}${agentId}_3`]
  let lastError = null
  for (const branch of candidates) {
    try {
      await exec('git', ['worktree', 'add', path, '-b', branch], { cwd: repoRoot })
      return { path, branch }
    } catch (err) {
      lastError = err
      if (!/already exists/i.test(String(err?.message ?? ''))) break
    }
  }
  throw new WorktreeIsolationError(
    `git worktree add failed: ${lastError?.message ?? 'unknown error'}`,
    { reason: 'worktree_add_failed', cause: lastError },
  )
}

/**
 * 收尾：无改动则移除 worktree 与分支；有改动则保留并报告文件数，由主 agent
 * 决定合并或丢弃。
 * @returns {Promise<{ removed: boolean, changedFiles: number }>}
 */
export async function finalizeWorktree({ path, branch, cwd, exec = defaultExec }) {
  let changedFiles = 0
  try {
    const { stdout } = await exec('git', ['-C', path, 'status', '--porcelain'], { cwd })
    changedFiles = stdout.split('\n').filter(line => line.trim().length > 0).length
  } catch {
    return { removed: false, changedFiles: 0 }
  }
  if (changedFiles > 0) return { removed: false, changedFiles }

  try {
    await exec('git', ['worktree', 'remove', path], { cwd })
    await exec('git', ['branch', '-D', branch], { cwd })
    return { removed: true, changedFiles: 0 }
  } catch {
    return { removed: false, changedFiles: 0 }
  }
}
```

- [ ] **Step 3: 接进 runtime 与 runner**

`runtime.spawn` 里，**先创建 handle（拿到 agentId），再建 worktree，再把结果挂回 handle**：

```js
      const handle = registry.create({
        type: typeName, description, parentAgentId, depth, nodeId, model: resolved, isolation: null,
      })
      onHandle?.(handle)

      if (isolation?.mode === 'worktree') {
        try {
          const wt = await createWorktree({
            agentId: handle.agentId,
            baseDir: isolationOpts.worktreeBaseDir ?? '.worktrees',
            branchPrefix: isolationOpts.branchPrefix ?? 'subagent/',
          })
          handle.isolation = {
            mode: 'worktree', path: wt.path, branch: wt.branch, dirty: false, changedFiles: 0,
          }
        } catch (err) {
          handle.transition('cancelled')
          return `Error: isolation "worktree" unavailable (${err.reason}): ${err.message}. `
            + 'Retry without the isolation parameter.'
        }
      }
```

`runner._runOnce` 已经在 Task 7 里就把 `cwd` 写进了 `child._toolContextExtra`，无需再改。

终态收尾（`_finishSucceeded` / `_finishFailed` 之前）：

```js
    if (handle.isolation?.mode === 'worktree') {
      const { removed, changedFiles } = await finalizeWorktree(handle.isolation)
      handle.isolation.dirty = !removed && changedFiles > 0
      handle.isolation.changedFiles = changedFiles
    }
```

- [ ] **Step 4: 运行测试确认通过并 Commit**

Run: `node --test src/agents/isolation.test.js && npm test`

```bash
git add src/agents/isolation.js src/agents/isolation.test.js src/agents/runtime.js src/agents/runner.js
git commit -m "feat(agents): implement isolation: worktree

Each isolated subagent gets its own git worktree and branch; a clean tree
is removed on exit, a dirty one is kept and reported so the parent can
decide whether to merge.

The framework does not rewrite tool arguments — read_file and shell_exec
belong to the host. The working directory is communicated as context in
the subagent's first message and via ctx.cwd; honouring it is the host
tool's call. Refuses to create anything if the base directory is not
gitignored."
```

---

## Phase 5 — 导出与文档

### Task 17: barrel 导出与文档

**Files:**
- Create: `src/agents/index.js`
- Modify: `src/index.js`、`CLAUDE.md`、`README.md`、`CHANGELOG.md`
- Test: `src/agents/index.test.js`

- [ ] **Step 1: 写失败测试**

```js
// src/agents/index.test.js
import test from 'node:test'
import assert from 'node:assert'
import * as agents from './index.js'
import * as sdk from '../index.js'

const EXPECTED = [
  'createSubagentRuntime', 'registerAgentType', 'getAgentType', 'listAgentTypes',
  'unregisterAgentType', 'resetAgentTypes', 'registerA2ATransport',
  'SubagentError', 'AgentTypeError', 'AgentGraphError', 'A2AError', 'WorktreeIsolationError',
]

test('agents barrel 导出齐全', () => {
  for (const name of EXPECTED) assert.strictEqual(typeof agents[name] !== 'undefined', true, `缺少 ${name}`)
})

test('SDK 顶层同样导出', () => {
  for (const name of EXPECTED) assert.strictEqual(typeof sdk[name] !== 'undefined', true, `src/index.js 缺少 ${name}`)
})

test('测试替身不外泄', () => {
  assert.strictEqual(agents.fakeAgentFactory, undefined)
})
```

- [ ] **Step 2: 实现 `src/agents/index.js` 并在 `src/index.js` 追加同一批导出**

```js
/** Subagent 系统的公开面。内部件（handle / registry / runner / graph 等）不导出。 */
export { createSubagentRuntime } from './runtime.js'
export {
  registerAgentType, getAgentType, listAgentTypes, unregisterAgentType, resetAgentTypes,
  AGENT_TYPE_NAME_RE, INITIAL_AGENT_TYPES,
} from './types.js'
export { registerA2ATransport, RESERVED_A2A_TRANSPORTS } from './a2a/index.js'
export { SUBAGENT_TOOL_NAMES } from './tools.js'
export {
  SubagentError, AgentTypeError, AgentGraphError, A2AError, WorktreeIsolationError,
} from './errors.js'
```

- [ ] **Step 3: 更新 `CLAUDE.md`**

在 Architecture 的 `skills/` 段之后追加 `agents/` 段，照 `mcp/` `skills/` 的写法列出：模块布局表、零新增依赖声明、`agent.js` 的 7 处触点、安全注意（无沙箱、产物轨是记账而非强制、`ctx.cwd` 需主机工具配合）、已知限制（`plan_and_execute` 下无类型清单/无轮边界注入/无 keep-alive、`isolation: 'remote'` 未实现）。在 Testing 段的测试文件清单里加上新增的测试文件。

- [ ] **Step 4: 更新 `README.md` 与 `CHANGELOG.md`**

README 增加一节 "Subagent 系统"，含：最小可用示例（配置 `subagents`、注册一个自定义类型、派一个同步 agent）、DAG 示例（`agent_graph` + `graph_start`）、提问路由的两种主机接法（hook 与 `answerQuestion`）、以及三条注意事项：后台 agent 跨 `chat()` 存活、退出前调 `closeSubagents()`、产物轨是记账约定。

CHANGELOG 在 Unreleased 下加 `### Added`，说明新增能力与**向后兼容性**（未配置 `opts.subagents` 时行为不变；`onAskUser` 单参数签名继续可用；`lastStopReason` 取值集合未变）。

- [ ] **Step 5: 跑全量测试并 Commit**

```bash
npm test
git add src/agents/index.js src/agents/index.test.js src/index.js CLAUDE.md README.md CHANGELOG.md
git commit -m "docs(agents): export the subagent public surface and document it"
```

---

## 附录：执行顺序与检查点

| 阶段 | 任务 | 结束时可用的能力 |
|---|---|---|
| 1 | 1-9 | 派 subagent（同步/后台）、查状态、取消、产物记账、历史检索 |
| 2 | 10-12 | 轮边界注入、agent 互发消息、多路提问定向应答 |
| 3 | 13-15 | DAG 惰性调度与就绪确认、keep-alive |
| 4 | 16 | worktree 硬隔离 |
| 5 | 17 | 导出与文档 |

**每个任务的收尾动作固定为：`npm test` 全绿 → commit。** 既有 354 个测试任何一个挂掉都意味着触点破坏了向后兼容，必须修到全绿再提交，不能带着红灯往下走。

