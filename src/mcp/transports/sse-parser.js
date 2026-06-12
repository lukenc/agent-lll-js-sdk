/**
 * SSE 帧解析器 — Server-Sent Events wire format parser
 *
 * 为 streamable-http (`./http.js`) 与 legacy SSE (`./sse.js`) 两条 transport 共享的
 * 底层帧解析层。它把 UTF-8 字节流(调用方已经过 `TextDecoder` 得到字符串 chunk)
 * 增量解析为一串 `{ event?, data }` 事件,完全对齐 WHATWG / MDN 的 SSE wire format:
 *
 * - 流文本由若干 event block 组成,block 之间以**空行**分隔。
 * - block 内每一行形如 `field:value` 或 `field: value`(单个空格可选);首字符为
 *   `:` 的是注释行,忽略。
 * - `field === 'event'` → 设置当前 block 的事件类型。
 * - `field === 'data'` → 累积 data 行;最终 emit 的 `data` 字段为所有 data 行
 *   以 `'\n'` 拼接的结果。
 * - 其它已知字段(`id` / `retry`)与未知字段一律忽略 —— 本 parser 不维护 last-event-id,
 *   也不处理 retry 策略;MCP 场景不需要这些。
 * - 行终止符接受 `\r\n` / `\n` / `\r` 三种;`\r` 可能跨 chunk 拆到两次 `push` 里,
 *   本实现对此做了显式缓冲处理(见 `push` 实现注释)。
 *
 * ## API 形状
 *
 * ```ts
 * const parser = createSseParser()
 * parser.push(chunkString)                 // 零次或多次投喂字符串
 * for await (const evt of parser.events) { // 单消费者异步迭代
 *   evt.data // string
 *   evt.event // string | undefined(仅当 server 显式发 `event:` 时存在)
 * }
 * parser.close()                           // 终止 events 迭代,使 for-await 自然退出
 * ```
 *
 * ## 使用约定
 *
 * - **单消费者**:`events[Symbol.asyncIterator]()` 可多次调用,但多个消费者之间会
 *   竞争同一个内部队列(每个事件只被其中一个消费)。transport 层只应该开一条消费
 *   循环,与 `close()` 配对。
 * - **背压**:解析器把事件囤积在内存队列里,`push` 永不异步阻塞。调用方若担心
 *   内存占用,应当自行在 transport 层控制流。MCP 单次 POST 响应通常很短,不会有
 *   压力。
 * - **零依赖**:仅用 JS 内置字符串操作,不引入任何 npm 包 (Req 9.2 / 9.3)。
 *
 * ## 规则细节
 *
 * 1. 空行(`\n\n`)触发一次 dispatch;只在 block 内至少出现过一个 `data:` 字段时
 *    才 emit 事件(对齐 SSE 规范的 "If the data buffer is empty, return" 条款)。
 *    仅含注释或仅含 `event:` 的 block 被静默丢弃。
 * 2. field 名和 value 的切分:取首个 `:` 前为字段名,其后为 value;若 value 以
 *    单个 `' '` 起首,去掉这一个 `' '`(SSE 规范行为)。没有 `:` 的行,整行即
 *    字段名,value 为空字符串。
 * 3. **流结束时的 trailing 不完整 block**:`close()` 不会 flush 已经累积但
 *    未遇到 `\n\n` 的 partial block —— 与 SSE 规范 "reset the stream"
 *    语义一致,也避免 MCP 在 keep-alive 半关场景下误 emit 半条 JSON-RPC 消息。
 *
 * @see Requirements 2.4(通用帧解析层);Property 15(SSE 帧解析 round-trip)
 */

/**
 * 创建一个增量 SSE 解析器。返回对象含三个成员:
 *
 * - `push(chunk: string)`:投喂字符串;内部按字符扫描行,完整 block 解析后入队,
 *   不完整的尾部留在内部缓冲等待下次 push。非 string 输入、null、undefined 静默忽略。
 *   调用 `close()` 之后再 push 同样静默忽略。
 * - `events`:一个 async iterable,每次迭代 yield 一个 `{ event?: string, data: string }`。
 *   `close()` 被调用且队列耗尽后自然结束(`for await` 的 loop 正常退出,不抛异常)。
 * - `close()`:幂等,将解析器置为已关闭状态,唤醒所有等待中的 iterator 消费者,
 *   让它们看到 `done: true`。
 *
 * @returns {{
 *   push: (chunk: string) => void,
 *   events: AsyncIterable<{ event?: string, data: string }>,
 *   close: () => void,
 * }}
 */
