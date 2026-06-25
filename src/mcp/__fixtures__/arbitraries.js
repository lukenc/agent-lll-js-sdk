/**
 * fast-check 生成器集合 — MCP Client 属性测试专用
 *
 * **Test-only fixture**: 本文件仅供 `src/mcp` 下的测试套件(`*.test.js`)
 * import,不是生产代码,**不从** `src/mcp/index.js` / `src/index.js` 导出。
 *
 * 集中定义本 Feature 16 条 Correctness Properties 所需的 fast-check arbitraries。
 * 命名约定: `arb<Shape>`。所有导出都返回一个 `fc.Arbitrary<T>`,调用方直接把它
 * 塞进 `fc.property` / `fc.assert`。
 *
 * @see design.md §Testing Strategy → "关键生成器(fast-check arbitraries)"
 * @see design.md §Correctness Properties (Property 2, 4, 5, 6, 8, 10, 11, 14, 15, 16)
 *
 * 注意事项:
 *   - fast-check v4 已移除 `fc.unicodeString` / `fc.fullUnicodeString` 顶级函数;
 *     宽字符覆盖统一走 `fc.string({ unit: 'grapheme' | 'binary' | ... })`。
 *   - 所有生成器默认 size 由 fast-check 的全局策略决定,不在生成器内硬编码
 *     `maxLength`,保证 shrinking 行为自然。少数需要边界控制的生成器(如
 *     `arbSecret`)显式给出 min/max。
 *
 * @module src/mcp/__fixtures__/arbitraries
 */

import fc from 'fast-check'

// ---------------------------------------------------------------------------
// 基础字符串生成器
// ---------------------------------------------------------------------------

/**
 * 覆盖 ASCII / emoji / 中文 / 控制字符 / 空串的 Unicode 字符串生成器。
 *
 * 使用 `fc.oneof` 按概率混合多条字符串生成路径:
 *   - 空串 (`fc.constant('')`) —— 纯边界
 *   - 普通 ASCII `fc.string()` —— 最常见路径
 *   - 二进制单元 `{ unit: 'binary' }` —— 覆盖控制字符 / 非打印 BMP 字符
 *   - grapheme 单元 `{ unit: 'grapheme' }` —— 覆盖 emoji / 组合字符 / 中文
 *     常用字符
 *   - grapheme-composite 单元 —— 进一步覆盖 ZWJ 组合序列
 *
 * Supports: Properties 2 (JSON-RPC 内字符串载荷), 6 (namespacing Unicode 输入),
 * 11 (归一化 text 字段), 14 (secret 字符串本身可能是 Unicode), 15 (SSE data
 * 字段常见多字节).
 */
export const arbUnicodeString = fc.oneof(
  { weight: 1, arbitrary: fc.constant('') },
  { weight: 4, arbitrary: fc.string() },
  { weight: 2, arbitrary: fc.string({ unit: 'binary' }) },
  { weight: 3, arbitrary: fc.string({ unit: 'grapheme' }) },
  { weight: 1, arbitrary: fc.string({ unit: 'grapheme-composite' }) },
)

/**
 * 安全 ASCII 字符串(可选 minLength),用于不希望生成器污染断言字符串匹配的
 * 场景,例如 JSON-RPC `method` 字段。
 */
const arbAsciiString = fc.string({ minLength: 1, maxLength: 32 })

/**
 * 短 method 名 —— 近似 MCP / JSON-RPC method 形式,但不约束前缀,让
 * codec round-trip 能覆盖任意合法字符串 method。
 */
const arbMethodName = fc.oneof(
  fc.string({ minLength: 1, maxLength: 32 }),
  fc.constantFrom(
    'initialize',
    'notifications/initialized',
    'notifications/cancelled',
    'notifications/tools/list_changed',
    'tools/list',
    'tools/call',
    'ping',
  ),
)

// ---------------------------------------------------------------------------
// JSON-RPC 生成器 (Property 2)
// ---------------------------------------------------------------------------

/**
 * 任意 JSON 对象 —— 作为 JSON-RPC `params` / `result` / `error.data` 的载荷。
 *
 * 使用 fast-check v4 的 `fc.object()`(默认生成 JSON-safe object,深度受
 * 全局 size 限制)。
 *
 * Supports: Properties 2, 4, 8, 10, 11
 */
