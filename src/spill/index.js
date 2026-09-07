/**
 * spill 存储层 —— 把过大的工具输出移出模型上下文，换成一个可取回的地址。
 *
 * 分三部分：
 *   1. `encodeSegment` / `SpillError` —— 与环境无关的基础件
 *   2. `MemorySpillStore` —— 内存后端，也是浏览器后端的可测替身
 *   3. `createNodeSpillStore` / `createIndexedDBSpillStore` —— 两个环境的实现
 *
 * 移植自 deepseek-harness 的 `dsh-spill` / `dsh-spill-local`（MIT）。
 * 契约见 docs/dsh-diff/CONTRACT-NOTES.md 的 B/C 节。
 *
 * 与 dsh 的差异：它只有 Node 文件后端且由宿主自理取回；我们要覆盖浏览器，
 * 所以抽出 SpillStore 接口 + 注册表，并内置 `spill_read` 工具（见 spill/policy.js）。
 */

// ------------------------------------------------------------------ 错误类型

/**
 * spill 存储层错误。
 *
 * 与 mcp/errors.js、agents/errors.js 同样的白名单策略：只接受标量字段，
 * 绝不吞下整个 options 对象 —— 否则 apiKey、绝对路径这类东西会漏进 err.message。
 */
export class SpillError extends Error {
  constructor(message, { code = null, locator = null, cause = null } = {}) {
    super(message)
    this.name = 'SpillError'
    this.code = code
    this.locator = locator
    if (cause) this.cause = cause
  }
}

// -------------------------------------------------------------- 路径段编码

/**
 * 把任意字符串编码成一个安全的路径段，且映射是**单射**的。
 *
 * 工具名、会话 id 都是不可信输入，直接拼进路径会有 `../` 穿越、绝对路径、
 * NUL、分隔符注入的风险。这里逐字符处理：安全集原样保留，其余编码成 `~XXXX`；
 * `~` 自身也转义，所以不同输入永远不会撞名（可逆）。
 *
 * 整段的 `.` / `..` 单独转义 —— 它们本身就是穿越语义。
 * 空串编码成 `~`，避免产生空路径段。
 *
 * 对齐 dsh 的 `encodeSegment`（spill-local/src/store.ts）。
 */
export function encodeSegment(raw) {
  if (raw.length === 0) return '~'
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = raw[i]
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch
    } else {
      out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
    }
  }
  return out
}

// ------------------------------------------------------------------ 工具函数

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** UTF-8 字节长度，Node 与浏览器通用（不依赖 Buffer） */
export function utf8Bytes(text) {
  return encoder.encode(text).length
}

/**
 * 按**字节**区间取子串，并保证不切坏多字节字符。
 *
 * 分段读取是按字节偏移的（模型拿到的 bytes 也是字节数），但切口可能落在
 * 一个字符中间。这里复用与 output-retention 相同的策略：头部跳过延续字节，
 * 尾部剪掉不完整序列 —— 宁可少给一两个字节，也不能返回乱码。
 */
export function sliceUtf8(text, offset, limit) {
  const all = encoder.encode(text)
  if (offset >= all.length) return ''
  let slice = all.subarray(offset, Math.min(all.length, offset + limit))

  // 头部：若不是从字符开头开始，跳过前导延续字节
  if (offset > 0) {
    let i = 0
    while (i < slice.length && (slice[i] & 0xc0) === 0x80) i++
    slice = slice.subarray(i)
  }
  // 尾部：若没读到末尾，剪掉结尾不完整的序列
  if (offset + limit < all.length) {
    let i = slice.length - 1
    while (i >= 0 && (slice[i] & 0xc0) === 0x80 && slice.length - i <= 3) i--
    if (i >= 0) {
      const lead = slice[i]
      const expected = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : lead < 0xf8 ? 4 : 0
      if (expected !== 0 && slice.length - i < expected) slice = slice.subarray(0, i)
    }
  }
  return decoder.decode(slice)
}

