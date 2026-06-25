/**
 * MCP_Client — 状态机 + JSON-RPC 请求/响应多路复用器(骨架)
 *
 * 本文件覆盖 tasks.md §6.1 – §6.6 的全部范围:
 *   - 构造函数 + 内部字段 + 只读 `state`
 *   - `_transitionTo` 状态迁移校验
 *   - transport 回调绑定(onMessage / onError / onClose)
 *   - `_sendRequest` / `_sendNotification` / `_onMessage` 核心多路复用
 *   - `close()` 幂等关闭路径
 *   - `_performHandshake` (initialize + initialized)
 *   - `listTools()` / `refreshTools()` + 分页
 *   - `Mcp_Tool_Def.execute` + CallToolResult 归一化
 *   - `notifications/tools/list_changed` / `notifications/cancelled` 等通知分派
 *
 * 设计参考:
 *   - design.md §Architecture 状态机图、§Architecture "JSON-RPC 多路复用"
 *   - design.md §Components `MCP_Client`、§Error Handling "错误路径组合表"
 *   - requirements.md 2.5, 6.2-6.4, 6.11-6.12, 7.1-7.7, 10.2-10.4
 *
 * 与 transport 层的契约取 design §Architecture "传输契约"小节:
 *   `transport.send(message: JsonRpcMessage): Promise<void>` — 接收 **原生对象**,
 *   由 transport 内部调用 `codec.encode` 并在字节层附加 `\n` / HTTP body / SSE
 *   frame。因此 `_sendRequest` / `_sendNotification` 向 transport 传递原生
 *   JsonRpcMessage 对象,而 `codec.encode(msg)` 只被 client 当作"程序员 bug
 *   触发点"的 validation(断言 msg 结构合法,失败时同步抛 MCPProtocolError)。
 */

import { MCPClosedError, MCPProtocolError, MCPRequestError } from './errors.js'
import { codec } from './codec.js'
import { assignUniqueNames } from './namespace.js'
import { normalizeCallToolResult } from './normalize.js'
import {
  attachMcpToolMetadata,
  describeMcpToolForModel,
} from './metadata.js'

/**
 * JSON-RPC 超时沿用规范未分配区间中的保留值 `-32000`(Req 6.11)。
 * 构造 MCPRequestError 时用此 code 表达"非 server 下发的 timeout"。
 */
const TIMEOUT_ERROR_CODE = -32000

/**
 * 单向状态机的合法转换表。未列入的迁移组合一律视为实现 bug,在
 * `_transitionTo` 中同步抛错以 fail fast。
 *   connecting → ready | closed
 *   ready      → closing | closed
 *   closing    → closed
 *   closed     → (terminal)
 *
 * @see design.md §Architecture 状态机图、Req 7.6
 */
const LEGAL_TRANSITIONS = Object.freeze({
  connecting: new Set(['ready', 'closed']),
  ready: new Set(['closing', 'closed']),
  closing: new Set(['closed']),
  closed: new Set(),
})

/**
 * @typedef {object} PendingEntry
 * @property {number} id                   outgoing 请求的 JSON-RPC id
 * @property {string} method               请求方法名,供诊断与超时 message 使用
 * @property {(result: unknown) => void} resolve
 * @property {(err: Error) => void} reject
 * @property {ReturnType<typeof setTimeout> | null} timer  超时定时器句柄
 * @property {AbortSignal} [signal]        调用方传入的取消 signal
 * @property {() => void} [onAbort]        已注册到 signal 上的 abort 监听
 * @property {string} [toolName]           仅 tools/call 使用(填充 MCPRequestError.toolName)
 */

/**
 * MCP Client — 单个 MCP_Server 的会话。
 *
 * 通过 `createMCPClient(options)` 工厂构造;不建议直接 `new`(工厂在
 * tasks 7.1 中会负责握手、错误路径汇聚与公开表面简化)。
 */