export function createSseParser() {
  // 未消费的原始字符。处理 `\r` 时会立即消费该行,因此 buffer 末尾不会残留孤立 `\r`。
  let buffer = ''

  // 若上一次消费行结束于 `\r`,则下一次看到的 `\n` 视为 `\r\n` 的后半,需要跳过
  // 以免触发一次假的空行。跨 chunk 的 `\r\n` 分割(`\r` 在 chunk_k 末尾,`\n` 在
  // chunk_{k+1} 开头)也由该标志兜住。
  let pendingLfSkip = false

  // 当前 block 的事件类型(`event:` 字段)。undefined 表示 server 未显式设置。
  /** @type {string | undefined} */
  let currentEvent = undefined
  // 当前 block 的 data 行数组;最终以 '\n' 连接。
  /** @type {string[]} */
  let currentData = []
  // 当前 block 是否已出现过至少一个 `data:` 字段 —— 决定是否 dispatch。
  let hasData = false

  // 事件队列:push 过程中产生的事件放这里,等 events 消费者异步读取。
  /** @type {Array<{ event?: string, data: string }>} */
  const queue = []

  // 等待队列:events 消费者在队列为空时注册的 resolver,push / close 时唤醒。
  /** @type {Array<() => void>} */
  const waiters = []

  let closed = false

  /**
   * 应用当前累积的 event / data 缓冲,若本 block 含 data 字段则入队。
   * 无论是否 emit,重置 block 缓冲状态进入下一 block。
   */
  function dispatchEvent() {
    if (hasData) {
      /** @type {{ event?: string, data: string }} */
      const evt = { data: currentData.join('\n') }
      if (currentEvent !== undefined) evt.event = currentEvent
      queue.push(evt)
      // 唤醒一个等待中的消费者(若有)。多消费者场景不做额外协调。
      const waiter = waiters.shift()
      if (waiter) waiter()
    }
    currentEvent = undefined
    currentData = []
    hasData = false
  }

  /**
   * 处理一行已经剥离行终止符的文本。空行触发 dispatch;`:` 起首的行是注释;
   * 其余按 `field:value` 解析,仅响应 `event` / `data`,其他字段静默忽略。
   */
  function processLine(line) {
    if (line === '') {
      // SSE 规范:空行 = dispatch event。
      dispatchEvent()
      return
    }
    if (line.charCodeAt(0) === 0x3a /* ':' */) {
      // Comment line — ignore entirely.
      return
    }
    const colonIdx = line.indexOf(':')
    let field
    let value
    if (colonIdx === -1) {
      // 无 ':' 的行:整行为 field 名,value 为空串(SSE 规范规定这一行为)。
      field = line
      value = ''
    } else {
      field = line.slice(0, colonIdx)
      value = line.slice(colonIdx + 1)
      // SSE 规范:若 value 以单个空格起首,去掉这一个空格(精确一个,不消耗更多)。
      if (value.charCodeAt(0) === 0x20 /* ' ' */) value = value.slice(1)
    }

    if (field === 'event') {
      currentEvent = value
    } else if (field === 'data') {
      currentData.push(value)
      hasData = true
    }
    // 'id' / 'retry' / 未知字段:忽略。
  }

  /**
   * 从当前 buffer 位置 i 处识别行终止符并处理当前行。返回新的 i(行处理完毕后从 0 开始),
   * 或 `-1` 表示遇到尾部不完整的 `\r`,需要等待更多 chunk。
   */
  function push(chunk) {
    if (closed) return
    if (typeof chunk !== 'string' || chunk.length === 0) return
    buffer += chunk

    // 逐字符扫描,识别 `\n` / `\r\n` / `\r` 三种行终止。对于 `\r` 与 `\n` 跨 chunk
    // 拆开的情况,由 `pendingLfSkip` 吸收:见到 `\r` 立即处理本行并置标志;下一次
    // 看到的 `\n`(无论是本 chunk 继续扫描还是下一 chunk 第一个字符)被静默跳过。
    let i = 0
    while (i < buffer.length) {
      const ch = buffer.charCodeAt(i)
      if (ch === 0x0a /* '\n' */) {
        if (pendingLfSkip) {
          // `\r\n` 的后半,只是消费掉不产生新行。
          pendingLfSkip = false
          buffer = buffer.slice(i + 1)
          i = 0
          continue
        }
        const line = buffer.slice(0, i)
        buffer = buffer.slice(i + 1)
        processLine(line)
        i = 0
      } else if (ch === 0x0d /* '\r' */) {
        // `\r` 永远立即触发一次行结束,不再等待 `\n`;若后随 `\n`,由
        // pendingLfSkip 在下一次迭代或下一 chunk 中吸收。
        const line = buffer.slice(0, i)
        buffer = buffer.slice(i + 1)
        pendingLfSkip = true
        processLine(line)
        i = 0
      } else {
        // 任何非终止符字符:如果之前标记了 pendingLfSkip,那现在可以清掉 —— 它只
        // 对紧跟 `\r` 的 `\n` 有效。
        pendingLfSkip = false
        i++
      }
    }
  }

  function close() {
    if (closed) return
    closed = true
    // 按规范,流 reset 时丢弃未完成的 block(不 flush 半条事件)。
    buffer = ''
    pendingLfSkip = false
    currentEvent = undefined
    currentData = []
    hasData = false
    // 唤醒所有等待中的消费者,让它们走到 closed 分支返回 done。
    while (waiters.length > 0) {
      const waiter = waiters.shift()
      if (waiter) waiter()
    }
  }

  const events = {
    /**
     * 单次迭代 yield 一条事件;在 close() 后仍会先消费完队列中已经在位的事件,
     * 再以 `done: true` 终止 —— 与 Node `Readable` 的关闭语义对齐。
     */
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (queue.length > 0) {
          yield /** @type {{ event?: string, data: string }} */ (queue.shift())
          continue
        }
        if (closed) return
        // 队列暂空且未关闭 —— 注册一个 resolver 等待 push / close 唤醒。
        await new Promise((resolve) => { waiters.push(resolve) })
      }
    },
  }

  return { push, events, close }
}
