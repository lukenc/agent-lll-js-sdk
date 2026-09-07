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
 * 内置类型。`tools: '*'` 表示继承父工具集，但四个图工具（`agent_graph` /
 * `graph_start` / `graph_close` / `graph_reactivate`）**无条件**剔除，`agent`
 * 则由 `canSpawn` 把关（默认 false 也剔除）。`model: 'main'` 指向模型别名表里的
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

/**
 * 校验一个 `attemptTimeoutMs` 取值，返回归一化后的值。
 *
 * 三个哨兵各有含义，**不能用 `??` 混为一谈**：
 *   - `undefined` —— 没表态，交给回退链的下一环（类型级 → `subagents.retry` → 默认）；
 *   - `null` —— 显式**不设截止**（与 `ask.timeoutMs` 默认 `null` = 永不超时同一拼法）；
 *   - 正整数毫秒 —— 就按它装表。
 *
 * `Infinity` 被拒而不是被读成"不设界"：不设界正是这个字段存在的理由所要防的失败形态
 * （一个卡在挂死工具调用上的子 agent 无上界地占着并发槽），想关就明写 `null`，让
 * "我确实决定了不设界"这件事在配置里看得见。与 `maxConsecutiveWakes` 拒绝 `Infinity`
 * 同一取舍。
 *
 * **住在这里而不是 `runner.js`**：runner.js 已经 import 本模块（`getAgentType`），反向
 * 再 import 一次就构成引用环 —— 本仓已经在 `agent.js → runtime.js → runner.js` 上为
 * 求值顺序脆弱性付过一次代价（runner.js 顶部那条"不要静态 import Agent"的注释）。
 * runner.js 把它 re-export 出去，所以公开面仍在机制所在的那个模块。
 *
 * @param {number|null|undefined} value
 * @param {string} [where] 出错信息里点名的字段路径
 * @returns {number|null|undefined}
 * @throws {TypeError} 非正整数毫秒
 */
export function normalizeAttemptTimeoutMs(value, where = 'subagents.retry.attemptTimeoutMs') {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(
      `${where} (${String(value)}) must be a whole number of milliseconds (>= 1), or null to disable the attempt deadline`,
    )
  }
  return value
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
  // `attemptTimeoutMs` 走 types.js 自己的校验函数，但错误类型换成本模块的
  // `AgentTypeError`：类型注册失败与本模块其余四处校验（name / description /
  // systemPrompt / tools）是同一类问题，调用方按 instanceof 分支时不该在这里
  // 分叉成 TypeError。`opts.subagents.retry.attemptTimeoutMs` 那一侧仍然抛
  // TypeError（与 `maxConsecutiveWakes` / `spill.maxToolResultBytes` 同）。
  let attemptTimeoutMs
  try {
    attemptTimeoutMs = normalizeAttemptTimeoutMs(def.attemptTimeoutMs, `registerAgentType: attemptTimeoutMs`)
  } catch (err) {
    throw new AgentTypeError(err.message, { typeName: name })
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
    // **刻意不填默认值**：`undefined` 是"这个类型不表态"，runner 的回退链据此继续
    // 找 `subagents.retry.attemptTimeoutMs` → `DEFAULT_ATTEMPT_TIMEOUT_MS`。谁在这里
    // eager 填了 600000，宿主级配置就永远不可达 —— `maxAttempts` 已经踩过一次。
    // `null` 则要原样穿过（它是"显式不设截止"），所以这里既不用 `??` 也不用 `||`。
    attemptTimeoutMs,
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
