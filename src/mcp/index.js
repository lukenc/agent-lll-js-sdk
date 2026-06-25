/**
 * MCP Client Integration — 公开 API 入口。
 *
 * 本文件是 `src/mcp/**` 模块的唯一对外表面,承担两件事:
 *
 *   1. 实现 `createMCPClient(options)` 工厂 —— 组合 transport 解析 + MCP_Client
 *      构造 + handshake,把 `MCP_Client` 的"半成品" async 初始化路径收束到一个
 *      总入口,对调用方只暴露 `Promise<MCP_Client>`。
 *   2. 再导出调用方需要的类型表面:`MCP_Client` 本身、四个错误类、以及
 *      `registerTransport` 扩展点。内部辅助函数(`resolveTransport` /
 *      `listRegisteredTransportNames` / `_setBuiltinTransport`)有意**不**再导出。
 *
 * ## 工厂的错误路径契约
 *
 * `createMCPClient` 的所有失败分支都已经在下游函数中收敛并转换成对外友好的错误
 * 类型(见各分支注释),本工厂只做**透传**,不做二次包装:
 *   - 未知 transport → `UnsupportedTransportError`(本文件同步抛)
 *   - handshake 超时/错/版本不匹配 → `MCPProtocolError`(`_performHandshake` 转换)
 *   - handshake 期间 signal abort → AbortError(`_performHandshake` 原样透出)
 *   - transport.send / connect 故障 → `MCPClosedError`(`_performHandshake` 原样透出)
 *
 * ## `pkgVersion` 读取策略
 *
 * 使用 `createRequire(import.meta.url)` 读取 `package.json.version`,而非
 * `import pkg from '../../package.json' assert { type: 'json' }`。原因:
 *   - 后者是实验性特性,不同 Node 版本语法不同(assert / with)。
 *   - `createRequire` 是 Node 18+ 稳定 API,与项目 engines 要求一致。
 *   - 本文件是 ESM,`require` 不可直接用,`createRequire` 是标准桥接方式。
 *
 * @see Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 1.11, 1.12
 * @see Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
 * @see design.md §Overview, §Error Handling "createMCPClient 入口"
 */

import { MCP_Client } from './client.js'
import {
  UnsupportedTransportError,
} from './errors.js'
import {
  resolveTransport,
  listRegisteredTransportNames,
} from './transports/index.js'

/**
 * Lazily 读取当前包 version,用于默认 `clientInfo.version`。
 *
 * 为什么 lazy: `createRequire` 来自 `node:module`,在浏览器 IIFE bundle 里
 * 会被 esbuild 包装成 throw-on-use 的 proxy。如果在模块顶层立即求值,纯
 * 加载 bundle 就会炸;而浏览器里**调用方通常会显式传入 `clientInfo`**,
 * 不需要我们读 package.json。因此改成首次需要时才 import + read,失败则
 * 降级为 `'unknown'`,不阻塞调用链。
 *
 * @returns {string}
 */
let _pkgVersion = null
async function readPkgVersion() {
  if (_pkgVersion !== null) return _pkgVersion
  try {
    const { createRequire } = await import('node:module')
    _pkgVersion = createRequire(import.meta.url)('../../package.json').version
  } catch {
    // 浏览器 / 构建环境下读取失败:不阻塞,给出标记值
    _pkgVersion = 'unknown'
  }
  return _pkgVersion
}

/**
 * 默认协议版本。与 design §Overview "默认值"表一致。
 * @see Requirement 1.9
 */
const DEFAULT_PROTOCOL_VERSION = '2025-11-25'

/**
 * 默认请求超时。与 design §Overview "默认值"表一致。
 * @see Requirement 1.10
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 60000

/**
 * 默认 client 名称。
 * @see Requirement 1.8
 */
const DEFAULT_CLIENT_NAME = 'lll-web-agent'

/**
 * 构造 Promise-style 的 AbortError。与 `client.js` 内部的 `makeAbortError`
 * 同形态 —— 不 import 以保持 `client.js` 的 helper 仍然 module-private;
 * 本工厂里复用 Error + name 覆写的轻量方案即可。
 *
 * @returns {Error}
 */
function makeAbortError() {
  const err = new Error('aborted')
  err.name = 'AbortError'
  return err
}

