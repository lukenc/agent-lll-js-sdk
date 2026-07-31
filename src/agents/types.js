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
