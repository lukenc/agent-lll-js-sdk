/**
 * MCP 传输注册表 — Transport Registry for MCP Client Integration.
 *
 * 本模块维护一张 `Map<name, MCP_Transport_Factory>`,供 `createMCPClient` 根据
 * `options.transport` 字段查表。它既承载四个内置 transport 的名字
 * (`'stdio' | 'http' | 'streamable-http' | 'sse'`),也对外暴露 `registerTransport`
 * 让调用方注入自定义 transport(例如 websocket)。
 *
 * ## 自注册(self-register)设计
 *
 * 本文件 **不 import** 任何 `./stdio.js` / `./http.js` / `./sse.js`,以避免
 * `transports/index.js ↔ transports/<xxx>.js` 的循环依赖。取而代之:
 *
 *   1. 内置 transport 模块(`./stdio.js` 等)在模块顶部 `import` 本文件并调用
 *      `_setBuiltinTransport(name, factory)` 把自己的 factory 注册进来。
 *   2. `createMCPClient` 的工厂在选择 transport 前按需 `import` 对应文件(例如
 *      `await import('./transports/stdio.js')`),从而触发自注册。
 *   3. 在相应内置模块被加载之前,`resolveTransport('stdio')` 返回 `null`,
 *      调用方应当在工厂层统一处理这种懒加载顺序。
 *
 * ## 'streamable-http' 别名
 *
 * MCP 2025-03-26 规范把 `'streamable-http'` 视作 `'http'` 的历史名。本注册表把这
 * 两个键**绑定到同一个 factory 引用**:无论内置 http 模块以哪个名字调用
 * `_setBuiltinTransport`,两个 key 都会被同步更新。
 *
 * @see Requirements 1.5, 1.6, 2.6, 2.7, 2.8
 */

/**
 * 保留名集合 —— 这四个名字由内置 transport 独占,`registerTransport` 不允许覆盖。
 *
 * 注意 `Object.freeze(Set)` 仅冻结 Set 实例的**属性**而非内容;出于防御目的,对外
 * 暴露的 `RESERVED_NAMES` 只用于只读判断,外部如果调用 `.add` / `.delete` 仍会
 * 修改实例。调用方不应这样做;未来如有需要可改成 `new Proxy` 包装。
 *
 * @type {Set<string>}
 */
export const RESERVED_NAMES = Object.freeze(new Set([
  'stdio',
  'http',
  'streamable-http',
  'sse',
]))

/**
 * 模块级单例注册表。key 为 transport 名称,value 为 factory 函数。
 *
 * @type {Map<string, Function>}
 */
const registry = new Map()

/**
 * 内置 transport 的自注册入口 —— 只有 `./stdio.js` / `./http.js` / `./sse.js`
 * 应该调用。下划线前缀表示"框架内部使用"。与 `registerTransport` 的差异:
 *   - 不校验 RESERVED_NAMES(保留名就是给它用的)。
 *   - 对 `'http'` / `'streamable-http'` 做别名同步:设置任一名都会同时设置另一名,
 *     确保 `resolveTransport('streamable-http')` 和 `resolveTransport('http')`
 *     返回同一引用,且两者都出现在 `listRegisteredTransportNames()` 中。
 *
 * @param {'stdio' | 'http' | 'streamable-http' | 'sse'} name  内置 transport 名
 * @param {Function} factory  `(options) => MCP_Transport` 形态的构造函数
 * @throws {TypeError} factory 不是 function。
 * @throws {Error} name 不在保留名集合内(防止误用)。
 */
export function _setBuiltinTransport(name, factory) {
  if (typeof factory !== 'function') {
    throw new TypeError('_setBuiltinTransport: factory must be a function')
  }
  if (!RESERVED_NAMES.has(name)) {
    throw new Error(
      `_setBuiltinTransport: "${String(name)}" is not a reserved built-in name`
    )
  }
  registry.set(name, factory)
  // 'http' 与 'streamable-http' 是别名,任何一边更新都同步另一边。
  if (name === 'http' || name === 'streamable-http') {
    registry.set('http', factory)
    registry.set('streamable-http', factory)
  }
}

/**
 * 注册自定义 transport。
 *
 * Requirement 2.7 要求框架导出此函数,Requirement 2.8 要求对保留名抛错。
 *
 * @param {string} name  自定义 transport 名称(非空字符串)
 * @param {Function} factory  `(options) => MCP_Transport` 形态的构造函数
 * @throws {TypeError} name 不是非空字符串或 factory 不是 function。
 * @throws {Error} name 是保留名(message 含 `transport name "..." is reserved`)。
 *
 * @see Requirement 2.7, 2.8
 */
export function registerTransport(name, factory) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('registerTransport: name must be a non-empty string')
  }
  if (typeof factory !== 'function') {
    throw new TypeError('registerTransport: factory must be a function')
  }
  if (RESERVED_NAMES.has(name)) {
    throw new Error(`transport name "${name}" is reserved`)
  }
  registry.set(name, factory)
}

/**
 * 解析 transport 名称为 factory 函数。
 *
 * - 命中 → 返回 factory 引用。
 * - 未命中(含内置名但对应模块尚未被 import)→ 返回 `null`。
 * - name 非字符串或空字符串 → 返回 `null`(total function,便于工厂层统一处理)。
 *
 * @param {string} name
 * @returns {Function | null}
 *
 * @see Requirement 1.6
 */
export function resolveTransport(name) {
  if (typeof name !== 'string' || name.length === 0) return null
  return registry.get(name) ?? null
}

/**
 * 列出当前所有已注册的 transport 名称(内置已加载 + 自定义)。
 *
 * 主要给 `UnsupportedTransportError` 消费,以便在 message 中输出
 * "available transports: ..." 便于定位配置错误。返回的数组是当前 `registry`
 * 的快照拷贝,调用方修改它不影响内部状态。
 *
 * @returns {string[]}
 *
 * @see Requirement 1.6, 10.1
 */
export function listRegisteredTransportNames() {
  return Array.from(registry.keys())
}