/** 生成随机 hex 前缀（Node 与浏览器都有 crypto.getRandomValues） */
function randomHex(bytes) {
  const buf = new Uint8Array(bytes)
  globalThis.crypto.getRandomValues(buf)
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 会话 id 的短稳定哈希（12 位 hex）。
 *
 * 用 FNV-1a 而不是 sha256：与 agents/artifacts.js 里的 fnv1a32 同源，
 * 零依赖、Node 与浏览器行为一致。这里只用于**目录命名**，不是密码学用途 ——
 * 目的是把不可控长度的 sessionId 变成定长安全名，真正的防护是 0700 权限
 * 和独占创建。
 */
function shortHash(input) {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 12)
}

/**
 * 默认取回提示 —— 给模型一条**可执行**的路，而不只是告诉它「被截断了」。
 *
 * 措辞把「先搜后读」摆在前面是有实测依据的：只说「用 spill_read 分段读」时，
 * 模型会从 offset 0 开始线性扫，150KB 的日志要 19 轮才能扫完，直接撞 maxRounds。
 * 对齐 dsh 的 hint 语义（"Use read with offset/limit, or grep this path to
 * search within it."），只是把它依赖的外部 grep 换成我们自带的 spill_search。
 *
 * 措辞要**尽量短**：它整条都算进 maxInlineBytes 的预留里（策略层 D5），
 * hint 越长留给预览的字节越少；长到一定程度会让小上限完全没有合规替换方案，
 * 触发 D6 保留原文 —— 那时 spill 等于没生效。
 *
 * 由后端提供而非策略层硬编码，是因为不同后端的取回方式本就可能不同 ——
 * 这一点与 dsh 的 `SpillRef.retrievalHint` 归属一致。
 */
const DEFAULT_HINT = '用 spill_search 搜关键词定位，再用 spill_read 按 offset 精读。'

// -------------------------------------------------------------- 内存后端

/**
 * 内存 SpillStore。
 *
 * 两个用途：一是测试替身，二是在既没有文件系统、也没有 IndexedDB 的
 * 环境里兜底（比如 Web Worker、或宿主显式选择不落盘）。
 *
 * 有条目上限，超出按 FIFO 淘汰最旧的 —— 它是「上下文减压阀」，
 * 不是持久存储，不该无限增长。
 */
export class MemorySpillStore {
  constructor({ maxEntries = 200 } = {}) {
    this._entries = new Map() // locator -> { sessionId, content }
    this._maxEntries = maxEntries
  }

  async saveText({ sessionId, toolName, callId, content }) {
    const locator = `spill://${shortHash(String(sessionId))}/${randomHex(6)}`
    this._entries.set(locator, { sessionId: String(sessionId), content })
    // FIFO 淘汰：Map 按插入序迭代
    while (this._entries.size > this._maxEntries) {
      const oldest = this._entries.keys().next().value
      this._entries.delete(oldest)
    }
    return { locator, bytes: utf8Bytes(content), retrievalHint: DEFAULT_HINT }
  }

  async readText(locator, { offset = 0, limit = Infinity } = {}) {
    const entry = this._entries.get(locator)
    if (!entry) {
      throw new SpillError(`spill 记录不存在或已被清理: ${locator}`, { code: 'not_found', locator })
    }
    if (offset === 0 && limit === Infinity) return entry.content
    return sliceUtf8(entry.content, offset, limit)
  }

  async clear(sessionId) {
    if (sessionId === undefined) return void this._entries.clear()
    for (const [k, v] of this._entries) {
      if (v.sessionId === String(sessionId)) this._entries.delete(k)
    }
  }
}

// -------------------------------------------------------------- Node 后端

/**
 * Node 文件后端。
 *
 * 安全措施逐条对齐 dsh 的 spill-local（这些防的是真实的本地攻击面）：
 *   - 私有根目录：mkdtemp 产生不可预测的名字，0700
 *   - 会话目录：`session-<hash>`，0700
 *   - 文件名：`<随机12位hex>-<encodeSegment(工具名)>.txt` —— 不可预测且可读
 *   - 独占创建：`open(path,'wx',0o600)`，路径已存在即失败，
 *     预植入的符号链接无法劫持写入
 *
 * `node:fs/promises` 用**动态导入**，浏览器打包时不会被拖进去
 * （与 skills/providers/local.js 同样的做法）。
 */
