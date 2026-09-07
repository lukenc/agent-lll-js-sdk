/**
 * 单次 attempt 的截止时间（`subagents.retry.attemptTimeoutMs`）—— 报告 §10 建议 #2。
 *
 * **缺陷**：0.9.0 的 CHANGELOG 把这件事写成"刻意留白"：一个卡在挂死工具调用（或挂死
 * 的非流式 LLM 请求）上的子 agent 只受 `maxRounds` 与调用方 `signal` 约束。而
 * `maxRounds` 数的是**轮**，一轮永不返回就永远不递增 —— 于是那个界根本不存在。后果
 * 有两层：`run_in_background: false` 时父 agent 的那次工具调用**无上界地** await 下去
 * （keep-alive 管不着它，它压根没走到"最终回答"那个分支）；后台派发时挂死的子 agent
 * 永久占着它那一个 depth 层的并发槽，四个就把 `maxConcurrent: 4` 的池坐死。
 *
 * **dsh 的对照**：`packages/subagent/subagent/src/continuation.ts` 里
 * `timeout|Timeout|deadline` **零命中** —— dsh 没有"单次 attempt 截止"这个东西。它的
 * 同类机制是两处更细的界：`packages/guard/timeout-policy` 给**每次工具调用**装一个
 * `deadline`，`packages/llm/llm-deepseek/src/adapter.ts:477` 给**每次流读取**装一个
 * 300s 的 `idleWatchdog`。我们拿不到第二处 —— 子 agent 走的是非流式 `syncChat`，一次
 * `await` 就是一整段黑盒，没有"空闲"可观测。所以这里移植的是 dsh 的**机制**（
 * `packages/util/timeout`：signal 融合、先到者胜、能力自有的分类、构造期校验），落在
 * 一个 dsh 没有的边界上，而不是抄一个 dsh 的功能。
 *
 * 本文件按 dsh `packages/util/timeout/tests/timeout.spec.ts` 逐条对照钉住：
 *   - 到点 abort，reason 是自有的分类载体（不是裸字符串）。
 *   - `clear()` 之后表不再触发 —— 对应它的 `[Symbol.dispose]`。**这条不是整洁问题**：
 *     漏掉的话每次 attempt 都留下一个最长 10 分钟的 `setTimeout`，Node 的事件循环因此
 *     不退出，"后台 agent settle 之后进程自然结束"这条既有承诺被推翻。
 *   - 取消先到 → 分类是**取消**，不是超时（它的 "cancel wins when it fires before the
 *     timeout"）。上游预先已 aborted → 立即转发，不等满。
 *   - 超时先到 → 之后上游再 abort 是 no-op（它的 "timeout wins when it fires before
 *     upstream cancellation"）。
 *   - `<= 0` / `null` → 不装表，只转发上游（它的 `timeoutMs <= 0` 分支）。
 *
 * 与 dsh 的两处**有意**分歧，都写在下面的用例里：`Infinity` 不是"不设界"的写法而是构造期
 * 报错（与 `maxConsecutiveWakes` 同款，"不设界"正是这个字段存在的理由所要防的），显式
 * 关闭用 `null`（与 `ask.timeoutMs` 默认 `null` = 永不超时同一拼法）；以及成功的 attempt
 * 即使与截止时刻擦肩也**照收**（dsh 的 timeout-policy 会丢弃工具结果，但它的结果可能是
 * 半截的，而一次跑完的 attempt 拿到的是完整报告 —— 丢掉它去重跑是纯烧 token）。
 */
import test from 'node:test'
import assert from 'node:assert'
import { getEventListeners } from 'node:events'
import { RuntimeHistory } from '../runtime-history.js'
import { AgentRegistry } from './registry.js'
import { ArtifactTrack } from './artifacts.js'
import {
  SubagentRunner, classifyFailure, RETRYABLE_KINDS,
  attemptDeadline, AttemptTimeoutError,
  DEFAULT_ATTEMPT_TIMEOUT_MS, normalizeAttemptTimeoutMs,
} from './runner.js'
import { resolveModelAliases } from './models.js'
import { registerAgentType, resetAgentTypes, getAgentType } from './types.js'
import { AgentTypeError } from './errors.js'
import { Agent } from '../agent.js'