export const arbJsonObject = fc.object()

/**
 * 任意 JSON 值 —— object / array / primitive 皆可,用作 params 数组元素或
 * structuredContent。
 */
export const arbJsonValue = fc.jsonValue()

/**
 * JSON-RPC request id。按 JSON-RPC 2.0 规范允许 number / string(不允许
 * fractional number,但 `fc.integer()` 自然为整数)。
 *
 * 注:design 侧 `MCP_Client` 自增 id 用 number,但 codec 层对 number / string
 * 都必须能 round-trip,所以生成器同时覆盖两种形态。
 */
const arbJsonRpcId = fc.oneof(
  fc.integer(),
  fc.string({ minLength: 1, maxLength: 16 }),
)

/**
 * JSON-RPC 请求 `params` 字段 —— 可为 object / 数组 / 缺失(undefined 时该
 * 字段整条省略,通过 `fc.record` 的 `requiredKeys` 实现)。
 */
const arbJsonRpcParams = fc.oneof(
  arbJsonObject,
  fc.array(arbJsonValue, { maxLength: 5 }),
)

/**
 * JSON-RPC **请求**消息: `{ jsonrpc: '2.0', id, method, params? }`。
 *
 * Supports: Property 2 (codec round-trip)
 */
export const arbJsonRpcRequest = fc.record(
  {
    jsonrpc: fc.constant('2.0'),
    id: arbJsonRpcId,
    method: arbMethodName,
    params: arbJsonRpcParams,
  },
  { requiredKeys: ['jsonrpc', 'id', 'method'] },
)

/**
 * JSON-RPC 响应的 `error` 字段形状: `{ code: number, message: string, data? }`。
 */
const arbJsonRpcError = fc.record(
  {
    code: fc.integer(),
    message: arbUnicodeString,
    data: arbJsonValue,
  },
  { requiredKeys: ['code', 'message'] },
)

/**
 * JSON-RPC **响应**消息: `{ jsonrpc: '2.0', id, result? | error? }` 且 `result`
 * 与 `error` 字段互斥(JSON-RPC 2.0 规范)。
 *
 * 通过 `fc.oneof` 在"含 result"与"含 error"两条分支间选择,确保互斥约束。
 *
 * Supports: Property 2 (codec round-trip)
 */
export const arbJsonRpcResponse = fc.oneof(
  fc.record({
    jsonrpc: fc.constant('2.0'),
    id: arbJsonRpcId,
    result: arbJsonValue,
  }),
  fc.record({
    jsonrpc: fc.constant('2.0'),
    id: arbJsonRpcId,
    error: arbJsonRpcError,
  }),
)

/**
 * JSON-RPC **通知**消息: `{ jsonrpc: '2.0', method, params? }` (无 id)。
 *
 * Supports: Property 2 (codec round-trip)
 */
export const arbJsonRpcNotification = fc.record(
  {
    jsonrpc: fc.constant('2.0'),
    method: arbMethodName,
    params: arbJsonRpcParams,
  },
  { requiredKeys: ['jsonrpc', 'method'] },
)

/**
 * 任意合法 JSON-RPC 消息(request / response / notification 三选一)。
 *
 * Supports: Property 2 (JSON-RPC codec 单行 + round-trip)
 */
export const arbJsonRpcMessage = fc.oneof(
  arbJsonRpcRequest,
  arbJsonRpcResponse,
  arbJsonRpcNotification,
)

// ---------------------------------------------------------------------------
// MCP Tool Descriptor 生成器 (Property 4, 5, 6, 8, 16)
// ---------------------------------------------------------------------------

/**
 * 简化 JSON Schema 生成器 —— 仅生成 `type: 'object'` 的对象 schema 并随机
 * 附加若干 properties。这是为了在 `arbToolDescriptor.inputSchema` 中提供
 * 一个**身份可比较**的对象(Property 5 要求 `t.parameters === d.inputSchema`
 * 是引用相等),同时保留一些形状随机性。
 */
