/**
 * MCP stdio Transport —— 基于 `child_process.spawn` 的本地子进程 transport.
 *
 * 语义(对齐 MCP 2025-03-26 规范):
 *   - stdin / stdout 作为双向 JSON-RPC 通道,每条消息一行(换行结尾);
 *   - stderr 作为 server 的日志通道,透传给 `options.onStderr`(未配置则
 *     `console.warn`),不参与 JSON-RPC;
 *   - 子进程 exit / error 映射为一次 `onClose({ code, signal, cause? })` 回调,
 *     之后 `send()` 立即 reject,以避免把消息写进已关闭的管道。
 *
 * ## 自注册
 *
 * 模块加载时调用 `_setBuiltinTransport('stdio', stdioFactory)` 将自己注册到
 * transport 注册表。`createMCPClient` 在需要时 `await import('./stdio.js')` 懒加
 * 载本模块,因此自注册与懒加载互不冲突。
 *
 * ## 公开符号
 *
 * - `stdioFactory(options)` —— 返回 `MCP_Transport` 对象({ send, onMessage,
 *   onError, onClose, close }).
 * - `createLineBuffer({ onLine })` —— 内部行帧缓冲工厂,供属性测试(task 11.4)
 *   直接消费以避免重复实现。对外保持独立导出,纯函数可安全在不同测试场景复用。
 *
 * @see Requirements 1.2, 2.4, 2.5, 2.6, 7.4
 */

import { spawn } from 'node:child_process'
import { codec } from '../codec.js'
import { _setBuiltinTransport } from './index.js'

/**
 * 行帧缓冲器 —— 将字节流按 `\n` 切分为整行,并在每条非空行上调用 `onLine`.
 *
 * 设计要点:
 *   - 支持字符串或 Buffer chunk(Buffer 会被 `.toString('utf8')` 解码,
 *     上层也可预先 `setEncoding('utf8')` 让 'data' 直接是字符串).
 *   - 空行(`\n\n` 之间零字节,或 `\r` 之后的空串)被直接忽略,满足 Req 2.4.
 *   - 末尾未带 `\n` 的残片保留在 buffer 中,待下个 chunk 拼接或 `flush()` 强行提交.
 *   - `onLine` 抛出的异常 **不会** 被本模块吞掉(上层调用 codec.decodeLine 有自己的
 *     try/catch);这样能避免 transport 层静默丢弃业务逻辑 bug.
 *
 * @param {{ onLine: (line: string) => void }} handlers
 * @returns {{ push(chunk: string | Buffer): void, flush(): void }}
 */
export function createLineBuffer(handlers) {
  if (!handlers || typeof handlers.onLine !== 'function') {
    throw new TypeError('createLineBuffer: handlers.onLine must be a function')
  }
  const onLine = handlers.onLine
  let buffer = ''

  function emit(line) {
    // 允许 \r\n 行尾:剥掉末尾 \r 以兼容 Windows 换行风格的 server.
    const normalized = line.length > 0 && line.charCodeAt(line.length - 1) === 0x0d
      ? line.slice(0, -1)
      : line
    if (normalized.length === 0) return
    onLine(normalized)
  }

  return {
    push(chunk) {
      if (chunk === null || chunk === undefined) return
      const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      if (str.length === 0) return
      buffer += str
      let idx = buffer.indexOf('\n')
      while (idx !== -1) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        emit(line)
        idx = buffer.indexOf('\n')
      }
    },
    flush() {
      if (buffer.length === 0) return
      const line = buffer
      buffer = ''
      emit(line)
    },
  }
}

/**
 * stdio transport 工厂.
 *
 * 参数契约(`CreateMCPClientOptions` 中 `transport: 'stdio'` 分支):
 *   - `command: string`(required)
 *   - `args?: string[]`
 *   - `env?: Record<string,string>` —— 只有显式传入才覆盖;默认继承父进程环境.
 *   - `cwd?: string`
 *   - `onStderr?: (chunk: string) => void`
 *
 * 返回的 transport 对象约定:
 *   - `send(msg)`:encode + append `'\n'`;stdin 已关闭或子进程已退出 → reject.
 *   - `onMessage(cb)` / `onError(cb)` / `onClose(cb)`:生命周期内最多注册一次.
 *     若 `onClose` 在子进程已退出之后才注册,回调会在下一 microtask 用
 *     缓存的 reason 调用一次.
 *   - `close()`:幂等;首次调用时 `stdin.end()` 触发 server 优雅退出,若 50ms 后
 *     仍存活再发 SIGTERM,随后等待 'exit' / 'error' 事件 resolve.
 *
 * @param {object} options
 * @returns {{
 *   send: (msg: object) => Promise<void>,
 *   onMessage: (cb: (msg: object) => void) => void,
 *   onError: (cb: (err: { kind: string, cause?: unknown }) => void) => void,
 *   onClose: (cb: (reason?: { code?: number|null, signal?: string|null, cause?: unknown }) => void) => void,
 *   close: () => Promise<void>,
 * }}
 */
