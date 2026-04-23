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

import { streamChat, syncChat } from './llm-client.js'
import { formatToolsForOpenAI, parseToolCalls, formatToolResult } from './tool.js'
import { SlidingWindowMemory } from './memory.js'
import { resolveProviderUrl } from './providers.js'
import { IntentRecognizer, defaultIntentResult } from './intent-recognizer.js'
import { ToolFilter } from './tool-filter.js'
import { ContextManager, defaultTokenBudget } from './context-manager.js'
import { PlanAndExecuteStrategy } from './plan-and-execute.js'

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
   * @param {number} [opts.maxMessages=40] - 记忆窗口大小
   * @param {number} [opts.temperature=1] - 温度
   * @param {boolean} [opts.enableIntentRecognition=false] - 启用意图识别
   * @param {string} [opts.intentModel] - 意图识别使用的模型（默认同主模型）
   * @param {import('./knowledge-base.js').KnowledgeBase} [opts.knowledgeBase] - 知识库
   * @param {import('./context-manager.js').TokenBudget} [opts.tokenBudget] - token 预算
   * @param {import('./memory.js').SlidingWindowMemory|import('./memory.js').SummarizingMemory} [opts.memory] - 自定义记忆实例
   * @param {'react'|'plan_and_execute'} [opts.strategy='react'] - 执行策略
   * @param {object} [opts.planAndExecuteOpts] - PlanAndExecute 策略配置
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
    this.temperature = opts.temperature ?? 1

    // 记忆：支持外部注入自定义 memory 实例
    this.memory = opts.memory ?? new SlidingWindowMemory(opts.maxMessages ?? 40)
    this.memory.add({ role: 'system', content: this.systemPrompt })

    // ---- Runtime 组件 ----
    this.enableIntentRecognition = opts.enableIntentRecognition ?? false
    this.knowledgeBase = opts.knowledgeBase ?? null
    this.tokenBudget = opts.tokenBudget ?? null

    // IntentRecognizer（sidecar LLM 调用）
    this.intentRecognizer = this.enableIntentRecognition
      ? new IntentRecognizer({ url: this.url, apiKey: this.apiKey, model: opts.intentModel ?? this.model })
      : null

    // ToolFilter
    this.toolFilter = new ToolFilter()

    // ContextManager
    this.contextManager = new ContextManager()
    if (this.knowledgeBase) this.contextManager.knowledgeBase = this.knowledgeBase

    // ---- 执行策略 ----
    this.strategy = opts.strategy ?? 'react'
    this.planAndExecuteOpts = opts.planAndExecuteOpts ?? {}
  }

  /**
   * 同步对话 — 发送消息，返回最终回复文本
   * @param {string} message
   * @param {object} [opts]
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<string>}
   */
  async chat(message, opts = {}) {
    if (this.strategy === 'plan_and_execute') {
      return this._planAndExecuteChat(message, opts)
    }
    this.memory.add({ role: 'user', content: message })
    return this._reactLoop(message, opts)
  }

  /**
   * 流式对话 — 通过 async generator 实时推送内容
   * @param {string} message
   * @param {object} [opts]
   * @param {AbortSignal} [opts.signal]
   * @yields {{ type: 'delta'|'reasoning'|'tool_start'|'tool_end'|'intent'|'done', ... }}
   */
  async *stream(message, opts = {}) {
    if (this.strategy === 'plan_and_execute') {
      yield* this._planAndExecuteStream(message, opts)
      return
    }
    this.memory.add({ role: 'user', content: message })
    yield* this._reactLoopStream(message, opts)
  }

  /** 清空对话历史，开始新会话 */
  reset() {
    this.memory.clear()
    this.memory.add({ role: 'system', content: this.systemPrompt })
  }

  // ---- Runtime 管线：意图识别 + 工具过滤 + 上下文组装 ----

  /**
   * 执行 Runtime 管线，返回组装好的 LLM 请求参数。
   * @param {string} userMessage - 当前用户消息
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ body: object, intent: import('./intent-recognizer.js').IntentResult, filteredTools: import('./tool.js').ToolDef[] }>}
   */
  async _runPipeline(userMessage, signal) {
    // 1. 意图识别（sidecar）
    let intent = defaultIntentResult()
    if (this.intentRecognizer) {
      const toolNames = this.tools.map(t => t.name)
      intent = await this.intentRecognizer.analyze(userMessage, toolNames, signal)
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
          messages: assembled.messages,
          temperature: this.temperature,
          ...(assembled.tools ? { tools: assembled.tools } : {}),
        },
        intent,
        filteredTools,
      }
    }

    // 简单模式：直接使用 memory 中的消息
    const messages = await this._getMessages()

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

  // ---- ReAct 循环（非流式） ----

  async _reactLoop(userMessage, { signal } = {}) {
    const toolMap = Object.fromEntries(this.tools.map(t => [t.name, t]))

    // 首轮 pipeline 得到的 filteredTools 在后续轮次复用，保证工具集一致性。
    // 见 todo.md P0-5。
    let roundTools = this.tools

    for (let round = 0; round < this.maxRounds; round++) {
      signal?.throwIfAborted()

      let body
      if (round === 0) {
        const first = await this._runPipeline(userMessage, signal)
        body = first.body
        roundTools = first.filteredTools ?? this.tools
      } else {
        body = (await this._buildSimpleBody(roundTools)).body
      }

      const response = await syncChat({ url: this.url, apiKey: this.apiKey, body, signal })

      const message = response.choices?.[0]?.message
      if (!message) throw new Error('Empty LLM response')

      const textContent = message.content ?? ''
      const toolCalls = parseToolCalls(response)

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
        const tool = toolMap[call.name]
        let result
        if (!tool) {
          result = `Error: Tool "${call.name}" not found. Available: ${this.tools.map(t => t.name).join(', ')}`
        } else {
          try {
            result = await tool.execute(call.arguments)
          } catch (err) {
            result = `Error executing ${call.name}: ${err.message}`
          }
        }
        this.memory.add(formatToolResult(call.id, call.name, result))
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
    const toolMap = Object.fromEntries(this.tools.map(t => [t.name, t]))

    // 首轮 filteredTools 在后续轮次复用，见 todo.md P0-5。
    let roundTools = this.tools

    for (let round = 0; round < this.maxRounds; round++) {
      signal?.throwIfAborted()

      let body
      let intent
      if (round === 0) {
        const first = await this._runPipeline(userMessage, signal)
        body = first.body
        intent = first.intent
        roundTools = first.filteredTools ?? this.tools
      } else {
        body = (await this._buildSimpleBody(roundTools)).body
        intent = defaultIntentResult()
      }

      // 首轮推送意图识别结果
      if (round === 0 && this.intentRecognizer) {
        yield { type: 'intent', intent }
      }

      const response = await streamChat({
        url: this.url,
        apiKey: this.apiKey,
        body,
        signal,
        onDelta: () => {},
      })

      const textContent = response.choices?.[0]?.message?.content ?? ''
      const toolCalls = parseToolCalls(response)

      if (textContent) {
        yield { type: 'delta', content: textContent }
      }

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

        const tool = toolMap[call.name]
        let result
        if (!tool) {
          result = `Error: Tool "${call.name}" not found`
        } else {
          try {
            result = await tool.execute(call.arguments)
          } catch (err) {
            result = `Error: ${err.message}`
          }
        }

        this.memory.add(formatToolResult(call.id, call.name, result))
        yield { type: 'tool_end', name: call.name, result }
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
    const { content } = await strategy.execute(message, { signal })
    // 将最终结果写入 memory 以保持对话连续性
    this.memory.add({ role: 'user', content: message })
    this.memory.add({ role: 'assistant', content })
    return content
  }

  async *_planAndExecuteStream(message, { signal } = {}) {
    const strategy = this._getPlanAndExecuteStrategy({ useStreaming: true })
    for await (const event of strategy.stream(message, { signal })) {
      yield event
    }
    // 将最终结果写入 memory
    // (done event 中包含 content)
  }

  // ---- 辅助方法 ----

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
  async _buildSimpleBody(tools = this.tools) {
    const messages = await this._getMessages()
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
