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

let ENVELOPE_SEQ = 0

/**
 * 生成 `env_` + 8 位十六进制的进程内唯一信封 id。
 *
 * **纯单调计数器，不用 `Date.now()`。** 时间戳作 id 时同一毫秒内发出的两封信会
 * 拿到同一个 id —— 而 `a2a.delivered` 事件与将来的 `correlationId` 配对全靠它，
 * 撞号会让"哪封信收到了哪个回答"变成猜的（`registry.js` 的 `newAgentId` 出于
 * 同一理由也是纯计数器）。
 */
export function newEnvelopeId() {
  ENVELOPE_SEQ = (ENVELOPE_SEQ + 1) >>> 0
  return `env_${ENVELOPE_SEQ.toString(16).padStart(8, '0')}`
}

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
  // `to.agentId` 是 Mailbox 的收件箱键。缺了它的帧不能放过 —— 那会投进一个键为
  // undefined 的收件箱，投递看起来成功，收件人永远读不到。
  if (typeof params.to.agentId !== 'string' || params.to.agentId === '') {
    throw new A2AError('malformed A2A frame: params.to.agentId must be a non-empty string', { kind: 'malformed_frame' })
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