const parent = {
  _providerName: 'openai',
  model: 'gpt-4o', apiKey: 'sk-main', url: 'https://main/v1',
  simpleModel: 'gpt-4o-mini', simpleApiKey: 'sk-simple', simpleUrl: 'https://simple/v1',
  knowledgeBase: null,
  tokenBudget: null,
  validateStreamCompletion: false,
  tools: [{ name: 'read_file', description: 'r', parameters: {}, execute: async () => 'x' }],
  hooks: {},
}

function abortError(reason) {
  if (reason instanceof Error) return reason
  const err = new Error('aborted')
  err.name = 'AbortError'
  return err
}

/**
 * 一个**挂死**的假子 Agent：`chat` 永不 resolve，只在 signal abort 时按调用方的
 * reason reject —— 与真实的 `syncChat` 被 fetch abort 打断时同形。
 */
function hangingAgentFactory() {
  const calls = []
  const factory = (options) => ({
    options,
    lastStopReason: null,
    _bus: { on() {}, off() {} },
    on() { return this }, off() { return this },
    getLastRunMetrics: () => null,
    async closeMCPClients() {},
    async chat(_contract, { signal } = {}) {
      calls.push({ signal })
      if (signal?.aborted) throw abortError(signal.reason)
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(abortError(signal.reason)), { once: true })
      })
    },
  })
  factory.calls = calls
  return factory
}

/** 一个**慢但会成功**的假子 Agent，用来验证"没有表就不该被掐"。 */
function slowAgentFactory(delayMs, text = '慢但完整的报告') {
  const calls = []
  const factory = (options) => ({
    options,
    lastStopReason: null,
    _bus: { on() {}, off() {} },
    on() { return this }, off() { return this },
    getLastRunMetrics: () => null,
    async closeMCPClients() {},
    async chat(_contract, { signal } = {}) {
      calls.push({ signal })
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, delayMs)
        signal?.addEventListener('abort', () => {
          clearTimeout(t)
          reject(abortError(signal.reason))
        }, { once: true })
      })
      return text
    },
  })
  factory.calls = calls
  return factory
}

function makeRunner(createAgent, opts = {}) {
  const sharedHistory = new RuntimeHistory()
  const registry = new AgentRegistry({ maxConcurrent: 4 })
  const artifacts = new ArtifactTrack({ sharedHistory })
  const events = []
  const runner = new SubagentRunner({
    parent, registry, artifacts, sharedHistory,
    aliases: resolveModelAliases(parent, undefined),
    // backoffMs: 0 —— 真实指数退避会让这个文件多睡好几秒，而退避策略另有测试覆盖。
    opts: { retry: { backoffMs: 0 }, maxDepth: 2, ...opts },
    emit: (type, payload) => events.push({ type, payload }),
    createAgent,
  })
  return { runner, registry, events }
}

function makeHandle(registry, overrides = {}) {
  return registry.create({
    type: 'general-purpose', description: 'Audit auth flow',
    parentAgentId: 'main', depth: 1,
    model: { alias: 'fast', model: 'gpt-4o-mini', apiKey: 'sk-simple', url: 'https://simple/v1' },
    ...overrides,
  })
}

const of = (events, type) => events.filter(e => e.type === type).map(e => e.payload)

// ============================ attemptDeadline：机制 ============================

test('到点 abort，reason 是自有的分类载体而不是裸字符串', async () => {
  const d = attemptDeadline(undefined, 10)
  assert.strictEqual(d.signal.aborted, false)
  assert.strictEqual(d.timedOut(), undefined, '还没到点')
  await new Promise(r => setTimeout(r, 40))
  assert.strictEqual(d.signal.aborted, true)
  const reason = d.timedOut()
  assert.ok(reason instanceof AttemptTimeoutError)
  assert.strictEqual(reason.timeoutMs, 10)
  assert.match(reason.message, /timed out after 10ms/)
  assert.strictEqual(d.signal.reason, reason, 'signal.reason 就是它，宿主拿得到')
  d.clear()
})