const arbJsonSchema = fc.record(
  {
    type: fc.constant('object'),
    properties: fc.dictionary(
      fc.string({ minLength: 1, maxLength: 12 }),
      fc.record({
        type: fc.constantFrom('string', 'number', 'boolean', 'object', 'array'),
        description: fc.option(fc.string({ maxLength: 40 }), { nil: undefined }),
      }),
      { maxKeys: 5 },
    ),
    required: fc.array(fc.string({ minLength: 1, maxLength: 12 }), { maxLength: 3 }),
  },
  { requiredKeys: ['type'] },
)

/**
 * MCP `ToolAnnotations` 形状(规范 2025-03-26)。所有字段可选。
 */
const arbAnnotations = fc.record(
  {
    title: fc.string({ maxLength: 40 }),
    readOnlyHint: fc.boolean(),
    destructiveHint: fc.boolean(),
    idempotentHint: fc.boolean(),
    openWorldHint: fc.boolean(),
  },
  { requiredKeys: [] },
)

/**
 * MCP_Tool_Descriptor —— 单个 tool 的 server 侧描述形状。
 *
 *   - `name` 使用 `arbUnicodeString` 的非空子集,覆盖消毒/截断/去重路径
 *     (namespace.js)。
 *   - `description` 可选。
 *   - `inputSchema` 是一个对象,在 property 5 的引用相等断言中被作为同一对象
 *     传递。
 *   - `annotations` 可选。
 *
 * Supports: Properties 4, 5, 6, 8, 16
 */
export const arbToolDescriptor = fc.record(
  {
    name: fc.oneof(
      fc.string({ minLength: 1, maxLength: 40 }),
      fc.string({ unit: 'grapheme', minLength: 1, maxLength: 12 }),
    ),
    description: fc.string({ maxLength: 80 }),
    inputSchema: arbJsonSchema,
    annotations: arbAnnotations,
  },
  { requiredKeys: ['name', 'inputSchema'] },
)

// ---------------------------------------------------------------------------
// CallToolResult / Content_Part 生成器 (Property 10, 11)
// ---------------------------------------------------------------------------

/**
 * base64-ish 字符串 —— 用作 image / audio `data` 字段。归一化时 `data` 并不
 * 出现在占位符里(Req 6.7 只要求 mimeType),所以真实 base64 语法正确性不
 * 重要,随机 ASCII 即可。
 */
const arbBase64Data = fc.base64String({ minLength: 0, maxLength: 64 })

/**
 * mimeType —— 以"/"分隔的两段 ASCII,覆盖一些常见 MIME 形态。
 */
const arbMimeType = fc.oneof(
  fc.constantFrom(
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'audio/wav',
    'audio/mpeg',
    'application/octet-stream',
    'text/plain',
  ),
  fc.tuple(
    fc.string({ minLength: 1, maxLength: 16 }),
    fc.string({ minLength: 1, maxLength: 16 }),
  ).map(([a, b]) => `${a}/${b}`),
)

/**
 * URI —— 覆盖 http(s) / file / 自定义 scheme,归一化占位符只要求出现
 * `uri=<value>`,因此任意非空字符串都是合法输入。
 */
const arbUri = fc.oneof(
  fc.webUrl(),
  fc.string({ minLength: 1, maxLength: 64 }).map(s => `file://${s}`),
  fc.string({ minLength: 1, maxLength: 64 }).map(s => `custom:${s}`),
)

/**
 * Content_Part: `{ type: 'text', text, annotations? }`
 */
const arbTextPart = fc.record(
  {
    type: fc.constant('text'),
    text: arbUnicodeString,
    annotations: fc.record({ priority: fc.option(fc.double({ min: 0, max: 1 })) }, { requiredKeys: [] }),
  },
  { requiredKeys: ['type', 'text'] },
)

/**
 * Content_Part: `{ type: 'image', data, mimeType, annotations? }`
 */
const arbImagePart = fc.record(
  {
    type: fc.constant('image'),
    data: arbBase64Data,
    mimeType: arbMimeType,
  },
  { requiredKeys: ['type', 'data', 'mimeType'] },
)

/**
 * Content_Part: `{ type: 'audio', data, mimeType, annotations? }`
 */
const arbAudioPart = fc.record(
  {
    type: fc.constant('audio'),
    data: arbBase64Data,
    mimeType: arbMimeType,
  },
  { requiredKeys: ['type', 'data', 'mimeType'] },
)