export class MCP_Client {
  /**
   * @param {{
   *   transport: object,
   *   serverName: string,
   *   options?: {
   *     clientInfo?: { name: string, version: string },
   *     protocolVersion?: string,
   *     requestTimeoutMs?: number,
   *     signal?: AbortSignal,
   *     onClose?: (reason?: object) => void,
   *     onToolsChanged?: (tools: object[]) => void,
   *   },
   * }} params
   */
  constructor({ transport, serverName, options = {} } = {}) {
    /** @type {object} 持有的 transport 实例(stdio/http/sse/自定义) */
    this._transport = transport

    /** @type {string} 前缀化用的 server 名(通常已 sanitize) */
    this._serverName = String(serverName ?? '')

    /** @type {object} 原始 options(含回调、超时、signal 等) */
    this._options = options ?? {}

    /** @type {'connecting' | 'ready' | 'closing' | 'closed'} */
    this._state = 'connecting'

    /**
     * 下一条 outgoing 请求的 id。从 1 开始单调递增;Property 9 对"生命周期
     * 内 id 两两不同"的断言依赖此字段永不回绕。
     * @type {number}
     */
    this._nextId = 1

    /** @type {Map<number, PendingEntry>} JSON-RPC demux 表 */
    this._pending = new Map()

    /** @type {object[] | null} listTools 缓存(task 6.4 填充) */
    this._toolsCache = null

    /** @type {Promise<object[]> | null} listTools 并发去抖(task 6.4 填充) */
    this._toolsPromise = null

    /** @type {Promise<void> | null} close() 幂等返回(首次调用缓存此 promise) */
    this._closePromise = null

    /** @type {{ name: string, version: string } | null} 握手后填充(task 6.3) */
    this.serverInfo = null

    /** @type {object | null} 握手后填充(task 6.3) */
    this.serverCapabilities = null

    /** @type {string | null} 握手后填充(task 6.3) */
    this.instructions = null

    // 绑定 transport 回调。这里用方法转发(而非直接传 this.xxx)是因为
    // 未来 6.6 的 `_onNotification` 会扩展 `_onMessage` 的通知分派,
    // 箭头函数闭包保证了拿到 new 出来的 this 而不是 transport 调用时的 this。
    transport.onMessage((msg) => this._onMessage(msg))
    transport.onError((err) => this._onTransportError(err))
    transport.onClose((reason) => this._handleTransportClose(reason))
  }

  /**
   * 只读状态。外部观察到的值永远是单向迁移链上的某一点,
   * 不会回退(Req 7.6)。
   * @returns {'connecting' | 'ready' | 'closing' | 'closed'}
   */
  get state() {
    return this._state
  }

  // ─────────────────────────────────────────────────────────────────────
  // 状态机
  // ─────────────────────────────────────────────────────────────────────

  /**
   * 强制校验的状态迁移。非法迁移同步抛 Error(视为实现 bug),
   * 这让违反 Req 7.6 的代码在 test 阶段就暴露。
   *
   * @param {'connecting' | 'ready' | 'closing' | 'closed'} next
   */
  _transitionTo(next) {
    const allowed = LEGAL_TRANSITIONS[this._state]
    if (!allowed || !allowed.has(next)) {
      throw new Error(
        `[mcp] illegal state transition: ${this._state} -> ${next}`
      )
    }
    this._state = next
  }

  // ─────────────────────────────────────────────────────────────────────
  // 出站:请求 / 通知
  // ─────────────────────────────────────────────────────────────────────