test('clear() 之后表不再触发（dsh 的 [Symbol.dispose] 语义）', async () => {
  // 漏掉 clear 的后果不是"多一个定时器"这么轻：Node 的事件循环会一直等到它触发，
  // 于是每个跑完的子 agent 都给宿主进程留下最长 attemptTimeoutMs（默认 10 分钟）
  // 的悬挂时间 —— README「后台 agent 跨 chat() 存活」那条承诺会变成"而且跑完了也不退出"。
  const d = attemptDeadline(undefined, 15)
  d.clear()
  await new Promise(r => setTimeout(r, 50))
  assert.strictEqual(d.signal.aborted, false, 'clear 之后不该再 abort')
  assert.strictEqual(d.timedOut(), undefined)
})

test('clear() 摘掉上游 signal 上的监听器（重试路径不堆积）', async () => {
  // 回归形状与 `nextEvent` 那条一样：`{ once: true }` 只在**真的 abort** 时自摘，
  // 而每次 attempt 都往同一个调用方 signal 上融一个新表 —— 三次重试就是三个常驻
  // 监听器，maxAttempts 大一点就是 MaxListenersExceededWarning。
  const ac = new AbortController()
  for (let i = 0; i < 6; i++) {
    const d = attemptDeadline(ac.signal, 5000)
    assert.strictEqual(d.signal.aborted, false)
    d.clear()
  }
  assert.strictEqual(getEventListeners(ac.signal, 'abort').length, 0)
})

test('取消先到 → 分类是取消，不是超时', async () => {
  // dsh：cancel wins when it fires before the timeout。这条是"主动取消不被误报成
  // 子 agent 出故障"的前提 —— `cancelHandle` 走的就是上游 abort。
  const ac = new AbortController()
  const d = attemptDeadline(ac.signal, 5000)
  const cancelErr = Object.assign(new Error('user cancelled'), { name: 'AbortError' })
  ac.abort(cancelErr)
  assert.strictEqual(d.signal.aborted, true)
  assert.strictEqual(d.signal.reason, cancelErr, '先到者的 reason 被采纳')
  assert.strictEqual(d.timedOut(), undefined, '我们的表没赢，就不该被读成超时')
  d.clear()
})

test('上游预先已 aborted → 立即转发，不等满 attemptTimeoutMs', async () => {
  const ac = new AbortController()
  ac.abort()
  const startedAt = Date.now()
  const d = attemptDeadline(ac.signal, 5000)
  assert.strictEqual(d.signal.aborted, true, '当场就是 aborted')
  assert.strictEqual(d.timedOut(), undefined)
  assert.ok(Date.now() - startedAt < 50)
  d.clear()
})

test('超时先到 → 之后上游再 abort 是 no-op', async () => {
  // dsh：timeout wins when it fires before upstream cancellation。融合信号只认第一个。
  const ac = new AbortController()
  const d = attemptDeadline(ac.signal, 10)
  await new Promise(r => setTimeout(r, 40))
  const winner = d.timedOut()
  assert.ok(winner instanceof AttemptTimeoutError)
  ac.abort(Object.assign(new Error('late cancel'), { name: 'AbortError' }))
  assert.strictEqual(d.timedOut(), winner, '分类不被迟到的取消改写')
  assert.strictEqual(d.signal.reason, winner)
  d.clear()
})

test('null / <= 0 → 不装表，signal 就是上游本身', async () => {
  const ac = new AbortController()
  for (const off of [null, 0, -1]) {
    const d = attemptDeadline(ac.signal, off)
    assert.strictEqual(d.signal, ac.signal, `${String(off)} 不该另造一个 signal`)
    assert.strictEqual(d.timedOut(), undefined)
    d.clear()
    d.clear() // 幂等
  }
  assert.strictEqual(ac.signal.aborted, false)
})

