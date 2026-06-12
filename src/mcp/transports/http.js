/**
 * MCP Streamable HTTP Transport — 单端点 POST + 可选 SSE 响应流的传输。
 *
 * 对齐 MCP 2025-03-26 规范定义的 "streamable-http":每一次 client → server
 * 的消息都是一次独立的 `POST <url>`,body 是单条 JSON-RPC 消息;server 的
 * 响应有两种合法形态:
 *
 *   1. `Content-Type: application/json` —— 响应 body 是一条 JSON-RPC 消息
 *      (通常是 request 的 response),读取完整 body 后当作一条入站消息
 *      `onMessage` 一次。
 *   2. `Content-Type: text/event-stream` —— 响应 body 是 SSE 流,每个 event
 *      的 `data:` 字段是一条 JSON-RPC 消息。流可能承载:(a) 对本次 POST 的
 *      response;(b) server 主动发起的 request / notification(借本次流下行)。
 *      逐条解码后 `onMessage`,流结束 transport 继续等待下一次 send()。
 *
 *   3. 其他响应(如 `202 Accepted` 带空 body 的 notification ack)—— 不触发
 *      `onMessage`,静默 drain。规范允许 server 对 client notification 只回
 *      202 而不附带 payload。
 *
 * ## 与 legacy SSE 的区别
 *
 * `./sse.js` 是**一对端点**(GET /sse 持续下行 + POST /messages 上行),握手
 * 时通过 `event: endpoint` 帧告知 POST 地址;而 streamable-http 是**单一
 * 端点**,既没有长连 GET 也没有 endpoint 协商 —— 每次 send 都是一次完整
 * request → response 往返,其中 response 可能以 SSE 形式携带多条消息。
 *
 * ## 自注册
 *
 * 模块加载时调用 `_setBuiltinTransport('http', httpFactory)` 与
 * `_setBuiltinTransport('streamable-http', httpFactory)`,把同一 factory
 * 绑到两个保留名上(Req 1.5 把 `streamable-http` 视作 `http` 的历史别名)。
 * 内置注册表的别名同步逻辑(`transports/index.js _setBuiltinTransport`)
 * 保证任一边更新都会同步另一边,这里显式调用两次仅为文档可读性。
 *
 * ## 错误分类
 *
 * - fetch 抛错(DNS / 网络 / ECONNRESET)→ `onError({ kind: 'transport_error', cause })`
 *   并立即 `fireClose`,同时重抛给 `send()` 调用方,让上层 `_sendRequest`
 *   把对应 pending 以 `MCPClosedError` reject。
 * - 非 2xx 响应 → 同上,构造 Error(`HTTP <status> <statusText>`)作为 cause。
 * - SSE data 解码失败 → `onError({ kind: 'malformed_frame', cause })`,
 *   不关闭连接(Req 2.5)。
 * - `AbortError`(close() 或 user signal)→ 静默退出,不升级为 transport_error;
 *   关闭路径由 `close()` 自身触发 fireClose。
 *
 * @see Requirements 1.3, 1.5, 2.6, 7.5
 */

import { codec } from '../codec.js'
import { _setBuiltinTransport } from './index.js'
import { createSseParser } from './sse-parser.js'

/**
 * 合并两个 AbortSignal — 返回一个新 AbortController,在任一上游 abort
 * 或该 controller 自身被 abort 时终态同步。
 *
 * 与 `./sse.js` 的 `combineSignals` 行为等价,内联在本文件而非共享,是为了
 * 保持每个 transport 文件的模块自洽(便于个别重写);实现简短,重复成本低。
 *
 * @param {AbortSignal | undefined} userSignal  用户传入的 options.signal
 * @param {AbortSignal} internalSignal          transport 内部 close() 触发的 signal
 * @returns {AbortSignal}                       合并后的 signal,供 fetch 使用
 */
