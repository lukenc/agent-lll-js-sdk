/**
 * Agent — 开箱即用的 LLM Agent（含完整 Runtime 管线）
 * 对应 Java 框架的 Agent + AgentBuilder + AgentRuntime + ReActStrategy
 *
 * Runtime 管线：
 *   用户消息 → IntentRecognizer(sidecar) → ToolFilter → ContextManager → LLM → 工具执行 → 循环
 *
 * 用法（简单模式，向后兼容）：
 *   const agent = new Agent({
 *     provider: 'openai',
 *     apiKey: 'sk-xxx',
 *     model: 'gpt-4',
 *     tools: [readFile, shellExec],
 *   })
 *   const reply = await agent.chat('帮我分析项目架构')
 *
 * 用法（Runtime 模式）：
 *   const agent = new Agent({
 *     provider: 'openai',
 *     apiKey: 'sk-xxx',
 *     model: 'gpt-4',
 *     tools: [readFile, shellExec],
 *     enableIntentRecognition: true,
 *     knowledgeBase: myKnowledgeBase,
 *     tokenBudget: { totalTokens: 120000, ... },
 *   })
 */

import { streamChat, syncChat, streamChatIter } from './llm-client.js'
import { formatToolsForOpenAI, parseToolCalls, formatToolResult } from './tool.js'
import { SlidingWindowMemory, SummarizingMemory } from './memory.js'
import { resolveProviderUrl } from './providers.js'
import { IntentRecognizer, defaultIntentResult } from './intent-recognizer.js'
import { ToolFilter, registerBaseTool, unregisterBaseTool, INITIAL_BASE_TOOLS } from './tool-filter.js'
import { ContextManager, defaultTokenBudget } from './context-manager.js'
import { PlanAndExecuteStrategy } from './plan-and-execute.js'
import { TelemetryBus, newTraceId, newSpanId, utf8ByteLength, childContext } from './telemetry.js'
import { createMCPClient } from './mcp/index.js'

/**
 * Build a zero-valued Session_Metrics object. Counter fields start at 0 so
 * that the per-run aggregation can add to them unconditionally (null-valued
 * provider usage contributes 0 per Requirement 8.6 / 8.7).
 * @returns {{
 *   totalRuns: number,
 *   totalRounds: number,
 *   totalLlmCalls: number,
 *   totalToolCalls: number,
 *   usage: { input_tokens: number, output_tokens: number, cached_tokens: number, reasoning_tokens: number },
 *   wallClockMs: number,
 * }}
 */
function _zeroSessionMetrics() {
  return {
    totalRuns: 0,
    totalRounds: 0,
    totalLlmCalls: 0,
    totalToolCalls: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cached_tokens: 0,
      reasoning_tokens: 0,
    },
    wallClockMs: 0,
  }
}

/**
 * Null-safe sum of `Usage_Object` fields across an array of
 * `LlmCallRecord`s. A field is `null` in the result only when every record
 * reported `null` for that field (i.e., no provider ever emitted it).
 * Otherwise `null` contributes 0 and the result is a number — this matches
 * Requirements 8.6 and 8.7.
 *
 * @param {Array<{
 *   'gen_ai.usage.input_tokens'?: number|null,
 *   'gen_ai.usage.output_tokens'?: number|null,
 *   'gen_ai.usage.cached_tokens'?: number|null,
 *   'gen_ai.usage.reasoning_tokens'?: number|null,
 * }>} records
 */
function _sumUsage(records) {
  const fields = [
    ['input_tokens', 'gen_ai.usage.input_tokens'],
    ['output_tokens', 'gen_ai.usage.output_tokens'],
    ['cached_tokens', 'gen_ai.usage.cached_tokens'],
    ['reasoning_tokens', 'gen_ai.usage.reasoning_tokens'],
  ]
  /** @type {{ input_tokens: number|null, output_tokens: number|null, cached_tokens: number|null, reasoning_tokens: number|null }} */
  const result = {
    input_tokens: null,
    output_tokens: null,
    cached_tokens: null,
    reasoning_tokens: null,
  }
  for (const [outKey, inKey] of fields) {
    let sum = 0
    let anyNumeric = false
    for (const rec of records) {
      const v = rec == null ? null : rec[inKey]
      if (typeof v === 'number' && Number.isFinite(v)) {
        sum += v
        anyNumeric = true
      }
    }
    result[outKey] = anyNumeric ? sum : null
  }
  return result
}

/**
 * Fold a completed `Run_Metrics` into the cumulative `Session_Metrics`.
 * Usage fields treat `null` as 0 (Requirements 8.6 / 8.7). Mutates
 * `sessionMetrics` in place.
 *
 * @param {ReturnType<typeof _zeroSessionMetrics>} sessionMetrics
 * @param {{
 *   totalRounds: number,
 *   totalLlmCalls: number,
 *   totalToolCalls: number,
 *   usage: { input_tokens: number|null, output_tokens: number|null, cached_tokens: number|null, reasoning_tokens: number|null },
 *   wallClockMs: number,
 * }} runMetrics
 */
function _foldRunIntoSession(sessionMetrics, runMetrics) {
  sessionMetrics.totalRuns += 1
  sessionMetrics.totalRounds += runMetrics.totalRounds
  sessionMetrics.totalLlmCalls += runMetrics.totalLlmCalls
  sessionMetrics.totalToolCalls += runMetrics.totalToolCalls
  sessionMetrics.wallClockMs += runMetrics.wallClockMs
  const u = runMetrics.usage
  sessionMetrics.usage.input_tokens += u.input_tokens ?? 0
  sessionMetrics.usage.output_tokens += u.output_tokens ?? 0
  sessionMetrics.usage.cached_tokens += u.cached_tokens ?? 0
  sessionMetrics.usage.reasoning_tokens += u.reasoning_tokens ?? 0
}

/**
 * 把一个 Promise 与一个超时计时器进行 `Promise.race` 竞速。供运行时动态加载
 * MCP 的连接（30s）与客户端关闭（5s）复用。
 *
 * 若 `promise` 在 `ms` 毫秒内 settle，则以其结果 resolve/reject，并清除计时器
 * 以免阻止进程退出；若超时先触发，则以一个描述性的超时错误 reject。
 *
 * @template T
 * @param {Promise<T>} promise 被竞速的 Promise
 * @param {number} ms 超时毫秒数
 * @returns {Promise<T>} 在 `promise` settle 或超时后 settle 的 Promise
 */