export function createNodeSpillStore({ root = null } = {}) {
  let resolvedRoot = root
  let fsMod = null
  let pathMod = null

  async function mods() {
    if (!fsMod) {
      fsMod = await import('node:fs/promises')
      pathMod = await import('node:path')
    }
    return { fs: fsMod, path: pathMod }
  }

  async function ensureRoot() {
    if (resolvedRoot) return resolvedRoot
    const { fs } = await mods()
    const os = await import('node:os')
    const { join } = await import('node:path')
    resolvedRoot = await fs.mkdtemp(join(os.tmpdir(), 'lll-spill-'))
    return resolvedRoot
  }

  // locator -> 绝对路径。locator 对外不透明，映射只在本后端内部持有，
  // 避免把宿主机绝对路径暴露给模型。
  const paths = new Map()
  const sessions = new Map() // sessionId -> Set<locator>

  return {
    async saveText({ sessionId, toolName, callId, content }) {
      const { fs, path } = await mods()
      const base = await ensureRoot()
      const dir = path.join(base, `session-${shortHash(String(sessionId))}`)
      await fs.mkdir(dir, { recursive: true, mode: 0o700 })

      const safeName = encodeSegment(`${toolName}.txt`)
      const filePath = path.join(dir, `${randomHex(6)}-${safeName}`)
      // 'wx' = 独占创建：路径已存在（含符号链接）直接失败
      const handle = await fs.open(filePath, 'wx', 0o600)
      try {
        await handle.writeFile(content, 'utf8')
      } finally {
        await handle.close()
      }

      const locator = `spill://${shortHash(String(sessionId))}/${path.basename(filePath)}`
      paths.set(locator, filePath)
      if (!sessions.has(String(sessionId))) sessions.set(String(sessionId), new Set())
      sessions.get(String(sessionId)).add(locator)

      return { locator, bytes: utf8Bytes(content), retrievalHint: DEFAULT_HINT }
    },

    async readText(locator, { offset = 0, limit = Infinity } = {}) {
      const filePath = paths.get(locator)
      if (!filePath) {
        throw new SpillError(`spill 记录不存在或已被清理: ${locator}`, { code: 'not_found', locator })
      }
      const { fs } = await mods()
      let content
      try {
        content = await fs.readFile(filePath, 'utf8')
      } catch (err) {
        throw new SpillError(`读取 spill 文件失败: ${locator}`, { code: 'read_failed', locator, cause: err })
      }
      if (offset === 0 && limit === Infinity) return content
      return sliceUtf8(content, offset, limit)
    },

    async clear(sessionId) {
      const { fs } = await mods()
      const targets = sessionId === undefined
        ? [...sessions.keys()]
        : [String(sessionId)]
      for (const sid of targets) {
        const locs = sessions.get(sid)
        if (!locs) continue
        for (const loc of locs) {
          const p = paths.get(loc)
          // 清理是尽力而为：删不掉不该让调用方失败
          if (p) { try { await fs.rm(p, { force: true }) } catch { /* 忽略 */ } }
          paths.delete(loc)
        }
        sessions.delete(sid)
      }
    },

    /** 仅供测试断言用：locator → 真实路径。不属于 SpillStore 公开契约。 */
    _pathOf(locator) {
      return paths.get(locator) ?? null
    },
  }
}

// ---------------------------------------------------- 浏览器 IndexedDB 后端

/**
 * 浏览器 IndexedDB 后端。
 *
 * 安全模型和 Node 完全不同：数据本来就在同源沙箱里，不存在同机其他用户
 * 读取的问题，所以不需要权限位和独占创建。但多了两件 Node 不用管的事：
 *   - **配额**：写入可能抛 QuotaExceededError，由策略层降级处理（D7）
 *   - **清理**：会话结束要清，否则用户的浏览器存储会一直涨
 */