/**
 * Content_Part: `{ type: 'resource_link', uri, name?, description?, mimeType? }`
 */
const arbResourceLinkPart = fc.record(
  {
    type: fc.constant('resource_link'),
    uri: arbUri,
    name: fc.string({ maxLength: 40 }),
    description: fc.string({ maxLength: 60 }),
    mimeType: arbMimeType,
  },
  { requiredKeys: ['type', 'uri'] },
)

/**
 * Content_Part: `{ type: 'resource', resource: { uri, mimeType?, text?, blob? } }`
 */
const arbResourcePart = fc.record(
  {
    type: fc.constant('resource'),
    resource: fc.record(
      {
        uri: arbUri,
        mimeType: arbMimeType,
        text: fc.string({ maxLength: 80 }),
        blob: arbBase64Data,
      },
      { requiredKeys: ['uri'] },
    ),
  },
  { requiredKeys: ['type', 'resource'] },
)

/**
 * 单个 Content_Part —— 五种 `type` 之一,均匀覆盖。
 *
 * Supports: Property 11 (归一化五种分支)
 */
export const arbContentPart = fc.oneof(
  arbTextPart,
  arbImagePart,
  arbAudioPart,
  arbResourceLinkPart,
  arbResourcePart,
)

/**
 * Content_Part[] —— 允许空数组以覆盖 "缺失/空 content + structuredContent
 * fallback" 场景。
 *
 * Supports: Properties 10, 11
 */
export const arbContentParts = fc.array(arbContentPart, { maxLength: 8 })

/**
 * MCP_Call_Result —— 覆盖 design §Property 11 列出的全部五种归一化分支:
 *   - 纯 text (content 非空且全 text)
 *   - 含非 text 片段 (content 混合)
 *   - structuredContent fallback (content 缺失/空 + structuredContent 存在)
 *   - isError 前缀
 *   - 完全空 (content 缺失/空 且 structuredContent 缺失)
 *
 * Supports: Properties 10, 11
 */
export const arbCallToolResult = fc.record(
  {
    content: arbContentParts,
    isError: fc.boolean(),
    structuredContent: arbJsonObject,
  },
  // 所有字段均可选,生成器据此覆盖"完全空"/"只有 structuredContent" 等分支
  { requiredKeys: [] },
)

// ---------------------------------------------------------------------------
// Secret 生成器 (Property 14)
// ---------------------------------------------------------------------------

/**
 * 保留词集合 —— 若 `arbSecret` 生成的字符串恰好等于其中某个词,Property 14
 * 的 `!err.message.includes(secret)` 断言可能因该词在标准错误 message
 * 模板里自然出现而误报。排除这些词后,剩余字符串空间的任何元素都不可能是
 * 错误 message 内"由代码发出"的子串,保证 Property 14 语义精准。
 *
 * 注意: 本集合只需覆盖"长度 ≥8 且可能在 message 中自然出现"的词。短词
 * (< 8 字符)不会被 `minLength: 8` 生成出来,无需在这里排除。
 */
const RESERVED_WORDS = new Set([
  'Authorization',
  'initialize',
  'initialized',
  'UnsupportedTransportError',
  'MCPClosedError',
  'MCPRequestError',
  'MCPProtocolError',
  'protocol_version_mismatch',
  'initialize_timeout',
  'malformed_frame',
  'malformed_response',
  'notifications',
  'streamable-http',
  'tools/list',
  'tools/call',
])

/**
 * 随机 secret 字符串 —— 长度 ≥8,排除保留词。
 *
 * 实现细节:
 *   - 使用 ASCII 字符串作为 base(避免 Unicode 在日志/测试 diff 中的噪声);
 *     Property 14 关注"字符串是否出现在 error.message"里,字符集不影响
 *     语义。
 *   - `.filter` 移除命中保留词的样本。fast-check 在 filter 上会自动重试
 *     (默认最多 10 次),实际命中极低概率,性能影响可忽略。
 *
 * Supports: Property 14 (错误 message 不含敏感数据)
 */
export const arbSecret = fc
  .string({ minLength: 8, maxLength: 64 })
  .filter(s => !RESERVED_WORDS.has(s))