// ============================ 分类 ============================

test('AttemptTimeoutError 被判成 timeout，而 timeout 是可重试类', () => {
  const err = new AttemptTimeoutError(600000)
  assert.strictEqual(classifyFailure(err), 'timeout')
  assert.strictEqual(RETRYABLE_KINDS.has('timeout'), true, '这条支路 0.9.0 起就是死代码')
  // 消息本身也落在既有的 /timed out/i 支路上 —— 两条路指向同一个结论，改文案不会
  // 让分类静默退化成不可重试的 tool_error。
  assert.strictEqual(classifyFailure(new Error('subagent attempt timed out after 5ms')), 'timeout')
})

// ============================ 配置校验 ============================

test('默认值是 600000（设计文档 2026-07-30 就写下的那个数）', () => {
  assert.strictEqual(DEFAULT_ATTEMPT_TIMEOUT_MS, 600000)
  // 内置类型不表态，交给回退链的最后一环。
  assert.strictEqual(getAgentType('general-purpose').attemptTimeoutMs, undefined)
})

test('normalizeAttemptTimeoutMs：undefined 交给回退链，null 是显式关闭', () => {
  assert.strictEqual(normalizeAttemptTimeoutMs(undefined), undefined)
  assert.strictEqual(normalizeAttemptTimeoutMs(null), null)
  assert.strictEqual(normalizeAttemptTimeoutMs(1500), 1500)
})

test('非法取值在构造期抛 TypeError（不留到调用期）', () => {
  // 与 `maxConsecutiveWakes` / `spill.maxToolResultBytes` 同一先例：留到调用期抛的话，
  // 一次本来成功的 attempt 会变成整个 run 报错。
  const baseOpts = { provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o' }
  for (const bad of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, '600', true, {}]) {
    assert.throws(
      () => new Agent({ ...baseOpts, subagents: { retry: { attemptTimeoutMs: bad } } }),
      /attemptTimeoutMs/,
      `应当拒绝 ${JSON.stringify(bad)}`,
    )
  }
  // null 合法（显式关闭），undefined 合法（用默认）。
  assert.doesNotThrow(() => new Agent({ ...baseOpts, subagents: { retry: { attemptTimeoutMs: null } } }))
  assert.doesNotThrow(() => new Agent({ ...baseOpts, subagents: {} }))
})

test('Agent_Type.attemptTimeoutMs 同样校验，且 null 能穿过回退链', () => {
  try {
    assert.throws(
      () => registerAgentType({
        name: 'bad-timeout', description: 'd', systemPrompt: 's', attemptTimeoutMs: 0,
      }),
      AgentTypeError,
    )
    assert.throws(
      () => registerAgentType({
        name: 'bad-timeout2', description: 'd', systemPrompt: 's', attemptTimeoutMs: '600',
      }),
      AgentTypeError,
    )
    registerAgentType({
      name: 'unbounded', description: 'd', systemPrompt: 's', attemptTimeoutMs: null,
    })
    assert.strictEqual(getAgentType('unbounded').attemptTimeoutMs, null)
    registerAgentType({ name: 'bounded', description: 'd', systemPrompt: 's', attemptTimeoutMs: 1234 })
    assert.strictEqual(getAgentType('bounded').attemptTimeoutMs, 1234)
  } finally {
    resetAgentTypes()
  }
})

// ============================ runner 集成 ============================

