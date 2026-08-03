# lll-web-agent

开箱即用的 LLM Agent SDK — 配个 API Key 就能跑。

内置完整 Runtime 管线：意图识别 → 工具过滤 → 上下文管理（token 预算） → ReAct 循环，
外加四个可选子系统：**MCP Client**、**Skill 系统**、**Subagent 系统**、**Telemetry**。
每个子系统未配置时零开销 —— 不注入工具、不发事件、行为与不带它时一致。

## 目录

- [安装](#安装) · [快速开始](#快速开始) · [流式对话](#流式对话) · [架构](#架构)
- **核心模块**：[Agent 配置](#agent) · [Hooks](#hooks) · [IntentRecognizer](#intentrecognizer) ·
  [KnowledgeBase](#knowledgebase) · [ContextManager](#contextmanager) ·
  [Memory 策略](#memory-策略) · [RuntimeHistory 与轨道](#runtimehistory-与轨道) ·
  [ToolFilter](#toolfilter) · [PlanAndExecute](#planandexecute-执行策略)
- **可选子系统**：[可观测性 / Telemetry](#可观测性--telemetry) ·
  [MCP Client](#mcp-clientmodel-context-protocol) ·
  [运行时动态工具管理](#运行时动态工具管理) ·
  [Skill 系统](#skill-系统) · [Subagent 系统](#subagent-系统)
- [浏览器使用](#浏览器使用) · [示例与 demo](#示例与-demo) · [License](#license)

## 安装

```bash
npm install lll-web-agent
```

## 快速开始

### 基础用法（10 行代码）

```js
import { Agent, defineTool } from 'lll-web-agent'

const readFile = defineTool({
  name: 'read_file',
  description: '读取文件内容',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  execute: async ({ path }) => (await import('fs/promises')).readFile(path, 'utf-8'),
})

const agent = new Agent({
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4',
  tools: [readFile],
})

const reply = await agent.chat('读取 package.json 并告诉我项目名称')
console.log(reply)
```

### Runtime 模式（完整管线）

```js
import { Agent, KnowledgeBase, createKnowledgeEntry } from 'lll-web-agent'

// 1. 构建知识库
const kb = new KnowledgeBase()
kb.addEntry(createKnowledgeEntry('ARCHITECTURE', '项目架构', '本项目使用 monorepo 结构...'))
kb.addEntry(createKnowledgeEntry('ERROR_PATTERN', '常见错误', '避免在循环中使用 await...'))

// 2. 创建 Agent（启用 Runtime 管线）
const agent = new Agent({
  provider: 'deepseek',
  apiKey: process.env.DEEPSEEK_API_KEY,
  model: 'deepseek-chat',
  tools: [readFile, shellExec],
  enableIntentRecognition: true,   // 启用意图识别（sidecar LLM 调用）
  knowledgeBase: kb,               // 注入知识库
  tokenBudget: {                   // 自定义 token 预算
    totalTokens: 60000,
    systemPromptRatio: 0.15,
    knowledgeRatio: 0.20,
    historyRatio: 0.45,
    toolsRatio: 0.20,
  },
})

const reply = await agent.chat('分析项目架构并找出潜在问题')
```

## 流式对话

```js
for await (const event of agent.stream('帮我重构这个函数')) {
  switch (event.type) {
    case 'intent':     console.log('意图:', event.intent); break
    case 'delta':      process.stdout.write(event.content); break
    case 'tool_start': console.log(`\n🔧 ${event.name}(${JSON.stringify(event.arguments)})`); break
    case 'tool_end':   console.log(`✅ ${event.name} → ${event.result}`); break
    case 'done':
      // done 附带结构化的 stopReason（'completed' | 'max_rounds'）与
      // rounds（轮次耗尽时），供消费方判断而非解析哨兵字符串。
      console.log(`\n完成 (stopReason=${event.stopReason}${event.rounds ? `, rounds=${event.rounds}` : ''})`)
      break
  }
}
```

若上游网关在流结束时省略 `finish_reason`（默认会被判定为截断并抛出
`LlmStreamIncompleteError`），可关闭校验：

```js
const agent = new Agent({ ..., validateStreamCompletion: false })
```

## 架构

```
用户消息
  │
  ├─ enableIntentRecognition=true?
  │   └─ IntentRecognizer (sidecar LLM 调用)
  │       → { clarity, complexity, recommendedStrategy, filteredToolNames }
  │
  ├─ ToolFilter
  │   → 根据 intent 过滤工具（BaseTool 始终保留）
  │
  ├─ ContextManager (如果配置了 tokenBudget 或 knowledgeBase)
  │   → 组装 prompt: systemPrompt + knowledge + history + tools
  │   → 超预算时按优先级裁剪: TOOLS → HISTORY → KNOWLEDGE
  │
  └─ 执行策略（strategy）
      ├─ react（默认）
      │   → LLM 调用 → 工具执行 → 观察结果 → 继续/完成
      │
      └─ plan_and_execute
          → Phase 1: Planning（LLM 生成结构化计划）
          → Phase 2: Execution（逐步执行，每步内部 ReAct 循环）
          → Phase 3: Synthesis（汇总结果，生成最终回答）
          → 支持自适应重规划（步骤失败时自动修订计划）
```

## 核心模块

### Agent

主入口，支持两种模式：

**基础**

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `provider` | (必需) | 供应商: openai, deepseek, qwen, moonshot, zhipu, x-grok |
| `apiKey` | (必需) | API Key |
| `model` | `'gpt-4'` | 模型名称 |
| `url` | 按 `provider` 推导 | 自定义 API URL（OpenAI 兼容端点） |
| `systemPrompt` | `'You are a helpful assistant.'` | 系统提示词 |
| `tools` | `[]` | 工具列表（`defineTool` 产出的 Tool_Def） |
| `temperature` | `0.6` | 温度（Agent 场景建议 0.5-0.7，兼顾工具调用稳定性与对话自然度） |
| `maxRounds` | `300` | 最大 ReAct 轮次 |

**Runtime 管线**

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `enableIntentRecognition` | `false` | 启用意图识别（sidecar LLM 调用，见 [IntentRecognizer](#intentrecognizer)） |
| `knowledgeBase` | `null` | 知识库实例 |
| `tokenBudget` | `null` | token 预算配置 |
| `strategy` | `'react'` | 执行策略: `'react'` 或 `'plan_and_execute'` |
| `planAndExecuteOpts` | `{}` | PlanAndExecute 策略配置（见 [下方](#planandexecute-配置参数)） |
| `validateStreamCompletion` | `true` | 校验流式响应以非空 `finish_reason` 收尾；为 `false` 时容忍网关省略 `finish_reason` 的流（不再抛 `LlmStreamIncompleteError`）。`react` 与 `plan_and_execute` 两种策略下均生效 |

**记忆**

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `memory` | `SummarizingMemory({ threshold: 20, keepRecent: 5 })` | 自定义记忆实例。默认实例的 summarizer 走简单任务模型（见下）自动压缩上下文 |
| `memoryOpts.threshold` | `20` | 触发摘要的消息数阈值（仅在未传 `memory` 时生效） |
| `memoryOpts.keepRecent` | `5` | 摘要后保留的最近消息数（仅在未传 `memory` 时生效） |

> 默认记忆是 `SummarizingMemory` 而不是滑动窗口 —— 长会话里较早的轮次会被压缩成摘要。
> 任何读原始历史的宿主逻辑都要容忍"最初那条 user 消息已经不在了"。需要不压缩的行为请
> 显式传 `memory: new SlidingWindowMemory(40)`。

**简单任务模型（sidecar）**

意图识别、难度判断、工具/skill 筛选、记忆摘要这些 sidecar 调用走这一组配置；任一字段
未配置时回退到主模型的对应字段。

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `simpleModel` | 回退到 `model` | 简单任务模型名 |
| `simpleApiKey` | 回退到 `apiKey` | 简单任务模型的 API Key |
| `simpleProvider` | 回退到 `provider` | 简单任务模型的供应商 |
| `simpleUrl` | 回退到 `url` | 简单任务模型的自定义 URL |

> `simpleModel` 同时是 subagent 系统 `fast` 别名的来源，见 [模型别名](#模型别名)。

**扩展子系统**

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `hooks` | `{}` | 生命周期钩子，见 [Hooks](#hooks) |
| `skills` | `null` | Skill 系统配置，见 [Skill 系统](#skill-系统) |
| `subagents` | `null` | Subagent 系统配置，见 [Subagent 系统](#subagent-系统) |
| `enableDynamicMCP` | `false` | 注入 `load_mcp_server` 元工具，让模型在对话中自主挂载 MCP Server，见 [运行时动态工具管理](#运行时动态工具管理) |
| `dynamicMCPOpts.connectTimeoutMs` | `30000` | 动态加载 MCP 的连接超时 |
| `dynamicMCPOpts.closeTimeoutMs` | `5000` | 动态加载 MCP 的关闭超时 |

`skills` / `subagents` 未配置时对应子系统完全不启用（零开销）：不注入任何工具、不发任何
新事件、`agent.skills` / `agent.subagents` 恒为 `null`。

### Hooks

五个可选钩子，都在 `opts.hooks` 下。

| 钩子 | 签名 | 说明 |
|------|------|------|
| `beforeToolCall` | `(name, args) => Promise<boolean\|void>` | 工具执行前。**返回 `false` 阻止本次执行** —— 这是宿主唯一的工具准入闸门 |
| `afterToolCall` | `(name, args, result) => void` | 工具执行后，`result` 是工具返回的字符串 |
| `onRoundStart` | `(round) => void` | 每轮 ReAct 循环开始 |
| `onError` | `(error, context) => void` | 错误回调。ReAct 工具执行路径传 `{ round, toolName }`，动态 MCP 替换连接失败时传 `{ serverKey, phase }` |
| `onAskUser` | `(question, meta) => Promise<string\|void>` | 用户交互回调；提供后自动注入 `ask_user` 工具，见 [提问路由](#提问路由) |

抛异常不会打断 ReAct 循环：`onRoundStart` / `afterToolCall` / `onError` 走 `_safeHook`
隔离（同步抛出被 catch 并 `console.warn`，返回的 promise 挂一个 no-op rejection handler）；
`beforeToolCall` 在每个工具自己的 `try/catch` 里被 await，失败按工具执行失败归类；
`onAskUser` 抛错则取消该次提问，等待方拿到一段说明而不是挂死。

```js
const agent = new Agent({
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY,
  tools: [readFile, shellExec],
  hooks: {
    beforeToolCall: async (name, args) => {
      if (name === 'shell_exec' && /rm\s+-rf/.test(args.command)) return false  // 拦下
    },
    afterToolCall: (name, args, result) => log(`${name} → ${result.slice(0, 80)}`),
    onRoundStart: (round) => log(`round ${round}`),
    onError: (err, ctx) => log(`error in round ${ctx?.round}, tool ${ctx?.toolName}: ${err.message}`),
  },
})
```

> **`beforeToolCall` / `afterToolCall` / `onError` 会原样转发给每一个 subagent。**
> 这是安全边界而不是便利：Skill 与 Subagent 两个系统都没有沙箱，宿主的工具准入策略必须
> 能覆盖子 agent。详见两节各自的"安全"说明。
>
> 另外两个由 subagent 运行时改写而不是透传：`onAskUser` 被换成经 `AskRegistry` 登记
> （这样提问才带得上归属、能被 `answerQuestion` 定向应答），`onRoundStart` 被用来在轮
> 边界投递邮箱消息。

### IntentRecognizer

Sidecar 方式独立 LLM 调用，分析用户请求：

```js
import { IntentRecognizer } from 'lll-web-agent'

const ir = new IntentRecognizer({
  url: 'https://api.openai.com/v1/chat/completions',
  apiKey: 'sk-xxx',
  model: 'gpt-4',
})

const intent = await ir.analyze('帮我重构整个项目的错误处理', ['read_file', 'write_file', 'shell_exec'])
// → { clarity: 'CLEAR', complexity: 'COMPLEX', recommendedStrategy: 'plan_and_execute', ... }
```

### KnowledgeBase

项目知识管理，注入到 prompt 中：

```js
import { KnowledgeBase, createKnowledgeEntry } from 'lll-web-agent'

const kb = new KnowledgeBase()
kb.addEntry(createKnowledgeEntry('ARCHITECTURE', '技术栈', 'React + TypeScript + Vite'))
kb.addEntry(createKnowledgeEntry('ERROR_PATTERN', 'API 调用', '所有 API 调用必须有超时设置'))

console.log(kb.buildKnowledgePrompt())
// → ## 项目架构\n### 技术栈\nReact + TypeScript + Vite\n\n## 错误避免模式\n...
```

### ContextManager

Token 预算管理和 prompt 组装：

```js
import { ContextManager, defaultTokenBudget } from 'lll-web-agent'

const cm = new ContextManager()
const result = cm.assemblePrompt({
  systemPrompt: '你是一个编程助手',
  userMessage: '帮我写排序',
  history: [{ role: 'user', content: '你好' }, { role: 'assistant', content: '你好！' }],
  filteredTools: myTools,
  tokenBudget: { ...defaultTokenBudget(), totalTokens: 8000 },
})
// result.messages → 组装好的 messages 数组
// result.trimmed → 是否发生了裁剪
```

### Memory 策略

```js
import { SlidingWindowMemory, SummarizingMemory, TokenAwareMemory } from 'lll-web-agent'

// 滑动窗口
const sw = new SlidingWindowMemory(40)

// 摘要记忆（超阈值时 LLM 压缩）—— Agent 未传 memory 时的默认策略，
// 默认实例的 summarizer 由 Agent 自动接到简单任务模型上
const sm = new SummarizingMemory({
  threshold: 20,
  keepRecent: 5,
  summarizer: async (text) => await myLlmSummarize(text),
})

// Token 感知记忆
const ta = new TokenAwareMemory(50000)

// 注入到 Agent
const agent = new Agent({ ..., memory: sm })
```

### RuntimeHistory 与轨道

内置 Memory 类现在内部基于 `RuntimeHistory` 保存完整会话事实，同时继续保持原来的 `add()` / `getMessages()` / `getHistory()` 接口。

默认轨道：

| 轨道 | 用途 |
|------|------|
| `all` | 完整事实源：system、user、assistant、tool、summary、artifact、diagnostic |
| `visible` | 适合 UI 展示的用户可见内容 |
| `model` | 发送给大模型的上下文投影，会受滑窗、摘要、token 策略影响 |
| `artifacts` | 计划、步骤结果、最终产物、文件改动记录 |
| `internal` | 摘要、主题切换、诊断等运行时内部事件 |

```js
const agent = new Agent({ provider, apiKey, memory: new SummarizingMemory({ summarizer }) })

const visible = await agent.getHistory('visible')
const modelContext = await agent.getHistory('model')
const artifacts = await agent.getArtifacts()
```

`SlidingWindowMemory`、`SummarizingMemory`、`TokenAwareMemory` 仍然是控制模型上下文长度的策略；它们不再代表完整历史本身。完整历史保存在 `RuntimeHistory` 的 `all` 轨道中。

### ToolFilter

```js
import { ToolFilter, BASE_TOOLS } from 'lll-web-agent'

const filter = new ToolFilter()
const filtered = filter.filter(intentResult, allTools)
// BASE_TOOLS (keyword_search, read_file, write_file, shell_exec, project_tree, ask_user) 始终保留
```

### PlanAndExecute 执行策略

对应 Java 框架的 `PlanAndExecuteStrategy`。适用于复杂多步骤任务，相比 ReAct 的"边思考边行动"，PlanAndExecute 先让 LLM 站在全局视角制定完整计划，然后逐步执行。

三阶段流程：
1. **Planning** — 调用 LLM 生成结构化执行计划（JSON 步骤列表）
2. **Execution** — 对每个步骤使用内部 ReAct 循环执行（支持工具调用）
3. **Synthesis** — 汇总所有步骤结果，生成最终回答

#### 通过 Agent 切换策略

```js
import { Agent, defineTool } from 'lll-web-agent'

const readFile = defineTool({ name: 'read_file', description: '读取文件', /* ... */ })
const writeFile = defineTool({ name: 'write_file', description: '写入文件', /* ... */ })
const shellExec = defineTool({ name: 'shell_exec', description: '执行命令', /* ... */ })

// 使用 PlanAndExecute 策略
const agent = new Agent({
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4',
  tools: [readFile, writeFile, shellExec],
  strategy: 'plan_and_execute',          // ← 切换策略
  planAndExecuteOpts: {                   // ← 可选配置
    maxPlanSteps: 10,
    stepMaxRounds: 20,
    maxReplanAttempts: 2,
  },
})

// 同步对话 — 用法与 ReAct 完全一致
const reply = await agent.chat('重构项目中所有废弃的 API 调用')
console.log(reply)

// 流式对话 — 额外推送计划和步骤进度事件
for await (const event of agent.stream('分析项目架构并生成文档')) {
  switch (event.type) {
    case 'phase':         console.log(`[${event.phase}] ${event.message}`); break
    case 'plan_generated': console.log('计划:', event.plan); break
    case 'step_start':    console.log(`▶ Step ${event.index + 1}: ${event.description}`); break
    case 'step_complete':
      console.log(
        `${event.success ? '✅' : '❌'} Step ${event.index + 1} (${event.duration}ms, ` +
        `tools=${event.step.toolCalls.length})`
      )
      break
    case 'plan_revised':  console.log('计划已修订:', event.plan); break
    case 'done':          console.log('最终结果:', event.content); break
  }
}
```

#### 动态切换策略

```js
// 根据任务复杂度动态选择策略
function chooseStrategy(message) {
  const complexKeywords = ['重构', '迁移', '分析整个', '批量修改', '全面检查']
  return complexKeywords.some(k => message.includes(k)) ? 'plan_and_execute' : 'react'
}

const agent = new Agent({
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4',
  tools: [readFile, writeFile, shellExec],
  strategy: chooseStrategy(userMessage),
})
```

#### 结合意图识别自动选择策略

```js
import { Agent, IntentRecognizer } from 'lll-web-agent'

// 先用 IntentRecognizer 分析任务复杂度
const ir = new IntentRecognizer({
  url: 'https://api.openai.com/v1/chat/completions',
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4',
})

const intent = await ir.analyze(userMessage, toolNames)
// intent.recommendedStrategy → 'react' | 'plan_and_execute'

const agent = new Agent({
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4',
  tools: myTools,
  strategy: intent.recommendedStrategy,  // ← 根据意图识别结果选择
})

const reply = await agent.chat(userMessage)
```

#### 独立使用 PlanAndExecuteStrategy

不通过 Agent，直接使用策略类：

```js
import { PlanAndExecuteStrategy } from 'lll-web-agent'

const strategy = new PlanAndExecuteStrategy({
  url: 'https://api.openai.com/v1/chat/completions',
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4',
  tools: [readFile, writeFile, shellExec],
  maxPlanSteps: 10,
  stepMaxRounds: 20,
  maxReplanAttempts: 2,

  // 进度回调
  onPhase: (phase, msg) => console.log(`[${phase}] ${msg}`),
  onPlanGenerated: (steps) => {
    console.log('执行计划:')
    steps.forEach(s => console.log(`  ${s.index + 1}. ${s.description}`))
  },
  onStepStart: (i, desc) => console.log(`▶ 开始步骤 ${i + 1}: ${desc}`),
  onStepComplete: (i, ok, result, step) => console.log(
    `${ok ? '✅' : '❌'} 步骤 ${i + 1}: ${result} ` +
    `(rounds=${step.rounds}, tools=${step.toolCalls.length})`
  ),
  onPlanRevised: (steps) => console.log('计划已修订，剩余步骤:', steps.length),
})

// 同步执行
const { content, plan } = await strategy.execute('将项目从 CommonJS 迁移到 ESM')
console.log('最终结果:', content)
console.log('计划步骤:', plan.map(s => `${s.status} - ${s.description}`))

// 流式执行
for await (const event of strategy.stream('批量修复所有 lint 错误')) {
  console.log(event)
}
```

#### PlanAndExecute 配置参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `maxPlanSteps` | `35` | 计划步骤上限 |
| `stepMaxRounds` | `300` | 单个步骤内 ReAct 循环最大轮次 |
| `maxReplanAttempts` | `2` | 步骤失败时最大重规划次数 |
| `planningTimeoutMs` | `120000` | 规划阶段 LLM 调用超时（毫秒） |
| `synthesisTimeoutMs` | `120000` | 合成阶段 LLM 调用超时（毫秒） |
| `onPhase` | - | 阶段变更回调 `(phase, message) => void` |
| `onPlanGenerated` | - | 计划生成回调 `(steps) => void` |
| `onStepStart` | - | 步骤开始回调 `(index, description, step: PlanStep) => void`。前两个参数保持与旧签名一致，第三个参数是完整 `PlanStep`（trace 此时为空） |
| `onStepComplete` | - | 步骤完成回调 `(index, success, result, step: PlanStep) => void`。前三个参数保持与旧签名一致，第四个参数是完整 `PlanStep`（含 `status / result / durationMs / toolCalls / messages / usage / rounds`）|
| `onPlanRevised` | - | 计划修订回调 `(steps) => void` |

#### 流式事件类型

| 事件 type | 字段 | 说明 |
|-----------|------|------|
| `phase` | `phase`, `message` | 阶段变更（planning / executing / synthesizing / completed / fallback） |
| `plan_generated` | `plan` | 计划生成完成 |
| `step_start` | `index`, `description`, `step` | 步骤开始执行。`step` 为 `PlanStep` 快照（含 `toolCalls / messages / usage / rounds`，开始时均为空/零）|
| `step_complete` | `index`, `success`, `result`, `duration`, `step` | 步骤执行完成。`step` 为完整 `PlanStep` 快照，可直接用于审计 / 回放 / UI 渲染 |
| `plan_revised` | `plan` | 计划被修订（步骤失败后重规划） |
| `done` | `content`, `plan`, `toolCallHistory` | 全部完成。`toolCallHistory` 是所有步骤的 `toolCalls` 按执行顺序展平 |

#### 结构化返回值（`strategy.execute()`）

```js
const { content, plan, toolCallHistory } = await strategy.execute('batch task')
//   content            → string          最终回答
//   plan               → PlanStep[]      每个 step 含：
//                                          status, result, durationMs,
//                                          toolCalls, messages, usage, rounds
//   toolCallHistory    → ToolCallRecord[]  跨步展平的工具调用序列，
//                                          每条含 stepIndex / name / arguments /
//                                          result / ok / errorKind? / durationMs / bytes
```

## 与 Java Runtime 的对应关系

| JS SDK | Java Runtime | 说明 |
|--------|-------------|------|
| `Agent` | `Agent + AgentBuilder + AgentRuntime` | 高层 API |
| `Agent({ strategy: 'react' })` | `ReActStrategy` | ReAct 执行策略（默认） |
| `Agent({ strategy: 'plan_and_execute' })` | `PlanAndExecuteStrategy` | Plan & Execute 执行策略 |
| `PlanAndExecuteStrategy` | `PlanAndExecuteStrategy` | 独立使用的策略类 |
| `PlanStep` / `StepStatus` | `PlanStep` / `PlanStep.Status` | 计划步骤模型 |
| `IntentRecognizer` | `fc.runtime.IntentRecognizer` | sidecar 意图识别 |
| `ToolFilter` | `fc.runtime.ToolFilter` | 工具过滤 |
| `ContextManager` | `fc.state.ContextManager` | prompt 组装 + token 预算 |
| `KnowledgeBase` | `fc.runtime.KnowledgeBase` | 知识库管理 |
| `SlidingWindowMemory` | `fc.memory.SlidingWindowMemory` | 滑动窗口记忆 |
| `SummarizingMemory` | `fc.memory.SummarizingMemory` | 摘要记忆 |
| `TokenAwareMemory` | `fc.memory.AdaptiveMemory` | token 感知记忆 |
| `streamChat / syncChat` | `LlmClient` | LLM 通信 |
| `defineTool` | `Tool` 接口 | 工具定义 |
| `resolveProviderUrl` | `LlmProviderAdapterRegistry` | 供应商适配 |

## 浏览器使用

```html
<script src="https://unpkg.com/lll-web-agent/dist/lll-web-agent.min.js"></script>
<script>
  const { Agent, defineTool, KnowledgeBase } = LllWebAgent
  // ...
</script>
```

## 可观测性 / Telemetry

`Agent` 提供一个轻量级事件总线与 per-run / per-session 指标聚合，字段命名对齐
[OpenTelemetry GenAI 语义约定](https://opentelemetry.io/docs/specs/semconv/gen-ai/)。
框架本身**不捆绑**任何 OTel SDK 或第三方导出器 — 只发射事件，你负责转发到
自己选择的后端（LangFuse / LangSmith / Datadog / 自建 pipeline）。

订阅事件即可拿到结构化遥测：

```js
const agent = new Agent({ provider: 'openai', apiKey, model: 'gpt-4o-mini', tools: [...] })

agent.on('llm.call', e => {
  console.log(
    e['gen_ai.operation.name'],        // 'agent.chat' / 'agent.intent' / 'agent.summarize' / 'plan.*'
    e['gen_ai.system'],                // 'openai' / 'deepseek' / 'qwen' / ...
    e['gen_ai.request.model'],
    e['gen_ai.usage.input_tokens'],
    e['gen_ai.usage.output_tokens'],
    e['gen_ai.client.operation.duration'],
    e.ok,
  )
})

agent.on('tool.call', e => {
  console.log(e.name, e.ok, e.errorKind, e.durationMs, e.bytes)
})

agent.on('session.end', metrics => {
  // metrics === Run_Metrics 完整副本 + ok + endedAt
  console.log('run usage:', metrics.usage, 'rounds:', metrics.totalRounds)
})

await agent.chat('帮我分析项目架构')

// 不需要订阅事件也能拿到聚合结果
const run = agent.getLastRunMetrics()       // 最近一次 chat/stream 的 Run_Metrics
const session = agent.getSessionMetrics()   // 所有 run 的累计 Session_Metrics
```

发射的事件类型：

**核心（始终发射）**

| 事件 | 触发时机 | 关键字段 |
|------|----------|----------|
| `session.start` | `chat()` / `stream()` 开始 | `traceId`, `spanId`, `parentSpanId: null`, `strategy`, `startedAt` |
| `session.end` | `chat()` / `stream()` 结束（成功或失败） | 完整 `Run_Metrics` + `endedAt` + `ok` |
| `round.start` / `round.end` | ReAct 每一轮开始 / 结束 | `traceId`, `spanId`, `parentSpanId`（指向 session root）, `round`, `durationMs` |
| `llm.call` | 每次 LLM HTTP 调用完成（含 sidecar） | OTel GenAI 字段 + `traceId` / `spanId` / `parentSpanId`, `ok`, `error?` |
| `tool.call` | 每次工具执行结束 | `name`, `arguments`, `durationMs`, `bytes`, `ok`, `errorKind?` |
| `warn` | 监听器抛异常时 | `source`, `eventType`, `error` |

**Subagent（仅配置 `opts.subagents` 后发射）**

| 事件 | 触发时机 | 关键字段 |
|------|----------|----------|
| `agent.spawn` | 子 agent 被创建 | `agentId`, `agentName`, `parentAgentId`, `type`, `description`, `depth`, `nodeId`, `model`, `isolation` |
| `agent.state` | 子 agent 状态迁移 | `agentId`, `agentName`, `parentAgentId`, `from`, `to` |
| `agent.retry` | 按 `failureKind` 自动重试前 | `agentId`, `agentName`, `parentAgentId`, `attempt`, `failureKind`, `delayMs` |
| `agent.succeeded` | 子 agent 走到成功终态 | `agentId`, `agentName`, `parentAgentId`, `rounds`, `usage`, `wallClockMs`, `artifactKeys` |
| `agent.failed` | 重试用尽或不可重试的失败 | `agentId`, `agentName`, `parentAgentId`, `failureKind`, `attempts`, `lastError` |
| `agent.cancelled` | 经 `agent_cancel` / `closeSubagents()` 取消 | `agentId`, `agentName`, `parentAgentId`, `reason` |
| `run.keep_alive.timeout` | keep-alive 等待超时（每轮对话最多一次） | `pendingAgents`, `pendingNodes`, `waitedMs` |

**图编排（仅配置 `opts.subagents` 后发射）**

| 事件 | 触发时机 | 关键字段 |
|------|----------|----------|
| `graph.opened` | 新建一张图 | `graphId`, `label` |
| `graph.declared` | `agent_graph` 声明成功 | `accepted`（本批节点 id）, `total` |
| `graph.closed` | `graph_close` | `graphId`, `label`, `reason`, `disposition`, `cancelled`, `stoppedAgents`, `outstanding`（后三者是**计数**） |
| `graph.reopened` | 激活已关闭图导致重开 | `graphId`, `label`, `reason` |
| `graph.evicted` | 超出 `retainClosedGraphs` 被 FIFO 淘汰 | `graphId`, `label`, `nodes` |
| `graph.reactivated` | `graph_reactivate` 整批完成 | `graphId`, `nodeIds`, `reason`, `reopened` |
| `graph.node.ready` | 节点依赖满足、待主 agent 确认 | `nodeId`, `upstream[]`（`nodeId` / `agentId` / `state`） |
| `graph.node.auto_start` | `on_ready: 'auto'` 节点自行起飞 | `nodeId` |
| `graph.node.started` | `graph_start` 启动了节点 | `nodeId`, `subagentType` |
| `graph.node.settled` | 节点收到终态回报 | `nodeId`, `state`, `agentId` |
| `graph.node.blocked` | 上游死亡导致阻塞 | `nodeId`, `reason`, `upstreamNodeId` |
| `graph.node.skipped` | `on_upstream_failure: 'skip'` 生效 | `nodeId`, `reason`, `upstreamNodeId` |
| `graph.node.cancelled` | 节点被取消 | `nodeId`, `reason`, `previousState`, `agentId` |
| `graph.node.reactivated` | 单个节点被送回 `blocked` | `nodeId`, `previousState`, `generation` |
| `graph.node.stale_report` | 丢弃了一份 generation 对不上的迟到回报 | `nodeId`, `state`, `agentId`, `generation`, `currentGeneration` |
| `graph.callback.error` | 调度回调抛异常 | `nodeId`, `callback`, `error` |

**产物轨 / 提问 / A2A（仅配置 `opts.subagents` 后发射）**

| 事件 | 触发时机 | 关键字段 |
|------|----------|----------|
| `artifact.write` | `artifact_write` 登记成功 | `artifactId`, `key`, `sha`, `bytes`, `agentId`, `agentName` |
| `artifact.conflict` | 同 key 跨 agent 冲突 | `key`, `owner`, `policy`（`'warn'` = 已写入并告警，`'deny'` = 已拒绝） |
| `ask.user` | 有 agent 发起提问 | `askId`, `agentId`, `agentName`, `parentAgentId`, `nodeId`, `taskDescription`, `question`, `askedAt` |
| `ask.answered` | 提问被应答 | `askId`, `agentId`, `agentName`, `via`（`'hook'` / `'api'`） |
| `ask.cancelled` | 提问被取消或超时 | `askId`, `agentId`, `reason` |
| `a2a.delivered` | `send_message` 投递成功 | `envelopeId`, `from`, `to`, `kind` |

#### 归属：子 agent 的事件带 `agentId`，主 agent 的不带

子 agent 内部的 `llm.call` / `tool.call` / `round.start` / `round.end` 原样转发到**父
agent 的同一条总线**上，仅追加 `agentId` / `agentName` / `parentAgentId`。主 agent 自己
发的事件没有这几个字段，所以归属规则只有一条：

```js
const owner = payload.agentId ?? 'main'
```

宿主注册一个监听器即可看到整棵树。但框架**刻意不缓存**"某个 agent 都调过哪些工具" ——
`AgentHandle` 只记 `metrics` 聚合数。要在界面上画出每个 agent 的工具流水，宿主必须自己
从事件流攒一份账（并自行设上限，一个跑飞的 agent 可能调几百次工具）。两个 demo 页面各
示范了一遍，服务端那份在 `demo/lib/activity.js`（带单测）。

监听器为空时不会改变 `chat()` / `stream()` 的返回值、`hooks.*` 的参数或任何现有
事件的字段 — 纯加法，可直接升级。 `agent.reset()` 会把 `getLastRunMetrics()`
清为 `null` 并归零 `getSessionMetrics()`，但保留已注册的监听器。

## MCP Client（Model Context Protocol）

接入社区 MCP Server（filesystem / github / postgres / playwright / slack / jira / notion …）
不需要写胶水代码。`createMCPClient(options)` 返回的 `listTools()` 结果形状与
`defineTool` 完全一致，直接塞进 `new Agent({ tools: [...] })`。

实现遵循 [MCP 2025-11-25 规范](https://modelcontextprotocol.io/specification/2025-11-25/index)，
零新增 runtime 依赖（只用 Node 18+ 内置 `child_process` / `fetch` / `http`）。

### 基础用法（stdio 子进程 MCP Server）

```js
import { Agent, createMCPClient, registerBaseTool } from 'lll-web-agent'

// 连接一个本地 MCP Server（如社区 filesystem server）
const mcp = await createMCPClient({
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
  name: 'filesystem',               // 可选：工具名前缀将形如 mcp__filesystem__read_file
})

// 拿到形状与 defineTool 完全一致的 Tool_Def[]
const mcpTools = await mcp.listTools()

// 如果开启了意图识别或 token 预算，建议把 MCP 工具标记为 base tool
// 避免被 ToolFilter / ContextManager.trimTools 过早裁剪
mcpTools.forEach(t => registerBaseTool(t.name))

const agent = new Agent({
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4',
  tools: [...mcpTools, ...myLocalTools],
})

const reply = await agent.chat('读取项目根目录结构并给出概览')
await mcp.close()
```

### 传输层

| transport | 用途 | 规范状态 |
|-----------|------|---------|
| `'stdio'` | 本地子进程（最常用） | MCP 2025-11-25 一等 |
| `'http'`（别名 `'streamable-http'`） | 远程 Streamable HTTP | MCP 2025-11-25 推荐 |
| `'sse'` | legacy SSE（GET 长连 + POST /messages） | 存量兼容 |

Streamable HTTP 会在 `initialize` 响应里记录 `MCP-Session-Id`（若 server 下发），
后续请求自动带上 `MCP-Session-Id` 与协商后的 `MCP-Protocol-Version`；`close()` 会尽力
发送带 session header 的 `DELETE` 结束会话。

未内置的传输（如 websocket）通过 `registerTransport(name, factory)` 自定义注入：

```js
import { registerTransport } from 'lll-web-agent'

registerTransport('ws', (options) => {
  // 返回 { send, onMessage, onError, onClose, close }
})
```

### 工具名命名空间

MCP 工具名自动前缀化为 `mcp__<serverName>__<toolName>`，符合 OpenAI / Anthropic
工具名正则 `^[a-zA-Z0-9_-]{1,64}$`。多个 Server 同时挂载也不会碰撞 ——
冲突时自动追加 `_2` / `_3` 数字后缀。非法字符（emoji / 中文 / 空格等）替换为 `_`。

### MCP 工具元数据

`listTools()` 会保留官方 `Tool` descriptor 的 UI / 执行 metadata。除
`name` / `description` / `parameters` / `execute` 外，MCP 工具还可通过属性读取：

```js
const [tool] = await mcp.listTools()

tool.title                  // descriptor.title
tool.icons                  // descriptor.icons
tool.outputSchema           // descriptor.outputSchema
tool.execution?.taskSupport // descriptor.execution.taskSupport
tool.annotations            // descriptor.annotations

tool._mcp.rawName           // server 原始工具名
tool._mcp.outputSchema      // 同一份官方 metadata 也保留在 _mcp 中
```

这些 metadata 属性和 `_mcp` 都是非枚举属性，不会进入 `Object.keys(tool)` 或
`formatToolsForOpenAI()` 的 JSON Schema 字段。为了让大模型也能理解这些信息，
MCP 工具的 `description` 会自动追加精简的 `title`、`outputSchema`、
`execution.taskSupport` 与 annotations 摘要；原始描述保存在 `tool._mcp.rawDescription`。

需要自己做 UI 代理或日志时，也可以用内置 helper：

```js
import {
  serializeMcpToolForBrowser,
  attachMcpToolMetadata,
  formatMcpToolSummary,
} from 'lll-web-agent'
```

### BASE_TOOLS 运行时扩展

当开启 `enableIntentRecognition: true` 或配置了 `tokenBudget` 时，`ToolFilter` 会
按意图结果过滤工具、`ContextManager.trimTools` 会在预算紧张时优先保留
"base tool"。把 MCP 工具标记为 base 可避免它们被误过滤 / 过早裁剪：

```js
import {
  registerBaseTool,     // 增（幂等）
  unregisterBaseTool,   // 删（返回 boolean）
  setBaseTools,         // 覆盖（原子，参数校验在 mutation 前完成）
  clearBaseTools,       // 清空
  resetBaseTools,       // 复位为 6 个初始名
  isBaseTool,           // 查询（非 string 输入返回 false，不抛）
  getBaseTools,         // 快照数组（修改返回数组不影响注册表）
} from 'lll-web-agent'

// 模式 A：增量追加
mcpTools.forEach(t => registerBaseTool(t.name))

// 模式 B：按角色整体覆盖
setBaseTools([
  'ask_user',
  ...mcpTools.filter(t => t._mcp.annotations?.readOnlyHint).map(t => t.name),
])

// 模式 C：测试隔离复位
beforeEach(() => resetBaseTools())
```

### 工具执行 & 错误类型

MCP 工具的 `execute` 透明地走 JSON-RPC `tools/call`；返回值始终是字符串
（与 `defineTool` 的契约一致，方便 LLM 直接消费）。错误分 4 个可 `instanceof`
判断的类型：

```js
import {
  UnsupportedTransportError,  // 未知 transport 名
  MCPProtocolError,           // 握手 / 协议版本 / 畸形帧
  MCPRequestError,            // tools/call 返回 JSON-RPC error 或超时（code: -32000）
  MCPClosedError,             // 连接已关闭 / 进程退出
} from 'lll-web-agent'
```

`tool.call` 遥测事件对 MCP 工具与本地工具一视同仁（`Agent` 层统一发射），
`hooks.beforeToolCall` / `hooks.afterToolCall` 也照常生效。

### 配置选项

```js
const mcp = await createMCPClient({
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
  env: { FOO: 'bar' },              // 可选环境变量
  cwd: '/tmp',                      // 可选工作目录
  onStderr: (chunk) => { },         // 可选 stderr 回调（默认 console.warn）

  // 通用选项（所有 transport）
  name: 'filesystem',               // 命名空间前缀 + 日志
  protocolVersion: '2025-11-25',    // 默认即此
  requestTimeoutMs: 60000,          // 默认 60s
  clientInfo: { name: 'my-app', version: '1.0.0' },  // 默认 {name:'lll-web-agent', version:<pkg>}
  signal: myAbortController.signal, // 握手阶段响应 abort
  onToolsChanged: (tools) => { },   // tools/list_changed 通知触发刷新后回调
  onClose: (reason) => { },         // 连接断开回调
})
```

### 运行时动态工具管理

构造之后仍可增删工具，下一轮 ReAct 立即可见。

```js
agent.addTools(readFile)                 // 单个 Tool_Def
agent.addTools([toolA, toolB])           // 或数组（长度上限 1000）
agent.removeTool('read_file')            // → boolean，未命中返回 false
agent.getTools()                         // → Tool_Def[] 防御性快照，改它不影响注册表
await agent.closeMCPClients()            // 关闭运行时动态连接的 MCP client
```

`addTools` 同名覆盖（保持原有位置），新名追加到末尾；任一元素缺少非空字符串 `name`
时整体回滚并抛 `TypeError`。`removeTool` 移除后会对该名调用 `unregisterBaseTool()`，
但 `INITIAL_BASE_TOOLS` 里的 6 个预置名例外 —— 它们的 base 身份始终保留。

**让模型自主挂载 MCP Server**：构造时传 `enableDynamicMCP: true`，工具集里就多一个
`load_mcp_server` 元工具，LLM 可在对话中自己决定加载哪个 MCP Server。

```js
const agent = new Agent({
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY,
  enableDynamicMCP: true,
  dynamicMCPOpts: { connectTimeoutMs: 30000, closeTimeoutMs: 5000 },  // 均为默认值
})
```

`load_mcp_server` 的入参是 `{ serverKey, transport, command?, args?, url?, headers?, name? }`。
重复加载同一 `serverKey` 会先关掉旧连接、摘掉它贡献的工具，再挂新的。经这条路加入的工具
自动 `registerBaseTool()`，因此开启意图识别时不会被 `ToolFilter` 裁掉。连接失败 / 列不出
工具 / 超时都以一句可纠正的话软失败，不炸掉这一轮。

> `load_mcp_server` 本身**不**是 base tool（它不在 `INITIAL_BASE_TOOLS` 里），只是一个
> 普通工具。

`agent.reset()` 与 `closeMCPClients()` 会统一关闭全部运行时连接，避免子进程泄漏。
完整示例：`node examples/dynamic-mcp.js`（示例 1、2 不需要 LLM Key）。

### 浏览器端使用 MCP（通过服务端代理）

浏览器没有 `child_process`，不能直接跑 `createMCPClient({ transport: 'stdio' })`；
直连远程 MCP Server 又受 CORS 和 API key 暴露约束。推荐走**服务端代理**：
`demo/server.js` 自带现成实现，随时可拷到自己的项目里。

启动（把 stdio-only 的 MCP Server 挂到 demo server）：

```bash
npm run build          # 先构建浏览器 bundle

MCP_SERVER_CMD=node \
MCP_SERVER_ARGS="src/mcp/__fixtures__/mock-mcp-server.js" \
MCP_SERVER_NAME=mock \
OPENAI_API_KEY=sk-xxx \
node demo/server.js

# 打开 http://localhost:3000/browser
```

也可以换成真正的搜索 / 文件系统 / GitHub 等 stdio MCP Server：

```bash
# 免费 web 搜索 —— open-websearch(无 API key,多引擎)
# MCP_SERVER_ENV 是 JSON,专门传给 MCP 子进程的环境变量,避免和 demo server
# 自己的 PORT / OPENAI_API_KEY 混在一起
MCP_SERVER_CMD=npx \
MCP_SERVER_ARGS="-y open-websearch@latest" \
MCP_SERVER_NAME=search \
MCP_SERVER_ENV='{"MODE":"stdio","DEFAULT_SEARCH_ENGINE":"bing"}' \
OPENAI_API_KEY=sk-xxx node demo/server.js

# 挂载 6 个搜索/抓取工具:
#   mcp__search__search              多引擎搜索(bing/duckduckgo/baidu/brave/...)
#   mcp__search__fetchWebContent     抓取任意 HTTPS 页面
#   mcp__search__fetchGithubReadme   抓取 GitHub 仓库 README
#   mcp__search__fetchCsdnArticle    CSDN 文章正文
#   mcp__search__fetchJuejinArticle  掘金文章正文
#   mcp__search__fetchLinuxDoArticle Linux.do 帖子正文

# 社区 filesystem server(需要 Node 20+)
MCP_SERVER_CMD=npx \
MCP_SERVER_ARGS="-y @modelcontextprotocol/server-filesystem /tmp" \
OPENAI_API_KEY=sk-xxx node demo/server.js
```

`demo/server.js` 暴露两个代理端点给浏览器：

| 端点 | 用途 |
|---|---|
| `GET /mcp-tools` | 拿工具清单（name / description / parameters / rawName / title / icons / outputSchema / execution / annotations / modelDescription） |
| `POST /mcp-call` | body `{ name, arguments }` —— 转发到服务端的 `MCP_Client.execute` |

`demo/browser.html` 里会把 `/mcp-tools` 的每一项包成本地 `defineTool`，并把
`title` / `icons` / `outputSchema` / `execution` / `annotations` 重新挂回非枚举属性；
`execute` 实现就是 `fetch('/mcp-call', ...)`。对浏览器 Agent 而言，MCP 工具和本地工具
没有任何区别，且意图识别开启时这些 MCP 工具也会注册为 Base Tool。API Key 和 MCP server
子进程都留在服务端，浏览器零暴露、零 CORS。

架构：

```
Browser Agent
    │
    │ tool.execute(args)
    ▼
[ defineTool wrapper (浏览器端) ]
    │
    │ fetch POST /mcp-call { name, arguments }
    ▼
demo/server.js  ────► MCP_Client.execute() ────► MCP Server (stdio / http / sse)
    │
    │ JSON { result: "..." }
    ▼
Browser Agent 继续 ReAct 循环
```

想在自己的 Web 应用里复用：把 `demo/server.js` 里 `/mcp-tools` + `/mcp-call` 两段代码
（约 40 行）抄过去即可；前端包装逻辑见 `demo/browser.html` 里的 `loadMcpTools()`。

## Skill 系统

一个 skill 是一个目录：`SKILL.md`（YAML frontmatter + Markdown 正文）加上可选的
`scripts/` / `references/` 等捆绑文件，目录结构与 [Claude Code 的 skill 格式](https://docs.claude.com/en/docs/claude-code/skills)
兼容，可直接复用已有的 Claude Code skill 包。

```js
import { Agent } from 'lll-web-agent'

const agent = new Agent({
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4',
  skills: {
    providers: [
      { type: 'local', dir: './skills' },              // 本地目录，每个子目录一个 skill
      { type: 'http', baseUrl: 'https://example.com/skills' }, // 远程 manifest（见下）
    ],
    filter: { threshold: 50, topK: 20 },  // 可选，均为默认值
  },
})

await agent.chat('帮我审查这个 PR')
```

`skills.providers` 为空或未配置时，Skill 系统完全不启用（零开销）。多个 provider 同时
配置时按数组顺序聚合，重名 skill first-wins（后面的 provider 会被 warn 并跳过）。

### 三级渐进披露（Progressive Disclosure）

与 Claude Code 一致，skill 内容按需分三级注入上下文，避免一次性把所有 skill 正文塞进
system prompt：

| 级别 | 内容 | 注入方式 |
|------|------|---------|
| Level 1 | 清单：`name` + `description` | 每轮自动合并进 system 消息（`_withSkillListingNote`） |
| Level 2 | `SKILL.md` 正文 | 模型调用内置 `skill` 元工具按需加载 |
| Level 3 | 捆绑资源（`scripts/` / `references/` 等文件） | Node 下用现有 `read_file` / `shell_exec` 读取 `baseDir`；浏览器下用专用 `skill_resource` 工具 |

`disable-model-invocation: true` 的 skill 不出现在 Level 1 清单里，但仍可通过
`agent.skills.get(name)` 访问。

#### `skill` 工具的参数（对齐 Claude Code）

```js
{ name: 'skill', parameters: { skill: string, args?: string } }  // 仅 skill 必填
```

`args` 是透传给 skill 的参数串，等价于斜杠命令 `/<name>` 后面那一截。SKILL.md 正文里
用占位符消费它，注入上下文前完成展开：

| 占位符 | 含义 |
|--------|------|
| `$ARGUMENTS` | 整个 `args` 串 |
| `$1` … `$9` | 按空白切分的位置参数，缺失代入空串 |

```markdown
---
name: review-pr
description: Review a PR with priority and assignee
argument-hint: [pr-number] [priority] [assignee]
---

Review pull request #$1 with priority level $2, then assign to $3.
```

模型发 `{ skill: 'review-pr', args: '123 high alice' }`，注入正文即
`Review pull request #123 with priority level high, then assign to alice.`

frontmatter 的 `argument-hint` 会以 `- name: description (args: <hint>)` 的形式写进
Level 1 清单 —— 这是模型唯一的参数形状线索，不声明它则 `args` 对自主调用不可见。
正文里没有任何占位符却传了 `args` 时，参数会作为 `Arguments: <args>` 附加在正文末尾，
不会被静默丢弃。展开逻辑在 `skills/model.js` 里单独实现为 `applySkillArgs(body, args)`
（返回 `{ text, applied }`），但**目前没有从包入口导出** —— 详见下方"宿主侧 API"。

Skill 数量超过 `filter.threshold`（默认 50）时，才会触发一次 sidecar LLM 调用
（`SkillFilter`，复用 `simpleModel` 配置）按用户消息做 Top-K 相关性排序；该调用在
`_runPipeline` 里每条用户消息只跑一次（同一轮对话的多个 ReAct round 复用结果），
失败时 fail-open —— 直接返回全量 skill 列表，与 `IntentRecognizer` 的失败策略一致。

**已知限制**：Level 1 清单注入目前只在 ReAct 策略下生效；`strategy: 'plan_and_execute'`
下 `PlanAndExecuteStrategy` 会为每个 step 构建独立的 system prompt，不会收到 skill 清单
（`skill` 工具仍可调用，只是模型看不到清单）。

### Node vs 浏览器运行时

`skills.runtime` 默认 `'auto'`（根据是否存在 `process.versions.node` 判断）。Node
运行时下，远程（HTTP provider）skill 会物化到本地磁盘缓存（默认
`~/.lll-agent/skills-cache/<name>/`，可用 `skills.cacheDir` 覆盖），随后与本地
provider 一样通过 `read_file` / `shell_exec` 访问 Level 3 资源。浏览器运行时不做任何
磁盘物化，改为注入 `skill_resource` 工具，参数为 `{ skill, path }`。

### HTTP provider 协议（自建 skill server）

```
GET {baseUrl}/manifest.json
→ { "skills": [{ "name": "pdf-fill", "description": "...", "version": "1.0.0", "hash": "...", "files": ["SKILL.md", "scripts/fill.py"] }] }

GET {baseUrl}/skills/{name}/{relPath}
→ 文件原始内容
```

`hash` 字段可选，用于 `agent.refreshSkills()` 增量刷新（未变化的 skill 直接复用缓存的
`Skill_Def`，跳过重新拉取 + 解析）。

### 宿主侧 API

```js
await agent.loadSkills()      // 急切全量加载；首次 chat()/stream() 前会自动调用
await agent.refreshSkills()   // 重新加载（按 hash 跳过未变项），下一轮重建 Level 1 清单

agent.skills.list()                          // → Skill_Def[]
agent.skills.get('review-pr')                // → Skill_Def | null
await agent.skills.readResource(name, rel)   // 读捆绑资源（拒绝 `..` / 绝对路径）
```

`loadSkills()` 的 promise 会被 memo；失败时清空 memo，下次调用重试而不是永久卡在失败态。
一次成功的 `refreshSkills()` 也会"治愈"此前失败的 load。

> **已知缺口：`applySkillArgs` 目前拿不到。** 它从 `src/skills/index.js` 导出，但
> `src/index.js` 没有把它再导出一层，而 `package.json` 的 `exports` 只映射了 `"."`，
> 所以 `import { applySkillArgs } from 'lll-web-agent'` 和子路径导入都取不到它 ——
> 尽管文件本身随包发布。要复用参数展开逻辑，现在只能自己实现，或等这个导出补上。
> 同样不可达的还有 `parseSkillMd` / `parseFrontmatter` / `resolveProvider`。

### 跑起来看看

```bash
OPENAI_API_KEY=sk-xxx node examples/skills.js
```

用 `examples/skills/` 下的本地 skill 包演示 Level 1 清单 → `skill` 工具注入正文 →
Level 3 资源读取的完整链路，包含 `disable-model-invocation: true` 的技能（不进清单、
只能由代码 `agent.skills.get(name)` 取用）。

demo 侧默认就开：只要 `demo/skills` 目录存在就启用，用 `SKILLS_DIR=/path/to/skills`
换目录。服务端页（`/`）走 local provider，浏览器页（`/browser`）走 HTTP provider +
`skill_resource`。细节见 `demo/README.md`。

### 安全

- HTTP provider 对 `name` 做 `^[a-z0-9-]{1,64}$` 校验，并对拼接进 URL 的每个路径分段做
  编码 / 拒绝（空分段、`..` 一律拒绝），防止路径穿越。
- `SkillRegistry.readResource` / 本地 provider 同样拒绝包含 `..` 的资源路径。
- 网络来源（HTTP provider）的 skill 脚本最终通过宿主提供的 `shell_exec` 工具执行 ——
  v1 没有沙箱。接入不受信任的 skill server 时，请通过工具授权 + `hooks.beforeToolCall`
  自行把关。

## Subagent 系统

把一个明确、单一、描述完整的任务派给一个独立的 agent 实例去做，主 agent 只收结论。
解决的是单 agent 运行时的老问题：要"读 8 个文件后给个结论"，主 agent 必须把全部中间
产物吃进自己的上下文，压缩一次就丢一批事实。

subagent 通过一个普通 `Tool_Def`（`agent` 工具）暴露给模型，因此自动获得
`ToolFilter` / `ContextManager` / telemetry 的既有处理；它的特殊之处不在接口，而在
`execute` 内部启动了一个能自己调工具、能在执行中收消息、能对外发事件的嵌套运行时。

```js
import { Agent } from 'lll-web-agent'

const agent = new Agent({
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4o',
  simpleModel: 'gpt-4o-mini',        // 成为 fast 别名（见"模型别名"）
  tools: [readFile, keywordSearch],  // 主机自己的工具；子 agent 按类型裁剪后继承
  subagents: {
    types: [
      {
        name: 'explorer',
        description: '只读检索：跨文件找定义、找用法、找配置，不改任何文件。',
        systemPrompt: 'You are a read-only research subagent. Report what you found, with file paths.',
        model: 'fast',
        tools: ['read_file', 'keyword_search', 'project_tree', 'history_search'],
      },
    ],
    maxConcurrent: 4,                // 每个 depth 层独立的并发槽数
    maxDepth: 2,                     // 主 agent 是 depth 0；depth 2 的 agent 不能再派
    artifacts: { policy: 'warn' },   // 'warn'（默认）| 'deny'
    retainClosedGraphs: 5,           // 保留多少张已关闭的图（超出按 FIFO 整张淘汰）
  },
})

await agent.chat('审一下认证链路，把 token 校验的每个位置都找出来')
```

未配置 `opts.subagents` 时 `agent.subagents` 恒为 `null`，不注入任何工具、不发任何新
事件，行为与旧版本逐字节一致（零开销）。

内置类型 `general-purpose` 始终可用且不可覆盖。类型也可以在运行时注册：

```js
import { registerAgentType, listAgentTypes, resetAgentTypes } from 'lll-web-agent'

registerAgentType({ name: 'reviewer', description: '代码评审', systemPrompt: '...' })
```

> 类型注册表是**进程级全局**的（与 `BASE_TOOLS` 同）。多个 `Agent` 实例共享同一张表，
> `resetAgentTypes()` 会把它清回内置类型。

### 12 个元工具

配置 `subagents` 后注入，且全部经 `registerBaseTool()` 注册为 base tool —— 否则开启
`enableIntentRecognition` 时 `ToolFilter` 会把它们裁掉，而 system prompt 里的类型清单
还在宣传它们（`skill` 已经踩过这个坑）。

| 工具 | 用途 |
|------|------|
| `agent` | 派一个 subagent。`{ description, prompt, subagent_type?, model?, run_in_background?, isolation? }` |
| `agent_status` | 查状态。`{ agent_id?, include_finished?, include_graph?, graph_id? }`（`graph_id: 'all'` 列出全部图，含已关闭的） |
| `agent_cancel` | 取消在跑的 agent 或放弃一个图节点。`{ agent_id?, node_id?, graph_id?, reason? }` |
| `agent_graph` | 声明依赖图（只声明，不创建）。`{ nodes, max_concurrent?, graph_id?, label? }` |
| `graph_start` | 就绪节点的确认闸门，在这里给出最终契约。`{ node_id, graph_id?, prompt, ... }` |
| `graph_close` | 任务结束时关掉它的图。`{ graph_id?, disposition, reason? }` |
| `graph_reactivate` | 让已完成节点重跑（缓存失效）。`{ graph_id?, node_ids, reason? }` |
| `send_message` | 给另一个 agent 发消息（不打断它正在执行的工具）。`{ to, message, summary? }` |
| `artifact_write` / `artifact_list` | 产物记账与查询 |
| `history_search` / `history_get` | 检索整个会话的**原始**事件轨（含已被压缩掉的内容） |

四个图工具与 `agent_status` / `agent_cancel` 的 `graph_id` 都可省，省略即"当前在用的那张图"
（见"一张图 = 一个任务"）。

`agent` 工具的两个 "description" 是两回事，容易混：入参 `description` 是 3-8 词的**标签**
（用于列表显示、agent 命名、日志），**不承载任务内容**；Task Contract 的唯一所在是入参
`prompt` —— 子 agent 不继承对话历史，它看到的就只有这段文字。这条边界由
`AGENT_TOOL_DESCRIPTION`（`src/agents/contract.js`）向模型讲清楚。

子 agent 拿到哪些工具由它的 `Agent_Type.tools` 决定：`'*'`（内置
`general-purpose` 的默认值）表示继承父 agent 的**整个**工具集，但两道剔除是恒定的 ——
四个图工具 `agent_graph` / `graph_start` / `graph_close` / `graph_reactivate`
**无条件**剔除（`canSpawn: true` 也不放行），`agent` 则由 `canSpawn` 把关（默认
`false`，即也剔除）；给一个名字数组则保留数组里点到的工具，**外加一组固定的基础设施
工具（floor）**：`artifact_write` / `artifact_list` / `history_search` / `history_get` /
`send_message` / `ask_user` 无论数组里写没写都会带上（与父 agent 实际拥有的工具
取交集 —— 父 agent 自己都没有的 floor 工具不会被凭空生造出来）。`explorer` 这样
的窄类型不再需要把这些元工具显式写进 `tools` 数组：一个类型写 `tools:
['read_file']` 的意思是"这个 agent 只读文件"，不是"它也不准写产物、搜历史、
问用户" —— 与 `tool-filter.js` 的 `BASE_TOOLS`（`ToolFilter` 对任何意图过滤结果都
恒定保留）同一思路。

**`canSpawn: true` 给的是 `agent`，只有 `agent`。** 图工具作用于**编排者那一个**图
容器：子 agent 拿到的是父 agent 的工具闭包，闭包捕获的是父的 runtime，工具本身没有
"是谁在调"的概念。放行的后果不是权限宽一点，而是三件静默的错事 —— 子 agent 的
`agent_graph` 会改写父的活跃图，它的 `graph_close` 能关掉父正在编排的任务，它起的
节点全记在 `main` 名下；再加上按深度分池的并发槽会自我争抢（一个 depth-1 的子 agent
调 `graph_start({ run_in_background: false })` 会 await 它自己正占着的那个池）。
派生新 agent 的能力仍然只由 `canSpawn` 把关，`maxDepth` 与并发分池沿 `agent` 这条路
照常成立（`agent` 工具自己算 `ctx.depth + 1`）。floor **不**包含这五个编排工具。

### 后台派发与 keep-alive

`run_in_background` 默认 `true`：`agent` 工具立刻返回一行 `[agent:<name> started]`，
结果稍后在主 agent 的**轮边界**注入。轮边界（而不是任意时刻）是关键 —— 那时上一轮的
`assistant(tool_calls)` 与全部 `tool` 结果消息已经成对落盘，插入 `user` 消息不会破坏
工具调用配对。

`keepAlive`（默认 `true`）补的是这个洞：模型说完"我派了三个 agent，等它们回来"就给出
了一个无工具调用的回复，ReAct 循环照旧会立即 `return`，结果回来时已经没人读了。开启后
这一轮不收尾，而是等下一个 subagent 事件回来、把结果带进上下文让模型继续决策。

```js
agent.on('agent.succeeded', ({ agentName, rounds, usage }) => { /* ... */ })
agent.on('run.keep_alive.timeout', ({ pendingAgents, pendingNodes, waitedMs }) => { /* ... */ })

// 每轮对话最多超时一次；超时后给模型留一条"收尾或 agent_cancel"的提示
agent.lastKeepAliveTimedOut      // boolean
agent.lastStopReason             // 取值集合未变：null | 'completed' | 'max_rounds'
```

轮次仍受 `maxRounds` 约束，因此不存在无界循环。`keepAlive: false` 时本轮直接结束，
通知暂存到下一次 `chat()` / `stream()` 的第一个轮边界。

等待的判据是"真的还有活在飞"（在跑的 agent、排队中的 agent、running 的图节点），
**不包括 `blocked` 与 `awaiting_confirm` 的图节点** —— 那些等的是主 agent 自己的下一步
动作，不会自行推进也不产生事件，按它们来等就是每轮干等到超时。所以一个就绪待确认的
节点：它的就绪通知会被投进上下文（待注入的判断优先于在飞判断），但通知投完之后若没有
别的活在飞，这一轮就正常收尾，把决定权交回主机与模型。

判据与告知都是**跨全部图**的（含已关闭的图）：一个在飞的 agent 不因为它所属的图被关掉就
停止存在。`run.keep_alive.timeout` 的 `pendingNodes` 同样跨图统计 —— 若未完成节点在另一
张图里而这个数报成 0，模型正好会在它决定要不要收尾的那一刻拿到一个假数。

### DAG 编排

`agent_graph` 只声明与排队，**不创建任何实例**：`blocked` / `awaiting_confirm`
的节点没有 handle、没有子 `Agent`、不占并发槽（没有一个停留态的 `ready`：依赖一满足，
节点在同一次 `tick()` 里直接走到 `awaiting_confirm` 或 `queued`）。模型发出的调用形如：

```json
{
  "nodes": [
    { "node_id": "n1", "description": "Map the schema",
      "prompt": "List every table and its columns.", "on_ready": "auto" },
    { "node_id": "n2", "depends_on": ["n1"], "description": "Write the migration" }
  ],
  "max_concurrent": 2
}
```

`n1` 的活儿事先就定死了，用 `on_ready: 'auto'` 直接跑。`n2` 走默认的
`on_ready: 'confirm'`：`n1` 成功后框架**不**启动 `n2`，而是把上游结果注入回主 agent，
由它看过 `n1` 实际产出之后再用 `graph_start` 写 `n2` 的最终契约（也可以在那里换类型、
换模型，或者 `agent_cancel` 放弃它）。前序结果经常会改变后续该干什么，这个闸门就是
"到了再创建、决策可变"的落点。

声明时校验**同一张图内** `node_id` 唯一、`depends_on` 指向已知节点、Kahn 环检测（有环
整批拒绝并回报环路径）、`on_ready: 'auto'` 的节点必须有 `prompt`。`agent_graph` 可多次
调用增量追加，新节点可依赖旧节点，每次都重跑环检测。失败传播默认 `block`（下游既不自动
取消也不自动启动，等主 agent 定夺），可按节点设 `on_upstream_failure: 'skip'`。

#### 一张图 = 一个任务（多图共存）

图跟的是**任务**，不是 `Agent` 实例：同一个任务始终往同一张图里加节点，图可以一直改；
任务变了就换一张新图。因此一个主 agent 可以同时持有多张图，`node_id` 的唯一性也只到
**图级**（第二个任务复用 `n1` 不再让整批声明被判重复而拒掉 —— 单图时代这是个真实缺陷，
不是可有可无的放宽）。

容器是惰性的：`agent.subagents.graphs` 是一张 `Map<graphId, GraphEntry>`，
`activeGraphId` 起手为 `null`，第一次声明才建图。`agent.subagents.graph` 仍是指向"当前
在用的那张图"的 getter，没有活跃图时返回 `null`（不抛）。`graphId` 由框架生成，形如
`gph_00000001`（`gph_` + 单调计数器的 8 位十六进制，**不混时间位** —— 本项目已经在
agentId 与 envelopeId 上各因时间戳撞号踩过一次）。

模型开第二张图的入口是 `label`（任务名）：

```json
{ "nodes": [{ "node_id": "n1", "description": "Map the schema" }], "label": "订单导出重构" }
```

同一个 `label` 再声明就接着往那张图里加；换一个 `label` 就是另一张图，两张图各有独立的
`node_id` 命名空间与独立的状态列表。`label` 与 `graph_id` 都不给时用当前活跃图（没有就
新建一张）。跨图重名之后，"这个 `node_id` 不在这张图里"必须点名它在哪张图，否则模型无从
自我纠正：

```
Error: node "x1" is not in graph gph_00000001; it lives in gph_00000002 ("登录埋点", open). Pass graph_id to act on it there.
```

`agent_status()` 默认只列活跃图；`agent_status({ graph_id: 'all' })` 列出全部（含已关闭
的），每段带一行 `graph gph_00000001 "订单导出" [open, active]` 的抬头。

#### 关闭与弃图协议

任务结束就关掉它的图：`graph_close({ graph_id?, disposition, reason? })`。

- `disposition: 'cancel_outstanding'` —— 每个未走到终态的节点都过一遍取消路径
  （`cancelHandle`，连它挂在 `ask_user` 上的提问一起结算）。
- `disposition: 'keep_running'` —— 图关掉不再收新节点，但已经在飞的 agent 继续跑到终态，
  完成通知照旧投递，`hasInFlight()` 仍然算它们。

`disposition` 是必填的，漏填会拿到一句列出两个取值的软失败（工具层刻意把 `undefined`
换成 `null` 传下去，否则会命中"只标记"的默认值，静默关掉一张图）。关掉活跃图之后就没有
活跃图了：下一次不带 `graph_id` 的 `agent_graph` 会新建一张。已关闭的图只有**声明**被拦
（往一张随时可能被淘汰的图里加节点等于静默丢活）；`graph_start` / `agent_cancel` /
`agent_status` / `graph_reactivate` 对它照旧可用 —— 一张已关闭的图里还在飞的节点必须仍
能启动、取消、查看。`retainClosedGraphs`（默认 `5`）按 FIFO 整张淘汰多余的已关闭图，
但**永不淘汰还有在飞节点的图**（那会让一个在跑 agent 的节点归属凭空消失）。

**"任务结束了"这个判断只在 prompt 里，这是有意的设计边界，不是遗漏。** 框架分不清用户的
新消息是同一个任务的续集还是另一个任务 —— 那是语义判断，只有看得见话题变化的模型（或有
显式"新任务"入口的主机）做得出来。所以协议写在模型读得到的地方（`AGENT_GRAPH_DESCRIPTION`
与 `graph_close` 的 `Tool_Def.description`）：话题变了就是上一个任务结束的信号；而关闭一张
**仍有未完成节点**的图之前，必须先用 `ask_user` 点名那些节点、问用户是等它们跑完、取消掉、
还是留着不管，拿到答复再调 `graph_close`。框架不强制，也无法强制：猜错的代价是取消掉别人
跑了一半的活，那个代价该由用户决定要不要付。协议本身不需要新机制 —— 提问路由已经是一张带
归属、可乱序应答的登记表。

#### 节点重新激活（缓存失效）

任务收尾之后用户又提了一个局部修改，正好命中某个**已完成**节点干过的活 —— 这时该做的不是
重开一张图从头再来，而是把那个节点连同消费过它产物的下游一起送回去重跑：

```json
{ "graph_id": "gph_00000005", "node_ids": ["schema", "docs"], "reason": "用户改了字段命名" }
```

一个已完成节点的产物本质是一份**缓存**：输入变了，它与消费过它的下游都得重跑。
`graph_reactivate` 把点名的节点送回 `blocked`（依赖已满足的会被 `tick()` 推到
`awaiting_confirm`，由主 agent 用 `graph_start` 写**新**契约 —— 输入变了，旧契约多半也
该变），清掉上一轮的 `agentId` / `result` / `error`，并自增该节点的 `generation`。
**只接受终态节点**（`succeeded` / `failed` / `cancelled` / `skipped`）：一个还在跑的节点
没有"过期产物"可言，想让它停下来是 `agent_cancel`。**已关闭的图也可以激活**，激活会把它
重新置为 open 并成为当前在用的那张（下一句 `graph_start` 才落在对的图上）—— 不过关闭活跃
图会清空 `activeGraphId`，所以这条最常见的路径要显式带上 `graph_id`，否则拿到的是
`Error: no graph is active. Known graphs: gph_00000005 (closed).`（软失败里点名了图 id，
模型一轮就能纠正）。

**框架不自动扩散到下游 —— 失效范围由模型决定，但框架必须把它漏掉的摆到它面前。** 模型手工
挑节点会漏（它得靠记忆推断"谁消费过这份产物"，而它的上下文可能已被压缩过），而漏掉的那个
下游会拿着过期认知继续跑，**并且不报任何错**。所以返回值列出：下游有哪些节点、其中哪些读过
刚被作废的产物 key、以及这些里哪些**没有**被本次点名：

```
reactivated 2 node(s) in graph gph_00000005: schema (generation 1), docs (generation 1).
That graph was closed; it is open again.
Graph gph_00000005 is now the one you are working in. ...

Artifacts you just declared stale: db/schema.sql.

Downstream of your selection — 3 node(s):
- api [succeeded] read db/schema.sql — NOT reactivated
- docs [blocked] read db/schema.sql — reactivated in this call
- e2e [succeeded] further downstream (via api) — NOT reactivated

Still to decide — not reactivated: api, e2e. ...
```

这段话是**机制而不是排版**：它只提供判断依据，决定权仍在模型 —— 把一个下游留在外面是一个
"它的活仍然成立"的决定，而不是一次无声的遗忘。直接依赖的节点报出它当初真读到的 key（一个
节点的契约 `inputs` 恰好就是其直接上游已登记的产物），更远的下游标 `further downstream
(via …)`，不硬编一份它从未读过的 key。

`prompt` 被刻意保留，所以 `on_ready: 'auto'` 的节点一被激活就带着原契约自己重新起飞（与
`auto` 的语义一致：活儿事先就定死了）。激活**不动产物轨** —— 旧记录留着，好让重跑的结果能
和它对比（代价见"已知限制"）。

`generation` 这个计数器挡的是一处具体的 ABA，不是为了整齐：`agent_cancel`（或
`graph_close` 的 `cancel_outstanding`）会把一个节点变成终态**而它的 agent 还在跑**，
`graph_reactivate` 又把它从终态取出来 —— 于是那个被放弃的 agent 迟到的回报会穿过图原有的
"终态节点不被迟到回报复活"守卫，把陈旧的 `succeeded` 写回去，并据此放行本该重跑的下游。
启动时捕获的 generation 随回报一起带回来，对不上就丢弃并发 `graph.node.stale_report`。

#### `depends_on` 是安全边界，不是调度提示

图节点**共享同一个工作目录**，这是有意设计（见下文），且**没有任何 per-node 隔离兜底**。
于是：**两个之间没有依赖路径的节点，一定会并行跑在同一个目录里。** 漏掉一条本该存在的
边，不是"跑慢了"或"顺序不理想"，而是两个 subagent 同时改同一批文件、彼此都不知道对方
改了什么 —— 静默产生冲突的代码，只剩产物轨事后告警。

`AGENT_GRAPH_DESCRIPTION` 把这一点讲给模型：一个节点 = 一个单一、边界清晰的子任务；
凡是 B 会读或写 A 产出/改动的东西就必须声明 `depends_on`（文件重叠本身就是依赖）；
拿不准就把边加上（多一条边只损失并行度，少一条边损失正确性且不会报错，两种代价不对称）；
但也不要编造不存在的顺序，把本可并行的活儿串成一条链，DAG 就退化成了顺序执行。

### 提问路由

多个 agent 可能同时向用户提问。每个问题拿一个 `askId` 并登记提问者，用户的回答按
`askId` 定向送回对应的等待方 —— 主机因此可以乱序回答。主 agent 自己的提问也走同一张表
（归属 `agentId: 'main'`）。

主机有两条接法，可以只用一条，也可以同时用（两条**竞速，先到先赢**，后到者静默 no-op）：

```js
// 接法 1：hook。签名扩展为 (question, meta)，旧的单参数写法继续工作。
const agent = new Agent({
  /* ... */
  subagents: {},
  hooks: {
    onAskUser: async (question, meta) => {
      // meta = { askId, agentId, agentName, parentAgentId, nodeId, taskDescription, question, askedAt }
      return await promptTheUser(`[${meta.agentName}] ${question}`)
      // 返回 null / undefined = 不在这里答，留给接法 2
    },
  },
})

// 接法 2：命令式通道。Web UI / HTTP 服务端更顺手 —— 不需要在请求上下文里 await。
for (const q of agent.pendingQuestions()) {
  console.log(q.askId, q.agentName, q.taskDescription, q.question)
}
agent.answerQuestion(askId, 'prisma')             // → true 表示被这条通道接走了
agent.cancelQuestion(askId, 'user closed the tab')
```

提问期间该 agent 状态转 `waiting_input`（在 `agent_status` 里可见），仍占并发槽。
`ask.timeoutMs` 默认 `null`（永不超时）；配置后超时返回"用户未在 N 秒内回答"，由子
agent 自己决定猜默认值还是放弃。

### 产物轨 —— 跨 agent 安全的主方案

`artifact_write` 把产出登记到共享的 `RuntimeHistory` `artifacts` 轨（只追加不覆盖，
历史版本全留），记清楚谁产出了什么、指纹是多少。同 `key` 的最新记录属于**另一个** agent
且本次写入未在 `supersedes` 中显式引用它时：

- `policy: 'warn'`（默认）—— 允许写入，返回一句告警指名上一版的归属，并 emit
  `artifact.conflict`；
- `policy: 'deny'` —— 拒绝写入，返回 owner 与 sha，让模型改 key 或先协调。

这两个值以外的 `policy`（`'DENY'`、拼错的值）在构造时**抛错**，不静默读成 `'warn'` ——
浏览器里这条轨是唯一的跨 agent 护栏，降级掉它而调用方以为自己开了硬拦截，是这里最坏
的失败形态。

```js
const rows = await agent.getArtifacts()                        // 全部
const mine = await agent.getArtifacts({ agentId: 'agt_...' })  // 按 agent 过滤
```

`sha` 是 FNV-1a 32 位（8 位十六进制），零依赖、Node 与浏览器同实现，用途是**变更与冲突
检测，非加密**。

**它是主方案，不是退路。** 目标环境包含浏览器，而浏览器里既没有 git worktree 也没有
`shell_exec`。产物轨（归属记录 + 同 key 跨 agent warn/deny）是唯一跨 Node 与浏览器都
成立、每个 agent 都能用的跨 agent 护栏，这一层的强度就是这套系统跨 agent 安全的实际
上限。同时它**是记账约定，不是强制隔离**：绕过 `artifact_write` 直接改文件的行为框架
检测不到（见"已知限制"）。

### 历史检索

`history_search` / `history_get` 搜的是共享轨上的**原始事件**，所以被
`SummarizingMemory` 压缩掉的内容照样能捞回来（摘要只影响投影时的跳过逻辑，不删原事件）。
这也是子 agent 不必继承父上下文的前提 —— 缺什么自己去捞，而不是一开始就把整个上下文
复制一份。子 agent 的消息只进 `internal` 与 `agent:<id>` 轨，**不进 `model` 轨**，
因此不会污染主 agent 的对话投影。

### 模型别名

```js
subagents: {
  modelAliases: {
    fast: { model: 'deepseek-chat', apiKey: process.env.DEEPSEEK_KEY, url: '...' },
    main: { model: 'gpt-4o' },   // 省略的字段继承父 Agent
  },
}
```

不配置时默认两个别名：`fast` → 父 `Agent` 的 `simpleModel` / `simpleApiKey` /
`simpleUrl` 三件套，`main` → 父的 `model` / `apiKey` / `url`。`agent` / `graph_start`
的 `model` 参数 enum 在工具注入时由别名表的键生成（不写死型号 —— 本 SDK 是多供应商的），
每个别名可独立指定 `apiKey` / `url`，因此快模型可以跨供应商。优先级：调用入参 `model`
> `Agent_Type.model` > 继承父模型。

### worktree 隔离（Node-only 实验特性，已搁置）

> **状态：搁置，不作为推荐的隔离路径。** 实现完整、有测试覆盖、代码保留，但请不要把它
> 当成"怎么防止多个 agent 互相踩"的答案 —— 那个答案是产物轨。
>
> 原因有二。其一，目标环境包含浏览器，那里没有 git worktree；一个在一半目标环境里不
> 存在的机制不能承担隔离主方案。其二，它与 DAG 语义相冲突：一个 DAG 节点是一个子任务、
> 由一个 subagent 执行，若每个 subagent 各自一个 worktree，下游节点看到的是上游动手
> **之前**的仓库状态，据此产生的修改必然与上游错位且不会报错。流水线要成立，下游就必须
> 看得见上游的改动 —— 所以 `agent_graph` / `graph_start` **有意不提供** `isolation`
> 参数，图节点共享工作区是设计决策，不是缺口。
>
> 它仍然适用于一种情形：Node 环境下、经 `agent` 工具直接派发的、彼此独立且不需要看到
> 对方改动的并行任务。

`agent` 工具传 `isolation: 'worktree'` 时，框架 `git worktree add` 一个
`<worktreeBaseDir>/agent-<agentId>` 与 `<branchPrefix><agentId>` 分支。收尾时
`git status --porcelain` 为空则删除 worktree 与分支；非空则保留，并在 `Agent_Result`
里报路径、分支与改动文件数，由主 agent 决定合并还是丢弃。非 git 仓库、`git` 不可用、
或 `worktreeBaseDir` 未被 `.gitignore` 忽略时**软失败**（返回一句"不带 isolation 参数
重试"，而不是炸掉这次派活）。

```js
subagents: {
  isolation: { worktreeBaseDir: '.worktrees', branchPrefix: 'subagent/' },
}
```

工作目录以两种**通告**方式传达给子 agent：写进它首条消息的上下文事实，以及工具执行时的
`ctx.cwd`。**框架不重写工具入参** —— `read_file` / `shell_exec` 是主机提供的，框架无权
改其语义；静默把路径重写进 worktree 会造出"看起来隔离、实际没隔离"的错觉，而那是最坏的
结果，因为主机会信它。

`isolation: 'remote'` 未实现，软失败。

### 宿主侧 API

```js
// 提问路由（见上）
agent.pendingQuestions()
agent.answerQuestion(askId, answer)
agent.cancelQuestion(askId, reason)

// 主动往主 agent 的上下文里塞一条消息 —— 在**下一个 ReAct 轮边界**写进 memory，
// 不是立刻写。后台完成通知、图节点就绪通知、send_message 投递共用这一条队列。
agent.enqueueMessage({ role: 'user', content: '用户补充：优先看 auth 模块' })

// 产物轨
await agent.getArtifacts()                        // 全部
await agent.getArtifacts({ agentId: 'agt_...' })  // 按 agent 过滤

// 图容器（惰性，起手无图）
agent.subagents.graph          // 当前在用的那张图的 AgentGraph；没有活跃图时为 null
agent.subagents.graphs         // Map<graphId, GraphEntry>，含已关闭的
agent.subagents.newGraph({ label })
agent.subagents.closeGraph(graphId, { reason, disposition })   // disposition 缺省 'keep_running'

// keep-alive 观测
agent.lastKeepAliveTimedOut    // boolean，本轮是否在还有活在飞时放弃了等待
agent.lastStopReason           // null | 'completed' | 'max_rounds'（取值集合未扩张）

// 退出前
await agent.closeSubagents()
```

`enqueueMessage` 只接受 `role` 为 `'user'` / `'system'` 的消息；`'tool'` 与
`'assistant'` 会被丢弃并 `console.warn` —— 一条没有 `tool_call_id` 的孤儿 tool 消息正是
轮边界注入这套机制要防的破坏，而伪造一轮助手发言会让模型误以为自己说过那句话。非法入参
被丢弃而不抛异常：调用方多是后台通知的 fire-and-forget 路径。

### 跑起来看看

两个可以直接执行的集成入口：

```bash
# 命令行：7 幕跑完既有功能（工具 / Skill / MCP）+ subagent（后台派发 / DAG /
# 产物轨 / 提问路由），末尾对若干关键事实做断言，不成立则非 0 退出
OPENAI_API_KEY=sk-xxx node examples/subagents.js

# 浏览器：服务端 Agent 与浏览器端 Agent 两个页面都带 subagent 面板
npm run build                             # /browser 页面依赖这个 bundle，只需跑一次
OPENAI_API_KEY=sk-xxx node demo/server.js
#   http://localhost:3000/        —— 服务端 Agent（提问走 /questions + /answer 命令式通道）
#   http://localhost:3000/browser —— 浏览器端 Agent（提问走 hooks.onAskUser 弹层，Key 在页面里填）

# 关掉 subagent 系统对比一下（元工具不注入、行为回到旧版本）
SUBAGENTS=0 OPENAI_API_KEY=sk-xxx node demo/server.js
```

demo 默认注册两个演示用 Agent_Type：`explorer`（只读检索，拿 `read_note` + 基础设施
floor）与 `interviewer`（只有 floor，含 `ask_user`）。面板会实时显示每个 subagent 的
状态、每张图的节点与依赖边、以及产物轨；subagent 提问时页面会要求你回答，答案按
`askId` 定向送回提问的那一个 agent。新增的 `/agents`、`/questions`、`/answer` 三个端点
是宿主接法的参考实现。细节见 `demo/README.md`。

### 注意事项
1. **后台 agent 跨 `chat()` 存活。** 它们不随 `chat()` 返回而终止，会一路跑到终态 ——
   因此宿主进程在全部后台 agent settle 之前不会自然退出。
2. **退出前调 `closeSubagents()`。** 它取消全部在跑的 agent、reject 全部待答提问
   （避免悬挂 Promise 卡住进程退出）、清理未改动的 worktree。可重复调用；`reset()` 已
   包含它；未配置 subagents 时是安全空操作。
3. **产物轨是记账约定。** 见上文 —— 它是主方案，但拦不住绕过它的行为。
4. **`hooks` 会转发给每个子 agent。** `beforeToolCall` / `afterToolCall` / `onError`
   必须转发，否则主机的工具管控策略对子 agent 就失效了 —— 这是安全边界，不是便利。
5. **`agent.subagents.graph` 起手是 `null`。** 图容器是惰性的，第一次声明才建图；主机若
   直接读这个 getter（例如自己 `declare()`），要么先 `agent.subagents.newGraph()`，要么
   判空。全部图在 `agent.subagents.graphs` 这张 Map 里，`closeGraph(graphId, { reason,
   disposition })` 是主机侧的关图入口（`disposition` 缺省为 `'keep_running'`）。

### 已知限制

1. **只在 ReAct 策略下生效** —— 类型清单注入、轮边界注入、keep-alive、以及
   `ctx` 的归属字段（`_toolContextExtra`）全都住在 `_reactLoop` / `_reactLoopStream`
   里。`strategy: 'plan_and_execute'` 下这些一概没有：`agent` 工具仍可调用，但模型看不
   到类型清单，后台 agent 的完成通知会滞留到下一次走 `react` 的调用，或只能经事件被主机
   感知。与 skill 清单注入是同一个既有限制。
2. **无沙箱** —— 子 agent 经主机提供的工具执行命令，与 skill 系统同一安全模型。主机须
   用工具供给 + `hooks.beforeToolCall` 自行把关。
3. **产物轨是记账而非强制** —— 一个绕过 `artifact_write`、直接改文件的 subagent，框架
   检测不到。
4. **`ctx.cwd` 是通告，不是保证** —— 主机工具认不认它由主机决定。框架**有意**不重写工具
   入参：静默重写路径会造出"看起来隔离、实际没隔离"的错觉。
5. **`isolation: 'remote'` 未实现** —— 协议与 transport 注册表已就位，但没有非 local
   的 transport 随包发布，需第三方 `registerA2ATransport()`。
6. **保留下来的 worktree 会在 `.git/worktrees/<name>` 留下管理项并逐渐累积** ——
   主机应自行 `git worktree prune`；框架**有意**不做，因为 prune 是仓库级操作，会碰到
   本 SDK 之外的 worktree。
7. **父 memory 没有 `runtimeHistory` 时历史检索退化** —— runtime 自建一条独立
   `RuntimeHistory` 兜底，此时 `history_search` 搜不到父历史，工具结果里会明确说明这一
   点，不假装能搜。
8. **"任务结束了"的判断只在 prompt 里** —— 弃图协议（话题变了 = 任务结束；关一张仍有未
   完成节点的图之前必须先 `ask_user`）由 `AGENT_GRAPH_DESCRIPTION` 与 `graph_close` 的
   描述讲给模型，框架不强制、也无法强制。这是设计边界而不是遗漏：区分"续集"与"新任务"是
   语义判断。
9. **重新激活不自动扩散到下游** —— 失效范围由模型决定，框架只把漏掉的下游摆出来。没被一并
   激活的下游会拿着过期认知继续跑，**并且不报错**：图会在一个已经不成立的答案上报成功。
10. **`agent_status` 的节点表不显示 `generation`** —— 一个正在重跑的节点与首次运行的节点
    在表里长得一样。这个字段在节点快照里（主机读得到），但模型看图的那个窗口看不见它。
11. **`label` 没有唯一性约束** —— `agent_graph({ label })` 取**第一张** open 的同名图，
    所以两张图可以共用一个 label，而第二张就再也无法用 label 命中。
12. **重跑与产物冲突策略的组合** —— 激活刻意不动产物轨（旧记录留着好做对比），因此在
    `artifacts.policy: 'deny'` 下，重跑写同一个 `key` 时若上一代记录属于另一个 agent，
    写入会被拒。这是既有语义，但"重跑 + deny"这个组合是新出现的。

## 示例与 demo

`examples/` 下每个文件都能直接跑。标注"免 Key"的部分不需要任何 API Key。

| 文件 | 覆盖内容 | 运行 |
|------|---------|------|
| `basic.js` | 最小可用 Agent + 工具调用 | `OPENAI_API_KEY=sk-xxx node examples/basic.js` |
| `deepseek.js` | 多供应商（DeepSeek） | `DEEPSEEK_API_KEY=sk-xxx node examples/deepseek.js` |
| `memory.js` | 三种 Memory 策略 + RuntimeHistory 轨道投影 | `node examples/memory.js`（免 Key 跑示例 1~3） |
| `plan-and-execute.js` | PlanAndExecute 三阶段策略 | `OPENAI_API_KEY=sk-xxx node examples/plan-and-execute.js`（示例 4 免 Key） |
| `mcp.js` | MCP 基础流程 + BASE_TOOLS 运行时 CRUD | `node examples/mcp.js`（免 Key 跑 MCP 流程） |
| `dynamic-mcp.js` | `addTools`/`removeTool`/`getTools` + `load_mcp_server` + 生命周期 | `node examples/dynamic-mcp.js`（免 Key 跑示例 1+2） |
| `mcp-custom-transport.js` | `registerTransport` 注入非内置 transport | `node examples/mcp-custom-transport.js`（免 Key） |
| `websearch-mcp.js` | SearXNG MCP 实时搜索 + 网页抓取 | `node examples/websearch-mcp.js`（需本地 SearXNG） |
| `skills.js` | Skill 三级渐进披露 + `refreshSkills()` | `OPENAI_API_KEY=sk-xxx node examples/skills.js` |
| `subagents.js` | **综合验收用例**：7 幕跑完工具 / Skill / MCP + subagent 四大能力，末尾断言 | `OPENAI_API_KEY=sk-xxx node examples/subagents.js` |

> `examples/subagent-render.js` 是 `subagents.js` 用的终端渲染模块，不是独立入口。

`demo/` 是浏览器侧的集成参考，同时提供服务端 Agent 与浏览器端 Agent 两个页面：

```bash
npm run build                             # /browser 页面依赖这个 bundle
OPENAI_API_KEY=sk-xxx node demo/server.js
#   http://localhost:3000/        —— 服务端 Agent（API Key 不出服务端）
#   http://localhost:3000/browser —— 浏览器端 Agent（Key 在页面里填）
```

常用开关：`SUBAGENTS=0` 关掉 subagent 系统、`SKILLS_DIR=<dir>` 换技能目录、
`DYNAMIC_MCP=1` 开 `load_mcp_server`、`MCP_SERVER_CMD` 系列挂 MCP Server、
`PROVIDER` / `MODEL` / `LLM_URL` 换供应商。完整清单见 `demo/README.md`。

> `demo/` 与 `examples/` 都打**真实供应商**，两边都没有 stub 模型 —— 它们是给接入方的
> 集成参考，一个假 LLM 出现在里面会误导读者。

## License


MIT