function mergeSignals(userSignal, internalSignal) {
  // 仅内部 signal:直接返回,省一层 listener。
  if (!userSignal || typeof userSignal.addEventListener !== 'function') {
    return internalSignal
  }
  const controller = new AbortController()
  // 已经 aborted 的上游:立即把 controller 置为 aborted。
  if (userSignal.aborted) {
    try { controller.abort(userSignal.reason) } catch { controller.abort() }
    return controller.signal
  }
  if (internalSignal.aborted) {
    try { controller.abort(internalSignal.reason) } catch { controller.abort() }
    return controller.signal
  }
  const forwardUser = () => {
    try { controller.abort(userSignal.reason) } catch { controller.abort() }
  }
  const forwardInternal = () => {
    try { controller.abort(internalSignal.reason) } catch { controller.abort() }
  }
  try { userSignal.addEventListener('abort', forwardUser, { once: true }) } catch { /* 非标准 signal — 退化为仅内部 abort 生效 */ }
  try { internalSignal.addEventListener('abort', forwardInternal, { once: true }) } catch { /* 同上 */ }
  return controller.signal
}

/**
 * Streamable HTTP transport 工厂。
 *
 * 参数契约(对应 `CreateMCPClientOptions` 的 `transport: 'http' | 'streamable-http'` 分支):
 *   - `url: string`       —— POST 端点的绝对 URL,必填
 *   - `headers?: Record<string,string>`  —— 合并到每一次 POST 请求头(如 `Authorization`)
 *   - `signal?: AbortSignal`             —— 用户级取消信号,与内部 AbortController 合并
 *
 * 返回对象满足 `MCP_Transport` 契约:
 *   - `send(msg)`:POST JSON;根据响应 Content-Type 分派到 JSON / SSE / 空体
 *     三种处理路径,处理完毕再 resolve。SSE 路径 **不** 等待流完整关闭 ——
 *     发起异步消费任务后立即 resolve,让 client 层能继续下一次 send。
 *   - `onMessage / onError / onClose`:注册回调,last-wins(与 stdio.js / sse.js 对齐)。
 *   - `close()`:幂等;abort 所有在途 fetch / SSE reader,触发 `onClose({ reason: 'client-initiated' })`。
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
export function httpFactory(options) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('httpFactory: options must be an object')
  }
  if (typeof options.url !== 'string' || options.url.length === 0) {
    throw new TypeError('httpFactory: options.url must be a non-empty string')
  }

  const url = options.url
  const userHeaders = (options.headers && typeof options.headers === 'object')
    ? options.headers
    : null
  const userSignal = options.signal

  /** 用于在 close() 时 abort 所有在途 fetch / reader. */
  const abortController = new AbortController()

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

  /**
   * 触发一次 onClose(最多一次)。用 try/catch 包住回调异常,避免 transport
   * 内部因用户代码 bug 崩溃。
   *
   * @param {object} [reason]  `{ kind?, cause?, reason? }` 等自由结构
   */
  function fireClose(reason) {
    if (closed) return
    closed = true
    closeReason = reason ?? null
    // 主动 abort 所有在途 fetch / reader,让它们的 await 及时唤醒。
    try { abortController.abort() } catch { /* 已 abort — 忽略 */ }
    if (onCloseCb) {
      try {
        onCloseCb(closeReason ?? undefined)
      } catch {
        // 吞掉用户回调内部错误以保护 transport 生命周期。
      }
    }
  }

  /**
   * 触发 onError(不自动 fireClose,调用方按需决定)。
   *
   * @param {{ kind: string, cause?: unknown }} err
   */
  function fireError(err) {
    if (onErrorCb) {
      try { onErrorCb(err) } catch { /* 吞掉 */ }
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // SSE 响应流消费 — 供 send() 内部调用
  // ─────────────────────────────────────────────────────────────────────

  /**
   * 异步消费一条 `text/event-stream` 响应:把 body chunks 喂给 sse-parser,
   * 从 parser 的 async-iterable 拉事件,每个 `data:` 字段走 codec.decodeLine
   * 后递交 onMessage。
   *
   * 任一 pump 异常(除 AbortError)都触发 `fireError + fireClose`;正常流结束
   * 不主动关闭 —— streamable-http 允许 server 在下一次 POST 之前先断本次
   * 响应流(等价 "本次 request 已完成,没有更多消息")。
   *
   * 注意:本函数不被 `send()` 的返回 Promise 等待。send() 在解析出 Content-Type
   * 后立即把 SSE 消费交给本函数异步跑,自身 resolve 让 client 层可以下一条
   * send。多次 send 产生的多条 SSE 消费任务独立并行(它们对应的 response
   * 各自独立),通过各自的 reader + parser 隔离。
   *
   * @param {Response} response
   */
  function consumeSseResponse(response) {
    if (!response.body || typeof response.body.getReader !== 'function') {
      // server 声明了 SSE 但没给 body — 视为协议问题但非致命,fireError 后返回。
      fireError({
        kind: 'transport_error',
        cause: new Error('http transport: SSE response has no body'),
      })
      return
    }

    const parser = createSseParser()
    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8')

    // pumpStream: 从 fetch reader 读字节 → push 给 parser。
    const pumpStream = (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          parser.push(decoder.decode(value, { stream: true }))
        }
        // flush decoder 可能残留的字节(UTF-8 多字节序列边界)。
        parser.push(decoder.decode())
      } catch (err) {
        if (err && err.name === 'AbortError') return
        // 读取异常 — 升级为 transport_error,并让上层 dispatch 循环自然退出。
        fireError({ kind: 'transport_error', cause: err })
        throw err
      } finally {
        try { parser.close() } catch { /* parser 已关闭 — 忽略 */ }
      }
    })()

    // dispatchEvents: 从 parser.events 异步迭代 → codec.decodeLine → onMessage。
    const dispatchEvents = (async () => {
      for await (const evt of parser.events) {
        // streamable-http 规范不区分 event 名;实现上只认 `message` 与缺省。
        // 其他 event 类型(server 自定义 / 未来扩展)静默忽略,不报错。
        if (evt.event !== undefined && evt.event !== 'message') continue

        let msg
        try {
          msg = codec.decodeLine(evt.data)
        } catch (err) {
          // malformed_frame:继续消费后续事件,不关闭连接(Req 2.5)。
          fireError({ kind: 'malformed_frame', cause: err })
          continue
        }
        if (onMessageCb) {
          try { onMessageCb(msg) } catch { /* 吞掉用户回调异常 */ }
        }
      }
    })()

    // fire-and-forget:两个 pump 都 settle 后,记录结果但不主动 fireClose
    // —— streamable-http 的 SSE 流"自然结束"是合法终态,只意味着本次 POST
    // 的对应 server→client 通道关闭,下次 send 会打开新一轮通道。
    //
    // 异常路径已经在 pumpStream 内 fireError 过;这里再兜底一次 fireClose
    // 仅在异常流条件下触发,避免"数据流挂了但 client 仍以为连接活着"。
    Promise.all([pumpStream, dispatchEvents]).catch(() => {
      if (!closed) {
        fireClose({ kind: 'transport_error' })
      }
    })
  }

  // ─────────────────────────────────────────────────────────────────────
  // 公共方法
  // ─────────────────────────────────────────────────────────────────────

  /**
   * POST 一条 JSON-RPC 消息到 url,按响应 Content-Type 分派消费。
   *
   * 成功路径:
   *   - 2xx + `application/json` body:await response.json() → onMessage(解析后的对象)。
   *     若 body 为空(server 省略 payload)→ 静默吞掉,不触发 onMessage。
   *   - 2xx + `text/event-stream` body:交给 `consumeSseResponse` 异步消费,
   *     send() 本身立即 resolve。
   *   - 2xx + 其他 / 空 body(如 `202 Accepted` notification ack)→ 静默 drain
   *     并 resolve。
   *
   * 失败路径:
   *   - closed 态 send:同步抛 `Error('http transport: closed')`。
   *   - fetch 抛(网络 / DNS):fireError + fireClose,重抛给调用方(AbortError 例外:
   *     由 close() 触发时静默重抛,让上层识别为"连接关闭"而非"网络错误")。
   *   - 非 2xx:构造 Error(`HTTP <status> <statusText>`),fireError + fireClose,重抛。
   *
   * @param {object} msg
   * @returns {Promise<void>}
   */
  async function send(msg) {
    if (closed) {
      throw new Error('http transport: closed')
    }
    // 形状断言 + 单行 JSON 输出;失败同步抛,不触发任何网络动作。
    const body = codec.encode(msg)
    const headers = {
      ...(userHeaders ?? {}),
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    }

    // 每次 send 合并一次 user signal + internal abort signal。abortController
    // 是 transport 生命周期内单例,因此多次 send 共享同一 close-on-demand 源。
    const signal = mergeSignals(userSignal, abortController.signal)

    let response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal,
      })
    } catch (err) {
      // AbortError 代表 close() 主动断开或用户 signal;上层用它区分"被动关闭"
      // 与"真实网络错误"。不 fireError / fireClose(若是 close 触发的,那
      // fireClose 已经被调用过)。
      if (err && err.name === 'AbortError') {
        throw err
      }
      fireError({ kind: 'transport_error', cause: err })
      fireClose({ kind: 'transport_error', cause: err })
      throw err
    }

    if (!response.ok) {
      const err = new Error(
        `http transport: HTTP ${response.status} ${response.statusText}`
      )
      fireError({ kind: 'transport_error', cause: err })
      fireClose({ kind: 'transport_error', cause: err })
      throw err
    }

    const contentType = String(response.headers.get('content-type') ?? '').toLowerCase()

    if (contentType.includes('text/event-stream')) {
      // SSE 路径:异步消费,不等流关闭(否则 send 会挂住后续调用)。
      consumeSseResponse(response)
      return
    }

    if (contentType.includes('application/json')) {
      // JSON 路径:读完整 body,交给 onMessage。若 body 为空(server 非标准
      // 地带了 application/json 却没写任何内容),静默吞掉。
      let text
      try {
        text = await response.text()
      } catch (err) {
        if (err && err.name === 'AbortError') return
        fireError({ kind: 'transport_error', cause: err })
        fireClose({ kind: 'transport_error', cause: err })
        throw err
      }
      if (text.length === 0) return
      let parsed
      try {
        parsed = codec.decodeLine(text)
      } catch (err) {
        // server 返回 application/json 但 body 不是合法 JSON-RPC — 按
        // malformed_frame 处理,保持连接存活(Req 2.5)。调用方能通过超时
        // 路径自然回落(pending 请求得不到响应 → 超时)。
        fireError({ kind: 'malformed_frame', cause: err })
        return
      }
      if (onMessageCb) {
        try { onMessageCb(parsed) } catch { /* 吞掉用户回调异常 */ }
      }
      return
    }

    // 其他 Content-Type(或 `202 Accepted` 无 body 的 notification ack)—— drain
    // body 以释放 keep-alive 连接,不触发 onMessage。
    try {
      if (typeof response.arrayBuffer === 'function') {
        await response.arrayBuffer()
      }
    } catch {
      // drain 失败无所谓 — 2xx 已经是成功信号。
    }
  }

  function onMessage(cb) {
    if (typeof cb !== 'function') {
      throw new TypeError('http transport: onMessage callback must be a function')
    }
    onMessageCb = cb
  }

  function onError(cb) {
    if (typeof cb !== 'function') {
      throw new TypeError('http transport: onError callback must be a function')
    }
    onErrorCb = cb
  }

  function onClose(cb) {
    if (typeof cb !== 'function') {
      throw new TypeError('http transport: onClose callback must be a function')
    }
    onCloseCb = cb
    // 若已关闭,microtask 内回放一次终态,避免丢失(与 stdio.js / sse.js 一致)。
    if (closed) {
      const reason = closeReason
      queueMicrotask(() => {
        try { cb(reason ?? undefined) } catch { /* 吞掉 */ }
      })
    }
  }

  /**
   * 幂等关闭。首次调用:abort 所有在途 fetch + SSE reader → fireClose。
   * 后续调用返回同一 Promise。
   *
   * 注意:fireClose 内部已经 `abortController.abort()`,这里无需额外动作。
   * 保留 async 包装是为了对齐 `MCP_Transport.close()` 的 `Promise<void>` 契约。
   *
   * @returns {Promise<void>}
   */
  function close() {
    if (closePromise) return closePromise
    closePromise = (async () => {
      if (closed) return
      fireClose({ reason: 'client-initiated' })
    })()
    return closePromise
  }

  return { send, onMessage, onError, onClose, close }
}

// 自注册到内置 transport 注册表。必须在模块加载时同步完成,以便
// `await import('./http.js')` 触发后 `resolveTransport('http')` 与
// `resolveTransport('streamable-http')` 都立即可用。
//
// `_setBuiltinTransport` 内部对 'http' / 'streamable-http' 做别名同步 ——
// 设置任一名都会自动把另一名也绑到同一 factory 引用。这里显式调用两次
// 是为了文档可读性(让 "两个名字都走同一 factory" 的事实在本文件里显式)。
_setBuiltinTransport('http', httpFactory)
_setBuiltinTransport('streamable-http', httpFactory)