  /**
   * 发起一条 JSON-RPC 请求,返回解析后 `result` 的 Promise。
   *
   * 行为摘要(详见 design §Architecture "JSON-RPC 多路复用"):
   *   1. 入口按 state 分派,非 'ready' 立即 reject `MCPClosedError`;
   *      例外:`opts.allowConnecting === true` 时允许在 'connecting' 阶段
   *      发送(initialize 握手唯一用例,task 6.3)。
   *   2. 若 `signal` 已 aborted,立即 reject `AbortError`,不占用 id。
   *   3. 分配 `_nextId++`,构造 `{ jsonrpc, id, method, params? }`。
   *   4. 调 `codec.encode(msg)` 做程序员 bug 断言(失败同步抛)。
   *   5. 注册 `_pending` 条目 → 挂 `setTimeout` 超时 → 挂 `signal.abort`
   *      监听 → 交给 `transport.send(msg)`。
   *   6. 响应到达后由 `_onMessage` 走 `_pending.get(id)` 路径 settle。
   *
   * 故障分支:
   *   - 超时:reject `MCPRequestError({ code: -32000, message: 'timeout: <m>', toolName })`。
   *   - signal abort:reject AbortError + fire-and-forget 发一条
   *     `notifications/cancelled`(Req 6.12)。
   *   - transport.send 抛错:reject `MCPClosedError({ cause })`,不主动
   *     关闭(由 transport 自己的 onClose 路径收敛)。
   *
   * @template T
   * @param {string} method
   * @param {object | unknown[] | undefined} params
   * @param {{
   *   signal?: AbortSignal,
   *   timeoutMs?: number,
   *   toolName?: string,
   *   allowConnecting?: boolean,
   * }} [opts]
   * @returns {Promise<T>}
   */
  _sendRequest(method, params, opts = {}) {
    const { signal, timeoutMs, toolName, allowConnecting = false } = opts

    // State 检查 — 非 ready 立即拒绝(Req 7.7)。allowConnecting 专供 6.3
    // 握手阶段:彼时 state === 'connecting',但 initialize 请求是唯一被
    // 允许在此态发送的流量。
    if (this._state === 'closed' || this._state === 'closing') {
      return Promise.reject(new MCPClosedError('MCP client is closed'))
    }
    if (this._state === 'connecting' && !allowConnecting) {
      return Promise.reject(
        new MCPClosedError('MCP client is not ready')
      )
    }

    // 预检 signal:已 abort 则不占用 id、不触碰 transport。
    if (signal && signal.aborted) {
      return Promise.reject(makeAbortError())
    }

    const id = this._nextId++
    /** @type {object} */
    const msg = { jsonrpc: '2.0', id, method }
    if (params !== undefined) msg.params = params

    // 程序员 bug 断言:若客户端自己拼错了 msg 结构,同步暴露。生产路径
    // 永远不会走到这里(encode 只做形状/jsonrpc 校验,不做业务语义校验)。
    codec.encode(msg)

    return new Promise((resolve, reject) => {
      /** @type {PendingEntry} */
      const entry = {
        id,
        method,
        resolve,
        reject,
        timer: null,
        signal,
        onAbort: undefined,
        toolName,
      }

      // 超时:单次 fire,清理 pending、clearTimer、detach signal listener。
      if (typeof timeoutMs === 'number' && timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          // 双检:可能在 timer fire 与 cleanup 之间被响应或 abort 抢先 settle。
          if (!this._pending.has(id)) return
          this._cleanupPending(entry)
          reject(
            new MCPRequestError(`timeout: ${method}`, {
              code: TIMEOUT_ERROR_CODE,
              toolName,
            })
          )
        }, timeoutMs)
      }

      // signal abort:reject + fire-and-forget cancel 通知(Req 6.12)。
      if (signal) {
        const onAbort = () => {
          if (!this._pending.has(id)) return
          this._cleanupPending(entry)
          reject(makeAbortError())
          // 不 await — 规范语义是"通知服务端可以丢弃"而非"等待确认"。
          // 失败也无所谓:transport 已断开时,send 会 reject;这里用 catch
          // 吞掉避免未处理 rejection 告警。
          this._sendNotification('notifications/cancelled', { requestId: id })
            .catch(() => { /* 已尽力而为;忽略 */ })
        }
        entry.onAbort = onAbort
        try {
          signal.addEventListener('abort', onAbort)
        } catch {
          // 非标准 AbortSignal 实现:忽略绑定失败,退化为"无 abort 支持"。
        }
      }

      this._pending.set(id, entry)

      // 交给 transport(可能同步返回 / 返回 Promise / 同步抛)。
      // 用 Promise.resolve().then(...) 规一化:同步抛 → reject 分支。
      Promise.resolve()
        .then(() => this._transport.send(msg))
        .catch((err) => {
          // 如果此时 pending 已被响应 / 超时 / abort 抢先清理,则忽略。
          if (!this._pending.has(id)) return
          this._cleanupPending(entry)
          reject(
            new MCPClosedError('MCP client is closed', { cause: err })
          )
        })
    })
  }

  /**
   * 发一条 JSON-RPC 通知(无 id、无响应)。
   *
   * 通知不入 `_pending`,也不设置超时 / signal 监听;调用方负责决定是否
   * `await` 返回值。若 transport.send 抛错,原样透出(不封装成
   * MCPClosedError,让调用方自行判断)。
   *
   * @param {string} method
   * @param {object | unknown[]} [params]
   * @returns {Promise<void>}
   */
  _sendNotification(method, params) {
    /** @type {object} */
    const msg = { jsonrpc: '2.0', method }
    if (params !== undefined) msg.params = params
    // 同 _sendRequest:codec.encode 仅做形状断言。
    codec.encode(msg)
    return Promise.resolve(this._transport.send(msg))
  }

  // ─────────────────────────────────────────────────────────────────────
  // 入站:消息分派
  // ─────────────────────────────────────────────────────────────────────

  /**
   * transport.onMessage 入口。按 JSON-RPC 形状分三路:
   *
   *   1. 响应 (`id != null` 且含 `result`/`error`) — 查 `_pending` 派发。
   *   2. 通知 (`method != null` 且 `id == null`) — 转 `_onNotification` 占位。
   *   3. 其他 — warn 并丢弃(codec 层已经过滤了大部分畸形帧,这里兜底)。
   *
   * @param {object} msg
   */
  _onMessage(msg) {
    if (msg === null || typeof msg !== 'object') {
      console.warn('[mcp] dropped malformed message')
      return
    }

    const hasId = msg.id != null
    const hasResult = Object.prototype.hasOwnProperty.call(msg, 'result')
    const hasError = Object.prototype.hasOwnProperty.call(msg, 'error')

    // 响应路径
    if (hasId && (hasResult || hasError)) {
      const entry = this._pending.get(msg.id)
      if (!entry) {
        // 未知 id:可能是迟到的超时响应或流氓 server。只 warn,不关闭。
        console.warn('[mcp] dropped response with unknown id:', msg.id)
        return
      }
      this._cleanupPending(entry)
      if (hasError && msg.error != null && typeof msg.error === 'object') {
        // JSON-RPC error — 用 MCPRequestError 透传 code / data / toolName。
        const err = new MCPRequestError(
          String(msg.error.message ?? 'MCP request failed'),
          {
            code:
              typeof msg.error.code === 'number' ? msg.error.code : 0,
            data: msg.error.data,
            toolName: entry.toolName,
          }
        )
        entry.reject(err)
      } else {
        entry.resolve(msg.result)
      }
      return
    }

    // 通知路径(id 缺失/为 null,且有 method)
    if (typeof msg.method === 'string' && !hasId) {
      this._onNotification(msg)
      return
    }

    // 其他:已通过 codec 的帧通常不会落在这里(codec 至少要求 jsonrpc 字段)。
    console.warn('[mcp] dropped malformed message')
  }

  /**
   * 通知分派 — 实现 tasks.md §6.6:
   *
   *   - `notifications/tools/list_changed`(Req 4.8):清缓存并异步刷新;
   *     刷新成功后调用 `options.onToolsChanged?(tools)`;失败仅 warn,
   *     不影响 client 存活。
   *   - `notifications/cancelled`(Req 6.12 反向):server 主动取消某个
   *     在途请求。若命中 `_pending`,用 AbortError reject 对应 Promise 并
   *     清理登记;未命中仅 warn(规范允许 server 对已 settle 的请求再发
   *     cancel,此时我们没有任何可操作的状态)。
   *   - 其他 method:silently ignore(规范允许 server 下发我们不识别的
   *     notification,不应噪音化日志)。
   *
   * @param {object} msg  JsonRpcNotification 形状的对象
   */
  _onNotification(msg) {
    const method = msg && typeof msg === 'object' ? msg.method : undefined

    if (method === 'notifications/tools/list_changed') {
      // 先失效缓存,后触发异步刷新。刷新内部也会再置一次 `null`,冗余但无害。
      this._toolsCache = null
      // 不 await:notification 处理路径必须同步返回,刷新失败仅 warn。
      this.refreshTools()
        .then((tools) => {
          const cb = this._options?.onToolsChanged
          if (typeof cb === 'function') {
            try {
              cb(tools)
            } catch (cbErr) {
              console.warn('[mcp] options.onToolsChanged threw:', cbErr)
            }
          }
        })
        .catch((err) => {
          console.warn('[mcp] refreshTools after list_changed failed:', err)
        })
      return
    }

    if (method === 'notifications/cancelled') {
      const requestId = msg?.params?.requestId
      const entry = requestId != null ? this._pending.get(requestId) : undefined
      if (entry) {
        this._cleanupPending(entry)
        try {
          entry.reject(makeAbortError())
        } catch {
          // reject 回调里抛的错忽略,不应打断后续消息分派
        }
        return
      }
      console.warn(
        '[mcp] notifications/cancelled for unknown request id:',
        requestId
      )
      return
    }

    // 其他未识别的 notification 方法:silently ignore(规范允许)
  }

  /**
   * transport.onError 入口。
   *
   * 按 design §Error Handling:只有 `kind === 'malformed_frame'` 在此 warn
   * 并保持连接存活(Req 2.5);其他 kind(如 `transport_error`)由 transport
   * 自己在捕获时再调 onClose,本 client 通过 `_handleTransportClose` 收敛。
   *
   * @param {{ kind?: string, cause?: unknown, message?: string }} err
   */
  _onTransportError(err) {
    if (err !== null && typeof err === 'object' && err.kind === 'malformed_frame') {
      console.warn('[mcp] malformed frame from transport; continuing')
      return
    }
    // 其余情形:当前不主动处理。transport 约定会随后触发 onClose,由
    // `_handleTransportClose` 做 pending 清理与用户回调调用。
  }

  /**
   * transport.onClose 入口(远端/底层主动断开)。
   *
   * 语义区分(Req 7.4 / 7.5):
   *   - 本方法处理 **transport-initiated** 关闭。
   *   - 显式 `client.close()` 路径不走这里,而是走 `close()` 方法,两条
   *     路径都会把 `_pending` 清空并最终落在 `state === 'closed'`。
   *
   * `_options.onClose` 用户回调只在 **transport-initiated** 场景触发;
   * 显式 close 不回调(避免调用方对自己发起的动作收到"被动关闭"的误导)。
   *
   * @param {object} [reason] 来自 transport 的 `{ code?, signal?, kind?, cause? }` 或等价结构
   */
  _handleTransportClose(reason) {
    if (this._state === 'closed') return

    this._transitionTo('closed')

    const err = new MCPClosedError('MCP client is closed', {
      reason: typeof reason?.kind === 'string' ? reason.kind : undefined,
      cause: reason?.cause ?? reason,
    })
    this._rejectAllPending(err)

    // 用户回调出错不应污染 client 状态 — 全部吞到 console.warn。
    const cb = this._options?.onClose
    if (typeof cb === 'function') {
      try {
        cb(reason)
      } catch (cbErr) {
        console.warn('[mcp] options.onClose threw:', cbErr)
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // 握手
  // ─────────────────────────────────────────────────────────────────────

  /**
   * 执行 MCP 握手 — `initialize` 请求 + `notifications/initialized` 通知。
   *
   * 调用约定:工厂函数 `createMCPClient` 在构造 MCP_Client 之后、把 client
   * 暴露给调用方之前调用本方法。入口态必须是 `'connecting'`;成功返回后 state
   * 变为 `'ready'`;失败路径内部已完成 transport.close() 与 state→'closed' 的
   * 收敛,并透明重抛最终错误(可能为 MCPProtocolError / AbortError / 其他)。
   *
   * 错误归一化(按 design §Error Handling "createMCPClient 入口"分支):
   *   - MCPRequestError.code === -32000(超时) → 替换为
   *     `MCPProtocolError({ kind: 'initialize_timeout' })`,丢弃 toolName 等
   *     请求级字段(握手不属于任何工具)。
   *   - 其他 MCPRequestError(server 下发 JSON-RPC error) → 替换为
   *     `MCPProtocolError({ kind: 'initialize_error', detail: { code, message, data } })`,
   *     把原始 JSON-RPC 错误要素压入 detail 方便调用方诊断。
   *   - AbortError(signal abort) → 原样透出,不包裹。
   *   - 其他 Error(transport.send 抛 / 连接类 MCPClosedError 等) → 原样透出。
   *
   * 无论走到哪一条错误分支,`_transport.close()` 都会被触发(失败被吞),随后
   * 若 state 尚未落在 'closed' 就迁移到 'closed';这条"无条件收敛到 closed"
   * 路径保证 pending 请求(此阶段理论上只有一条 initialize)被 `_handleTransportClose`
   * 或 `close()` 之一清理掉,调用方永远不会观察到"握手失败但 state 仍 connecting"
   * 的泄漏态。
   *
   * @returns {Promise<void>}
   * @see Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
   */
  async _performHandshake() {
    try {
      /** @type {any} */
      const result = await this._sendRequest(
        'initialize',
        {
          protocolVersion: this._options.protocolVersion,
          clientInfo: this._options.clientInfo,
          capabilities: {},
        },
        {
          allowConnecting: true,
          timeoutMs: this._options.requestTimeoutMs,
          signal: this._options.signal,
        }
      )

      // Req 3.3:protocolVersion 兼容性检查。MCP 规范允许 server 返回它支持的
      // 最高版本;只要 server 返回了一个合法的版本字符串,我们就接受(向后兼容)。
      // 只有 server 完全不返回 protocolVersion 时才视为不兼容。
      const serverVersion = result?.protocolVersion
      if (!serverVersion) {
        throw new MCPProtocolError('MCP protocol version mismatch', {
          kind: 'protocol_version_mismatch',
          detail: {
            expected: this._options.protocolVersion,
            actual: serverVersion,
          },
        })
      }

      // Req 3.2:保存服务端元数据供后续调用方读取。
      this.serverInfo = result.serverInfo ?? null
      this.serverCapabilities = result.capabilities ?? null
      this.instructions = result.instructions ?? null

      // Req 3.4:完成握手礼节。失败会让下面 await 抛错,走 catch 收敛。
      await this._sendNotification('notifications/initialized')

      this._transitionTo('ready')
    } catch (err) {
      // 错误归一化 —— 把请求级错误语义翻译成协议级错误语义(Req 3.5 / 3.6)。
      let finalErr = err
      if (err instanceof MCPRequestError) {
        if (err.code === TIMEOUT_ERROR_CODE) {
          finalErr = new MCPProtocolError('initialize timeout', {
            kind: 'initialize_timeout',
          })
        } else {
          finalErr = new MCPProtocolError('initialize error', {
            kind: 'initialize_error',
            detail: {
              code: err.code,
              message: err.message,
              data: err.data,
            },
          })
        }
      }
      // AbortError / MCPClosedError / MCPProtocolError(已被上游构造好的)
      // 其他一切 Error 直接原样透出,不二次包装。

      // 无条件收敛到 closed 态:transport.close 失败被吞(我们正在拆除会话,
      // 对失败根因没有可操作路径)。
      await this._transport.close().catch(() => { /* ignore */ })
      if (this._state !== 'closed') {
        this._transitionTo('closed')
      }

      throw finalErr
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // 工具列表与调用
  // ─────────────────────────────────────────────────────────────────────

  /**
   * 返回当前可用的 Mcp_Tool_Def 数组。
   *
   * 语义(Req 4.1 / 4.2 / 4.6 / 7.7):
   *   - state !== 'ready' → reject `MCPClosedError`(不区分 connecting /
   *     closing / closed;对调用方来说都是"暂不可用")。
   *   - 已有 `_toolsCache` → 直接 resolve 该缓存(同一数组引用,调用方若
   *     mutate 会污染缓存 —— 与 design 一致,调用方约定只读)。
   *   - 已有 in-flight `_toolsPromise` → 返回同一 promise(Property 7 的
   *     并发幂等语义,避免重复打 `tools/list`)。
   *   - 都不满足 → 启动一次 `_fetchAndBuildTools`;完成后填 cache,
   *     无论成功失败都把 `_toolsPromise` 置回 null 以允许后续重试。
   *
   * @returns {Promise<object[]>}
   */
  listTools() {
    if (this._state !== 'ready') {
      return Promise.reject(new MCPClosedError('MCP client is not ready'))
    }
    if (this._toolsCache !== null) {
      return Promise.resolve(this._toolsCache)
    }
    if (this._toolsPromise !== null) {
      return this._toolsPromise
    }
    this._toolsPromise = this._fetchAndBuildTools()
      .then((tools) => {
        this._toolsCache = tools
        return tools
      })
      .finally(() => {
        this._toolsPromise = null
      })
    return this._toolsPromise
  }

  /**
   * 强制刷新工具列表,绕过任何 `_toolsCache`(Req 4.7)。
   *
   * 与 `listTools()` 的关键区别:
   *   - 入口立即把 `_toolsCache` 置 null,保证即使并发 `listTools()` 也
   *     不会拿到陈旧值。
   *   - **不复用** `_toolsPromise` 的 in-flight 去抖 —— 每次 `refreshTools`
   *     都是一次新的 fetch(Property 7 要求 M 次 refresh 产生 M 条
   *     `tools/list` 请求)。
   *   - 成功后写回 `_toolsCache`;失败**不**写回(保持 null 使后续
   *     `listTools()` 自动重试)。
   *
   * @returns {Promise<object[]>}
   */
  refreshTools() {
    if (this._state !== 'ready') {
      return Promise.reject(new MCPClosedError('MCP client is not ready'))
    }
    this._toolsCache = null
    return this._fetchAndBuildTools().then((tools) => {
      this._toolsCache = tools
      return tools
    })
  }

  /**
   * 真正发起 `tools/list` 请求并处理分页合并 + 去重命名 + Tool_Def 构造。
   *
   * 分页契约(Req 4.3):server 在响应里附 `nextCursor: string` 表示"还有更多
   * 页",直到缺失该字段为止。我们把每页的 `result.tools` 原序 push 进
   * `descriptors`,最终数组与 server 一次性返回全部工具时顺序一致 —— 这是
   * Property 4 的基础不变式。
   *
   * 异常路径:
   *   - 某一页 send 或响应失败 → 透传 `_sendRequest` 抛出的错误(MCPRequestError /
   *     MCPClosedError 等),不做二次包装;调用方要么从 `listTools()` 拿到 reject,
   *     要么从 `refreshTools()` 拿到 reject,语义一致。
   *   - `result.tools` 缺失或非数组 → 当作"该页无新增",继续检查 nextCursor。
   *     这是故意的容忍设计:server 可以发 `{ nextCursor: 'x' }` 做 prefetch / ping 式
   *     响应,客户端不应因此爆炸。
   *
   * @returns {Promise<object[]>}  Mcp_Tool_Def[],顺序与 server 声明顺序一致
   */
  async _fetchAndBuildTools() {
    const descriptors = []
    let cursor = undefined

    // 分页循环 —— while(true) + break 比 do-while 更清晰;cursor 一旦不是
    // string 就退出,避免把 null / 空串 / 数字当作合法 cursor 再请求一轮。
    while (true) {
      const params = cursor === undefined ? undefined : { cursor }
      const result = await this._sendRequest('tools/list', params, {
        timeoutMs: this._options.requestTimeoutMs,
        signal: this._options.signal,
      })

      if (result != null && Array.isArray(result.tools)) {
        for (const descriptor of result.tools) {
          descriptors.push(descriptor)
        }
      }

      if (result != null && typeof result.nextCursor === 'string' && result.nextCursor.length > 0) {
        cursor = result.nextCursor
        continue
      }
      break
    }

    // 统一分配 namespaced name(含 sanitize + 长度裁剪 + _2/_3 去重后缀)。
    const pairs = assignUniqueNames(this._serverName, descriptors)
    return pairs.map(({ namespaced, descriptor }) =>
      this._buildToolDef(namespaced, descriptor)
    )
  }

  /**
   * 把单个 MCP_Tool_Descriptor 封装成 Agent Runtime 消费的 Mcp_Tool_Def。
   *
   * 形状(Req 4.4 / 4.5):
   *   - `name`:已分配的 namespaced 名(`mcp__<server>__<tool>` 形态)
   *   - `description`:descriptor.description + 官方 metadata 摘要,供 LLM 理解
   *   - `parameters`:直接透传 descriptor.inputSchema(JSON Schema 对象)
   *   - `execute`:闭包绑定 this,调用时走 `_executeTool(rawName, args, ctx)`;
   *     因此若在 `listTools()` 后 client 变为 closed/closing,`execute` 会在
   *     每次调用入口拿到最新 state 并立即 reject MCPClosedError。
   *   - MCP 官方 Tool metadata: title / icons / outputSchema / execution /
   *     annotations 作为非枚举属性暴露在 toolDef 上,方便 UI / 调度层读取,
   *     但不污染 `Object.keys(toolDef)` / `formatToolsForOpenAI`。
   *   - `_mcp`:非可枚举元数据,让 `JSON.stringify(toolDef)` 与
   *     `formatToolsForOpenAI` 看不到原始对象;LLM 只通过 description 摘要
   *     看到必要 metadata。
   *     字段包含 serverName / rawName 以及上述官方 metadata。
   *
   * @param {string} namespaced
   * @param {object} descriptor  MCP_Tool_Descriptor
   * @returns {object}  Mcp_Tool_Def
   */
  _buildToolDef(namespaced, descriptor) {
    const metadata = {
      serverName: this._serverName,
      rawName: descriptor.name,
      rawDescription: descriptor.description ?? '',
      title: descriptor.title,
      icons: descriptor.icons,
      outputSchema: descriptor.outputSchema,
      execution: descriptor.execution,
      annotations: descriptor.annotations,
    }
    const toolDef = {
      name: namespaced,
      description: describeMcpToolForModel({
        name: namespaced,
        description: descriptor.description ?? '',
        ...metadata,
      }),
      parameters: descriptor.inputSchema,
      execute: (args, ctx) => this._executeTool(descriptor.name, args, ctx),
    }

    return attachMcpToolMetadata(toolDef, metadata)
  }

  /**
   * `Mcp_Tool_Def.execute` 的真正实现 — 发 `tools/call` 并归一化响应。
   *
   * 路径(design §Error Handling "execute(args, ctx)" 分支):
   *   1. state !== 'ready' → reject MCPClosedError(不发任何流量)。
   *   2. ctx.signal 已 aborted → reject AbortError(不发)(Req 6.12)。
   *   3. 否则 `_sendRequest('tools/call', { name: rawName, arguments: args }, ...)`:
   *      - 响应正常 → `normalizeCallToolResult(result, rawName)` 始终返回字符串;
   *        包含 `isError === true` 分支 —— 归一化函数负责前置 `"Error from MCP tool "<rawName>": "`
   *        前缀(Req 6.9),外层不抛异常,调用方拿到的是带前缀的字符串。
   *      - 响应 JSON-RPC error → _sendRequest 已包装成 MCPRequestError(code / data /
   *        toolName 完整),原样透出(Req 6.11)。
   *      - 响应超时 → _sendRequest 已包装成 MCPRequestError(code: -32000, toolName),
   *        原样透出。
   *      - ctx.signal 途中 abort → _sendRequest 已 reject AbortError +
   *        fire-and-forget 发 `notifications/cancelled`,原样透出。
   *
   * @param {string} rawName  server 原始工具名(descriptor.name,未经 sanitize)
   * @param {unknown} args    工具参数;透传给 JSON-RPC 的 `params.arguments`
   * @param {{ signal?: AbortSignal } | undefined} [ctx]
   * @returns {Promise<string>}
   */
  async _executeTool(rawName, args, ctx = {}) {
    if (this._state !== 'ready') {
      return Promise.reject(new MCPClosedError('MCP client is not ready'))
    }
    if (ctx?.signal?.aborted) {
      return Promise.reject(makeAbortError())
    }

    const result = await this._sendRequest(
      'tools/call',
      { name: rawName, arguments: args },
      {
        signal: ctx?.signal,
        timeoutMs: this._options.requestTimeoutMs,
        toolName: rawName,
      }
    )

    // normalizeCallToolResult 内部处理 isError 前缀;始终返回 string(Req 6.9)
    return normalizeCallToolResult(result, rawName)
  }

  // ─────────────────────────────────────────────────────────────────────
  // 关闭
  // ─────────────────────────────────────────────────────────────────────

  /**
   * 关闭 client。幂等 — 多次调用返回同一 Promise(Req 7.3)。
   *
   * 状态迁移:
   *   - `closed`   → 直接 resolve(Req 7.3 幂等)。
   *   - `ready`    → 'closing' → transport.close() → 'closed'。
   *   - `connecting` → (skip 'closing') → transport.close() → 'closed'。
   *                   合法迁移表不允许 connecting → closing,所以从握手
   *                   阶段取消时直接落在 closed。
   *   - `closing`  → 第一次 close 的 `_closePromise` 缓存已命中,不会走到
   *                   分支主体。此处留出兜底 early-return。
   *
   * 其他副作用:
   *   - 立即 reject `_pending` 中所有在途请求(Req 7.2)。顺序上在 await
   *     transport.close() 之前,保证调用方在同一 tick 观察到 rejection。
   *   - 不调用 `_options.onClose` — 该回调专属 transport-initiated 场景
   *     (见 `_handleTransportClose` 注释)。
   *
   * @returns {Promise<void>}
   */
  close() {
    if (this._closePromise) return this._closePromise

    if (this._state === 'closed') {
      this._closePromise = Promise.resolve()
      return this._closePromise
    }

    // 进入 closing(仅 ready 允许);connecting 保持不变直到最终 closed。
    if (this._state === 'ready') {
      this._transitionTo('closing')
    }

    // 同步 reject 所有在途请求,让调用方立即观察到失败。
    const closedError = new MCPClosedError('MCP client is closed')
    this._rejectAllPending(closedError)

    this._closePromise = Promise.resolve()
      .then(() => this._transport.close())
      .catch(() => {
        // 主动关闭阶段的 transport.close 失败被吞:我们正在拆除会话,
        // state 仍应落在 closed。失败的根因(如果有)由 transport 的
        // onClose 事件已处理,或由调用方业务 telemetry 通过其他渠道观察。
      })
      .then(() => {
        // 可能被 `_handleTransportClose` 抢先转到了 closed(竞态);两条
        // 路径收敛到同一终态,此处幂等。
        if (this._state !== 'closed') {
          this._transitionTo('closed')
        }
      })

    return this._closePromise
  }

  // ─────────────────────────────────────────────────────────────────────
  // 内部工具
  // ─────────────────────────────────────────────────────────────────────

  /**
   * 清理单条 pending 条目:清 timer、detach abort listener、从 map 删除。
   * 不 settle Promise — 调用方自行决定用哪个分支 resolve/reject。
   *
   * @param {PendingEntry} entry
   */
  _cleanupPending(entry) {
    if (entry.timer !== null && entry.timer !== undefined) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    if (entry.signal && entry.onAbort) {
      try {
        entry.signal.removeEventListener('abort', entry.onAbort)
      } catch {
        // 非标准 AbortSignal:移除失败忽略(不会阻碍 GC)。
      }
      entry.onAbort = undefined
    }
    this._pending.delete(entry.id)
  }

  /**
   * 一次性清空 `_pending` 并以 `reason` reject 所有条目。用于:
   *   - 显式 `close()` 的首步;
   *   - transport-initiated 关闭的 `_handleTransportClose`。
   *
   * 先快照再 clear 避免 reject 回调里同步再触发的清理操作污染迭代。
   *
   * @param {Error} reason
   */
  _rejectAllPending(reason) {
    if (this._pending.size === 0) return
    const entries = Array.from(this._pending.values())
    this._pending.clear()
    for (const entry of entries) {
      if (entry.timer !== null && entry.timer !== undefined) {
        clearTimeout(entry.timer)
        entry.timer = null
      }
      if (entry.signal && entry.onAbort) {
        try {
          entry.signal.removeEventListener('abort', entry.onAbort)
        } catch {
          // ignore
        }
      }
      try {
        entry.reject(reason)
      } catch {
        // reject 回调里抛的错不应打断其他 pending 的清理。
      }
    }
  }
}

/**
 * 构造一个 DOMException-风格的 AbortError,避免依赖 polyfill。
 *
 * Node 18+ 下 `new DOMException('aborted', 'AbortError')` 可用,但保持
 * "纯 Error + name 覆写"的形态以:
 *   (a) 避免跨运行时差异;
 *   (b) 与调用方常见 `err.name === 'AbortError'` 判定兼容。
 *
 * @returns {Error}
 */
function makeAbortError() {
  const err = new Error('aborted')
  err.name = 'AbortError'
  return err
}
