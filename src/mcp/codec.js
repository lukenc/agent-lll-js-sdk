/**
 * JsonRpcCodec — JSON-RPC 2.0 编解码器
 *
 * 为 MCP Client 提供统一的 JSON-RPC 帧编解码能力,所有 transport(stdio / http /
 * sse / 自定义)通过这一层把 `JsonRpcMessage` 对象与字符串互转。
 *
 * 设计要点(见 design.md §Components `JsonRpcCodec`):
 *   - `encode(msg)` 使用原生 `JSON.stringify`,在返回前断言 `jsonrpc === '2.0'`
 *     与"至少一个业务字段(`method` 或 `result` 或 `error`)"存在。`JSON.stringify`
 *     默认会把字符串中的 `\n` / `\r` 转义为 `\\n` / `\\r`,因此输出字符串天然
 *     不含裸换行,可直接作为 stdio 行帧或 SSE `data:` 字段载荷使用。
 *   - `decodeLine(line)` 使用原生 `JSON.parse`,随后做**最小**形状校验(必须是
 *     非空对象且含 `jsonrpc` 字段);任何解析失败或形状违反都抛
 *     `MCPProtocolError({ kind: 'malformed_frame' })`。错误 `message` **不**
 *     包含原始 `line` 内容(Req 10.5),以避免日志里泄露潜在敏感 payload。
 *
 * 模块对外同时暴露类 `JsonRpcCodec` 与其单例 `codec`,既方便直接 `codec.encode(msg)`
 * 调用,也允许测试按需 `new JsonRpcCodec()` 以隔离状态(当前实现无实例状态)。
 *
 * @see Requirements 2.1, 2.2, 2.3, 2.5, 10.5
 */

import { MCPProtocolError } from './errors.js'

const JSON_RPC_VERSION = '2.0'

/**
 * JSON-RPC 2.0 编解码器。当前实现无实例状态,所有方法均可改写为静态函数;
 * 保留类封装是为了在 design 的"单例 codec"与"可构造的 JsonRpcCodec"两条
 * API 风格间共享同一份实现。
 */
export class JsonRpcCodec {
  /**
   * 将一条 JsonRpcMessage 编码为单行 JSON 字符串。
   *
   * 断言:
   *   - `message` 是非 null 对象
   *   - `message.jsonrpc === '2.0'`
   *   - 含至少一个业务字段(request 的 `method` / response 的 `result` 或 `error` /
   *     notification 的 `method`)
   *
   * 断言失败抛 `MCPProtocolError({ kind: 'malformed_frame' })` —— 虽然这是
   * client 侧的编码错误,但与 decode 侧共享同一错误类型便于 transport 统一
   * 处理;`detail.phase` 区分 `'encode'` vs `'decode'`。
   *
   * @param {object} message
   * @returns {string}  单行 JSON 字符串,保证不含 `\n` / `\r`
   */
  encode(message) {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      throw new MCPProtocolError(
        'JsonRpcCodec.encode: message must be a non-null object',
        { kind: 'malformed_frame', detail: { phase: 'encode', reason: 'not_object' } }
      )
    }
    if (message.jsonrpc !== JSON_RPC_VERSION) {
      throw new MCPProtocolError(
        `JsonRpcCodec.encode: expected jsonrpc === "${JSON_RPC_VERSION}"`,
        { kind: 'malformed_frame', detail: { phase: 'encode', reason: 'bad_jsonrpc' } }
      )
    }
    const hasMethod = typeof message.method === 'string'
    const hasResult = Object.prototype.hasOwnProperty.call(message, 'result')
    const hasError = Object.prototype.hasOwnProperty.call(message, 'error')
    if (!hasMethod && !hasResult && !hasError) {
      throw new MCPProtocolError(
        'JsonRpcCodec.encode: message must have "method", "result", or "error"',
        { kind: 'malformed_frame', detail: { phase: 'encode', reason: 'missing_body_field' } }
      )
    }

    // JSON.stringify 默认把字符串内的 \n / \r 转义为 \\n / \\r,因此输出
    // 字符串天然是单行;不需要额外 replace 处理。此处仍做一次防御性断言,
    // 防止 future Node 版本对某些 exotic 对象 toJSON 返回含裸换行的输出。
    const encoded = JSON.stringify(message)
    if (typeof encoded !== 'string') {
      throw new MCPProtocolError(
        'JsonRpcCodec.encode: JSON.stringify returned non-string',
        { kind: 'malformed_frame', detail: { phase: 'encode', reason: 'stringify_failed' } }
      )
    }
    if (encoded.indexOf('\n') !== -1 || encoded.indexOf('\r') !== -1) {
      throw new MCPProtocolError(
        'JsonRpcCodec.encode: encoded payload unexpectedly contains newline characters',
        { kind: 'malformed_frame', detail: { phase: 'encode', reason: 'newline_in_output' } }
      )
    }
    return encoded
  }

  /**
   * 将单行 JSON 字符串解码为 JsonRpcMessage。
   *
   * 校验流程:
   *   1. `JSON.parse(line)` —— 任何 parse 错误直接抛 `malformed_frame`
   *   2. 结果是非 null 对象且不是数组(JSON-RPC 2.0 不在此处支持 batch,
   *      实际 MCP 规范也不使用 batch)
   *   3. 有 `jsonrpc` 字段(允许值不等于 `'2.0'`,仅基本形状校验;严格版本
   *      匹配留给 `MCP_Client._performHandshake` 做业务判定)
   *
   * 出错时 `MCPProtocolError.message` **不**包含 `line` 的值,仅给出发生
   * 阶段与原因(Req 10.5)。原始错误以 `cause` 字段保留,调用方在调试时
   * 可自行 inspect。
   *
   * @param {string} line
   * @returns {object}
   */
  decodeLine(line) {
    if (typeof line !== 'string') {
      throw new MCPProtocolError(
        'JsonRpcCodec.decodeLine: input must be a string',
        { kind: 'malformed_frame', detail: { phase: 'decode', reason: 'not_string' } }
      )
    }

    let parsed
    try {
      parsed = JSON.parse(line)
    } catch (cause) {
      // 不把原始 line 放进 message — 避免日志里泄露 payload
      throw new MCPProtocolError(
        'JsonRpcCodec.decodeLine: invalid JSON',
        { kind: 'malformed_frame', detail: { phase: 'decode', reason: 'invalid_json', cause } }
      )
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new MCPProtocolError(
        'JsonRpcCodec.decodeLine: parsed value is not a JSON-RPC object',
        { kind: 'malformed_frame', detail: { phase: 'decode', reason: 'not_object' } }
      )
    }

    if (!Object.prototype.hasOwnProperty.call(parsed, 'jsonrpc')) {
      throw new MCPProtocolError(
        'JsonRpcCodec.decodeLine: missing "jsonrpc" field',
        { kind: 'malformed_frame', detail: { phase: 'decode', reason: 'missing_jsonrpc' } }
      )
    }

    return parsed
  }
}

/**
 * 默认共享单例 —— transport 与 client 均通过此实例编解码。
 */
export const codec = new JsonRpcCodec()
