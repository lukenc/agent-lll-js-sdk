# lll-web-agent

开箱即用的 LLM Agent SDK — 配个 API Key 就能跑。

内置完整 Runtime 管线：意图识别 → 工具过滤 → 上下文管理（token 预算） → ReAct 循环。

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
    case 'done':       console.log('\n完成'); break
  }
}
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

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `provider` | (必需) | 供应商: openai, deepseek, qwen, moonshot, zhipu, x-grok |
| `apiKey` | (必需) | API Key |
| `model` | `'gpt-4'` | 模型名称 |
| `tools` | `[]` | 工具列表 |
| `maxRounds` | `300` | 最大 ReAct 轮次 |
| `enableIntentRecognition` | `false` | 启用意图识别 |
| `knowledgeBase` | `null` | 知识库实例 |
| `tokenBudget` | `null` | token 预算配置 |
| `memory` | `SlidingWindowMemory(40)` | 自定义记忆实例 |
| `strategy` | `'react'` | 执行策略: `'react'` 或 `'plan_and_execute'` |
| `planAndExecuteOpts` | `{}` | PlanAndExecute 策略配置（见下方） |

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

// 滑动窗口（默认）
const sw = new SlidingWindowMemory(40)

// 摘要记忆（超阈值时 LLM 压缩）
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

### ToolFilter

```js
import { ToolFilter, BASE_TOOLS } from 'lll-web-agent'

const filter = new ToolFilter()
const filtered = filter.filter(intentResult, allTools)
// BASE_TOOLS (keyword_search, read_file, write_file, shell_exec, project_tree) 始终保留
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

| 事件 | 触发时机 | 关键字段 |
|------|----------|----------|
| `session.start` | `chat()` / `stream()` 开始 | `traceId`, `spanId`, `parentSpanId: null`, `strategy`, `startedAt` |
| `session.end` | `chat()` / `stream()` 结束（成功或失败） | 完整 `Run_Metrics` + `endedAt` + `ok` |
| `round.start` / `round.end` | ReAct 每一轮开始 / 结束 | `traceId`, `spanId`, `parentSpanId`（指向 session root）, `round`, `durationMs` |
| `llm.call` | 每次 LLM HTTP 调用完成（含 sidecar） | OTel GenAI 字段 + `traceId` / `spanId` / `parentSpanId`, `ok`, `error?` |
| `tool.call` | 每次工具执行结束 | `name`, `arguments`, `durationMs`, `bytes`, `ok`, `errorKind?` |
| `warn` | 监听器抛异常时 | `source`, `eventType`, `error` |

监听器为空时不会改变 `chat()` / `stream()` 的返回值、`hooks.*` 的参数或任何现有
事件的字段 — 纯加法，可直接升级。 `agent.reset()` 会把 `getLastRunMetrics()`
清为 `null` 并归零 `getSessionMetrics()`，但保留已注册的监听器。

## MCP Client（Model Context Protocol）

接入社区 MCP Server（filesystem / github / postgres / playwright / slack / jira / notion …）
不需要写胶水代码。`createMCPClient(options)` 返回的 `listTools()` 结果形状与
`defineTool` 完全一致，直接塞进 `new Agent({ tools: [...] })`。

实现遵循 [MCP 2025-03-26 规范](https://modelcontextprotocol.io/specification/2025-03-26/index)，
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
| `'stdio'` | 本地子进程（最常用） | MCP 2025-03-26 一等 |
| `'http'`（别名 `'streamable-http'`） | 远程 Streamable HTTP | MCP 2025-03-26 推荐 |
| `'sse'` | legacy SSE（GET 长连 + POST /messages） | 存量兼容 |

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
  protocolVersion: '2025-03-26',    // 默认即此
  requestTimeoutMs: 60000,          // 默认 60s
  clientInfo: { name: 'my-app', version: '1.0.0' },  // 默认 {name:'lll-web-agent', version:<pkg>}
  signal: myAbortController.signal, // 握手阶段响应 abort
  onToolsChanged: (tools) => { },   // tools/list_changed 通知触发刷新后回调
  onClose: (reason) => { },         // 连接断开回调
})
```

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
| `GET /mcp-tools` | 拿工具清单（name / description / parameters / rawName） |
| `POST /mcp-call` | body `{ name, arguments }` —— 转发到服务端的 `MCP_Client.execute` |

`demo/browser.html` 里 `loadMcpTools()` 把 `/mcp-tools` 的每一项包成本地 `defineTool`，
`execute` 实现就是 `fetch('/mcp-call', ...)`。对浏览器 Agent 而言，MCP 工具和本地工具
没有任何区别。API Key 和 MCP server 子进程都留在服务端，浏览器零暴露、零 CORS。

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

## License

MIT

