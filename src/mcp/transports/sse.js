/**
 * MCP legacy SSE Transport — 老式 Server-Sent Events 双端点 transport.
 *
 * 相对 `streamable-http` (§12) 的单端点语义,legacy SSE 使用一**对**端点:
 *   - `GET <url>`:server → client 单向 SSE 流(握手时经
 *     `event: endpoint\ndata: <relative_or_absolute_post_url>` 告知 POST
 *     端点);其余以 `event: message` 或缺省事件名下发 JSON-RPC 帧。
 *   - `POST <endpoint>`:client → server 的 JSON-RPC 请求 / 通知,单次一条,
 *     期望 server 响应 `202 Accepted` 立刻返回,真实响应由上面的 SSE 流
 *     异步回传。
 *
 * 该传输在当前 MCP 规范中已被 Streamable HTTP 取代,但社区存量 server 仍
 * 在用;本框架将其作为一等公民内置以最大化兼容面。
 *
 * ## 自注册
 *
 * 模块加载时调用 `_setBuiltinTransport('sse', sseFactory)` 把自己挂到内置
 * 注册表。`createMCPClient` 在需要时 `await import('./sse.js')` 懒加载,
 * 与注册无冲突(见 `./index.js` 头注释)。
 *
 * ## 端点解析与 fallback
 *
 * 为避免 send() 在 `event: endpoint` 之前被调用时拿到 undefined,工厂在构
 * 造时先把 `endpointUrl` 初始化为 `url + '/messages'`(保守 fallback);若
 * server 随后发来更具体的 `event: endpoint` 帧,则用其值覆盖。server 发
 * 送 endpoint 的 `data` 可以是绝对 URL 或相对 URL,后者按 `new URL(data, url)`
 * 解析。
 *
 * ## 错误分类
 *
 * - GET 连接失败(DNS / 网络 / HTTP !ok)→ `onError({ kind: 'transport_error', cause })`
 *   并立即 `fireClose`。
 * - POST 失败(非 2xx / 网络错误)→ 抛出给 `send()` 的调用方,同时发一次
 *   `onError({ kind: 'transport_error', cause })` + `fireClose`,让 client 侧
 *   pending 请求全部以 `MCPClosedError` reject。
 * - SSE data 解码失败 → `onError({ kind: 'malformed_frame', cause })`,不关闭
 *   连接(对齐 Req 2.5)。
 * - AbortError(来自 close() 主动 abort)→ 静默吞掉,不升级为 transport_error。
 *
 * @see Requirements 1.4, 2.6, 7.5
 */

import { codec } from '../codec.js'
import { _setBuiltinTransport } from './index.js'
import { createSseParser } from './sse-parser.js'

/**
 * 合并两个 AbortSignal — 返回的新 signal 在任一上游 abort 时同步 abort.
 *
 * Node 18+ 有 `AbortSignal.any(...)`,但为兼容更老的语义与测试环境(fast-check
 * polyfill 等)我们手动实现。逻辑:
 *   - 任一入参为 undefined 则跳过。
 *   - 任一上游已 aborted → 返回的 signal 立即处于 aborted 状态。
 *   - 否则为每个上游挂 abort 监听,收到就转发。
 *   - 返回 `controller` 以便调用方自主 abort(关闭流程用)。
 *
 * @param {AbortSignal | undefined} a
 * @param {AbortSignal | undefined} b
 * @returns {AbortController}
 */
function combineSignals(a, b) {
  const controller = new AbortController()
  const signals = [a, b].filter((s) => s && typeof s.addEventListener === 'function')
  for (const s of signals) {
    if (s.aborted) {
      try { controller.abort(s.reason) } catch { controller.abort() }
      return controller
    }
  }
  for (const s of signals) {
    const forward = () => {
      try { controller.abort(s.reason) } catch { controller.abort() }
    }
    try { s.addEventListener('abort', forward, { once: true }) } catch {
      // 非标准 AbortSignal 实现:放弃转发,调用方仍可通过 controller 直接 abort.
    }
  }
  return controller
}

