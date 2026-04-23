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
      console.log(`${event.success ? '✅' : '❌'} Step ${event.index + 1} (${event.duration}ms)`)
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
  onStepComplete: (i, ok, result) => console.log(`${ok ? '✅' : '❌'} 步骤 ${i + 1}: ${result}`),
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
| `onStepStart` | - | 步骤开始回调 `(index, description) => void` |
| `onStepComplete` | - | 步骤完成回调 `(index, success, result) => void` |
| `onPlanRevised` | - | 计划修订回调 `(steps) => void` |

#### 流式事件类型

| 事件 type | 字段 | 说明 |
|-----------|------|------|
| `phase` | `phase`, `message` | 阶段变更（planning / executing / synthesizing / completed / fallback） |
| `plan_generated` | `plan` | 计划生成完成 |
| `step_start` | `index`, `description` | 步骤开始执行 |
| `step_complete` | `index`, `success`, `result`, `duration` | 步骤执行完成 |
| `plan_revised` | `plan` | 计划被修订（步骤失败后重规划） |
| `done` | `content`, `plan` | 全部完成，包含最终结果和计划快照 |

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

## License

MIT