/**
 * 从 `options` 推导用于命名空间前缀的 `serverName`。
 *
 * 策略(Req 1.7):
 *   1. 显式 `options.name`(非空字符串)优先。
 *   2. 否则按 transport 类型派生可读名:
 *      - stdio + command → `stdio:<command>`
 *      - http / streamable-http + url → `http:<url>`
 *      - sse + url → `sse:<url>`
 *   3. 上面都不满足 → `<transport>:anon`,至少保证结果是 string。
 *
 * 注意:派生值未做 sanitize —— `assignUniqueNames` 会在命名空间阶段统一
 * 消毒非 `[A-Za-z0-9_-]` 字符,此处保留原文便于后续调试日志直接读出。
 *
 * @param {object} options
 * @returns {string}
 */
function deriveServerName(options) {
  if (typeof options.name === 'string' && options.name.length > 0) {
    return options.name
  }
  const t = options.transport
  if (t === 'stdio' && typeof options.command === 'string') {
    return `stdio:${options.command}`
  }
  if ((t === 'http' || t === 'streamable-http') && typeof options.url === 'string') {
    return `http:${options.url}`
  }
  if (t === 'sse' && typeof options.url === 'string') {
    return `sse:${options.url}`
  }
  return `${t}:anon`
}

/**
 * 按需懒加载内置 transport 模块,让它们触发 `_setBuiltinTransport` 自注册。
 *
 * 本文件 **有意不** 在顶部静态 `import ./transports/stdio.js` 等,原因:
 *   - stdio / http / sse 三个模块各自 import Node 内置的 `child_process` / `http`
 *     / `fetch` 等,静态 import 会让所有调用方(哪怕只用 http transport)都付出
 *     全部 transport 的加载成本。
 *   - 懒加载后,只有真正用到对应 transport 的调用才付出那份代价。
 *
 * `import()` 失败时(模块尚未实现 / 构建文件缺失)静默忽略 —— 下一步的
 * `resolveTransport` 会拿到 `null`,最终由 `UnsupportedTransportError` 报告
 * "Available transports: ..."。这条错误消息已经足够诊断。
 *
 * @param {string | undefined} transport
 * @returns {Promise<void>}
 */
async function ensureBuiltinTransportLoaded(transport) {
  try {
    if (transport === 'stdio') {
      await import('./transports/stdio.js')
    } else if (transport === 'http' || transport === 'streamable-http') {
      await import('./transports/http.js')
    } else if (transport === 'sse') {
      await import('./transports/sse.js')
    }
  } catch {
    // 内置 transport 模块尚未实现或加载失败:交给下面 resolveTransport → null
    // → UnsupportedTransportError 的统一报告路径。此处吞错是有意的。
  }
}

/**
 * 创建并完成 handshake 的 MCP_Client。
 *
 * 工厂语义(design §Overview + Req 1.x / 3.x):
 *   1. 校验 options 是对象;非对象同步抛 TypeError(调用约定违反,不是 MCP 协议错)。
 *   2. 预检 `options.signal` 已 abort → 立即抛 AbortError,不做任何 I/O。
 *   3. 应用默认值:`clientInfo` / `protocolVersion` / `requestTimeoutMs`。
 *   4. 推导 `serverName`(见 `deriveServerName`)。
 *   5. 懒加载内置 transport 模块触发自注册。
 *   6. `resolveTransport(options.transport)` 查表;miss → `UnsupportedTransportError`。
 *   7. 调 transport factory 拿 transport 实例,用它构造 `MCP_Client`。
 *   8. `client._performHandshake()`:失败会自行完成 transport.close + state→closed,
 *      然后把已归一化的错误透传出来;工厂不做二次处理。
 *   9. 成功 → resolve `client`,`state` 落在 `'ready'`。
 *
 * 错误不包装原则:`_performHandshake` 已经把各类底层错误翻译成了 `MCPProtocolError`
 * / AbortError / `MCPClosedError` 中的正确一个,本工厂若再包装一层只会让调用方
 * 写两层 `instanceof` 判断。同样,`UnsupportedTransportError` 也是工厂层的原生
 * 错误,不经过 `_performHandshake`,直接同步抛。
 *
 * @param {object} options
 * @param {'stdio' | 'http' | 'streamable-http' | 'sse' | string} options.transport
 *   必填。transport 名称,查注册表决定用哪个 factory。
 * @param {string} [options.name]  可选显式 server 名(用于命名空间前缀与日志);未提供则按
 *   `deriveServerName` 规则派生。
 * @param {{ name: string, version: string }} [options.clientInfo]
 *   调用方身份;未提供默认 `{ name: 'lll-web-agent', version: <package.json .version> }`。
 * @param {string} [options.protocolVersion]  未提供默认 `'2025-11-25'`。
 * @param {number} [options.requestTimeoutMs]  未提供默认 `60000`。
 * @param {AbortSignal} [options.signal]  外部取消源;handshake 途中 abort → AbortError。
 * @param {(reason?: object) => void} [options.onClose]  transport-initiated 关闭回调。
 * @param {(tools: object[]) => void} [options.onToolsChanged]  `notifications/tools/list_changed`
 *   后自动 refresh 并回调的钩子。
 * @returns {Promise<MCP_Client>}
 * @throws {TypeError}            options 不是对象
 * @throws {Error}                options.signal 已 aborted(name === 'AbortError')
 * @throws {UnsupportedTransportError}  transport 名称未注册
 * @throws {MCPProtocolError}     handshake 失败(超时 / 版本不匹配 / server 返回 error)
 * @throws {MCPClosedError}       handshake 期间 transport 层故障
 *
 * @see Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 1.11, 1.12
 * @see Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
 */