// ---------------------------------------------------------------------------
// Agent 动态工具加载生成器 (runtime-dynamic-mcp-loading — Property 1..16)
// ---------------------------------------------------------------------------
//
// 以下生成器/工厂服务于 `runtime-dynamic-mcp-loading` Feature 的属性测试,
// 覆盖 Tool_Registry 增删/覆盖/快照、每轮工具派生、Base_Tool 协同、
// onToolsChanged 集合替换、生命周期拆除等不变式。
//
// 复用既有 `arbUnicodeString`(Unicode 工具名覆盖)与 `arbToolDescriptor`
// (server 侧 descriptor 形状),不从零实现框架。
//
// @see design.md §Testing Strategy → "关键生成器(fast-check arbitraries)"
// @see design.md §Data Models → Tool_Def / ManagedEntry

/**
 * 工具名生成器 —— 非空字符串(覆盖 ASCII / grapheme),供 `arbToolDef.name`
 * 与 `arbIntentResult.filteredToolNames` 共用。
 *
 * 既要覆盖宽字符(Unicode 工具名经命名空间消毒后的边界),又要保证非空
 * (Tool_Def 的 `name` 校验要求非空字符串),因此对 `arbUnicodeString` 做
 * `.filter(s => s.length > 0)` 而非直接复用(后者含空串分支)。
 *
 * Supports: Properties 1, 2, 4, 5, 9, 10, 14
 */
export const arbToolName = fc.oneof(
  fc.string({ minLength: 1, maxLength: 40 }),
  fc.string({ unit: 'grapheme', minLength: 1, maxLength: 12 }),
  arbUnicodeString.filter(s => s.length > 0),
)

/**
 * Tool_Def 生成器 —— 与 `Agent` 工具格式兼容的合法工具定义。
 *
 * 形状(见 design §Data Models / src/tool.js `ToolDef`):
 *   - `name`        : 非空字符串(`arbToolName`),Tool_Registry 的唯一键。
 *   - `description` : 任意字符串(可空)。
 *   - `parameters`  : JSON Schema 对象 —— 直接复用 `arbToolDescriptor` 生成的
 *                     `inputSchema`,保证是合法 object schema。
 *   - `execute`     : 简单 async 函数,回显工具名与入参,便于断言"该轮 LLM
 *                     选中此工具时能在 toolMap 按名查到并派发执行"。
 *
 * 实现复用 `arbToolDescriptor`(取其 `inputSchema` 作 parameters),再用
 * `.map` 附加 `execute` 闭包 —— 满足"复用既有 arbToolDescriptor"的要求,
 * 同时让每个 Tool_Def 携带可执行的 execute。
 *
 * Supports: Properties 1, 2, 3, 4, 5, 6, 9, 10, 14, 16
 */
export const arbToolDef = fc
  .tuple(arbToolName, arbToolDescriptor)
  .map(([name, descriptor]) => ({
    name,
    description: descriptor.description ?? '',
    parameters: descriptor.inputSchema,
    execute: async (args) => `mock-tool-result:${name}:${JSON.stringify(args ?? null)}`,
  }))

/**
 * Tool_Def 数组生成器 —— 长度 0..N。注意此处**不**保证工具名唯一,刻意保留
 * 重名样本以覆盖 Tool_Registry 的同名覆盖路径(Property 2)。
 *
 * Supports: Properties 1, 2, 3, 5, 6
 */
export const arbToolDefList = fc.array(arbToolDef, { maxLength: 12 })

/**
 * 工具名唯一的 Tool_Def 数组 —— 适用于需要"加入顺序 = 可见顺序且无覆盖"
 * 的断言(Property 1)。通过对生成结果按 `name` 去重(保留首次出现)实现。
 *
 * Supports: Property 1
 */
export const arbUniqueToolDefList = arbToolDefList.map((tools) => {
  const seen = new Set()
  const unique = []
  for (const t of tools) {
    if (seen.has(t.name)) continue
    seen.add(t.name)
    unique.push(t)
  }
  return unique
})

