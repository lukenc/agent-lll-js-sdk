/**
 * CallToolResult 归一化 — 将 MCP `tools/call` 响应的 `result` 结构归一化为
 * 供 LLM 消费的单一字符串。
 *
 * 规则(对应 design §Components `normalize.js` / Property 11):
 *   1. `result.isError === true`:返回
 *      `'Error from MCP tool "<rawName>": ' + normalizeContent(result)`
 *      (Requirement 6.9);
 *   2. 否则返回 `normalizeContent(result)`。
 *
 * `normalizeContent(result)`:
 *   A. `result.content` 为非空数组 → 按 Content_Part 的 `type` 分支:
 *      - `'text'`          → 原样保留 `text` 字段内容;
 *      - `'image'`         → `[mcp:image mimeType=<mime>]`;
 *      - `'audio'`         → `[mcp:audio mimeType=<mime>]`;
 *      - `'resource_link'` → `[mcp:resource_link uri=<uri>]`;
 *      - `'resource'`      → `[mcp:resource uri=<resource.uri>]`;
 *      - 其他未知 type     → `[mcp:<type>]`;
 *      然后以 `'\n'` 连接所有片段(Requirements 6.6, 6.7);
 *   B. `result.content` 缺失或为空数组,且 `result.structuredContent` 存在 →
 *      返回 `JSON.stringify(result.structuredContent)`(Requirement 6.8);
 *   C. 都空 → 返回空字符串。
 *
 * 返回值 **始终** 是 `string`。
 *
 * @see Requirements 6.6, 6.7, 6.8, 6.9
 */

/**
 * 把单个 Content_Part 渲染成字符串片段。
 *
 * 设计取舍:对非 text 类型,我们只输出规范里定义的最小摘要字段(image/audio
 * 的 `mimeType`、resource_link 的 `uri`、resource 的 `resource.uri`),不泄露
 * 原始 base64 负载、binary blob 或其他大体积/敏感字段。未知 type 只输出
 * `[mcp:<type>]`,保持对未来规范扩展的向前兼容。
 *
 * @param {object} part  Content_Part 对象,期望含 `type` 字段
 * @returns {string}
 */
function renderContentPart(part) {
  // 防御性:part 非对象或无 type 字段时按未知类型处理
  if (part === null || typeof part !== 'object') {
    return '[mcp:unknown]'
  }
  const type = part.type
  switch (type) {
    case 'text': {
      // Req 6.6:保留每一份 text 字段的原文
      const text = part.text
      return typeof text === 'string' ? text : ''
    }
    case 'image':
      return `[mcp:image mimeType=${String(part.mimeType ?? '')}]`
    case 'audio':
      return `[mcp:audio mimeType=${String(part.mimeType ?? '')}]`
    case 'resource_link':
      return `[mcp:resource_link uri=${String(part.uri ?? '')}]`
    case 'resource': {
      const resource = part.resource
      const uri = resource && typeof resource === 'object' ? resource.uri : undefined
      return `[mcp:resource uri=${String(uri ?? '')}]`
    }
    default:
      // 未知 type:只输出 type 名字,不暴露未知字段
      return `[mcp:${String(type ?? 'unknown')}]`
  }
}

/**
 * 归一化 `result.content` + `structuredContent` 为字符串(不考虑 isError)。
 *
 * @param {object} result  MCP_Call_Result
 * @returns {string}
 */
function normalizeContent(result) {
  const content = result?.content
  if (Array.isArray(content) && content.length > 0) {
    return content.map(renderContentPart).join('\n')
  }
  // content 缺失/为空数组:尝试 structuredContent fallback (Req 6.8)
  const structured = result?.structuredContent
  if (structured !== undefined && structured !== null) {
    try {
      return JSON.stringify(structured)
    } catch {
      // JSON.stringify 只在循环引用等极端场景下抛错;降级为空串保持"永远返回 string"的契约
      return ''
    }
  }
  return ''
}

/**
 * 归一化 MCP_Call_Result 为 LLM 消费的字符串。
 *
 * @param {object} result        MCP `tools/call` 响应的 `result` 字段
 * @param {string} rawToolName   server 原始工具名 (rawName),用于 isError 前缀
 * @returns {string}             始终为字符串
 */
export function normalizeCallToolResult(result, rawToolName) {
  const body = normalizeContent(result ?? {})
  if (result?.isError === true) {
    // Req 6.9:错误响应以固定前缀拼接归一化 body,不抛异常
    return `Error from MCP tool "${String(rawToolName ?? '')}": ${body}`
  }
  return body
}