export async function createMCPClient(options) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('createMCPClient: options must be an object')
  }

  // 预检 abort:调用方给了一个已经 aborted 的 signal,就不该触碰 transport。
  // 这条路径不占用任何 id、不 spawn 子进程、不发 HTTP 请求。
  if (options.signal && options.signal.aborted) {
    throw makeAbortError()
  }

  // 应用默认值。注意 `??` 只在 undefined / null 时回落到默认值,空对象 {}
  // 或空字符串 '' 仍然尊重调用方的显式传入(即便那可能是 bug 也不是本工厂的
  // 职责去纠正,让下游校验报错)。
  const clientOptions = {
    clientInfo: options.clientInfo ?? { name: DEFAULT_CLIENT_NAME, version: await readPkgVersion() },
    protocolVersion: options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    signal: options.signal,
    onClose: options.onClose,
    onToolsChanged: options.onToolsChanged,
  }

  const serverName = deriveServerName(options)

  // 懒加载内置 transport,触发自注册(见 ensureBuiltinTransportLoaded 注释)。
  await ensureBuiltinTransportLoaded(options.transport)

  const factory = resolveTransport(options.transport)
  if (!factory) {
    throw new UnsupportedTransportError(
      String(options.transport),
      listRegisteredTransportNames()
    )
  }

  // 让 transport factory 自由决定如何解释 options(url / command / headers / env 等)。
  // factory 抛错会原样透出;MCP_Client 还未构造,没有需要清理的 pending / 子进程。
  const transport = factory(options)

  const client = new MCP_Client({
    transport,
    serverName,
    options: clientOptions,
  })

  // handshake 失败时:
  //   - `_performHandshake` 内部已经完成 transport.close() + state→closed 的收敛;
  //   - 抛出的错误已归一化为 MCPProtocolError / AbortError / MCPClosedError 其中之一;
  //   - 调用方不会观察到"半初始化"的 client 实例泄漏。
  await client._performHandshake()

  return client
}

// ─────────────────────────────────────────────────────────────────────────────
// 公开类型表面 re-export
//
// 只导出调用方需要用到的表面符号。`resolveTransport` /
// `listRegisteredTransportNames` / `_setBuiltinTransport` 是框架内部协议,
// 有意不再导出 —— 内部代码直接从 `./transports/index.js` 取用。
// ─────────────────────────────────────────────────────────────────────────────

export { MCP_Client } from './client.js'
export {
  UnsupportedTransportError,
  MCPClosedError,
  MCPRequestError,
  MCPProtocolError,
} from './errors.js'
export { registerTransport } from './transports/index.js'
export {
  MCP_TOOL_METADATA_KEYS,
  attachMcpToolMetadata,
  describeMcpToolForModel,
  formatMcpToolSummary,
  readMcpToolMetadata,
  serializeMcpToolForBrowser,
  summarizeMcpOutputSchema,
} from './metadata.js'