export function createIndexedDBSpillStore({ dbName = 'lll-agent-spill', storeName = 'spills' } = {}) {
  let dbPromise = null

  function openDB() {
    if (dbPromise) return dbPromise
    dbPromise = new Promise((resolve, reject) => {
      const req = globalThis.indexedDB.open(dbName, 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(storeName)) {
          const os = db.createObjectStore(storeName, { keyPath: 'locator' })
          os.createIndex('sessionId', 'sessionId', { unique: false })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(new SpillError('打开 IndexedDB 失败', { code: 'db_open_failed', cause: req.error }))
    })
    return dbPromise
  }

  /**
   * 把一次 IndexedDB 事务包成 Promise。
   *
   * 注意 `req.result` 必须在 **oncomplete 时**读取，不能在回调返回时就读 ——
   * 那时请求还没跑完，拿到的是 undefined。更要命的是「记录不存在」时
   * `req.result` 也是 undefined，两种情况混在一起会让 `!rec` 的判断失效：
   * 表现为 readText 对已删除的 locator 返回 undefined 而不是抛错。
   */
  function tx(db, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeName, mode)
      const store = t.objectStore(storeName)
      let req
      try { req = fn(store) } catch (err) { reject(err); return }
      // 事务提交后再取结果：此时请求一定已经完成。
      t.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined)
      t.onerror = () => reject(t.error)
      t.onabort = () => reject(t.error)
    })
  }

  return {
    async saveText({ sessionId, toolName, callId, content }) {
      const db = await openDB()
      const locator = `spill://${shortHash(String(sessionId))}/${randomHex(6)}`
      try {
        await tx(db, 'readwrite', store => store.put({
          locator, sessionId: String(sessionId), toolName, content,
        }))
      } catch (err) {
        // 配额超限等 —— 交给策略层降级（保留原始内容，不影响工具调用）
        throw new SpillError('写入 IndexedDB 失败', { code: 'write_failed', locator, cause: err })
      }
      return { locator, bytes: utf8Bytes(content), retrievalHint: DEFAULT_HINT }
    },

    async readText(locator, { offset = 0, limit = Infinity } = {}) {
      const db = await openDB()
      const rec = await tx(db, 'readonly', store => store.get(locator))
      if (!rec) {
        throw new SpillError(`spill 记录不存在或已被清理: ${locator}`, { code: 'not_found', locator })
      }
      if (offset === 0 && limit === Infinity) return rec.content
      return sliceUtf8(rec.content, offset, limit)
    },

    async clear(sessionId) {
      const db = await openDB()
      // 游标删除是**逐条异步**的：不能只发起 openCursor 就返回，
      // 必须把整个游标遍历包在事务的 oncomplete 里等它走完。
      // （早期版本在 tx() 的同步回调里发起游标，事务会在遍历结束前就 complete，
      //   表现为「clear() 返回了但内容还在」—— 这个只有在真实浏览器里才暴露。）
      await new Promise((resolve, reject) => {
        const t = db.transaction(storeName, 'readwrite')
        const store = t.objectStore(storeName)
        if (sessionId === undefined) {
          store.clear()
        } else {
          const idx = store.index('sessionId')
          const req = idx.openCursor(IDBKeyRange.only(String(sessionId)))
          req.onsuccess = () => {
            const cursor = req.result
            if (!cursor) return // 遍历结束，等事务 complete
            cursor.delete()
            cursor.continue()
          }
          req.onerror = () => reject(req.error)
        }
        t.oncomplete = () => resolve()
        t.onerror = () => reject(t.error)
        t.onabort = () => reject(t.error)
      })
    },
  }
}

// ------------------------------------------------------------------ 自动选择

/**
 * 按运行环境挑一个后端。
 *
 * Node → 文件；浏览器且有 IndexedDB → IndexedDB；其余 → 内存。
 * 宿主可以显式传 store 覆盖（比如想放到自己的对象存储里）。
 */
export function createDefaultSpillStore(options = {}) {
  const isNode = typeof process !== 'undefined' && process.versions?.node
  if (isNode) return createNodeSpillStore(options)
  if (typeof globalThis.indexedDB !== 'undefined') return createIndexedDBSpillStore(options)
  return new MemorySpillStore(options)
}
