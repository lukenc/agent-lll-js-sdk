export const MCP_TOOL_METADATA_KEYS = Object.freeze([
  'title',
  'icons',
  'outputSchema',
  'execution',
  'annotations',
])

export function describeMcpToolForModel(tool) {
  if (tool == null || typeof tool !== 'object') return ''
  if (typeof tool.modelDescription === 'string' && tool.modelDescription.length > 0) {
    return tool.modelDescription
  }

  const meta = readMcpToolMetadata(tool)
  const baseDescription = firstString(
    meta.rawDescription,
    tool.rawDescription,
    tool.description,
    ''
  )
  const details = []
  const displayTitle = firstString(meta.title, meta.annotations?.title)
  if (displayTitle && displayTitle !== baseDescription) {
    details.push(`title=${displayTitle}`)
  }
  if (typeof meta.execution?.taskSupport === 'string' && meta.execution.taskSupport.length > 0) {
    details.push(`taskSupport=${meta.execution.taskSupport}`)
  }
  const outputSummary = summarizeMcpOutputSchema(meta.outputSchema)
  if (outputSummary) {
    details.push(`outputSchema=${outputSummary}`)
  }
  const annotationSummary = summarizeMcpAnnotations(meta.annotations)
  if (annotationSummary) {
    details.push(annotationSummary)
  }

  if (details.length === 0) return baseDescription
  const prefix = baseDescription ? `${baseDescription}\n` : ''
  return `${prefix}MCP metadata: ${details.join('; ')}.`
}

export function formatMcpToolSummary(tool) {
  const meta = readMcpToolMetadata(tool)
  const name = firstString(tool?.name, meta.rawName, '(unnamed)')
  const parts = [name]
  const displayTitle = firstString(meta.title, meta.annotations?.title)
  if (displayTitle) parts.push(`title=${displayTitle}`)
  if (meta.rawName && meta.rawName !== name) parts.push(`rawName=${meta.rawName}`)
  if (typeof meta.execution?.taskSupport === 'string' && meta.execution.taskSupport.length > 0) {
    parts.push(`taskSupport=${meta.execution.taskSupport}`)
  }
  const outputSummary = summarizeMcpOutputSchema(meta.outputSchema)
  if (outputSummary) parts.push(`outputSchema=${outputSummary}`)
  return parts.join(' | ')
}

export function serializeMcpToolForBrowser(tool) {
  const meta = readMcpToolMetadata(tool)
  const modelDescription = describeMcpToolForModel(tool)
  return {
    name: tool?.name,
    description: modelDescription,
    modelDescription,
    rawDescription: firstString(meta.rawDescription, tool?.rawDescription, tool?.description, ''),
    parameters: tool?.parameters ?? tool?.inputSchema ?? { type: 'object', properties: {} },
    rawName: meta.rawName,
    serverName: meta.serverName,
    title: meta.title,
    icons: meta.icons,
    outputSchema: meta.outputSchema,
    execution: meta.execution,
    annotations: meta.annotations,
  }
}

export function attachMcpToolMetadata(toolDef, source = {}) {
  if (toolDef == null || typeof toolDef !== 'object') {
    throw new TypeError('attachMcpToolMetadata: toolDef must be an object')
  }
  const meta = readMcpToolMetadata(source)
  for (const key of MCP_TOOL_METADATA_KEYS) {
    defineHiddenMetadata(toolDef, key, meta[key])
  }
  defineHiddenMetadata(toolDef, '_mcp', {
    serverName: meta.serverName,
    rawName: meta.rawName,
    rawDescription: meta.rawDescription,
    title: meta.title,
    icons: meta.icons,
    outputSchema: meta.outputSchema,
    execution: meta.execution,
    annotations: meta.annotations,
  })
  return toolDef
}

export function readMcpToolMetadata(source = {}) {
  const mcp = source?._mcp && typeof source._mcp === 'object' ? source._mcp : {}
  return {
    serverName: source.serverName ?? mcp.serverName,
    rawName: source.rawName ?? mcp.rawName ?? source.name,
    rawDescription: source.rawDescription ?? mcp.rawDescription,
    title: source.title ?? mcp.title,
    icons: source.icons ?? mcp.icons,
    outputSchema: source.outputSchema ?? mcp.outputSchema,
    execution: source.execution ?? mcp.execution,
    annotations: source.annotations ?? mcp.annotations,
  }
}

export function summarizeMcpOutputSchema(schema) {
  if (schema == null || typeof schema !== 'object') return ''
  const type = typeof schema.type === 'string' ? schema.type : 'object'
  const props = schema.properties && typeof schema.properties === 'object'
    ? Object.keys(schema.properties).slice(0, 12)
    : []
  const required = Array.isArray(schema.required) ? schema.required.slice(0, 12) : []
  const parts = [type]
  if (props.length > 0) parts.push(`properties: ${props.join(', ')}`)
  if (required.length > 0) parts.push(`required: ${required.join(', ')}`)
  return parts.join('; ')
}

function summarizeMcpAnnotations(annotations) {
  if (annotations == null || typeof annotations !== 'object') return ''
  const keys = [
    'readOnlyHint',
    'destructiveHint',
    'idempotentHint',
    'openWorldHint',
  ]
  const parts = []
  for (const key of keys) {
    if (typeof annotations[key] === 'boolean') {
      parts.push(`${key}=${annotations[key]}`)
    }
  }
  return parts.join('; ')
}

function defineHiddenMetadata(target, key, value) {
  if (value === undefined) return
  const existing = Object.getOwnPropertyDescriptor(target, key)
  if (existing && existing.configurable === false) return
  Object.defineProperty(target, key, {
    value,
    enumerable: false,
    writable: false,
    configurable: false,
  })
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}
