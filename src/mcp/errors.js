/**
 * MCP 错误类 — MCP Client Integration 的分层错误类型
 *
 * 导出顺序按 tasks.md §1.1 固定:
 *   UnsupportedTransportError → MCPClosedError → MCPRequestError → MCPProtocolError
 *
 * 所有错误实例的 `err.message` 都是人类可读的简短描述,不含 API Key、
 * `options.headers.Authorization` 值、`options.env` 值、或原始 JSON-RPC
 * payload 二进制附件等敏感数据 (Requirement 10.5)。实现方式:
 *   - 错误构造函数只接收白名单字段(transport 名称、错误码、工具名、kind 等),
 *     不接收原始 options 对象。调用方必须自行避免把 headers / env 拼到
 *     message 或 detail 里。
 *   - `UnsupportedTransportError` 只读取 `requested` 和 `available` 两个
 *     白名单字段,不访问原始 options。
 *
 * @see Requirements 10.1, 10.2, 10.3, 10.4, 10.5
 */

/**
 * 未知/未注册的 transport 被传入 `createMCPClient` 时抛出。
 *
 * `message` 同时列出 `requested` 名称与当前所有已注册 transport 名称,便于
 * 调用方立刻定位配置错误。
 *
 * @see Requirement 1.6, 10.1
 */
export class UnsupportedTransportError extends Error {
  /**
   * @param {string} requested  调用方传入的 transport 名称
   * @param {string[]} available  当前已注册的所有 transport 名称(含内置 + 自定义)
   */
  constructor(requested, available) {
    const requestedStr = String(requested ?? '')
    const availableList = Array.isArray(available) ? available.map(String) : []
    const availableStr = availableList.length > 0 ? availableList.join(', ') : '(none)'
    super(
      `Unsupported MCP transport "${requestedStr}". ` +
      `Available transports: ${availableStr}.`
    )
    this.name = 'UnsupportedTransportError'
    this.requested = requestedStr
    this.available = availableList
  }
}

/**
 * MCP_Client 已关闭或正在关闭时,被调用的 API 或在途请求以此错误 reject。
 *
 * 触发场景(见 design §Error Handling):
 *   - 显式 `client.close()`
 *   - stdio 子进程退出 / HTTP / SSE 底层断开
 *   - `state === 'closed'` 时被调用 `listTools` / `refreshTools` / `execute`
 *
 * @see Requirements 7.2, 7.4, 7.5, 7.7, 10.2
 */
export class MCPClosedError extends Error {
  /**
   * @param {string} [message]  默认 "MCP client is closed"
   * @param {{ reason?: string, cause?: unknown }} [options]
   *   - `reason`: 关闭原因的简短字符串(如 `'transport_error'` / `'remote_exit'`)
   *   - `cause`: 原始底层错误,保留在 `err.cause` 上供调用方检查
   */
  constructor(message = 'MCP client is closed', options = {}) {
    super(message)
    this.name = 'MCPClosedError'
    if (options && options.reason !== undefined) this.reason = options.reason
    if (options && options.cause !== undefined) this.cause = options.cause
  }
}

/**
 * 向 MCP_Server 发起的请求失败 —— JSON-RPC error 响应 或 请求超时。
 *
 * `code` 取 JSON-RPC `error.code`;框架内对超时使用保留值 `-32000`。
 * `data` 透传 JSON-RPC `error.data` 字段(调用方要渲染给 UI 时需自行过滤)。
 * `toolName` 仅在 `tools/call` 失败时填充,等于 server 原始工具名(rawName)。
 *
 * @see Requirements 6.10, 6.11, 10.3
 */
export class MCPRequestError extends Error {
  /**
   * @param {string} message
   * @param {{ code: number, data?: unknown, toolName?: string }} [fields]
   */
  constructor(message, fields = {}) {
    super(message)
    this.name = 'MCPRequestError'
    this.code = typeof fields.code === 'number' ? fields.code : 0
    if (fields.data !== undefined) this.data = fields.data
    if (fields.toolName !== undefined) this.toolName = fields.toolName
  }
}

/**
 * MCP 协议层错误 —— 用于区分传输层之上、业务请求之外的协议违反场景。
 *
 * `kind` 枚举对应 design §Error Handling 中列出的所有分支:
 *   - `'protocol_version_mismatch'`  initialize 响应的 protocolVersion 不匹配
 *   - `'malformed_frame'`            收到的一行无法 JSON.parse
 *   - `'initialize_timeout'`         initialize 请求在 requestTimeoutMs 内无响应
 *   - `'malformed_response'`         分页合并时发现响应结构违反不变式
 *   - `'initialize_error'`           initialize 响应是 JSON-RPC error(而非 result)
 *
 * `detail` 可选,承载诊断上下文(如 `{ expected, actual }`)。不应包含敏感数据。
 *
 * @see Requirements 2.5, 3.3, 3.5, 10.4
 */
export class MCPProtocolError extends Error {
  /**
   * @param {string} message
   * @param {{ kind: 'protocol_version_mismatch' | 'malformed_frame' | 'initialize_timeout' | 'malformed_response' | 'initialize_error', detail?: object }} [fields]
   */
  constructor(message, fields = {}) {
    super(message)
    this.name = 'MCPProtocolError'
    this.kind = fields.kind
    if (fields.detail !== undefined) this.detail = fields.detail
  }
}