/**
 * 把 server 发来的 endpoint 值(可能相对也可能绝对)解析为绝对 URL 字符串.
 *
 * 允许两种形态:
 *   - 绝对 URL(含 scheme):直接采纳.
 *   - 相对路径(如 `/messages` 或 `messages`):按 base URL 相对解析,继承
 *     base 的 origin.
 *
 * 解析失败(非法 URL 字符)回退到默认 fallback,保持 send() 可用.
 *
 * @param {string} baseUrl   GET 所用的 SSE 端点绝对 URL
 * @param {string} endpointValue  server 发来的 endpoint 原文
 * @param {string} fallback  解析失败时的兜底
 * @returns {string}  绝对 URL 字符串
 */
function resolveEndpointUrl(baseUrl, endpointValue, fallback) {
  if (typeof endpointValue !== 'string' || endpointValue.length === 0) return fallback
  // 尝试当绝对 URL 解析.
  try {
    return new URL(endpointValue).href
  } catch {
    // 继续尝试相对解析
  }
  try {
    return new URL(endpointValue, baseUrl).href
  } catch {
    return fallback
  }
}

/**
 * 构造默认 POST endpoint fallback: `baseUrl + '/messages'`.
 * 处理 baseUrl 是否以 `/` 结尾,避免 `//messages` 双斜杠.
 *
 * @param {string} baseUrl
 * @returns {string}
 */
function defaultMessagesEndpoint(baseUrl) {
  try {
    return new URL('messages', baseUrl.endsWith('/') ? baseUrl : baseUrl + '/').href
  } catch {
    // baseUrl 不合法?退回字符串拼接,后续 POST 会失败并由上层错误路径处理.
    return baseUrl + (baseUrl.endsWith('/') ? 'messages' : '/messages')
  }
}

/**
 * legacy SSE transport 工厂.
 *
 * 参数契约(对应 `CreateMCPClientOptions` 的 `transport: 'sse'` 分支):
 *   - `url: string` — SSE GET 端点(绝对 URL)
 *   - `headers?: Record<string,string>` — 用户自定义头(如 `Authorization`),
 *     会合并到 GET 与 POST 两次请求上
 *   - `signal?: AbortSignal` — 用户级取消信号
 *
 * 返回对象满足 `MCP_Transport` 契约:
 *   - `send(msg)`:POST JSON 至 endpoint;202 / 任何 2xx 视为成功;非 2xx 抛错并关闭.
 *   - `onMessage / onError / onClose`:注册回调,每类最多一次.
 *   - `close()`:幂等;abort 底层 fetch reader 并触发 onClose.
 *
 * @param {object} options
 * @returns {{
 *   send: (msg: object) => Promise<void>,
 *   onMessage: (cb: (msg: object) => void) => void,
 *   onError: (cb: (err: { kind: string, cause?: unknown }) => void) => void,
 *   onClose: (cb: (reason?: object) => void) => void,
 *   close: () => Promise<void>,
 * }}
 */