function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Operation timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export class Agent {
  /**
   * @param {object} opts
   * @param {string} opts.provider - 供应商名称
   * @param {string} opts.apiKey - API Key
   * @param {string} [opts.model='gpt-4'] - 模型名称
   * @param {string} [opts.systemPrompt='You are a helpful assistant.'] - 系统提示词
   * @param {string} [opts.url] - 自定义 API URL
   * @param {import('./tool.js').ToolDef[]} [opts.tools=[]] - 工具列表
   * @param {number} [opts.maxRounds=300] - 最大 ReAct 轮次
   * @param {number} [opts.maxMessages=40] - 记忆窗口大小（仅在使用 SlidingWindowMemory 时生效）
   * @param {number} [opts.temperature=0.6] - 温度（Agent 场景建议 0.5-0.7 兼顾工具调用稳定性和对话自然度）
   * @param {boolean} [opts.enableIntentRecognition=false] - 启用意图识别
   * @param {string} [opts.intentModel] - 意图识别使用的模型（已废弃，优先级高于 simpleModel；未设置时回退到 simpleModel）
   * @param {string} [opts.simpleModel] - 简单任务模型（用于意图识别/难度判断/工具筛选/记忆摘要等 sidecar 调用）。未配置时所有 sidecar 调用回退使用主模型
   * @param {string} [opts.simpleApiKey] - 简单任务模型的 API Key。未配置时回退到主 apiKey
   * @param {string} [opts.simpleProvider] - 简单任务模型的供应商。未配置时沿用主 provider（同一 URL）
   * @param {string} [opts.simpleUrl] - 简单任务模型的自定义 API URL。未配置时沿用主 URL
   * @param {import('./knowledge-base.js').KnowledgeBase} [opts.knowledgeBase] - 知识库
   * @param {import('./context-manager.js').TokenBudget} [opts.tokenBudget] - token 预算
   * @param {import('./memory.js').SlidingWindowMemory|import('./memory.js').SummarizingMemory} [opts.memory] - 自定义记忆实例
   * @param {object} [opts.memoryOpts] - 默认 SummarizingMemory 配置（仅在未传入 memory 时生效）
   * @param {number} [opts.memoryOpts.threshold=20] - 触发摘要的消息数阈值
   * @param {number} [opts.memoryOpts.keepRecent=5] - 摘要后保留的最近消息数
   * @param {'react'|'plan_and_execute'} [opts.strategy='react'] - 执行策略
   * @param {object} [opts.planAndExecuteOpts] - PlanAndExecute 策略配置
   * @param {object} [opts.hooks] - 生命周期钩子
   * @param {(name: string, args: object) => Promise<boolean|void>} [opts.hooks.beforeToolCall] - 工具执行前（返回 false 阻止执行）
   * @param {(name: string, args: object, result: string) => void} [opts.hooks.afterToolCall] - 工具执行后
   * @param {(round: number) => void} [opts.hooks.onRoundStart] - 每轮 ReAct 循环开始
   * @param {(error: Error, context: object) => void} [opts.hooks.onError] - 错误回调
   * @param {(question: string) => Promise<string>} [opts.hooks.onAskUser] - 用户交互回调（提供后自动注入 ask_user 工具）
   */
  constructor(opts) {
    if (!opts.apiKey) throw new Error('apiKey is required')
    if (!opts.provider) throw new Error('provider is required')

    this.apiKey = opts.apiKey
    this.model = opts.model ?? 'gpt-4'
    this.systemPrompt = opts.systemPrompt ?? 'You are a helpful assistant.'
    this.url = resolveProviderUrl(opts.provider, opts.url)
    this.tools = opts.tools ?? []
    this.maxRounds = opts.maxRounds ?? 300
    this.temperature = opts.temperature ?? 0.6

    // ---- Tool_Registry generation 与动态 MCP 状态 ----
    // `this.tools` 保持为数组（元素顺序 = 加入顺序），既有 `tools` 选项语义不变。
    // `_toolsGeneration` 单调递增，任何改写 Tool_Registry 的操作都会令其自增，
    // 供 ReAct 每轮边界比对以决定是否重新派生该轮工具集。
    // `_managedClients` 持有运行时动态加载的 MCP 客户端（Server_Key → ManagedEntry）。
    // `_lastIntent` 缓存首轮意图识别结果，供后续轮重新应用 ToolFilter。
    this._toolsGeneration = 0
    this._managedClients = new Map()
    this._lastIntent = null

    // ---- 运行时动态 MCP 加载配置 ----
    // `enableDynamicMCP` 默认 false（向后兼容，Req 7.2）；启用后向 Tool_Registry
    // 注入 `load_mcp_server` 元工具。`dynamicMCPOpts` 提供连接 / 关闭超时，
    // 默认 30000ms / 5000ms（Req 3.8 / 5.4）。不引入新的必填参数。
    this.enableDynamicMCP = opts.enableDynamicMCP ?? false
    this.dynamicMCPOpts = {
      connectTimeoutMs: opts.dynamicMCPOpts?.connectTimeoutMs ?? 30000,
      closeTimeoutMs: opts.dynamicMCPOpts?.closeTimeoutMs ?? 5000,
    }
    // 内部可注入的 MCP 客户端工厂（默认为模块级 `createMCPClient`）。
    // 仅用于测试时注入 mock 工厂，生产行为与直接调用 `createMCPClient` 等价。
    this._createMCPClient = createMCPClient

    // ---- 简单任务模型配置 ----
    // 用于意图识别、难度判断、工具筛选、记忆摘要等 sidecar 调用。
    // 任一字段未配置时单独回退到主模型对应字段，整体未配置时全部使用主模型。
    const hasSimpleConfig = !!(opts.simpleModel || opts.simpleApiKey || opts.simpleProvider || opts.simpleUrl)
    if (hasSimpleConfig) {
      this.simpleApiKey = opts.simpleApiKey ?? this.apiKey
      this.simpleModel = opts.simpleModel ?? this.model
      this.simpleUrl = (opts.simpleProvider || opts.simpleUrl)
        ? resolveProviderUrl(opts.simpleProvider ?? opts.provider, opts.simpleUrl)
        : this.url
    } else {
      this.simpleApiKey = this.apiKey
      this.simpleModel = this.model
      this.simpleUrl = this.url
    }

    // 记忆：默认使用 SummarizingMemory 自动压缩上下文，
    // 通过简单任务模型（未配置则回退主模型）生成摘要。
    if (opts.memory) {
      this.memory = opts.memory
    } else {
      const agentUrl = this.simpleUrl
      const agentApiKey = this.simpleApiKey
      const agentModel = this.simpleModel
      // Default summarizer — closes over `this` (the Agent) so it can read
      // the current run's root TelemetryContext at call time. When no run
      // is in flight (`_currentRun == null`), `childContext(null, ...)`
      // returns `null` and llm-client degrades to a no-op telemetry path.
      // This satisfies Requirements 4.3 / 6.3 / 9.1 / 9.2 without forcing
      // the caller to wire `setSummaryContext` manually.
      const summarizer = async (text) => {
        const parentCtx = this._currentRun?.rootCtx ?? null
        const ctx = childContext(parentCtx, 'agent.summarize')
        const resp = await syncChat({
          url: agentUrl,
          apiKey: agentApiKey,
          body: {
            model: agentModel,
            messages: [
              { role: 'system', content: 'Summarize the following conversation concisely, preserving key facts, decisions, tool results, and context needed for future turns. Output only the summary.' },
              { role: 'user', content: text },
            ],
            temperature: 0,
          },
          telemetry: { ctx },
        })
        return resp.choices?.[0]?.message?.content ?? ''
      }
      this.memory = new SummarizingMemory({
        threshold: opts.memoryOpts?.threshold ?? 20,
        keepRecent: opts.memoryOpts?.keepRecent ?? 5,
        summarizer,
      })
    }
    this.memory.add({ role: 'system', content: this.systemPrompt })

    // ---- Runtime 组件 ----
    this.enableIntentRecognition = opts.enableIntentRecognition ?? false
    this.knowledgeBase = opts.knowledgeBase ?? null
    this.tokenBudget = opts.tokenBudget ?? null

    // IntentRecognizer（sidecar LLM 调用）使用简单任务模型配置
    this.intentRecognizer = this.enableIntentRecognition
      ? new IntentRecognizer({
          url: this.simpleUrl,
          apiKey: this.simpleApiKey,
          model: opts.intentModel ?? this.simpleModel,
        })
      : null

    // ToolFilter
    this.toolFilter = new ToolFilter()

    // ContextManager
    this.contextManager = new ContextManager()
    if (this.knowledgeBase) this.contextManager.knowledgeBase = this.knowledgeBase

    // ---- 执行策略 ----
    this.strategy = opts.strategy ?? 'react'
    this.planAndExecuteOpts = opts.planAndExecuteOpts ?? {}

    // ---- 生命周期钩子 ----
    this.hooks = opts.hooks ?? {}

    // ---- Telemetry ----
    // The bus is owned by the Agent and exposed via `on` / `off` / `emit`.
    // `_lastRunMetrics` is `null` until the first chat()/stream() completes.
    // `_sessionMetrics` starts at zero values and is reset by `reset()`.
    // `_currentRun` is non-null only while a chat()/stream() is in flight;
    // its shape matches the design doc (traceId, rootSpanId, startedAt,
    // startedPerfNow, llmCalls, toolCalls, totalRounds, currentLlmSpanId).
    this._bus = new TelemetryBus()
    this._lastRunMetrics = null
    this._sessionMetrics = _zeroSessionMetrics()
    this._currentRun = null

    // ---- 内置工具：ask_user ----
    // 当提供 hooks.onAskUser 时，自动注入 ask_user 工具，
    // 让 LLM 在需要时可以向用户提问并等待回答。
    if (this.hooks.onAskUser) {
      const onAskUser = this.hooks.onAskUser
      this.tools = [
        ...this.tools,
        {
          name: 'ask_user',
          description: 'Ask the user a question and wait for their response. Use this when you need clarification, confirmation, or additional information from the user before proceeding.',
          parameters: {
            type: 'object',
            properties: {
              question: { type: 'string', description: 'The question to ask the user' },
            },
            required: ['question'],
          },
          execute: async function(params) {
            return await onAskUser(params.question)
          },
        },
      ]
    }

    // ---- 元工具：load_mcp_server ----
    // 仅当 `enableDynamicMCP === true` 时把 `load_mcp_server` 追加进 `this.tools`
    // （与 ask_user 注入方式一致，但**不**注册为 Base_Tool —— 它是普通工具，
    // 且其名不在 INITIAL_BASE_TOOLS 中，Req 3.1 / 3.7）。
    if (this.enableDynamicMCP) {
      this.tools = [
        ...this.tools,
        {
          name: 'load_mcp_server',
          description: '在对话过程中加载一个 MCP 服务器，把它的工具加入可用工具集。重复加载同一 serverKey 会替换旧连接。',
          parameters: {
            type: 'object',
            properties: {
              serverKey: { type: 'string', description: '该 MCP 服务器的稳定唯一标识；重复加载同一 key 会替换旧连接' },
              transport: { type: 'string', enum: ['stdio', 'http', 'streamable-http', 'sse'], description: '传输类型' },
              command: { type: 'string', description: 'stdio：可执行命令' },
              args: { type: 'array', items: { type: 'string' }, description: 'stdio：命令参数' },
              url: { type: 'string', description: 'http/streamable-http/sse：端点 URL' },
              headers: { type: 'object', description: 'http/sse：自定义请求头（如 Authorization）' },
              name: { type: 'string', description: '可选，命名空间前缀用 server 名' },
            },
            required: ['serverKey', 'transport'],
          },
          execute: (params, ctx) => this._loadMCPServer(params, ctx),
        },
      ]
    }
  }

  /**
   * 同步对话 — 发送消息，返回最终回复文本
   * @param {string} message
   * @param {object} [opts]
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<string>}
   */
  async chat(message, opts = {}) {
    return this._runWithSession(async (_rootCtx) => {
      if (this.strategy === 'plan_and_execute') {
        return this._planAndExecuteChat(message, opts)
      }
      this.memory.add({ role: 'user', content: message })
      return this._reactLoop(message, opts)
    })
  }

  /**
   * 流式对话 — 通过 async generator 实时推送内容
   * @param {string} message
   * @param {object} [opts]
   * @param {AbortSignal} [opts.signal]
   * @yields {{ type: 'delta'|'reasoning'|'tool_start'|'tool_end'|'intent'|'done', ... }}
   */
  async *stream(message, opts = {}) {
    yield* this._runWithSessionStream(async function* (_rootCtx) {
      if (this.strategy === 'plan_and_execute') {
        yield* this._planAndExecuteStream(message, opts)
        return
      }
      this.memory.add({ role: 'user', content: message })
      yield* this._reactLoopStream(message, opts)
    }.bind(this))
  }

  /** 清空对话历史，开始新会话 */
  reset() {
    this.memory.clear()
    this.memory.add({ role: 'system', content: this.systemPrompt })
    // 动态 MCP 生命周期拆除：仅当 `_managedClients` 非空时以 fire-and-forget 方式
    // 触发 `_teardownManagedClients()`（关闭客户端、移除动态工具并取消 Base_Tool
    // 注册、清空集合）。`reset()` 保持同步返回 undefined（Req 7.2），故不 await；
    // 空集合时不触发任何 `close()`（Req 5.5 / 7.5）。
    if (this._managedClients.size > 0) {
      Promise.resolve()
        .then(() => this._teardownManagedClients())
        .catch(() => {
          // _teardownManagedClients 内部已做错误隔离；此处兜底，避免未处理 rejection。
        })
    }
    this._lastIntent = null
    // Clear telemetry aggregates so a reset agent reports zero history.
    // Listeners registered via `on(...)` are NOT cleared — that would silently
    // break application-level subscriptions across a reset.
    this._lastRunMetrics = null
    this._sessionMetrics = _zeroSessionMetrics()
    this._currentRun = null
  }

  // ---- 动态工具管理 API ----

  /**
   * 把一个或多个 Tool_Def 加入 Tool_Registry（同名覆盖，保持唯一）。
   *
   * 先对全部元素做校验（每个元素须为对象且含非空字符串 `name`），全部通过
   * 才提交，任一非法则整体回滚（不写入本次调用中的任何 Tool_Def）。成功提交
   * 且实际产生变更时 `_toolsGeneration` 自增 1；长度为 0 的数组为不变更的正常返回。
   *
   * 动态工具与静态工具的区分：公开调用方使用单参形式 `addTools(tools)`，此时
   * **不**把工具注册为 Base_Tool（静态工具不受意图过滤豁免影响，Req 7.3）。运行时
   * 动态加载路径（`_loadMCPServer` / `_onToolsChanged`）使用内部选项
   * `{ asBaseTool: true }`，使每个被加入的工具在加入 Tool_Registry 的**同一同步
   * 操作内**调用一次 `registerBaseTool(name)`（Req 4.1），保证其下一轮不被 ToolFilter
   * 过滤掉。
   *
   * @param {object|object[]} tools 单个 Tool_Def 或长度 0..1000 的 Tool_Def 数组
   * @param {object} [options] 内部选项（公开调用方无需提供）
   * @param {boolean} [options.asBaseTool=false] 为 true 时把每个加入的工具注册为
   *   Base_Tool（仅供运行时动态加载路径使用）
   * @throws {TypeError} 参数为 `null`/`undefined`、既非 Tool_Def 也非数组、
   *   数组长度超过 1000、或任一元素缺少非空字符串 `name`（整体回滚）
   * @returns {void}
   */
  addTools(tools, { asBaseTool = false } = {}) {
    if (tools === null || tools === undefined) {
      throw new TypeError('addTools: tools must be a Tool_Def or an array of Tool_Defs, got ' + String(tools))
    }

    // 归一为待加入数组：单个对象包成单元素数组；数组则原样。
    let incoming
    if (Array.isArray(tools)) {
      if (tools.length > 1000) {
        throw new TypeError(`addTools: tools array length ${tools.length} exceeds the maximum of 1000`)
      }
      incoming = tools
    } else if (typeof tools === 'object') {
      incoming = [tools]
    } else {
      throw new TypeError('addTools: tools must be a Tool_Def or an array of Tool_Defs, got ' + typeof tools)
    }

    // 全量校验：每个元素须为非空对象且含非空字符串 name。任一失败即抛出，不写入。
    for (let i = 0; i < incoming.length; i++) {
      const tool = incoming[i]
      if (tool === null || typeof tool !== 'object' || Array.isArray(tool)) {
        throw new TypeError(`addTools: element at index ${i} is not a Tool_Def object`)
      }
      if (typeof tool.name !== 'string' || tool.name.length === 0) {
        throw new TypeError(`addTools: element at index ${i} is missing a non-empty string \`name\``)
      }
    }

    // 空数组：不变更、正常返回（不自增 generation）。
    if (incoming.length === 0) return

    // 全部通过校验后才提交。同名覆盖：替换已存在的同名 Tool_Def（保持其原有位置），
    // 新名追加到末尾（保持加入顺序）。当 asBaseTool 为 true 时，在加入 Tool_Registry
    // 的同一同步操作内对其 name 调用 registerBaseTool（Req 4.1）。
    for (const tool of incoming) {
      const idx = this.tools.findIndex((t) => t.name === tool.name)
      if (idx === -1) {
        this.tools.push(tool)
      } else {
        this.tools[idx] = tool
      }
      if (asBaseTool) {
        registerBaseTool(tool.name)
      }
    }

    this._toolsGeneration++
  }

  /**
   * 按工具名从 Tool_Registry 移除对应 Tool_Def。
   *
   * 命中并移除时返回 `true` 且 `_toolsGeneration` 自增 1；未命中（名称为合法
   * 非空字符串但不存在）时返回 `false` 且不变更 Tool_Registry。
   *
   * 成功移除且该 `name` 不属于 `INITIAL_BASE_TOOLS` 中的预置基础工具名时，对其
   * 调用一次 `unregisterBaseTool(name)`，使其 Base_Tool 身份被取消（Req 4.3）；
   * 属于 `INITIAL_BASE_TOOLS` 的名称则保持其 Base_Tool 注册不变（Req 4.4），从而
   * `getBaseTools()` 始终为 `INITIAL_BASE_TOOLS` 的超集（Req 4.5）。
   *
   * @param {string} name 非空字符串（长度 1..256）
   * @throws {TypeError} `name` 不是非空字符串
   * @returns {boolean} 命中并移除返回 true，未命中返回 false
   */
  removeTool(name) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError('removeTool: name must be a non-empty string, got ' + (typeof name === 'string' ? '""' : typeof name))
    }

    const idx = this.tools.findIndex((t) => t.name === name)
    if (idx === -1) return false

    this.tools.splice(idx, 1)
    // 预置基础工具名不取消 Base_Tool 注册（Req 4.4）；其余动态工具取消注册（Req 4.3）。
    if (!INITIAL_BASE_TOOLS.includes(name)) {
      unregisterBaseTool(name)
    }
    this._toolsGeneration++
    return true
  }

  /**
   * 返回 Tool_Registry 的防御性快照。
   *
   * 返回一个新的数组实例，元素顺序与工具加入 Tool_Registry 的先后顺序一致；
   * 对返回数组的任何修改（push/splice/重排等）都不会改变 Tool_Registry 的内容。
   *
   * @returns {object[]} Tool_Def 数组的浅拷贝快照
   */
  getTools() {
    return [...this.tools]
  }

  /**
   * Return a projected history track. RuntimeHistory-backed memories provide
   * rich tracks; custom memories fall back to their existing history/messages
   * projection.
   * @param {string} [trackName='model']
   * @returns {Promise<object[]>}
   */
  async getHistory(trackName = 'model') {
    const rh = this.memory?.runtimeHistory
    if (rh && typeof rh.project === 'function') {
      if (trackName === 'model' || trackName === 'visible') {
        return rh.projectMessages(trackName)
      }
      return rh.project(trackName)
    }
    if (trackName === 'artifacts' || trackName === 'internal') return []
    return await this._getHistory()
  }

  /**
   * Return model/tool artifacts captured by RuntimeHistory-backed memories.
   * @returns {Promise<object[]>}
   */
  async getArtifacts() {
    const rh = this.memory?.runtimeHistory
    if (rh && typeof rh.project === 'function') return rh.project('artifacts')
    return []
  }

  // ---- Telemetry public API ----

  /**
   * Register a listener for a telemetry event type.
   * See `src/telemetry.js` for event payload shapes. Returns `this` to allow
   * chaining.
   * @param {string} eventType
   * @param {(payload: object) => void} listener
   * @returns {this}
   */
  on(eventType, listener) {
    this._bus.on(eventType, listener)
    return this
  }

  /**
   * Unregister a previously-registered listener. No-op if the listener was
   * never registered. Returns `this` to allow chaining.
   * @param {string} eventType
   * @param {Function} listener
   * @returns {this}
   */
  off(eventType, listener) {
    this._bus.off(eventType, listener)
    return this
  }

  /**
   * Emit an event on the telemetry bus.
   *
   * This is used by the framework to dispatch its own events and is also
   * available to application code that wants to piggy-back synthetic events
   * on the same stream. Failures in the listener path (including the bus
   * itself) are caught and logged via `console.warn` so they never escape
   * into `chat()` / `stream()` (Requirement 9.6).
   *
   * @param {string} eventType
   * @param {object} payload
   */
  emit(eventType, payload) {
    this._safeEmit(eventType, payload)
  }

  /**
   * Return the `Run_Metrics` for the most recently completed `chat()` or
   * `stream()` invocation, or `null` when no invocation has completed since
   * construction / the last `reset()`.
   * @returns {object|null}
   */
  getLastRunMetrics() {
    return this._lastRunMetrics
  }

  /**
   * Return a defensive shallow clone of the cumulative `Session_Metrics`.
   * The clone protects callers against accidental mutation of the agent's
   * internal accumulator (the `usage` sub-object is also cloned).
   * @returns {object}
   */
  getSessionMetrics() {
    const sm = this._sessionMetrics
    return {
      totalRuns: sm.totalRuns,
      totalRounds: sm.totalRounds,
      totalLlmCalls: sm.totalLlmCalls,
      totalToolCalls: sm.totalToolCalls,
      usage: {
        input_tokens: sm.usage.input_tokens,
        output_tokens: sm.usage.output_tokens,
        cached_tokens: sm.usage.cached_tokens,
        reasoning_tokens: sm.usage.reasoning_tokens,
      },
      wallClockMs: sm.wallClockMs,
    }
  }

  /**
   * Internal helper used by every framework emission site. Wraps the bus
   * dispatch in `try`/`catch` so failures in the listener path (bus internals
   * included) never propagate into `chat()` / `stream()`.
   * @param {string} eventType
   * @param {object} payload
   */
  _safeEmit(eventType, payload) {
    try {
      this._bus.emit(eventType, payload)
    } catch (err) {
      // Requirement 9.6: never propagate listener-path failures.
      // Using console.warn keeps us dependency-free.
      console.warn(
        `[agent] telemetry emit failed for "${eventType}":`,
        err?.message || err,
      )
    }
  }

  // ---- Session lifecycle wrapper ----

  /**
   * Wrap a strategy invocation (`_reactLoop` / `_planAndExecuteChat`) with
   * the session lifecycle: generate trace/span IDs, emit `session.start`,
   * run the strategy, then in `finally` finalize `Run_Metrics`, fold into
   * `Session_Metrics`, and emit `session.end`.
   *
   * The `finally` block guarantees `session.end` fires even when the
   * strategy throws (including abort) — Requirement 5.7.
   *
   * `_currentRun` is populated with empty collections so later tasks
   * (5.x / 7.x / 8.x) can accumulate `llmCalls` / `toolCalls` / `totalRounds`
   * into it during the run. The root `TelemetryContext` is also parked on
   * `_currentRun.rootCtx` so downstream code can retrieve it without
   * threading an extra parameter through every internal method.
   *
   * @template T
   * @param {(rootCtx: object) => Promise<T>} strategyFn
   * @returns {Promise<T>}
   */
  async _runWithSession(strategyFn) {
    const traceId = newTraceId()
    const rootSpanId = newSpanId()
    const startedAt = Date.now()
    const startedPerfNow = performance.now()

    const rootCtx = {
      traceId,
      parentSpanId: rootSpanId,
      operationName: 'agent.chat',
      bus: this._bus,
    }

    this._currentRun = {
      traceId,
      rootSpanId,
      startedAt,
      startedPerfNow,
      llmCalls: [],
      toolCalls: [],
      totalRounds: 0,
      currentLlmSpanId: null,
      rootCtx,
    }

    // Internal bookkeeping listeners — Requirement 9.5: `Run_Metrics` /
    // `Session_Metrics` MUST populate even when callers register zero
    // listeners. These two listeners are installed directly on the bus
    // (so they fire regardless of external subscriptions), push every
    // emitted `llm.call` / `tool.call` event into `_currentRun`, and are
    // torn down in `finally` so they don't leak across runs.
    const run = this._currentRun
    const _onLlmCall = (ev) => { run.llmCalls.push(ev) }
    const _onToolCall = (ev) => { run.toolCalls.push(ev) }
    this._bus.on('llm.call', _onLlmCall)
    this._bus.on('tool.call', _onToolCall)

    this._safeEmit('session.start', {
      traceId,
      spanId: rootSpanId,
      parentSpanId: null,
      strategy: this.strategy,
      startedAt,
    })

    let ok = true
    try {
      return await strategyFn(rootCtx)
    } catch (err) {
      ok = false
      throw err
    } finally {
      this._bus.off('llm.call', _onLlmCall)
      this._bus.off('tool.call', _onToolCall)
      this._finalizeRun({ ok })
    }
  }

  /**
   * Async-generator counterpart to `_runWithSession`. The strategy is an
   * async generator whose yielded values are passed through to the caller.
   * `session.start` fires before iteration begins; `session.end` fires in a
   * `finally` block after the generator completes or throws, guaranteeing
   * emission on both normal completion and abort (Requirement 5.7).
   *
   * @param {(rootCtx: object) => AsyncGenerator<any, void, any>} strategyFn
   */
  async *_runWithSessionStream(strategyFn) {
    const traceId = newTraceId()
    const rootSpanId = newSpanId()
    const startedAt = Date.now()
    const startedPerfNow = performance.now()

    const rootCtx = {
      traceId,
      parentSpanId: rootSpanId,
      operationName: 'agent.chat',
      bus: this._bus,
    }

    this._currentRun = {
      traceId,
      rootSpanId,
      startedAt,
      startedPerfNow,
      llmCalls: [],
      toolCalls: [],
      totalRounds: 0,
      currentLlmSpanId: null,
      rootCtx,
    }

    // See `_runWithSession` for rationale — Requirement 9.5 requires that
    // aggregate bookkeeping runs unconditional of external listener count.
    const run = this._currentRun
    const _onLlmCall = (ev) => { run.llmCalls.push(ev) }
    const _onToolCall = (ev) => { run.toolCalls.push(ev) }
    this._bus.on('llm.call', _onLlmCall)
    this._bus.on('tool.call', _onToolCall)

    this._safeEmit('session.start', {
      traceId,
      spanId: rootSpanId,
      parentSpanId: null,
      strategy: this.strategy,
      startedAt,
    })

    let ok = true
    try {
      yield* strategyFn(rootCtx)
    } catch (err) {
      ok = false
      throw err
    } finally {
      this._bus.off('llm.call', _onLlmCall)
      this._bus.off('tool.call', _onToolCall)
      this._finalizeRun({ ok })
    }
  }

  /**
   * Build `Run_Metrics` from `_currentRun`, publish it to `_lastRunMetrics`,
   * fold into `_sessionMetrics`, and emit `session.end`. Also clears
   * `_currentRun` so subsequent calls start clean.
   *
   * Usage sums are null-safe: `null` contributes 0 to the running total, and
   * the result field is `null` only when every contributing record was also
   * `null` (i.e., no provider ever reported that field). This satisfies
   * Requirements 8.6 / 8.7.
   *
   * Task 8.x will refine the accumulation once llm.call / tool.call
   * bookkeeping is fully wired up; for Task 3.2 the shape is complete and
   * correct for the empty-events case.
   *
   * @param {{ ok: boolean }} args
   */
  _finalizeRun({ ok }) {
    const run = this._currentRun
    if (!run) return

    const endedAt = Date.now()
    const wallClockMs = performance.now() - run.startedPerfNow

    const llmCalls = run.llmCalls
    const toolCalls = run.toolCalls
    const totalLlmCalls = llmCalls.reduce((n, r) => n + (r.ok ? 1 : 0), 0)
    const totalToolCalls = toolCalls.reduce((n, r) => n + (r.ok ? 1 : 0), 0)
    const usage = _sumUsage(llmCalls)

    /** @type {object} */
    const runMetrics = {
      traceId: run.traceId,
      totalRounds: run.totalRounds,
      totalLlmCalls,
      totalToolCalls,
      usage,
      wallClockMs,
      llmCalls,
      toolCalls,
    }

    this._lastRunMetrics = runMetrics
    _foldRunIntoSession(this._sessionMetrics, runMetrics)

    this._safeEmit('session.end', {
      ...runMetrics,
      endedAt,
      ok,
    })

    this._currentRun = null
  }

  // ---- Runtime 管线：意图识别 + 工具过滤 + 上下文组装 ----

  /**
   * 执行 Runtime 管线，返回组装好的 LLM 请求参数。
   * @param {string} userMessage - 当前用户消息
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ body: object, intent: import('./intent-recognizer.js').IntentResult, filteredTools: import('./tool.js').ToolDef[] }>}
   */
  async _runPipeline(userMessage, signal) {
    // 1. 意图识别（sidecar）—— 带上对话历史，以便正确解析「继续」「上个结果」等引用。
    //    IntentRecognizer 会自动去重末尾重复的 userMessage 并截取最近 N 条。
    let intent = defaultIntentResult()
    if (this.intentRecognizer) {
      const toolNames = this.tools.map(t => t.name)
      const history = await this._getHistory()
      intent = await this.intentRecognizer.analyze(userMessage, toolNames, {
        history,
        signal,
        telemetry: this._currentRun?.rootCtx ?? null,
      })
    }

    // 2. 工具过滤
    const filteredTools = this.toolFilter.filter(intent, this.tools)

    // 3. 上下文组装（如果配置了 tokenBudget 或 knowledgeBase）
    if (this.tokenBudget || this.knowledgeBase) {
      const history = await this._getHistory()

      const assembled = this.contextManager.assemblePrompt({
        systemPrompt: this.systemPrompt,
        history,
        knowledgeBase: this.knowledgeBase,
        filteredTools,
        tokenBudget: this.tokenBudget,
      })

      return {
        body: {
          model: this.model,
          messages: this._withUnavailableToolsNote(assembled.messages),
          temperature: this.temperature,
          ...(assembled.tools ? { tools: assembled.tools } : {}),
        },
        intent,
        filteredTools,
      }
    }

    // 简单模式：直接使用 memory 中的消息
    const messages = this._withUnavailableToolsNote(await this._getMessages())

    const openaiTools = filteredTools.length > 0 ? formatToolsForOpenAI(filteredTools) : undefined
    return {
      body: {
        model: this.model,
        messages,
        temperature: this.temperature,
        ...(openaiTools ? { tools: openaiTools } : {}),
      },
      intent,
      filteredTools,
    }
  }

  /**
   * 派生某一轮 ReAct 迭代应使用的工具集（不重新运行意图识别）。
   *
   * 当启用意图识别（`enableIntentRecognition` 为 true）时，对**当前**的
   * `this.tools` 复用首轮缓存的意图结果 `this._lastIntent` 重新应用
   * `ToolFilter.filter`——由于动态工具加入时已 `registerBaseTool`，`ToolFilter`
   * 的 BASE_TOOLS 分支保证它们不会被过滤掉。`_lastIntent` 为 null 时
   * `ToolFilter.filter` 自然回退为全量工具。
   *
   * 当未启用意图识别时，返回 `this.tools` 的防御性浅拷贝（全量工具）。
   *
   * 该派生是确定性的：相同的 `this.tools`、`enableIntentRecognition` 与
   * `this._lastIntent` 输入产生元素集合相等的结果，供非流式（`_reactLoop`）与
   * 流式（`_reactLoopStream`）两条路径共用，保证两路派生一致。
   *
   * @returns {import('./tool.js').ToolDef[]} 该轮使用的工具集
   */
  _deriveRoundTools() {
    if (this.enableIntentRecognition) {
      return this.toolFilter.filter(this._lastIntent, this.tools)
    }
    return [...this.tools]
  }

  /**
   * 移除某 Server_Key 贡献的全部动态工具，并取消其 Base_Tool 注册。
   *
   * 以 `ManagedEntry.toolNames` Set 为准界定归属（而非命名空间前缀匹配），
   * 避免不同 Server_Key 的 server 名 sanitize 后前缀碰撞。对每个工具名：
   * 从 `this.tools` 移除对应 Tool_Def，并调用 `unregisterBaseTool(name)`——
   * 但若该 `name` 属于 `INITIAL_BASE_TOOLS` 中的预置基础工具名，则**不**取消
   * 其 Base_Tool 注册（保持预置工具不被动态拆除影响）。
   *
   * 仅当本次调用实际从 Tool_Registry 移除了至少一个工具时，`_toolsGeneration`
   * 自增 1，使 ReAct 每轮边界能感知变化。`serverKey` 不在 `_managedClients`
   * 中时为安全空操作。
   *
   * @param {string} serverKey 已加载 MCP 服务器的稳定标识
   * @returns {void}
   */
  _removeToolsByServerKey(serverKey) {
    const entry = this._managedClients.get(serverKey)
    if (!entry) return

    let changed = false
    for (const name of entry.toolNames) {
      const idx = this.tools.findIndex((t) => t.name === name)
      if (idx !== -1) {
        this.tools.splice(idx, 1)
        changed = true
      }
      // 预置基础工具名不取消 Base_Tool 注册（Req 4.4）。
      if (!INITIAL_BASE_TOOLS.includes(name)) {
        unregisterBaseTool(name)
      }
    }

    if (changed) this._toolsGeneration++
  }

  /**
   * 关闭 `_managedClients` 中的全部 MCP 客户端，移除其贡献的动态工具并取消
   * Base_Tool 注册，最终清空集合。错误隔离：单个客户端 `close()` 抛错或在
   * `closeTimeoutMs`（默认 5000ms）内未完成时，产生一条含其 Server_Key 的诊断
   * （优先 `hooks.onError`，否则 `console.warn`），继续关闭其余客户端，并最终
   * 完成集合清空（Req 5.2 / 5.4）。空集合时为安全空操作（Req 5.7）。
   *
   * 实现以集合快照迭代：对每个条目先 `withTimeout(close(), closeTimeoutMs)`
   * 竞速，再 `_removeToolsByServerKey(serverKey)`（此时条目仍在 map 中，
   * 其 `toolNames` 可用），随后从 map 删除该条目。
   *
   * @returns {Promise<void>}
   */
  async _teardownManagedClients() {
    const entries = [...this._managedClients.values()]
    for (const entry of entries) {
      const { serverKey, client } = entry
      try {
        // 用 Promise.resolve().then 包裹，确保 client.close() 同步抛错也被竞速捕获。
        await withTimeout(
          Promise.resolve().then(() => client.close()),
          this.dynamicMCPOpts.closeTimeoutMs,
        )
      } catch (err) {
        const message = `closeMCPClients: failed to close MCP client for serverKey "${serverKey}": ${err?.message ?? err}`
        if (typeof this.hooks.onError === 'function') {
          try {
            this.hooks.onError(err instanceof Error ? err : new Error(message), {
              serverKey,
              phase: 'teardown',
            })
          } catch {
            // 钩子自身抛错不得影响其余客户端的关闭。
          }
        } else {
          console.warn(message)
        }
      }
      // 移除该客户端贡献的动态工具并取消 Base_Tool 注册（条目仍在 map 中）。
      this._removeToolsByServerKey(serverKey)
      this._managedClients.delete(serverKey)
    }
    // 保险：确保集合最终为空（应已被逐条删除）。
    this._managedClients.clear()
  }

  /**
   * 关闭所有运行时加载的 MCP_Client，移除其贡献的动态工具并取消 Base_Tool
   * 注册，最后清空 `_managedClients`。空集合时为安全空操作（Req 5.7）。
   *
   * @returns {Promise<void>}
   */
  async closeMCPClients() {
    if (this._managedClients.size === 0) return
    await this._teardownManagedClients()
  }

  /**
   * `load_mcp_server` 元工具主体：在对话进行中加载一个 MCP 服务器，把它的工具
   * 加入 Tool_Registry。所有失败路径均返回**描述性字符串**（不抛异常给 LLM，
   * 与既有工具执行 catch 分支一致），使 LLM 能读到错误并继续推理。
   *
   * 流程（见 design §Architecture）：
   *   1. 校验参数（对象 / 非空 serverKey / transport 枚举）→ 失败返回指明参数名
   *      的错误字符串，不调用 createMCPClient、不改 Tool_Registry（Req 3.5）。
   *   2. `createMCPClient(options)` 配 AbortController + connectTimeoutMs 超时竞速；
   *      装配 `onToolsChanged` 回调（Req 6.1）。连接失败 / 超时 → 描述性错误字符串
   *      （Req 3.6 / 3.8）。
   *   3. 同 serverKey 已存在 → 先 close 旧客户端（closeTimeoutMs 超时、错误隔离）
   *      并移除其工具（Req 5.1 / 5.6）。
   *   4. `listTools()` 后：空集仍保存 client 但不加工具，返回"无可用工具"文本
   *      （Req 3.9）；非空则 `addTools(tools, { asBaseTool: true })` 并保存
   *      ManagedEntry，返回含 serverKey 与新增工具名清单的成功文本（Req 3.3 / 3.4）。
   *
   * @param {object} params LLM 提供的连接参数
   * @param {object} [ctx] 工具执行上下文（含 signal 等，可选）
   * @returns {Promise<string>}
   */
  async _loadMCPServer(params, ctx = {}) {
    // ---- 1. 参数校验（指明失败参数名，不改 Tool_Registry）----
    if (params === null || typeof params !== 'object' || Array.isArray(params)) {
      return 'Error: load_mcp_server expects an object of connection parameters, but received a non-object value.'
    }
    const { serverKey, transport } = params
    if (typeof serverKey !== 'string' || serverKey.length === 0) {
      return 'Error: load_mcp_server parameter `serverKey` is required and must be a non-empty string.'
    }
    const SUPPORTED_TRANSPORTS = ['stdio', 'http', 'streamable-http', 'sse']
    if (!SUPPORTED_TRANSPORTS.includes(transport)) {
      return `Error: load_mcp_server parameter \`transport\` must be one of ${SUPPORTED_TRANSPORTS.join(', ')}, but received "${String(transport)}".`
    }

    // ---- 2. 建立连接（30s 超时竞速 + AbortController + onToolsChanged 装配）----
    const controller = new AbortController()
    // 把外部 signal（若有）与内部超时 abort 关联：外部取消时也中止本次连接。
    const outerSignal = ctx?.signal
    if (outerSignal) {
      if (outerSignal.aborted) controller.abort()
      else outerSignal.addEventListener('abort', () => controller.abort(), { once: true })
    }

    const options = {
      transport,
      signal: controller.signal,
      onToolsChanged: (tools) => this._onToolsChanged(serverKey, client, tools),
    }
    if (typeof params.command === 'string') options.command = params.command
    if (Array.isArray(params.args)) options.args = params.args
    if (typeof params.url === 'string') options.url = params.url
    if (params.headers && typeof params.headers === 'object') options.headers = params.headers
    if (typeof params.name === 'string') options.name = params.name

    let client
    let timedOut = false
    let timer
    try {
      // 测试可通过内部 seam `this._createMCPClient` 注入 mock 工厂；默认使用真实
      // `createMCPClient`。该 seam 不属于公开 API（不改变构造选项 / 公开方法）。
      const factory = this._createMCPClient ?? createMCPClient
      const connectPromise = factory(options)
      const timeoutPromise = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          controller.abort()
          reject(new Error(`connection timed out after ${this.dynamicMCPOpts.connectTimeoutMs}ms`))
        }, this.dynamicMCPOpts.connectTimeoutMs)
      })
      client = await Promise.race([connectPromise, timeoutPromise])
    } catch (err) {
      if (timedOut) {
        return `Error: load_mcp_server failed to connect to "${serverKey}": connection timed out after ${this.dynamicMCPOpts.connectTimeoutMs}ms.`
      }
      return `Error: load_mcp_server failed to connect to "${serverKey}": ${err?.message ?? err}`
    } finally {
      clearTimeout(timer)
    }

    // ---- 3. 同 serverKey 替换：先关闭旧客户端并移除其工具 ----
    if (this._managedClients.has(serverKey)) {
      const old = this._managedClients.get(serverKey)
      try {
        await withTimeout(
          Promise.resolve().then(() => old.client.close()),
          this.dynamicMCPOpts.closeTimeoutMs,
        )
      } catch (err) {
        const message = `load_mcp_server: failed to close previous MCP client for serverKey "${serverKey}": ${err?.message ?? err}`
        if (typeof this.hooks.onError === 'function') {
          try { this.hooks.onError(err instanceof Error ? err : new Error(message), { serverKey, phase: 'replace' }) } catch {}
        } else {
          console.warn(message)
        }
      }
      this._removeToolsByServerKey(serverKey)
      this._managedClients.delete(serverKey)
    }

    // ---- 4. listTools + 加入工具 + 保存 ManagedEntry ----
    let tools
    try {
      tools = await client.listTools()
    } catch (err) {
      // listTools 失败：保存的连接尚未建立，关闭并返回错误。
      try { await withTimeout(Promise.resolve().then(() => client.close()), this.dynamicMCPOpts.closeTimeoutMs) } catch {}
      return `Error: load_mcp_server connected to "${serverKey}" but failed to list its tools: ${err?.message ?? err}`
    }

    if (!Array.isArray(tools) || tools.length === 0) {
      // 空工具集：仍保存 client（便于后续 onToolsChanged / 统一关闭），但不加工具。
      this._managedClients.set(serverKey, { serverKey, client, toolNames: new Set() })
      return `MCP server "${serverKey}" connected, but it provided no available tools.`
    }

    this.addTools(tools, { asBaseTool: true })
    const toolNames = tools.map((t) => t.name)
    this._managedClients.set(serverKey, { serverKey, client, toolNames: new Set(toolNames) })

    return `Successfully loaded MCP server "${serverKey}" with ${toolNames.length} tool(s): ${toolNames.join(', ')}.`
  }

  /**
   * `notifications/tools/list_changed` 同步：用回调提供的新集合精确替换某
   * Server_Key 客户端当前贡献的动态工具（Req 6.2–6.7）。
   *
   *   - 陈旧客户端（`_managedClients.get(serverKey) !== client`）→ 忽略（Req 6.7）。
   *   - `newTools` 非数组，或含缺非空字符串 `name` 的元素 → 忽略（Req 6.6）。
   *   - 以 `entry.toolNames` 为准做集合替换：删除不在新集合的旧工具并
   *     `unregisterBaseTool`；加入 / 覆盖新集合工具并 `registerBaseTool`；空数组
   *     移除全部该客户端动态工具。仅实际产生变更时 `_toolsGeneration++` 并更新
   *     `toolNames`。
   *
   * @param {string} serverKey
   * @param {object} client 触发回调的 MCP_Client 实例
   * @param {object[]} newTools 新的 Tool_Def 数组
   * @returns {void}
   */
  _onToolsChanged(serverKey, client, newTools) {
    const entry = this._managedClients.get(serverKey)
    if (!entry || entry.client !== client) return // 陈旧客户端忽略（Req 6.7）
    if (!Array.isArray(newTools)) return // 非数组忽略（Req 6.6）
    for (const t of newTools) {
      if (t === null || typeof t !== 'object' || typeof t.name !== 'string' || t.name.length === 0) {
        return // 含非法元素 → 整体忽略（Req 6.6）
      }
    }

    const oldNames = entry.toolNames
    const newNames = new Set(newTools.map((t) => t.name))
    let changed = false

    // 删除不在新集合中的旧工具 + unregisterBaseTool（预置名除外）。
    for (const name of oldNames) {
      if (!newNames.has(name)) {
        const idx = this.tools.findIndex((t) => t.name === name)
        if (idx !== -1) {
          this.tools.splice(idx, 1)
          changed = true
        }
        if (!INITIAL_BASE_TOOLS.includes(name)) unregisterBaseTool(name)
      }
    }

    // 加入 / 覆盖新集合中的工具 + registerBaseTool。
    for (const tool of newTools) {
      const idx = this.tools.findIndex((t) => t.name === tool.name)
      if (idx === -1) {
        this.tools.push(tool)
        changed = true
      } else if (this.tools[idx] !== tool) {
        this.tools[idx] = tool
        changed = true
      }
      registerBaseTool(tool.name)
    }

    entry.toolNames = newNames
    if (changed) this._toolsGeneration++
  }

  // ---- ReAct 循环（非流式） ----

  async _reactLoop(userMessage, { signal } = {}) {
    // 工具集与 toolMap 在每轮边界处按 Tool_Registry 的 generation 重新派生。
    // 首轮由 `_runPipeline` 得到 filteredTools；后续轮仅在 `_toolsGeneration`
    // 相对上次派生发生变化时用 `_deriveRoundTools()` 重建（并同步重建 toolMap），
    // 否则复用上一轮快照（与既有 Round_Tools_Cache 行为等价）。单轮内使用派生
    // 快照，轮内对 Tool_Registry 的变化只在下一轮边界生效（Req 2.x / 7.1）。
    let roundTools = this.tools
    let toolMap = Object.fromEntries(this.tools.map(t => [t.name, t]))
    let derivedGeneration = -1

    for (let round = 0; round < this.maxRounds; round++) {
      signal?.throwIfAborted()
      this.hooks.onRoundStart?.(round)

      // Round lifecycle: emit round.start / round.end around the iteration
      // body. The per-round span becomes the parentSpanId for any llm.call
      // emitted inside this iteration (Requirement 4.3). The try/finally
      // below guarantees round.end fires on all three exit paths:
      //   - tool-call completion → finally runs then loop continues;
      //   - final-answer return  → finally runs before the return lands;
      //   - max-rounds break     → finally on the last iteration then the
      //     for-loop exits naturally into the post-loop block.
      const run = this._currentRun
      const roundSpanId = newSpanId()
      const roundStartedAt = Date.now()
      const roundStartPerf = performance.now()
      if (run) run.totalRounds += 1

      this._safeEmit('round.start', {
        traceId: run?.traceId,
        spanId: roundSpanId,
        parentSpanId: run?.rootSpanId ?? null,
        round,
        startedAt: roundStartedAt,
      })

      const telemetry = run
        ? {
            ctx: {
              traceId: run.traceId,
              parentSpanId: roundSpanId,
              operationName: 'agent.chat',
              bus: this._bus,
            },
            onLlmSpanStart: (spanId) => { run.currentLlmSpanId = spanId },
          }
        : undefined

      let roundEnded = false
      const endRound = () => {
        if (roundEnded) return
        roundEnded = true
        this._safeEmit('round.end', {
          traceId: run?.traceId,
          spanId: roundSpanId,
          round,
          durationMs: performance.now() - roundStartPerf,
          endedAt: Date.now(),
        })
      }

      try {
        let body
        if (round === 0) {
          const first = await this._runPipeline(userMessage, signal)
          body = first.body
          roundTools = first.filteredTools ?? this.tools
          toolMap = Object.fromEntries(roundTools.map(t => [t.name, t]))
          // 缓存首轮意图结果，供后续轮 `_deriveRoundTools` 重新应用 ToolFilter。
          this._lastIntent = first.intent ?? null
          derivedGeneration = this._toolsGeneration
        } else if (this._toolsGeneration !== derivedGeneration) {
          // Tool_Registry 自上次派生以来发生变化 → 重新派生该轮工具集与 toolMap。
          roundTools = this._deriveRoundTools()
          toolMap = Object.fromEntries(roundTools.map(t => [t.name, t]))
          derivedGeneration = this._toolsGeneration
          body = (await this._buildSimpleBody(roundTools)).body
        } else {
          // 未变更 → 复用上一轮快照。
          body = (await this._buildSimpleBody(roundTools)).body
        }

        const response = await syncChat({ url: this.url, apiKey: this.apiKey, body, signal, telemetry })

        const choice = response.choices?.[0]
        const message = choice?.message
        if (!message) throw new Error('Empty LLM response')

        const textContent = message.content ?? ''
        const toolCalls = parseToolCalls(response)

        // finish_reason === 'length' 且无工具调用：文本被截断，直接返回已有内容
        if (toolCalls.length === 0) {
          this.memory.add({ role: 'assistant', content: textContent })
          return textContent
        }

        this.memory.add({
          role: 'assistant',
          content: textContent || null,
          tool_calls: message.tool_calls,
        })

        for (const call of toolCalls) {
          // tool.call emission scaffold — Req 3.1-3.8.
          // `toolStartPerf` is captured at the very top of the per-call
          // block so `durationMs` includes the existing pre-checks and the
          // `beforeToolCall` gate, as mandated by Requirement 3.4.
          const toolSpanId = newSpanId()
          const toolStartPerf = performance.now()
          const tool = toolMap[call.name]
          let result
          /** @type {undefined | 'not_found' | 'rejected' | 'truncated_args' | 'aborted' | 'exception'} */
          let errorKind

          // 工具调用参数被截断（finish_reason=length + JSON 解析失败）：
          // 不执行工具，反馈错误让 LLM 重试
          if (call._truncated && call._parseError) {
            errorKind = 'truncated_args'
            result = `Error: Tool call "${call.name}" was truncated by the model (finish_reason=length). ` +
              `The arguments JSON is incomplete and could not be parsed. Please retry with shorter arguments.`
          } else if (!tool) {
            errorKind = 'not_found'
            const availableNames = roundTools.map(t => t.name).join(', ') || '(none)'
            result = `Error: Tool "${call.name}" not found. It may have been removed or its MCP server unloaded since earlier in this conversation. Available tools now: ${availableNames}. Do not call "${call.name}" again; use one of the available tools, or if none fits, tell the user this capability is currently unavailable.`
          } else {
            try {
              // beforeToolCall 返回 false 阻止执行
              const approved = await this.hooks.beforeToolCall?.(call.name, call.arguments)
              if (approved === false) {
                errorKind = 'rejected'
                result = `Tool call "${call.name}" was rejected by the application.`
              } else {
                result = await tool.execute(call.arguments, { signal })
              }
            } catch (err) {
              // Classify per Requirement 3.7: abort wins over generic
              // exception so a tool that throws because the signal fired
              // reports `'aborted'` rather than `'exception'`.
              errorKind = (err?.name === 'AbortError' || signal?.aborted)
                ? 'aborted'
                : 'exception'
              result = `Error executing ${call.name}: ${err.message}`
              this.hooks.onError?.(err, { round, toolName: call.name })
            }
          }
          this.hooks.afterToolCall?.(call.name, call.arguments, result)
          this.memory.add(formatToolResult(call.id, call.name, result))

          // Emit tool.call after the exact-same memory string is appended
          // (Requirement 9.3: memory content byte-for-byte unchanged).
          // `bytes` measures the UTF-8 byte length of the appended result
          // string (Requirement 3.5). The internal listener installed in
          // `_runWithSession` pushes this payload onto `_currentRun.toolCalls`,
          // so Task 5.2 does not need to push explicitly.
          const ok = errorKind === undefined
          /** @type {{ traceId: string|undefined, spanId: string, parentSpanId: string|null, name: string, arguments: object|null, durationMs: number, bytes: number, ok: boolean, errorKind?: string }} */
          const toolCallPayload = {
            traceId: run?.traceId,
            spanId: toolSpanId,
            parentSpanId: run?.currentLlmSpanId ?? null,
            name: call.name,
            arguments: call.arguments,
            durationMs: performance.now() - toolStartPerf,
            bytes: utf8ByteLength(String(result)),
            ok,
          }
          if (!ok) toolCallPayload.errorKind = errorKind
          this._safeEmit('tool.call', toolCallPayload)
        }
      } finally {
        endRound()
      }
    }

    // 超轮：补写一条 final assistant 消息，避免 memory 尾部停在 assistant(tool_calls) → tool。
    // 见 todo.md P0-4。
    const maxRoundsMsg = '[max rounds exceeded]'
    this.memory.add({ role: 'assistant', content: maxRoundsMsg })
    return maxRoundsMsg
  }

  // ---- ReAct 循环（流式） ----

  async *_reactLoopStream(userMessage, { signal } = {}) {
    // 与 `_reactLoop` 共用同一派生策略：每轮边界按 generation 比对决定复用或
    // 重新派生（`_deriveRoundTools()`），并同步重建 toolMap，保证流式与非流式
    // 两条路径派生出元素集合相等的 roundTools / toolMap（Req 2.5 / 2.6 / 7.1）。
    let roundTools = this.tools
    let toolMap = Object.fromEntries(this.tools.map(t => [t.name, t]))
    let derivedGeneration = -1

    for (let round = 0; round < this.maxRounds; round++) {
      signal?.throwIfAborted()
      this.hooks.onRoundStart?.(round)

      // Round lifecycle — see `_reactLoop` for the rationale behind the
      // try/finally around the iteration body. The streaming version
      // benefits from the same guarantee: `endRound()` fires even when a
      // `yield` inside the body is followed by a `return` / `throw` from
      // the consumer.
      const run = this._currentRun
      const roundSpanId = newSpanId()
      const roundStartedAt = Date.now()
      const roundStartPerf = performance.now()
      if (run) run.totalRounds += 1

      this._safeEmit('round.start', {
        traceId: run?.traceId,
        spanId: roundSpanId,
        parentSpanId: run?.rootSpanId ?? null,
        round,
        startedAt: roundStartedAt,
      })

      const telemetry = run
        ? {
            ctx: {
              traceId: run.traceId,
              parentSpanId: roundSpanId,
              operationName: 'agent.chat',
              bus: this._bus,
            },
            onLlmSpanStart: (spanId) => { run.currentLlmSpanId = spanId },
          }
        : undefined

      let roundEnded = false
      const endRound = () => {
        if (roundEnded) return
        roundEnded = true
        this._safeEmit('round.end', {
          traceId: run?.traceId,
          spanId: roundSpanId,
          round,
          durationMs: performance.now() - roundStartPerf,
          endedAt: Date.now(),
        })
      }

      try {
        let body
        let intent
        if (round === 0) {
          const first = await this._runPipeline(userMessage, signal)
          body = first.body
          intent = first.intent
          roundTools = first.filteredTools ?? this.tools
          toolMap = Object.fromEntries(roundTools.map(t => [t.name, t]))
          this._lastIntent = first.intent ?? null
          derivedGeneration = this._toolsGeneration
        } else if (this._toolsGeneration !== derivedGeneration) {
          roundTools = this._deriveRoundTools()
          toolMap = Object.fromEntries(roundTools.map(t => [t.name, t]))
          derivedGeneration = this._toolsGeneration
          body = (await this._buildSimpleBody(roundTools)).body
          intent = defaultIntentResult()
        } else {
          body = (await this._buildSimpleBody(roundTools)).body
          intent = defaultIntentResult()
        }

        // 首轮推送意图识别结果
        if (round === 0 && this.intentRecognizer) {
          yield { type: 'intent', intent }
        }

        // 真正的流式推送：逐 chunk yield delta
        let response = null
        for await (const event of streamChatIter({
          url: this.url,
          apiKey: this.apiKey,
          body,
          signal,
          telemetry,
        })) {
          if (event.type === 'delta') {
            yield { type: 'delta', content: event.content }
          } else if (event.type === 'reasoning') {
            yield { type: 'reasoning', content: event.content }
          } else if (event.type === 'tool_call') {
            yield { type: 'tool_call', index: event.index, toolCall: event.toolCall }
          } else if (event.type === 'done') {
            response = event.response
          }
        }

        if (!response) throw new Error('Empty LLM response')

        const textContent = response.choices?.[0]?.message?.content ?? ''
        const toolCalls = parseToolCalls(response)

        if (toolCalls.length === 0) {
          this.memory.add({ role: 'assistant', content: textContent })
          yield { type: 'done', content: textContent }
          return
        }

        this.memory.add({
          role: 'assistant',
          content: textContent || null,
          tool_calls: response.choices[0].message.tool_calls,
        })

        for (const call of toolCalls) {
          yield { type: 'tool_start', name: call.name, arguments: call.arguments }

          // See `_reactLoop` for the classification rationale. The stream
          // path keeps the existing error strings byte-for-byte (Req 9.3)
          // and yields `tool_start` / `tool_end` as before (Req 9.2); the
          // `tool.call` emission is interleaved between the memory write
          // and the `tool_end` yield so aggregate bookkeeping lands before
          // the consumer observes the step as complete.
          const toolSpanId = newSpanId()
          const toolStartPerf = performance.now()
          const tool = toolMap[call.name]
          let result
          /** @type {undefined | 'not_found' | 'rejected' | 'truncated_args' | 'aborted' | 'exception'} */
          let errorKind

          if (call._truncated && call._parseError) {
            errorKind = 'truncated_args'
            result = `Error: Tool call "${call.name}" was truncated by the model (finish_reason=length). ` +
              `The arguments JSON is incomplete and could not be parsed. Please retry with shorter arguments.`
          } else if (!tool) {
            errorKind = 'not_found'
            const availableNames = roundTools.map(t => t.name).join(', ') || '(none)'
            result = `Error: Tool "${call.name}" not found. It may have been removed or its MCP server unloaded since earlier in this conversation. Available tools now: ${availableNames}. Do not call "${call.name}" again; use one of the available tools, or if none fits, tell the user this capability is currently unavailable.`
          } else {
            try {
              const approved = await this.hooks.beforeToolCall?.(call.name, call.arguments)
              if (approved === false) {
                errorKind = 'rejected'
                result = `Tool call "${call.name}" was rejected by the application.`
              } else {
                result = await tool.execute(call.arguments, { signal })
              }
            } catch (err) {
              errorKind = (err?.name === 'AbortError' || signal?.aborted)
                ? 'aborted'
                : 'exception'
              result = `Error: ${err.message}`
              this.hooks.onError?.(err, { round, toolName: call.name })
            }
          }

          this.hooks.afterToolCall?.(call.name, call.arguments, result)
          this.memory.add(formatToolResult(call.id, call.name, result))

          const ok = errorKind === undefined
          /** @type {{ traceId: string|undefined, spanId: string, parentSpanId: string|null, name: string, arguments: object|null, durationMs: number, bytes: number, ok: boolean, errorKind?: string }} */
          const toolCallPayload = {
            traceId: run?.traceId,
            spanId: toolSpanId,
            parentSpanId: run?.currentLlmSpanId ?? null,
            name: call.name,
            arguments: call.arguments,
            durationMs: performance.now() - toolStartPerf,
            bytes: utf8ByteLength(String(result)),
            ok,
          }
          if (!ok) toolCallPayload.errorKind = errorKind
          this._safeEmit('tool.call', toolCallPayload)

          yield { type: 'tool_end', name: call.name, result }
        }
      } finally {
        endRound()
      }
    }

    // 超轮：同步写入 memory，保持与 _reactLoop 行为一致。见 todo.md P0-4。
    const maxRoundsMsg = '[max rounds exceeded]'
    this.memory.add({ role: 'assistant', content: maxRoundsMsg })
    yield { type: 'done', content: maxRoundsMsg }
  }

  // ---- PlanAndExecute 策略委托 ----

  /** 创建 PlanAndExecuteStrategy 实例（懒初始化） */
  _getPlanAndExecuteStrategy(extraCallbacks = {}) {
    return new PlanAndExecuteStrategy({
      url: this.url,
      apiKey: this.apiKey,
      model: this.model,
      temperature: this.temperature,
      tools: this.tools,
      ...this.planAndExecuteOpts,
      ...extraCallbacks,
    })
  }

  async _planAndExecuteChat(message, { signal } = {}) {
    const strategy = this._getPlanAndExecuteStrategy()
    // 在写入当前轮之前拿历史，传给 strategy 供 planner/synthesizer 使用（P1-2）
    const history = await this._getHistory()
    const telemetry = this._currentRun?.rootCtx ?? null
    const { content, plan, toolCallHistory } = await strategy.execute(message, { signal, history, telemetry })
    this._recordPlanArtifacts({ message, content, plan, toolCallHistory })
    // 将最终结果写入 memory 以保持对话连续性
    this.memory.add({ role: 'user', content: message })
    this.memory.add({ role: 'assistant', content })
    return content
  }

  async *_planAndExecuteStream(message, { signal } = {}) {
    const strategy = this._getPlanAndExecuteStrategy({ useStreaming: true })
    const history = await this._getHistory()
    const telemetry = this._currentRun?.rootCtx ?? null
    let finalContent = ''
    let finalPlan = null
    let finalToolCallHistory = []
    for await (const event of strategy.stream(message, { signal, history, telemetry })) {
      if (event.type === 'done' && typeof event.content === 'string') {
        finalContent = event.content
      }
      if (event.type === 'done') {
        if (Array.isArray(event.plan)) finalPlan = event.plan
        if (Array.isArray(event.toolCallHistory)) finalToolCallHistory = event.toolCallHistory
      }
      yield event
    }
    this._recordPlanArtifacts({
      message,
      content: finalContent,
      plan: finalPlan,
      toolCallHistory: finalToolCallHistory,
    })
    // 将最终结果写入 memory 以保持对话连续性（对齐 _planAndExecuteChat）
    this.memory.add({ role: 'user', content: message })
    this.memory.add({ role: 'assistant', content: finalContent })
  }

  // ---- 辅助方法 ----

  _recordPlanArtifacts({ message, content, plan, toolCallHistory }) {
    const rh = this.memory?.runtimeHistory
    if (!rh || typeof rh.appendArtifact !== 'function') return
    if (Array.isArray(plan)) {
      rh.appendArtifact({
        kind: 'plan',
        request: message,
        steps: plan.map(step => ({
          index: step.index,
          description: step.description,
          status: step.status,
          result: step.result,
          durationMs: step.durationMs,
          rounds: step.rounds,
        })),
      })
      for (const step of plan) {
        rh.appendArtifact({
          kind: 'plan_step',
          index: step.index,
          description: step.description,
          status: step.status,
          result: step.result,
          toolCalls: Array.isArray(step.toolCalls) ? step.toolCalls.slice() : [],
        })
      }
    }
    rh.appendArtifact({
      kind: 'final_answer',
      request: message,
      content,
      toolCallHistory: Array.isArray(toolCallHistory) ? toolCallHistory.slice() : [],
    })
  }

  /**
   * 统一读取 memory 中的 messages，兼容同步/异步 getMessages。
   * 避免把 Promise 直接塞进请求体（见 todo.md P0-1）。
   * @returns {Promise<object[]>}
   */
  async _getMessages() {
    if (typeof this.memory.getMessages !== 'function') return []
    return await this.memory.getMessages()
  }

  /**
   * 统一读取对话历史，兼容同步/异步 getHistory，并处理没有 getHistory
   * 实现的自定义 memory（退化到 getMessages 后过滤 system）。
   * 见 todo.md P0-2。
   * @returns {Promise<object[]>}
   */
  async _getHistory() {
    if (typeof this.memory.getHistory === 'function') {
      return await this.memory.getHistory()
    }
    const msgs = await this._getMessages()
    return msgs.filter(m => m.role !== 'system')
  }

  /**
   * 后续轮次的简单请求体构建（不重新走 pipeline）。
   * @param {import('./tool.js').ToolDef[]} [tools] - 该轮使用的工具集；
   *   默认为 `this.tools`（全量）。ReAct 循环会传入首轮的 filteredTools 以
   *   保持跨轮工具集一致（P0-5）。
   */
  /**
   * 给一组待发送的 messages 计算并合并"已不可用工具"提示。
   *
   * 扫描对话历史里被引用过的工具名（`assistant.tool_calls[].function.name`
   * 与 `tool` 角色消息的 `name`），凡是当前 Tool_Registry（`this.tools`）中
   * 已不存在的，视为"运行时被移除/卸载"的工具。若存在这类工具，则把一条提示
   * 合并进**本轮**发送的 system 消息（不持久化进 memory，每轮重算、自我纠正），
   * 明确告诉模型这些工具已不可用、不要再调用。
   *
   * 仅当历史引用的工具名与当前工具集出现差集时才生效——静态工具（从不在运行时
   * 增删）的调用方永不触发，故对既有行为完全向后兼容（Req 7.1/7.2）。该判断与
   * 工具"如何"被移除无关（`removeTool` / `closeMCPClients` / `onToolsChanged`
   * 乃至直接整体替换 `this.tools` 都覆盖）。
   *
   * @param {object[]} messages 即将发送给 LLM 的消息数组
   * @returns {object[]} 合并提示后的新数组（无差集时原样返回，不复制）
   */
  _withUnavailableToolsNote(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return messages

    const current = new Set(this.tools.map((t) => t.name))
    const referenced = new Set()
    for (const m of messages) {
      if (m && m.role === 'assistant' && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const n = tc?.function?.name
          if (typeof n === 'string' && n.length > 0) referenced.add(n)
        }
      } else if (m && m.role === 'tool' && typeof m.name === 'string' && m.name.length > 0) {
        referenced.add(m.name)
      }
    }

    const gone = [...referenced].filter((n) => !current.has(n))
    if (gone.length === 0) return messages

    const note =
      `Note: the following tools were used earlier in this conversation but are no longer available. ` +
      `Do not call them again: ${gone.join(', ')}. Use only the tools provided to you this turn; ` +
      `if none fits the request, tell the user the capability is currently unavailable.`

    const out = messages.slice()
    const sysIdx = out.findIndex((m) => m && m.role === 'system')
    if (sysIdx === -1) {
      out.unshift({ role: 'system', content: note })
    } else {
      const sys = out[sysIdx]
      const base = typeof sys.content === 'string' ? sys.content : ''
      out[sysIdx] = { ...sys, content: base ? `${base}\n\n${note}` : note }
    }
    return out
  }

  async _buildSimpleBody(tools = this.tools) {
    const messages = this._withUnavailableToolsNote(await this._getMessages())
    const openaiTools = tools.length > 0 ? formatToolsForOpenAI(tools) : undefined
    return {
      body: {
        model: this.model,
        messages,
        temperature: this.temperature,
        ...(openaiTools ? { tools: openaiTools } : {}),
      },
      intent: defaultIntentResult(),
    }
  }
}