export function stdioFactory(options) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('stdioFactory: options must be an object')
  }
  if (typeof options.command !== 'string' || options.command.length === 0) {
    throw new TypeError('stdioFactory: options.command must be a non-empty string')
  }

  // 只有显式传入 env / cwd 才覆盖 spawn 默认值(默认值 = 继承父进程).
  const spawnOptions = { stdio: ['pipe', 'pipe', 'pipe'] }
  if (options.env !== undefined) spawnOptions.env = options.env
  if (options.cwd !== undefined) spawnOptions.cwd = options.cwd

  const child = spawn(options.command, options.args ?? [], spawnOptions)

  /** @type {null | ((msg: object) => void)} */
  let onMessageCb = null
  /** @type {null | ((err: { kind: string, cause?: unknown }) => void)} */
  let onErrorCb = null
  /** @type {null | ((reason?: object) => void)} */
  let onCloseCb = null

  /** 已经发出 onClose / 等价处于 closed 状态? 防止重复触发. */
  let closed = false
  /** 最近一次 close reason,供迟到的 onClose 注册使用. */
  let closeReason = null
  /** close() 幂等 Promise 缓存. */
  let closePromise = null

  // ----- stdout: 行帧 → codec.decodeLine → onMessage / onError -----
  child.stdout.setEncoding('utf8')
  const stdoutBuffer = createLineBuffer({
    onLine: (line) => {
      let msg
      try {
        msg = codec.decodeLine(line)
      } catch (err) {
        // codec 已经保证抛 MCPProtocolError({ kind: 'malformed_frame' })
        if (onErrorCb) {
          try {
            onErrorCb({ kind: 'malformed_frame', cause: err })
          } catch (_cbErr) {
            // 吞掉回调内部错误以保护 transport 生命周期
          }
        }
        return
      }
      if (onMessageCb) {
        onMessageCb(msg)
      }
    },
  })
  child.stdout.on('data', (chunk) => {
    stdoutBuffer.push(chunk)
  })
  child.stdout.on('end', () => {
    // EOF 时把残余未换行的内容也递交(理论上 server 不会这么干,但防御性处理)
    stdoutBuffer.flush()
  })
  child.stdout.on('error', () => {
    // stdout 读取错误不单独触发 onError;父级 'exit' / 'error' 会覆盖终态.
  })

  // ----- stderr: 透传或 console.warn -----
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    if (typeof options.onStderr === 'function') {
      try {
        options.onStderr(chunk)
      } catch (_cbErr) {
        // 用户回调抛错不破坏 transport
      }
    } else {
      // 默认:仍然给开发者留一条肉眼可见的线索,生产环境可由调用方覆盖 onStderr.
      // eslint-disable-next-line no-console
      console.warn('[mcp:stdio:stderr]', chunk)
    }
  })
  child.stderr.on('error', () => {
    // 同 stdout: 静默,终态由父级 'exit' / 'error' 决定
  })

  // ----- 子进程生命周期: exit / error → onClose -----
  function fireClose(reason) {
    if (closed) return
    closed = true
    closeReason = reason
    if (onCloseCb) {
      try {
        onCloseCb(reason)
      } catch (_cbErr) {
        // 吞掉回调异常,transport 不应再抛
      }
    }
  }
  child.on('exit', (code, signal) => {
    fireClose({ code, signal })
  })
  child.on('error', (err) => {
    fireClose({ cause: err })
  })
  // child.stdin 写入失败时 (EPIPE) 也会触发 'error' 事件,我们静默处理,
  // 真正的关闭信号由 'exit' 给出;若 'error' 先于 'exit' 到达,fireClose 仍会执行.
  child.stdin.on('error', () => {
    // EPIPE / ERR_STREAM_DESTROYED 等由 send() 的 write callback 处理, 这里不再重复
  })

  // ----- 公共方法 -----

  function send(msg) {
    return new Promise((resolve, reject) => {
      if (closed) {
        reject(new Error('stdio transport: child process exited'))
        return
      }
      const stdin = child.stdin
      if (!stdin || stdin.destroyed || stdin.writableEnded || !stdin.writable) {
        reject(new Error('stdio transport: stdin closed'))
        return
      }
      let payload
      try {
        payload = codec.encode(msg) + '\n'
      } catch (err) {
        reject(err)
        return
      }
      stdin.write(payload, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  function onMessage(cb) {
    if (typeof cb !== 'function') {
      throw new TypeError('stdio transport: onMessage callback must be a function')
    }
    onMessageCb = cb
  }

  function onError(cb) {
    if (typeof cb !== 'function') {
      throw new TypeError('stdio transport: onError callback must be a function')
    }
    onErrorCb = cb
  }

  function onClose(cb) {
    if (typeof cb !== 'function') {
      throw new TypeError('stdio transport: onClose callback must be a function')
    }
    onCloseCb = cb
    // 若已经处于 closed 状态,则在 microtask 中回放一次,避免丢失终态.
    if (closed) {
      const reason = closeReason
      queueMicrotask(() => {
        try {
          cb(reason)
        } catch (_cbErr) {
          // 吞掉回调异常
        }
      })
    }
  }

  function close() {
    if (closePromise) return closePromise
    closePromise = new Promise((resolve) => {
      // 已经退出 —— 立即 resolve.
      if (closed) {
        resolve()
        return
      }

      const finish = () => resolve()
      child.once('exit', finish)
      child.once('error', finish)

      // Step 1: 优雅告知 server —— 关闭 stdin.
      try {
        if (child.stdin && !child.stdin.destroyed && !child.stdin.writableEnded) {
          child.stdin.end()
        }
      } catch (_err) {
        // 已经处于异常状态, exit / error 会接管
      }

      // Step 2: 兜底 50ms 后如仍存活则 SIGTERM.
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null && !child.killed) {
          try {
            child.kill()
          } catch (_err) {
            // 进程状态由 exit / error 事件最终体现
          }
        }
      }, 50).unref?.()
    })
    return closePromise
  }

  return { send, onMessage, onError, onClose, close }
}

// 自注册到内置 transport 注册表. 必须在模块加载时同步完成,以便
// `await import('./stdio.js')` 触发后 `resolveTransport('stdio')` 立即可用.
_setBuiltinTransport('stdio', stdioFactory)