export function sseFactory(options) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('sseFactory: options must be an object')
  }
  if (typeof options.url !== 'string' || options.url.length === 0) {
    throw new TypeError('sseFactory: options.url must be a non-empty string')
  }

  const baseUrl = options.url
  const userHeaders = (options.headers && typeof options.headers === 'object')
    ? options.headers
    : null

  /** 用于主动 abort 底层 fetch / reader 的 controller. close() 时触发. */
  const abortController = new AbortController()
  /** 合并用户 signal 与自身 controller,供 fetch 使用. */
  const mergedController = combineSignals(options.signal, abortController.signal)

  /** @type {null | ((msg: object) => void)} */
  let onMessageCb = null
  /** @type {null | ((err: { kind: string, cause?: unknown }) => void)} */
  let onErrorCb = null
  /** @type {null | ((reason?: object) => void)} */
  let onCloseCb = null

  /** close() 后置位;防止 fireClose 重入、send 再发起. */
  let closed = false
  /** 已触发的 onClose reason 缓存,供"晚绑定的 onClose"同步回放. */
  let closeReason = null
  /** close() 幂等 Promise. */
  let closePromise = null

  /** POST endpoint:保守 fallback 初始化,server 发 endpoint 事件后覆盖. */
  let endpointUrl = defaultMessagesEndpoint(baseUrl)
  /** 标志位:是否收到过显式 endpoint 事件(调试/观察用,非必需). */
  let endpointAnnounced = false

  /** SSE 解析器实例;close() 时需要调用它的 close() 让 events 迭代结束. */
  const parser = createSseParser()

  /**
   * 触发一次 onClose(最多一次). 用 try/catch 包住回调异常,避免 transport
   * 内部因用户代码 bug 崩溃.
   *
   * @param {object} [reason]
   */
  function fireClose(reason) {
    if (closed) return
    closed = true
    closeReason = reason ?? null
    // 通知 SSE 解析器停止,以便流消费循环能自然退出.
    try { parser.close() } catch { /* 已关闭 / 其他竞态 — 忽略 */ }
    if (onCloseCb) {
      try {
        onCloseCb(closeReason ?? undefined)
      } catch {
        // 吞掉回调内部错误以保护 transport 生命周期.
      }
    }
  }

  /**
   * 触发 onError(不自动 fireClose,调用方按需决定).
   *
   * @param {{ kind: string, cause?: unknown }} err
   */
  function fireError(err) {
    if (onErrorCb) {
      try { onErrorCb(err) } catch { /* 吞掉 */ }
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // GET SSE 流消费循环
  // ─────────────────────────────────────────────────────────────────────

  // 异步启动,避免构造函数本身 async.
  ;(async () => {
    let response
    try {
      const getHeaders = {
        ...(userHeaders ?? {}),
        Accept: 'text/event-stream',
      }
      response = await fetch(baseUrl, {
        method: 'GET',
        headers: getHeaders,
        signal: mergedController.signal,
      })
    } catch (err) {
      // AbortError 来自主动 close() 或用户 signal — 静默退出,fireClose 由
      // close() / 上游 signal 路径单独处理.
      if (err && err.name === 'AbortError') return
      fireError({ kind: 'transport_error', cause: err })
      fireClose({ kind: 'transport_error', cause: err })
      return
    }

    if (!response.ok) {
      const err = new Error(`sse transport: HTTP ${response.status} ${response.statusText}`)
      fireError({ kind: 'transport_error', cause: err })
      fireClose({ kind: 'transport_error', cause: err })
      return
    }
    if (!response.body) {
      const err = new Error('sse transport: response has no body')
      fireError({ kind: 'transport_error', cause: err })
      fireClose({ kind: 'transport_error', cause: err })
      return
    }

    // 同时启动两条 pump:
    //   1. pumpStream: 从 response.body reader 读字节 → push 给 parser.
    //   2. dispatchEvents: 从 parser.events 异步迭代取事件 → 派发.
    // 两者通过 parser 内部队列协作;任一异常都应该触发 fireClose.

    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8')

    const pumpStream = (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          parser.push(decoder.decode(value, { stream: true }))
        }
        // 收尾:把 decoder 内部可能残留的字节 flush 进 parser.
        parser.push(decoder.decode())
      } catch (err) {
        if (err && err.name === 'AbortError') return
        // 读取异常 — 转 transport_error. 不在此处直接 fireClose,留给
        // 外层"两个 pump 都 settle 后"的收敛分支统一处理.
        fireError({ kind: 'transport_error', cause: err })
        throw err
      } finally {
        // 无论正常 / 异常,都让 parser 关闭以便 events 迭代终止.
        try { parser.close() } catch { /* 忽略 */ }
      }
    })()

    const dispatchEvents = (async () => {
      for await (const evt of parser.events) {
        // 控制帧:server 首次握手时告知 POST endpoint.
        if (evt.event === 'endpoint') {
          endpointUrl = resolveEndpointUrl(baseUrl, evt.data, endpointUrl)
          endpointAnnounced = true
          continue
        }
        // 数据帧:`event: message` 或缺省(无 event 字段)都视为 JSON-RPC 消息.
        // 其他 event 类型(未来规范扩展 / server 自定义)静默忽略,不报错.
        if (evt.event !== undefined && evt.event !== 'message') continue

        let msg
        try {
          msg = codec.decodeLine(evt.data)
        } catch (err) {
          // malformed_frame 不关闭连接(Req 2.5 拓展到 SSE).
          fireError({ kind: 'malformed_frame', cause: err })
          continue
        }
        if (onMessageCb) {
          try { onMessageCb(msg) } catch { /* 吞掉用户回调异常 */ }
        }
      }
    })()

    // 等两条 pump 都 settle. pumpStream 是真正的错误源(reader 抛),
    // dispatchEvents 基本只会自然退出(parser.close() 后).
    try {
      await Promise.all([pumpStream, dispatchEvents])
      // 流自然结束 — 非主动关闭. 按 Req 7.5 归类为 transport_error
      // (远端单方断开),以便 client 把所有 pending 以 MCPClosedError 拒.
      if (!closed) {
        fireClose({ kind: 'transport_error', cause: new Error('sse transport: stream ended') })
      }
    } catch {
      // 已经在 pumpStream 的 catch 里 fireError 过一次,这里只需收敛关闭.
      if (!closed) {
        fireClose({ kind: 'transport_error' })
      }
    }
  })()

  // ─────────────────────────────────────────────────────────────────────
  // 公共方法
  // ─────────────────────────────────────────────────────────────────────

  /**
   * POST 一条 JSON-RPC 消息到 endpointUrl.
   *
   * 期望 server 回 `202 Accepted`(或任何 2xx);响应 body 不被解析 — 真实
   * JSON-RPC 响应由 SSE 流异步回传。非 2xx 视为 transport_error:抛给
   * 调用方并同时触发 onError + fireClose,让 client 层统一收敛所有 pending.
   *
   * @param {object} msg
   * @returns {Promise<void>}
   */
  async function send(msg) {
    if (closed) {
      throw new Error('sse transport: closed')
    }
    // 形状断言 + 单行 JSON 输出.
    const body = codec.encode(msg)
    const postHeaders = {
      ...(userHeaders ?? {}),
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    }

    let response
    try {
      response = await fetch(endpointUrl, {
        method: 'POST',
        headers: postHeaders,
        body,
        signal: mergedController.signal,
      })
    } catch (err) {
      // AbortError 通常意味着 close() 已触发,不再升级为 transport_error.
      if (err && err.name === 'AbortError') {
        throw err
      }
      fireError({ kind: 'transport_error', cause: err })
      fireClose({ kind: 'transport_error', cause: err })
      throw err
    }

    if (!response.ok) {
      const err = new Error(
        `sse transport: POST failed with HTTP ${response.status} ${response.statusText}`
      )
      fireError({ kind: 'transport_error', cause: err })
      fireClose({ kind: 'transport_error', cause: err })
      throw err
    }
    // 消费并丢弃响应 body,避免 keep-alive 连接被挂住.
    // node-fetch / undici 不强制要求,但显式 drain 更稳妥.
    try {
      if (typeof response.arrayBuffer === 'function') {
        await response.arrayBuffer()
      }
    } catch {
      // body 读取失败无关紧要 — 2xx 已经是成功信号.
    }
  }

  function onMessage(cb) {
    if (typeof cb !== 'function') {
      throw new TypeError('sse transport: onMessage callback must be a function')
    }
    onMessageCb = cb
  }

  function onError(cb) {
    if (typeof cb !== 'function') {
      throw new TypeError('sse transport: onError callback must be a function')
    }
    onErrorCb = cb
  }

  function onClose(cb) {
    if (typeof cb !== 'function') {
      throw new TypeError('sse transport: onClose callback must be a function')
    }
    onCloseCb = cb
    // 若已关闭,microtask 内回放一次终态,避免丢失(与 stdio.js 一致).
    if (closed) {
      const reason = closeReason
      queueMicrotask(() => {
        try { cb(reason ?? undefined) } catch { /* 吞掉 */ }
      })
    }
  }

  /**
   * 幂等关闭. 首次调用:abort 底层 fetch/reader → parser.close() →
   * fireClose(client-initiated). 再次调用直接返回同一 promise.
   *
   * @returns {Promise<void>}
   */
  function close() {
    if (closePromise) return closePromise
    closePromise = (async () => {
      if (closed) return
      // 主动 abort:唤醒 GET reader 的 pending read / POST in-flight.
      try { abortController.abort() } catch { /* 已 abort — 忽略 */ }
      // fireClose 同步置位 closed 并通知消费者. 若 GET 循环还没进到 fireClose
      // 分支,这里兜底一次;若已经进去,fireClose 自身是幂等的.
      fireClose({ reason: 'client-initiated' })
    })()
    return closePromise
  }

  return { send, onMessage, onError, onClose, close }
}

// 自注册到内置 transport 注册表. 必须在模块加载时同步完成,以便
// `await import('./sse.js')` 触发后 `resolveTransport('sse')` 立即可用.
_setBuiltinTransport('sse', sseFactory)