test('挂死的 attempt 到点被判 timeout 并重试，用尽后只发一次 agent.failed', async () => {
  const createAgent = hangingAgentFactory()
  const { runner, registry, events } = makeRunner(createAgent, {
    retry: { maxAttempts: 3, backoffMs: 0, attemptTimeoutMs: 20 },
  })
  const handle = makeHandle(registry)
  const ac = new AbortController()

  const startedAt = Date.now()
  const out = await runner.run(handle, { prompt: '做课件', signal: ac.signal })
  const elapsed = Date.now() - startedAt

  assert.strictEqual(createAgent.calls.length, 3, '每次 attempt 一个全新实例，共 maxAttempts 次')
  assert.match(out, /^\[agent:general-purpose-1 failed\]/m)
  assert.match(out, /failureKind=timeout/, '终态必须说清是超时，不是笼统的故障')
  assert.strictEqual(handle.state, 'failed')
  assert.strictEqual(handle.attempt, 3)

  const retries = of(events, 'agent.retry')
  assert.strictEqual(retries.length, 2, 'maxAttempts=3 → 两次重试')
  assert.deepStrictEqual(retries.map(r => r.failureKind), ['timeout', 'timeout'])
  assert.strictEqual(of(events, 'agent.failed').length, 1, '终态事件只发一次')
  assert.strictEqual(of(events, 'agent.failed')[0].failureKind, 'timeout')
  assert.strictEqual(of(events, 'agent.cancelled').length, 0, '超时不是取消')
  assert.ok(elapsed >= 55, `三次 attempt 各自等满 20ms，实际 ${elapsed}ms`)
})

test('每次 attempt 拿到的是独立的表：上一次超时不影响下一次', async () => {
  const createAgent = hangingAgentFactory()
  const { runner, registry } = makeRunner(createAgent, {
    retry: { maxAttempts: 2, backoffMs: 0, attemptTimeoutMs: 15 },
  })
  await runner.run(makeHandle(registry), { prompt: 'p' })
  const [first, second] = createAgent.calls.map(c => c.signal)
  assert.notStrictEqual(first, second, '两次 attempt 各融一个新 signal')
  assert.notStrictEqual(first.reason, second.reason, 'reason 也各自独立')
  assert.strictEqual(first.reason.timeoutMs, 15)
  assert.strictEqual(second.reason.timeoutMs, 15)
})

test('调用方的 signal 不被我们的表污染 —— 这是超时后还能重试的前提', async () => {
  // `run()` 的重试闸门读的是 `!signal?.aborted`。若把融合后的 signal 写回调用方那一个
  // （或去 abort `handle._abort`），第一次超时就会让闸门认为"调用方取消了"，重试当场
  // 失效 —— 这个字段也就只剩"把挂死变成失败"而没有"再试一次"。
  const createAgent = hangingAgentFactory()
  const { runner, registry, events } = makeRunner(createAgent, {
    retry: { maxAttempts: 2, backoffMs: 0, attemptTimeoutMs: 15 },
  })
  const ac = new AbortController()
  await runner.run(makeHandle(registry), { prompt: 'p', signal: ac.signal })
  assert.strictEqual(ac.signal.aborted, false, '调用方的 signal 必须干净')
  assert.strictEqual(of(events, 'agent.retry').length, 1)
})

test('调用方取消先到 → aborted，不重试', async () => {
  const createAgent = hangingAgentFactory()
  const { runner, registry, events } = makeRunner(createAgent, {
    retry: { maxAttempts: 3, backoffMs: 0, attemptTimeoutMs: 5000 },
  })
  const handle = makeHandle(registry)
  const ac = new AbortController()
  setTimeout(() => ac.abort(abortError('user cancelled')), 10)

  const out = await runner.run(handle, { prompt: 'p', signal: ac.signal })
  // 头部是 `failed` 而不是 `cancelled`：这条路径是**调用方 signal** 被 abort，没有经过
  // `cancelHandle`（后者才会先把 handle 转成终态 `cancelled`）。要紧的是分类 —— 它落在
  // `aborted`，于是既不被读成"子 agent 超时"，也不进 `RETRYABLE_KINDS`。
  assert.match(out, /failureKind=aborted/, '一次刻意的取消不该被读成子 agent 超时')
  assert.strictEqual(createAgent.calls.length, 1, '取消不重试')
  assert.strictEqual(of(events, 'agent.retry').length, 0)
})