/**
 * IntentResult 生成器 —— 意图识别结果形状(见 intent-recognizer.js
 * `IntentResult`)。属性测试主要关心 `filteredToolNames`(驱动 `ToolFilter`
 * 过滤),其余字段按枚举随机以覆盖完整形状。
 *
 *   - `clarity`             : 'CLEAR' | 'AMBIGUOUS'
 *   - `complexity`          : 'SIMPLE' | 'COMPLEX'
 *   - `recommendedStrategy` : 'react' | 'plan_and_execute'
 *   - `reasoning`           : 任意短字符串
 *   - `filteredToolNames`   : 随机工具名数组(可空 → 触发 ToolFilter 的"回退
 *                             全量"分支)
 *
 * Supports: Properties 5, 10
 */
export const arbIntentResult = fc.record({
  clarity: fc.constantFrom('CLEAR', 'AMBIGUOUS'),
  complexity: fc.constantFrom('SIMPLE', 'COMPLEX'),
  recommendedStrategy: fc.constantFrom('react', 'plan_and_execute'),
  reasoning: fc.string({ maxLength: 60 }),
  filteredToolNames: fc.array(arbToolName, { maxLength: 8 }),
})

// ---------------------------------------------------------------------------
// mock MCP_Client (Property 7, 12, 13, 14, 15)
// ---------------------------------------------------------------------------

/**
 * mock MCP_Client 的 `close()` 行为枚举:
 *   - 'normal' : `close()` 立即 resolve。
 *   - 'throw'  : `close()` reject 一个 Error(覆盖拆除错误隔离,Property 12)。
 *   - 'hang'   : `close()` 返回永不 settle 的 Promise(覆盖 5s 超时竞速,
 *                Property 12 / Req 5.4)。
 *
 * @typedef {'normal' | 'throw' | 'hang'} MockCloseBehavior
 */

/**
 * 构造一个 mock `MCP_Client` —— 仅实现 `Agent` 动态加载路径实际消费的表面
 * (`listTools` / `close`),不依赖真实 transport / JSON-RPC 通道。
 *
 * @param {object} [config]
 * @param {object[]} [config.tools=[]]          `listTools()` resolve 的 Tool_Def 数组
 * @param {MockCloseBehavior} [config.closeBehavior='normal'] `close()` 行为
 * @param {Error} [config.closeError]           `closeBehavior==='throw'` 时 reject 的错误
 * @param {boolean} [config.listToolsThrows=false] 为 true 时 `listTools()` reject
 * @param {Error} [config.listToolsError]        `listToolsThrows` 时 reject 的错误
 * @returns {{
 *   listTools: () => Promise<object[]>,
 *   close: () => Promise<void>,
 *   listToolsCalls: number,
 *   closeCalls: number,
 *   closeBehavior: MockCloseBehavior,
 * }}
 */
export function makeMockMCPClient({
  tools = [],
  closeBehavior = 'normal',
  closeError,
  listToolsThrows = false,
  listToolsError,
} = {}) {
  const client = {
    listToolsCalls: 0,
    closeCalls: 0,
    closeBehavior,
    listTools() {
      client.listToolsCalls += 1
      if (listToolsThrows) {
        return Promise.reject(listToolsError ?? new Error('mock listTools failed'))
      }
      return Promise.resolve(tools)
    },
    close() {
      client.closeCalls += 1
      if (closeBehavior === 'throw') {
        return Promise.reject(closeError ?? new Error('mock close failed'))
      }
      if (closeBehavior === 'hang') {
        // 永不 settle —— 调用方应以超时竞速(withTimeout)收敛。
        return new Promise(() => {})
      }
      return Promise.resolve()
    },
  }
  return client
}

/**
 * mock MCP_Client 生成器 —— 随机 `listTools` 返回与随机 `close` 行为。
 *
 * 用于属性测试中批量生成"被 `Agent` 管理的客户端集合",覆盖正常/抛错/挂起
 * 三种关闭路径混合时的拆除错误隔离(Property 12)与集合替换(Property 13)。
 *
 * Supports: Properties 7, 12, 13, 14, 15
 */
export const arbMockMCPClient = fc
  .record({
    tools: fc.array(arbToolDef, { maxLength: 6 }),
    closeBehavior: fc.constantFrom('normal', 'throw', 'hang'),
  })
  .map(cfg => makeMockMCPClient(cfg))
