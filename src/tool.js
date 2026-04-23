/**
 * Tool 定义 — 对应 Java 框架的 Tool 接口
 *
 * 用法：
 *   const readFile = defineTool({
 *     name: 'read_file',
 *     description: '读取文件内容',
 *     parameters: {
 *       type: 'object',
 *       properties: { path: { type: 'string', description: '文件路径' } },
 *       required: ['path'],
 *     },
 *     execute: async ({ path }) => {
 *       const fs = await import('fs/promises')
 *       return await fs.readFile(path, 'utf-8')
 *     },
 *   })
 */

/**
 * @typedef {object} ToolDef
 * @property {string} name - 工具唯一名称
 * @property {string} description - 工具描述（供 LLM 理解）
 * @property {object} parameters - JSON Schema 格式的参数定义
 * @property {(params: object, context?: object) => Promise<string>} execute - 执行函数
 */

/**
 * 定义一个工具
 * @param {ToolDef} def
 * @returns {ToolDef}
 */
export function defineTool(def) {
  if (!def.name) throw new Error('Tool name is required')
  if (!def.description) throw new Error('Tool description is required')
  if (!def.execute) throw new Error('Tool execute function is required')
  return {
    name: def.name,
    description: def.description,
    parameters: def.parameters ?? { type: 'object', properties: {} },
    execute: def.execute,
  }
}

/** 将 Tool 列表转换为 OpenAI tools 格式 */
export function formatToolsForOpenAI(tools) {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }))
}

/** 从 LLM 响应中解析工具调用 */
export function parseToolCalls(response) {
  const message = response.choices?.[0]?.message
  if (!message?.tool_calls?.length) return []
  return message.tool_calls.map(tc => ({
    id: tc.id,
    name: tc.function.name,
    arguments: safeParseJSON(tc.function.arguments),
  }))
}

/** 将工具执行结果格式化为对话消息 */
export function formatToolResult(callId, toolName, result) {
  return {
    role: 'tool',
    tool_call_id: callId,
    name: toolName,
    content: typeof result === 'string' ? result : JSON.stringify(result),
  }
}

function safeParseJSON(str) {
  try { return JSON.parse(str) } catch { return {} }
}