test('attemptTimeoutMs: null 不装表 —— 慢 attempt 照样成功', async () => {
  const createAgent = slowAgentFactory(60)
  const { runner, registry, events } = makeRunner(createAgent, {
    retry: { maxAttempts: 2, backoffMs: 0, attemptTimeoutMs: null },
  })
  const out = await runner.run(makeHandle(registry), { prompt: 'p' })
  assert.match(out, /^\[agent:general-purpose-1 succeeded\]/m)
  assert.ok(out.includes('慢但完整的报告'))
  assert.strictEqual(of(events, 'agent.retry').length, 0)
  assert.strictEqual(createAgent.calls[0].signal, undefined, '不装表时不该另造 signal')
})

test('Agent_Type.attemptTimeoutMs 生效，且被 opts.retry 覆盖（回退链次序）', async () => {
  // 钉住 `maxAttempts` 那次回归的形状：默认值只该在 runner 的回退链里解析一次。
  // 谁要是又在 runtime.js 里 eager 填了 `retry.attemptTimeoutMs`，类型级配置就不可达，
  // 下面第一段的断言会立刻失败（15ms 的类型级上限会变成默认的 600000，测试挂 10 分钟）。
  try {
    registerAgentType({
      name: 'timeout-typed', description: 'd', systemPrompt: 's',
      model: 'fast', tools: '*', attemptTimeoutMs: 15,
    })

    const typeLevel = hangingAgentFactory()
    const a = makeRunner(typeLevel, { retry: { maxAttempts: 1, backoffMs: 0 } })
    const handleA = a.registry.create({
      type: 'timeout-typed', description: 'd', parentAgentId: 'main', depth: 1,
      model: { alias: 'fast', model: 'm', apiKey: 'k', url: 'u' },
    })
    const startedAt = Date.now()
    await a.runner.run(handleA, { prompt: 'p' })
    assert.match(typeLevel.calls[0].signal.reason.message, /after 15ms/, '类型级上限生效')
    assert.ok(Date.now() - startedAt < 2000)

    const overridden = hangingAgentFactory()
    const b = makeRunner(overridden, { retry: { maxAttempts: 1, backoffMs: 0, attemptTimeoutMs: 40 } })
    const handleB = b.registry.create({
      type: 'timeout-typed', description: 'd', parentAgentId: 'main', depth: 1,
      model: { alias: 'fast', model: 'm', apiKey: 'k', url: 'u' },
    })
    await b.runner.run(handleB, { prompt: 'p' })
    assert.match(overridden.calls[0].signal.reason.message, /after 40ms/, 'opts.retry 优先')
  } finally {
    resetAgentTypes()
  }
})

test('未配置时走默认 600000，且不会在测试里真的等十分钟', () => {
  // 不跑 attempt，只断言解析结果 —— 默认值本身由上一条与 DEFAULT_ATTEMPT_TIMEOUT_MS 钉住。
  const { runner, registry } = makeRunner(hangingAgentFactory(), { retry: { maxAttempts: 1 } })
  const handle = makeHandle(registry)
  assert.strictEqual(runner._attemptTimeoutMs(getAgentType(handle.type)), DEFAULT_ATTEMPT_TIMEOUT_MS)
  assert.strictEqual(
    runner._attemptTimeoutMs({ attemptTimeoutMs: null }),
    null,
    'null 必须穿过 ?? 链 —— 用 `?? DEFAULT` 收尾的话这里会变成 600000',
  )
})

test('成功的 attempt 不留监听器、不留表', async () => {
  const createAgent = slowAgentFactory(5, 'ok')
  const { runner, registry } = makeRunner(createAgent, {
    retry: { maxAttempts: 2, backoffMs: 0, attemptTimeoutMs: 5000 },
  })
  const ac = new AbortController()
  const out = await runner.run(makeHandle(registry), { prompt: 'p', signal: ac.signal })
  assert.match(out, /succeeded/)
  assert.strictEqual(getEventListeners(ac.signal, 'abort').length, 0)
  // 表若没被 clear，5 秒后它会 abort 一个没人再看的 signal —— 这里等一小段确认
  // 没有任何迟到事件（agent.failed / agent.retry）冒出来。
  await new Promise(r => setTimeout(r, 30))
  assert.strictEqual(ac.signal.aborted, false)
})
