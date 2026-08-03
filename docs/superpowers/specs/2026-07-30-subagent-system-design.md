# Subagent 系统设计（Agent as Tool + DAG 编排 + A2A）

- 日期：2026-07-30
- 分支：`worktree-subagent-system`
- 基线：`1c6be94`（skill 系统合并后）
- 状态：设计已确认，待实现计划

## 1. 背景与目标

`lll-web-agent` 目前是单 agent 运行时：一条 ReAct 循环、一份 memory、一个工具集。要处理"读 8 个文件后给结论"这类任务，主 agent 必须把全部中间产物吃进自己的上下文，压缩一次就丢一批事实。

本设计引入 **subagent**：把一个明确、单一、描述完整的任务派给一个独立的 agent 实例去做，主 agent 只收结论。核心目标：

1. **Agent as Tool** —— subagent 通过一个普通 `Tool_Def` 暴露给模型（`agent` 工具），入参形状严格对齐参考实现，因此自动获得 `ToolFilter` / `ContextManager` / telemetry 的既有处理。它的特殊之处不在接口，而在 `execute` 内部启动了一个能自己调工具、能在执行中收消息、能对外发事件的嵌套运行时。
2. **主 agent 承担编排** —— 状态可查、列表可列、失败可见。框架不替主 agent 做重试之外的任何决策。
3. **DAG 惰性调度** —— 可并行、可排队；阻塞节点**就绪时才创建**，且默认把上游产物交回主 agent 重新确定契约后再启动，因为前序结果会改变后续决策。**图按任务划分**：一张图跟一个任务、可持续修改，一个主 agent 可同时持有多张图；任务结束时关图（弃图协议），已完成节点可被重新激活重跑（缓存失效）。见 §7.1–§7.3。
4. **不打断的消息投递** —— subagent 执行中可以收到新消息（`SendMessage`），消息不中断当前工具，只在轮边界汇入上下文。
5. **多路提问路由** —— 多个 agent 同时向用户提问时，每个问题带归属，用户的回答定向送回提问者。
6. **产物轨** —— 每个 agent 的产物记账归属，同一 key 被他人覆盖时可见、可拒。
7. **失败上抛** —— 可重试类失败自动重试；重试用尽后作为结构化失败结果回给主 agent，由主 agent 决定后续。
8. **记忆找回** —— `history_search` / `history_get` 让 subagent（和被压缩过上下文的主 agent）检索完整历史事件轨，而不必继承整个上下文。

### 非目标（v1 明确排除）

- **不实现远程 transport**。A2A 协议与 transport 注册表完整定义，v1 只实现进程内 `local`；`isolation: 'remote'` 返回软失败。
- **不做沙箱**。subagent 通过主机提供的 `shell_exec` 等工具执行命令，与 skill 系统同一安全模型：主机用工具供给与 `hooks.beforeToolCall` 自行管控。
- **不做 Task Contract 的结构化校验**。契约是自然语言，完整写在入参 `prompt` 里，靠 `agent` 工具自身的 `Tool_Def.description` 引导模型写全，不做字段拆解、不做"单一性"启发式检查。
- **不改 `memory.js` / `tool.js` / `context-manager.js` / `plan-and-execute.js`**。
- **不为 `plan_and_execute` 策略注入 agent 类型清单**（与 skill 系统同一既有限制，见 §16）。

## 2. 术语与数据结构

### Agent_Type

代码内注册的 subagent 类型定义。`name` 匹配 `^[a-z0-9-]{1,64}$`。

```js
{
  name: 'general-purpose',
  description: '通用 agent，适合研究复杂问题、跨文件搜索、多步执行',  // 进 system prompt 清单
  systemPrompt: 'You are a focused subagent...',
  model: 'main',                  // 模型别名；未指定则继承父模型
  tools: '*' | ['read_file', 'keyword_search', ...],
  maxRounds: 60,
  maxAttempts: 3,
  temperature: 0.6,
  canSpawn: false,                // 是否给它那五个编排工具（agent / agent_graph / graph_start /
                                  // graph_close / graph_reactivate）
  enableIntentRecognition: false, // 子 agent 默认关闭（任务已收窄，省 sidecar 调用）
}
```

内置 `general-purpose`（`tools: '*'`、`model: 'main'`、`canSpawn: false`），保留名不可覆盖 —— 与 `mcp/transports` 的保留 transport 名、`skills/provider` 的保留 provider 类型同一策略。

`tools: '*'` 表示继承父工具集，但**始终排除**五个编排工具 `agent` / `agent_graph` / `graph_start` / `graph_close` / `graph_reactivate`，除非 `canSpawn: true`。

### Agent_Handle

```js
{
  agentId: 'agt_7f3a9c21',        // 稳定唯一 id
  name: 'general-purpose-1',      // 人可读名，重名加 _2/_3 后缀
  type: 'general-purpose',
  description: 'Audit auth flow',  // 入参 description 原文（3-8 词标签，非任务内容）
  parentAgentId: 'main' | 'agt_...',
  depth: 1,                        // 主 agent = 0
  nodeId: null | 'n1',             // 来自图节点则非空
  state: 'pending' | 'queued' | 'running' | 'waiting_input'
       | 'succeeded' | 'failed' | 'cancelled',
  attempt: 1,
  attempts: [{ attempt, failureKind, error, startedAt, endedAt }],
  model: { alias: 'fast', model: 'deepseek-chat', url, /* apiKey 不入 handle */ },
  isolation: null | { mode: 'worktree', path, branch, dirty: false },
  result: null | Agent_Result,
  metrics: { rounds, llmCalls, toolCalls, usage, wallClockMs },
  artifactKeys: ['docs/findings.md'],
  createdAt, startedAt, endedAt,
}
```

`toStatus()` 返回不含函数与 apiKey 的纯数据快照，供 `agent_status` 与主机使用。

### Agent_Result

subagent 终态的结构化结果。作为字符串回给主 agent（`Tool_Def.execute` 必须返回可字符串化的值），头部机器可读、正文人可读。

成功：

```
[agent:general-purpose-1 succeeded] type=general-purpose model=fast attempts=1 rounds=7
usage: in=12043 out=1877  wall=8.4s
<子 agent 最终回复原文>
--- artifacts (2) ---
docs/findings.md (sha:a1b2c3d4) · src/probe.js (sha:d4e5f6a7)
```

失败：

```
[agent:general-purpose-1 failed] failureKind=rate_limited attempts=3 (retried 2x)
lastError: 429 Too Many Requests
--- partial artifacts (1) ---
docs/findings.md (sha:a1b2c3d4, attempt=1)
下一步由你决定：换 model 重发、缩小任务范围重发、或跳过该任务继续。
```

worktree 隔离且有改动时追加：

```
--- worktree ---
path=.worktrees/agent-agt_7f3a9c21 branch=subagent/agt_7f3a9c21 changed=3 files (已保留，未自动清理)
```

后台派发的即时返回：

```
[agent:general-purpose-1 started] background; 完成后会通知你。用 agent_status 查看进度。
```

`failureKind` 取值与重试策略：

| failureKind | 触发 | 自动重试 |
|---|---|---|
| `rate_limited` | 429（`llm-client` 重试用尽后仍失败） | 是 |
| `llm_error` | 5xx / 协议错误 / 流截断 | 是 |
| `network` | fetch 层失败 | 是 |
| `timeout` | 底层 LLM/工具调用自行超时（`TimeoutError` 或消息含 "timed out"）；框架不额外强制单次 attempt 超时 | 是 |
| `max_rounds` | 子 agent 轮次耗尽 | 否 |
| `tool_error` | 工具连续失败导致子 agent 自行放弃 | 否 |
| `aborted` | 被 `agent_cancel` / signal 取消 | 否 |
| `contract_invalid` | 缺 `description` / `prompt`，或 `subagent_type` 未注册 | 否 |
| `depth_exceeded` | 超过 `maxDepth` | 否 |
| `isolation_unavailable` | `isolation` 指定但环境不支持 | 否 |

重试 = **同一份契约起一个全新子 agent 实例**（不续用失败实例的 memory，避免把污染的上下文带进重试）。`attempt` 计入产物归属。重试之间沿用 `llm-client` 已有的指数退避语义，额外在 run 级重试前等待 `min(2^attempt * 1000, 8000)ms`。`maxAttempts` 优先级：`subagents.retry.maxAttempts` > `Agent_Type.maxAttempts` > 默认 `3`。

### Graph_Node

```js
{
  nodeId: 'n2',
  dependsOn: ['n1'],
  description: 'Write migration',
  prompt: null | '...',            // on_ready:'confirm' 时可省
  subagentType: 'general-purpose',
  model: null | 'fast',
  onReady: 'confirm' | 'auto',
  onUpstreamFailure: 'block' | 'skip',
  state: 'blocked' | 'awaiting_confirm' | 'queued' | 'running' | 'waiting_input'
       | 'succeeded' | 'failed' | 'cancelled' | 'skipped',
  blockedReason: null | 'upstream_failed' | 'upstream_cancelled' | 'upstream_skipped'
       | 'launch_failed' | '<cancel 时的自由文本 reason>',
  agentId: null | 'agt_...',
  result: null | '<渲染好的 Agent_Result 字符串>',
  error: null | '...',             // 宿主回调抛出时记在节点上（会进 statusTable）
  generation: 0,                   // 这个节点跑到第几轮；reactivate 自增（§7.3）
  declaredAt,
}
```

节点没有停留态的 `ready`：依赖一满足，`tick()` 在同一次调用里把它推到 `awaiting_confirm`（默认）或 `queued`（`on_ready: 'auto'`）。`generation` 在节点快照（`snapshot()`）里，宿主读 `graph.get(nodeId)` 就能看到（见 §7.3）。

### Envelope（A2A）

```js
{
  jsonrpc: '2.0',
  id: 'env_1a2b',                          // notify 时省略
  method: 'message/send' | 'message/notify',
  params: {
    from: { agentId, name },
    to:   { agentId } | { name },
    kind: 'message' | 'question' | 'answer' | 'notice' | 'result',
    correlationId: null | 'ask_1a2b',
    body: '...',
    meta: {},
  },
}
```

### Artifact_Record

```js
{
  artifactId: 'art_1a2b',
  key: 'docs/findings.md',        // 逻辑标识，冲突检测以此为准
  agentId, agentName, nodeId, attempt,
  kind: 'file' | 'text' | 'json' | 'patch' | 'url',
  path: null | 'docs/findings.md',
  sha: 'a1b2c3d4',                // FNV-1a 32 位十六进制，用于变更/冲突检测，非加密用途
  bytes: 2048,
  summary: '认证链路的 6 处问题清单',
  supersedes: null | 'art_0f9e',
  ts,
}
```

### Ask_Record

```js
{ askId: 'ask_1a2b', agentId, agentName, parentAgentId, nodeId,
  taskDescription, question, askedAt, state: 'pending'|'answered'|'cancelled' }
```

## 3. 模块布局

新目录 `src/agents/`，与 `mcp/` `skills/` 平级同构。**零新增运行时依赖**（`node:child_process` 仅 worktree 隔离用，动态 import；浏览器构建不触发）。

| 文件 | 职责 |
|---|---|
| `agents/index.js` | barrel 导出 |
| `agents/errors.js` | `SubagentError` / `AgentTypeError` / `AgentGraphError` / `A2AError` / `WorktreeIsolationError`；构造函数只接受白名单标量字段（照 `mcp/errors.js`，防 apiKey 泄进 `err.message`） |
| `agents/types.js` | Agent_Type 注册表：`registerAgentType` / `getAgentType` / `listAgentTypes` / `unregisterAgentType` / `resetAgentTypes`；内置 `general-purpose` 保留 |
| `agents/contract.js` | `agent` / `agent_graph` / `graph_close` / `graph_reactivate` 四个工具的 `Tool_Def.description` 常量（引导模型把完整契约写进入参 `prompt`、把依赖声明当安全边界、以及弃图协议与失效范围）+ 把 `{ description, prompt, inputs }` 渲染成子 agent 首条 user 消息 |
| `agents/models.js` | 模型别名表解析（alias → `{ model, apiKey, url }`）与 `agent` 工具 `model` enum 的生成（§10） |
| `agents/handle.js` | `AgentHandle` 与状态机迁移校验 |
| `agents/registry.js` | agentId / name 分配（重名 `_2` 后缀，复用 `mcp/namespace.js` 的去重思路）、按 id/name 查（重名时最新者胜）、并发槽位记账、完成态 LRU 保留 |
| `agents/runner.js` | 造子 `Agent`、跑、按 failureKind 重试、产出 `Agent_Result`、转发遥测 |
| `agents/graph.js` | 节点声明、Kahn 环检测、ready 集计算、惰性 spawn、失败传播、节点重新激活（`reactivate`）与 `generation` 收报守卫。**一个 `AgentGraph` 实例 = 一个任务** |
| `agents/mailbox.js` | 收件箱与轮边界投递 |
| `agents/mirror.js` | `wrapMemoryForMirror(inner, { sharedHistory, agentId })` —— 子 agent 消息单向镜像进共享历史轨 |
| `agents/a2a/index.js` | Envelope 编解码 + `registerA2ATransport` / `resolveA2ATransport`；保留名 `local` / `http` / `grpc` |
| `agents/a2a/local.js` | 内置进程内 transport |
| `agents/ask.js` | `AskRegistry` |
| `agents/artifacts.js` | 产物轨写入与冲突检测；`fnv1a32` |
| `agents/history-search.js` | 共享历史轨上的子串/正则检索 |
| `agents/isolation.js` | worktree 隔离（Node-only） |
| `agents/tools.js` | 12 个元工具定义 |
| `agents/runtime.js` | `createSubagentRuntime({ parent, ...opts })` —— 组装并持有上述部件，并持有**多图容器**（`graphs` / `activeGraphId` / `newGraph` / `closeGraph` / `reactivateNodes`，见 §7.1） |

## 4. `agent.js` 触点

全部增量，无破坏性改动。

### 4.1 构造函数

```js
opts.subagents = {
  types: [Agent_Type, ...],              // 追加注册（不覆盖内置）
  defaultType: 'general-purpose',
  maxConcurrent: 4,                       // 每个 depth 层独立的并发槽数（见 §7）
  maxDepth: 2,                            // 主 agent depth=0；depth 2 的 agent 不能再派
  modelAliases: { fast: {...}, main: {...} },
  retry: { maxAttempts: 3 },              // 优先级：本字段 > Agent_Type.maxAttempts > 3
  keepAlive: true,                        // §8
  keepAliveTimeoutMs: 600000,
  artifacts: { policy: 'warn' },          // 'warn' | 'deny'
  ask: { timeoutMs: null },
  isolation: { worktreeBaseDir: '.worktrees', branchPrefix: 'subagent/' },
  retainCompleted: 20,                    // 完成态 agent 保留数（供 send_message 续跑）
  retainClosedGraphs: 5,                  // 已关闭图的保留数（超出按 FIFO 整张淘汰，见 §7.1）
  a2a: { transport: 'local' },
}
```

存在时创建 `this.subagents = createSubagentRuntime({ parent: this, ...opts.subagents })`，并按 `ask_user` / `skill` / `load_mcp_server` 同款手法追加 12 个元工具，同时对每个调用 `registerBaseTool(name)`。

> 为什么必须注册为 base tool：开启 `enableIntentRecognition` 后 `ToolFilter` 会按意图裁剪工具集，元工具被裁掉时 system prompt 里的类型清单就指向了模型实际调不到的工具 —— `skill` 已经踩过这个坑（提交 `20617d8`）。

### 4.2 `enqueueMessage(msg)` + `_pendingInjections`

```js
enqueueMessage(message)   // { role:'user', content:'...' }；FIFO 入队，不立即写 memory
```

在 `_reactLoop` 与 `_reactLoopStream` 的**轮边界**排空：位置在 `_buildSimpleBody()` / `_runPipeline()` 之前，此时上一轮的 `assistant(tool_calls)` + 全部 `tool` 结果消息已经成对落盘，插入 `user` 消息不会破坏工具调用配对（`memory-policy.js` 的 `adjustCutPointForToolPairs` / `sliceWithoutOrphanTools` 依赖这个不变量）。

超过 5 条待注入时合并为单条消息（每条一个 `<agent-notification>` 段），避免连续多条 `user` 消息触发部分供应商的校验。

三个来源共用这一个机制：后台 agent 终态通知、图节点就绪通知、`send_message` 投递。

### 4.3 `ask_user` 升级

- 注入条件从 `hooks.onAskUser` 放宽为 `hooks.onAskUser || opts.subagents`（主机可以只用 `answerQuestion` 而不提供 hook）。
- hook 签名扩展为 `onAskUser(question, meta)`，`meta = { askId, agentId, agentName, parentAgentId, nodeId, taskDescription }`。旧的单参数 hook 无改动即可继续工作（JS 忽略多余实参）。
- `Agent` 新增：`pendingQuestions()` / `answerQuestion(askId, answer)` / `cancelQuestion(askId, reason)`。
- 主 agent 自己的提问也走注册表，归属 `agentId: 'main'`。

### 4.4 `_withSubagentTypesNote(messages)`

与 `_withSkillListingNote` 并列，把类型清单合并进 system 消息：

```
Available agent types for the `agent` tool:
- general-purpose: 通用 agent... (model: main, tools: all)
- explorer: 只读检索... (model: fast, tools: read_file, keyword_search, project_tree)
```

清单每轮重算（类型可运行时注册），只在 `react` 策略下注入。

### 4.5 工具执行上下文扩展

`tool.execute(args, ctx)` 的 `ctx` 从 `{ signal }` 扩展为 `{ signal, cwd, agentId, agentName, depth }`。主 agent 的 `cwd` 为 `null`（不改变现有行为）；worktree 隔离的子 agent 传其 workspace 根。**主机工具是否采纳 `ctx.cwd` 由主机决定**，框架不重写工具入参（见 §11）。

改动点：`_reactLoop` 与 `_reactLoopStream` 各一处 `tool.execute(call.arguments, { signal })`，改为展开实例字段 `this._toolContextExtra`。既有工具收到多余字段无影响。

### 4.6 keep-alive

见 §8。改动位于 `_reactLoop` / `_reactLoopStream` 中"无工具调用 → return"的分支。

### 4.7 生命周期

- `getArtifacts({ agentId } = {})` 增加可选过滤参数（无参行为不变）。
- 新增 `closeSubagents()`：取消全部在跑 agent、reject 全部待答提问、清理未改动的 worktree。
- `reset()` 调用 `closeSubagents()`。

## 5. 工具集

12 个工具，仅在 `opts.subagents` 配置后注入，全部注册为 base tool。子 agent 拿到哪些工具由 `Agent_Type.tools` 决定：`'*'` 继承父 agent 整个工具集（五个编排工具 `agent` / `agent_graph` / `graph_start` / `graph_close` / `graph_reactivate` 仅给 `canSpawn: true` 的类型保留 —— 后两个也在这一组里，因为关掉或重跑**父 agent 正在编排的**任务不是子 agent 有依据做的决定）；显式数组则是"数组点名的任务工具"∪"固定的基础设施 floor"——`send_message` / `history_search` / `history_get` / `artifact_write` / `artifact_list` / `ask_user`（`FLOOR_TOOLS`，见 `runner.js`）无论数组里写没写都会带上，与父 agent 实际拥有的工具取交集。floor **不含**那五个编排工具——派生子 agent 的能力仍然只由 `canSpawn` 把关。

### 5.1 `agent`

入参 schema **严格对齐参考实现**，`additionalProperties: false`：

```json
{
  "type": "object",
  "properties": {
    "description": { "type": "string", "description": "A short (3-8 word) description of the task" },
    "prompt":      { "type": "string", "description": "The task for the agent to perform" },
    "subagent_type": { "type": "string", "description": "The type of specialized agent to use for this task" },
    "model": { "type": "string", "enum": ["fast", "main"] },
    "run_in_background": { "type": "boolean" },
    "isolation": { "type": "string", "enum": ["worktree", "remote"] }
  },
  "required": ["description", "prompt"],
  "additionalProperties": false
}
```

> **术语消歧（全文通用）**：`agent` 工具涉及两个都叫 "description" 的东西，本文严格区分：
> - **入参 `description`** —— 模型每次调用时填的那个字段。**3-8 词的短描述，只是给这个 subagent 起的一个标签**，用于 `agent_status` 列表显示、agent 命名、日志与事件。**它不承载任何任务内容。**
> - **`Tool_Def.description`** —— `agent` 这个工具自身的说明文字（模型在工具列表里读到的那一段，`formatToolsForOpenAI` 输出的 `function.description`）。本文一律写作 `Tool_Def.description`，绝不简称 "description"。

- **入参 `description`**：3-8 词短标签。用途仅限列表显示、agent 命名、日志。**不写任务内容、不写契约。**
- **入参 `prompt`**：**Task Contract 的唯一所在**，纯自然语言，由主 agent 一次性写全。子 agent 看到的就是这段文字，它没有别的信息来源。
- 这两个字段的边界由 `Tool_Def.description`（即 §3 的 `agents/contract.js` 里那段常量）向模型讲清楚。该常量必须要求 `prompt` 自带：单一明确的目标；必要背景（子 agent 不继承对话历史）；期望产物的形态与落点；验收标准；约束与禁止事项。并提示：项目知识可以让子 agent 用 `history_search` 或读项目 md 自行找回。
- `model` 的 enum 在注入时由 `subagents.modelAliases` 的键生成（§10）。
- `run_in_background` 默认 `true`。
- `isolation` 见 §11。
- `subagent_type` 未注册 → 软失败（返回可用类型列表让模型重选），不 throw。

返回：同步模式返回完整 `Agent_Result`；后台模式返回 `[agent:<name> started]` 行。

### 5.2 `agent_status`

```js
{ agent_id?: string, include_graph?: boolean, include_finished?: boolean, graph_id?: string }
```

无参时返回全部活跃 agent 的一行式摘要 + 并发占用；`include_graph` 追加图的节点状态表；`include_finished` 含终态 agent。`graph_id` 指定打印哪张图（隐含 `include_graph` —— 给了 graph_id 却什么图都不打印是个静默空操作），`'all'` 打印全部图含已关闭的；省略时只打印当前在用的那张。

### 5.3 `agent_cancel`

```js
{ agent_id?: string, node_id?: string, graph_id?: string, reason?: string }
```

取消在跑 agent（abort signal）或未启动的图节点（标记 `cancelled`）。二者至少给一个。`graph_id` 省略时用当前在用的图；节点不在那张图里时软失败**点名它在哪张图**（多图之后 `node_id` 可跨图重名，这个提示是模型自我纠正的唯一依据）。

### 5.4 `agent_graph`

```js
{ nodes: [{ node_id, depends_on?, description, prompt?, subagent_type?, model?,
            on_ready?: 'confirm'|'auto', on_upstream_failure?: 'block'|'skip' }],
  max_concurrent?: number, graph_id?: string, label?: string }
```

只声明与排队，**不创建任何实例**。声明时校验：**同一张图内** `node_id` 唯一、`depends_on` 指向已知节点（可指向先前批次的节点）、Kahn 环检测（有环整批拒绝并回报环路径）、`on_ready: 'auto'` 的节点必须有 `prompt`。

#### 一张图 = 一个任务

图跟的是**任务**而不是 `Agent` 实例：同一任务始终往同一张图里加节点、图可以一直改；任务变了就换一张新图，因此一个主 agent 可以同时持有多张图（容器语义见 §7.1）。目标图的选择有三条路：

1. 给 `graph_id` —— 用它；**已关闭的拒掉**（往一张随时会被 FIFO 淘汰的图里声明节点等于静默丢活）。
2. 给 `label` —— label 就是任务名：找一张**同名的 open 图**接着往里加，没有就新开一张。这是模型开第二张图的唯一入口。
3. 都不给 —— 当前在用的那张图，没有就新开一张。

`node_id` 的唯一性随之只到图级。这修的是一个真实缺陷而不是放宽规则：单图时代第二个任务复用 `n1` 会被判重复、**整批声明被拒**。

`AGENT_GRAPH_DESCRIPTION` 还必须写明弃图协议的入口（详见 §5.11）：话题变了就是上一个任务结束的信号，此时关掉旧图、把新任务的节点声明进一张新图。**这个判断只能由模型做** —— 框架分不清用户的新消息是同一任务的续集还是另一个任务，那是语义判断。

#### 依赖声明是安全边界，不是调度提示

`AGENT_GRAPH_DESCRIPTION`（`agents/contract.js` 常量，与 `AGENT_TOOL_DESCRIPTION` 并列）必须把这一点讲透，因为它是模型唯一能读到的约束来源。

图节点**共享同一个工作目录**（§11：这是有意的，下游必须看得见上游的改动），且**没有任何 per-node 隔离兜底**。于是：**两个之间没有依赖路径的节点，一定会并行跑在同一个目录里。** 漏掉一条本该存在的边，不是"跑慢了"或"顺序不理想"，而是两个 subagent 同时改同一批文件、彼此都不知道对方改了什么 —— 静默产生冲突的代码，只剩产物轨（§12）事后告警。worktree 搁置之后，这层判断底下**没有物理隔离垫底了**。

因此 `Tool_Def.description` 必须要求：

1. **一个节点 = 一个单一、边界清晰的子任务。** 目标说不成一句话，就该拆成两个节点。
2. **凡是 B 会读或写 A 产出/改动的东西，就必须声明 `depends_on`。** 文件重叠本身就是依赖，哪怕两件事在业务逻辑上看起来无关。
3. **拿不准就把边加上。** 多一条边只损失并行度（墙上时间）；少一条边损失正确性，且不会报错。这两种代价不对称，所以默认偏向串行。
4. **但不要编造不存在的顺序。** 把本可并行的工作串成一条链，DAG 就退化成了顺序执行，这套机制也就没意义了。要判断的是"是否真的存在读写重叠"，不是"顺序上舒不舒服"。
5. **依赖必须在声明时已经存在** —— 每条边都指向更早声明的节点，因此环只可能出现在同一批次内（`detectCycle` 的 `existing` 参数是为将来可改写 `depends_on` 的路径预留的，见 §7）。


### 5.5 `graph_start`

```js
{ node_id: string, graph_id?: string, prompt: string, subagent_type?, model?, run_in_background? }
```

就绪节点的确认闸门：主 agent 看过上游产物后在此给出最终契约再启动。节点不在 `awaiting_confirm` 状态 → 软失败说明当前状态（`blocked` 时连带说明它在等什么）。`graph_id` 省略时用当前在用的图，且**只查不建**（打的是一个已经声明过的节点，凭它造一张空图毫无意义）；节点不在那张图里时软失败点名它在哪张图。已关闭的图**照旧可以** `graph_start` —— 里面还没启动或还在飞的节点必须仍能推进。

### 5.6 `send_message`

```js
{ to: string, message: string, summary?: string }
```

`to` 接受 agentId、agent name（重名取最新）、或别名 `'parent'` / `'main'`。目标在跑 → 入 inbox，轮边界注入。目标已终态且上下文仍保留 → **续跑**该 agent（状态回到 `running`，以既有 memory 继续，结果作为新的完成通知投递）。上下文已被 LRU 淘汰 → 软失败说明。

### 5.7 / 5.8 `artifact_write` / `artifact_list`

```js
artifact_write { key, kind, summary, path?, content?, supersedes? }
artifact_list  { agent_id?, key?, since?, limit? }
```

### 5.9 / 5.10 `history_search` / `history_get`

```js
history_search { query, regex?, agent_id?, role?, track?, since?, until?, limit? }
history_get    { event_id, before?, after? }
```

见 §13。

### 5.11 `graph_close`

```js
{ graph_id?: string, disposition: 'cancel_outstanding'|'keep_running', reason?: string }
```

任务结束时关掉它的图。`graph_id` 省略时关当前在用的那张（只查不建 —— 建一张空图只为立刻关掉它毫无意义）。

- `cancel_outstanding` —— 每个未走到终态的节点走 `runtime._cancelNode` → `cancelHandle`（连它挂在 `ask_user` 上的提问一起结算）。
- `keep_running` —— 图标记 closed 不再收新节点，在飞 agent 继续跑到终态，完成通知照旧投递，`hasInFlight()` 仍算它们。

`disposition` 是**必填**：工具层把 `undefined` 换成 `null` 再往下传，否则会命中容器层"只标记"的默认值，模型漏填就会静默关掉一张图。关闭活跃图后 `activeGraphId` 置空，下一次不带 `graph_id` 的 `agent_graph` 新建一张。返回文本区分"取消了几个**节点**"与"停掉了几个**agent**"——`blocked` / `awaiting_confirm` 的节点压根没起 agent，说"agent 都停了"会让模型向用户转述一件没发生的事。

#### 弃图协议（prompt 级，且只能是 prompt 级）

`GRAPH_CLOSE_DESCRIPTION` 与 `AGENT_GRAPH_DESCRIPTION` 必须写明：话题变了就是任务结束的信号；关闭一张**仍有未完成节点**（`blocked` / `awaiting_confirm` / `queued` / `running` / `waiting_input`）的图之前，**必须先用 `ask_user`** 点名那些节点、问用户是等它们跑完、取消掉、还是留着不管，拿到答复再调 `graph_close`。

框架不强制、也无法强制，这是**设计边界而不是遗漏**：判断任务是否结束需要语义判断（新消息是续集还是新任务），只有模型或有显式"新任务"入口的主机做得出来；而后果（取消别人跑了一半的活）不该由模型独断。协议不需要新机制 —— `ask_user` 已是带归属、可乱序应答的登记表（§14）。

### 5.12 `graph_reactivate`

```js
{ graph_id?: string, node_ids: string[], reason?: string }
```

缓存失效：把点名的**终态**节点送回去重跑（语义见 §7.3）。**已关闭的图也可以激活**（这正是用例：任务收尾后又来了局部修改），激活会把它重新置为 open 并成为当前在用的那张图。注意关闭活跃图会清空 `activeGraphId`，所以这条最常见的路径要显式带 `graph_id`，否则拿到 `Error: no graph is active. Known graphs: gph_… (closed).`（软失败里点名了图 id，模型一轮即可纠正）。

**返回值是机制的一部分。** 框架不自动扩散到下游，失效范围由模型决定，因此返回值必须给出模型漏掉的东西：哪些节点在拓扑上位于被激活节点下游、其中哪些的 `inputs` 里出现过被激活节点产出的 artifact key、以及这些里**哪些没被列进本次 `node_ids`**。措辞要让"没列进来"读起来是一个待确认的决定，而不是一句可以 skim 过去的提示 —— 漏一个下游，那个下游就拿着过期认知继续跑，而且不报任何错。

`consumedKeys` 的判据：一个节点契约里的 `inputs` 恰好是它**直接上游**已登记的产物（见 §7.1 的 `_startNode`），所以"直接依赖 ∩ 被激活集合"就复现了它当初真读到的东西；更远的下游标 `further downstream (via …)`，不硬编一份它从未读过的 key。产物 key 必须在 `graph.reactivate` **之前**取 —— 激活会清 `agentId`，而产物是按 agentId 记账的。

## 6. 子 agent 的构造与继承

`SubagentRunner` 用组合方式 `new Agent({...})`：

**继承**：`provider` / `url` / `apiKey`（按模型别名解析）、`knowledgeBase`（同一实例）、`tokenBudget`、`validateStreamCompletion`、`hooks.beforeToolCall` / `afterToolCall` / `onError`（**必须转发**，否则主机的工具管控策略对子 agent 失效 —— 这是安全边界）、`hooks.onAskUser`（经 `AskRegistry` 包装后转发）、skill registry（同一实例，不重复加载）、MCP 工具（作为父工具集的一部分按 `type.tools` 裁剪）。

**不继承**：memory（全新实例，经 `wrapMemoryForMirror` 包装）、`systemPrompt`（用 `Agent_Type.systemPrompt`）、`enableIntentRecognition`（默认关，类型可开）、`strategy`（子 agent 恒为 `react`）。

**遥测串联**：子 agent 的 `_bus` 事件全部转发到父 bus，payload 追加 `agentId` / `parentAgentId` / `agentName`；`traceId` 沿用父 run 的 traceId，`parentSpanId` 为触发它的 `agent` 工具调用 span。主机注册一个监听器即可看到整棵树。

## 7. DAG 调度语义

节点状态机（**没有停留态的 `ready`**：依赖一满足，`tick()` 在同一次调用里把节点推到 `awaiting_confirm` 或 `queued`）：

```
blocked ──依赖全部 succeeded & on_ready:'auto'────> queued ──有并发槽──> running
blocked ──依赖全部 succeeded & 'confirm'（默认）──> awaiting_confirm ──graph_start──> queued
running ⇄ waiting_input（该节点的 agent 正在等用户回答）
running ──> succeeded | failed | cancelled
blocked ──上游 failed/cancelled/skipped & on_upstream_failure:'skip'──> skipped
blocked ──上游 failed/cancelled/skipped & 'block'（默认）──> 保持 blocked，blockedReason 标注原因
终态 ──graph_reactivate──> blocked（generation +1，见下）
```

- **惰性创建**：只有进入 `queued` 才分配 `AgentHandle`、才构造子 `Agent` 实例。`blocked` / `awaiting_confirm` 节点不占任何运行时资源。
- **就绪确认（默认路径）**：节点转 `awaiting_confirm` 时，emit `graph.node.ready` 并向主 agent 注入一条通知，内容含：所属 `graph_id`、节点 id、声明时的入参 `description` 标签、上游 `Agent_Result` 的摘录、上游产物 key 列表。主 agent 随后 `graph_start`（在那里才写出该节点最终的 `prompt` 契约，也可换类型 / 换模型）或 `agent_cancel`。这是"到了再创建、决策可变"的落点。通知里必须带 `graph_id`：多图之后 `node_id` 可跨图重名，少了它模型的 `graph_start` 会打到别的图上。
- **并发**：全局 `maxConcurrent`（默认 4）与图级 `max_concurrent` 取较小值。超额节点停在 `queued`，有槽即按声明顺序放行。同步 `agent` 调用（`run_in_background: false`）同样排队等槽，其间父 agent 的该轮工具调用一直挂起。
- **并发槽按 depth 分层计数** —— 这是必须的，否则会死锁：若全局共用一个槽池，`maxConcurrent: 4` 的情况下 4 个 depth 1 的 agent 各自同步派一个 depth 2 的孙 agent，4 个槽全被父辈占着，孙辈永远等不到槽，而父辈又在等孙辈返回。每个 depth 维护独立的 `maxConcurrent` 槽池，跨层不争用，死锁在结构上不可能发生。图级 `max_concurrent` 只约束该图所在的那一层。
- **失败传播**：默认 `block`，即下游不自动取消也不自动启动，等主 agent 定夺 —— 与"框架不自作主张"一致。
- **多批声明**：`agent_graph` 可多次调用增量追加节点，新节点可依赖旧节点。每次声明都重跑环检测。

### 7.1 多图容器：图按任务划分

`runtime` 持有 `graphs: Map<graphId, GraphEntry>`，`GraphEntry = { graph, graphId, label, state: 'open'|'closed', createdAt, closedAt }`，插入序即创建序。

- `activeGraphId: string | null` —— **构造时为 `null`，容器是惰性的**：一个主 agent 可以持有多张图，凭空建一张空图没有意义。`runtime.graph` 是指向活跃图 `AgentGraph` 的 getter，无活跃图时返回 `null`（不抛）。
- `graphId` = `gph_` + 单调计数器补零到 8 位十六进制，**不混时间位** —— 与 `newAgentId` / `newEnvelopeId` 同一理由（本项目已两次因时间戳撞号），而 `graphs.set` 是静默覆盖：撞号会让前一张图连它记录的节点归属一起消失且不报错。
- **`node_id` 唯一性是图级的**（每张图自己的 `nodes` Map）。`AgentGraph` 本身不需要为多图改动 —— 要的是"多个它"，不是重写调度器。
- **解析路径分两条，这个区分是有意的**：只有**声明**走 `_resolveGraph`（不给 id 且无活跃图时新建并置活跃）；取消 / 关闭 / 查状态 / `graph_start` / 激活走 `_lookupGraph`（只查不建），否则一次注定失败的 `agent_cancel` 会凭空造出一张空图并把它设成活跃，那是个说不通的副作用。
- **回调必须绑定到自己那张图**：`AgentGraph` 的构造回调不带图身份，所以 `newGraph()` 为每张图单独构造 `onReadyNode` / `onAutoStart` 闭包各自捕获自己的 `graphId`；`_startNode` 在入口一次性解析 graph 对象，之后 `settle` / `onHandle` 全部闭包这个已解析的对象。闭包若读活跃图 getter，活跃图一变回报就落到别人的图上 —— 而 `onAgentSettled` 对未知 nodeId 是**静默 return**，所以这个错误不报错，只会让节点永远停在 `running`。
- **跨图聚合是硬要求**：`hasInFlight()` / `hasPending()` / `pendingNodeCount()` 都遍历**全部**图，含 closed —— 一个在飞的 agent 不因为它所属的图被关掉就停止存在。漏了这条，主 agent 一切换（或关闭）活跃图就不再等旧图里还在跑的 agent，那些结果没人接。`pendingNodeCount()` 是**告知**模型用的那个数（`run.keep_alive.timeout` 事件与收尾提示文本）：判据一直是跨图的，若告知不是，模型正好在决定要不要收尾的那一刻拿到假数。
- **`retainClosedGraphs`（默认 5）**：整张 closed 图按 FIFO 淘汰，否则"无界增长"只是从节点级搬到图级；**有在飞节点的图永不淘汰**（否则一个还在跑的 agent 的节点归属凭空消失，而闭包仍持着那张图的对象往里写）。淘汰发 `graph.evicted`。
- **`statusTable({ graphId })`**：默认只渲活跃图；`'all'` 渲全部含 closed；每段抬头 `graph <id> "label" [state, active]`。图 id 必须出现在渲染里 —— 跨图重名之后，模型全靠它决定填哪个 `graph_id`。

### 7.2 关闭：closed 的语义只强制一半，是有意的

`closeGraph(graphId?, { reason, disposition })` 见 §5.11。**只有 `agent_graph`（声明）拒绝 closed 图** —— 往一张随时可被 FIFO 淘汰的图里声明节点等于让它们随时消失，那是静默丢活。`graph_start` / `agent_cancel` / `agent_status` / `graph_reactivate` 对 closed 图**照旧可行**：一张 closed 图里还在飞的节点必须仍能取消、仍能查看，还没启动的仍能启动。

宿主直接调 `closeGraph(id)` 时 `disposition` 缺省为 `keep_running`（"只标记"），工具层刻意不沿用这个默认值（见 §5.11）。

### 7.3 节点重新激活：缓存失效与 generation 令牌

`graph.reactivate(nodeIds)` 把点名的**终态**节点送回 `blocked`，清 `agentId` / `result` / `error`，自增 `generation`，然后整批 `tick()` 一次（同一批里可能互为上下游，逐个 tick 只会让中间态多跑几遍）。

- **只接受终态节点**（`succeeded` / `failed` / `cancelled` / `skipped`）：一个还没跑完的节点没有"过期产物"可言，想让它停下来是 `agent_cancel`。
- **不自动扩散到下游**（用户决定）：框架自动铲掉整条下游会连模型判断"仍然有效"的那些一起铲，而框架没有依据做那个判断。代价是模型会漏，所以工具层必须把漏掉的摆到它面前（§5.12）。
- **`prompt` 故意留着**（当 `graph_start` 的默认值），于是 `on_ready: 'auto'` 的节点一被激活就带着原契约自己重新起飞 —— 与 `auto` 的语义一致（活儿事先就定死了）。
- **`tick()` 会清掉已作废的 `blockedReason`**（`upstream_cancelled` 之类，上游刚被激活）：`statusTable()` 是模型看图的唯一窗口，留着就是一句假话。
- **不动产物轨**：旧 artifact 记录留着，好让重跑的结果能与它对比。代价见 §16。

**`generation` 挡的是一处具体的 ABA，不是为了整齐。** `onAgentSettled` 原来的守卫是"节点当前是不是终态"，用来忽略迟到回报；而激活会把节点**从终态取出来**，于是那道守卫不再兜得住。可达路径全程走公开工具面：

> 节点在跑 → `agent_cancel`（或 `graph_close cancel_outstanding`）把它变成 `cancelled`（终态，**agent 还在跑**）→ 模型 `graph_reactivate` 它（终态，合法）→ 被放弃的旧 agent 这时才 settle，带着上一轮的结果穿过守卫，把陈旧的 `succeeded` 写回去，并据此**放行本该重跑的下游**。

因此 `_startNode` 在启动时捕获 `node.generation`，`onHandle` 的 `running` 回报与 `finish` 的终态回报都带上它；`onAgentSettled` 先比 generation，不匹配就 emit `graph.node.stale_report` 并丢弃。两点补充：

1. **省略 `generation` 的回报照旧被采信**（`generation != null` 才比较），宿主与老调用点不必都改，此时守的只剩终态那一条。
2. **`node.agentId = agentId` 挪到了两道守卫之后**。一份不该被采信的回报里的身份同样不该被采信 —— 让上一轮的 agentId 覆盖上去，`agent_cancel` 与 `agent_status` 就都打到错的 agent 上。这不丢信息：`onHandle` 在 `spawn` 的同步段就把 agentId 写上了，"终态回报补 agentId"这条路径在生产里从不产生新信息。

## 8. keep-alive 与轮边界注入

**问题**：ReAct 循环拿到无工具调用的回复即 `return`，主 agent 说完"我等它们回来"这一轮 `chat()` 就结束了，后台结果无人接。

**语义**（`subagents.keepAlive: true` 为默认）：`_reactLoop` 在 `toolCalls.length === 0` 分支处，先把 assistant 文本写入 memory，然后按顺序判断：待注入的通知 → 本轮是否已超时过一次 → `subagents.hasInFlight()`（存在 `running` / `queued` / `waiting_input` 的 agent，或 `queued` / `running` / `waiting_input` 的图节点，**跨全部图**）。用 `hasInFlight()` 而不是 `hasPending()`：`blocked` / `awaiting_confirm` 的节点等的是主 agent 自己的下一步，不产生任何事件，按它们来等就是每轮干等到超时。

- 无 pending → 照旧 `return textContent`，`lastStopReason = 'completed'`。
- 有 pending 且有待注入 → 排空注入，继续下一轮。
- 有 pending 且无待注入 → `await subagents.nextEvent({ signal, timeoutMs: keepAliveTimeoutMs })`，唤醒后注入并继续下一轮。
- 超时 → 注入一条说明（列出仍未完成的 agent / 节点），继续一轮让主 agent 收尾；同时 emit `run.keep_alive.timeout`、置 `agent.lastKeepAliveTimedOut = true`。

轮次仍受 `maxRounds` 约束，因此不存在无界循环。`lastStopReason` **不新增取值**（`'completed'` / `'max_rounds'` 是跨包契约，见 CHANGELOG），keep-alive 超时通过新增的独立字段与事件暴露。

`keepAlive: false` 时：本轮直接结束，通知暂存，在下一次 `chat()` / `stream()` 的第一个轮边界注入。

**跨 `chat()` 的生命周期**：后台 agent 不随 `chat()` 返回而终止，它们继续跑到终态。因此宿主进程在全部后台 agent settle 之前不会自然退出 —— CLI 类主机应在退出前调用 `closeSubagents()`（`reset()` 已包含）。这条要写进 README 的注意事项。

流式路径 `_reactLoopStream` 同语义，注入内容不作为 chunk 吐给消费方（它不是模型输出），只经事件暴露。

## 9. A2A 协议与邮箱

- **协议**：JSON-RPC 2.0 形状的 Envelope（§2）。方法：`message/send`（需回执）、`message/notify`（单向）。为远程预留 `agent/status`、`agent/cancel`、`agent/result` 三个方法名，v1 不实现。
- **transport 注册表**：`registerA2ATransport(name, factory)` / 内部 `resolveA2ATransport(config)`。保留名 `local` / `http` / `grpc` 不可被用户代码覆盖（照 `mcp/transports/index.js`）。
- **`local` transport**：进程内按 agentId 路由到目标 inbox。**即使无需序列化也走一遍 encode/decode**，让形状错误在本地就暴露，而不是等接远程时才炸。
- **投递时机**：入队即 emit `a2a.delivered`；目标在自己的 ReAct 轮边界排空 inbox，注入为 `role: 'user'` 的 `<agent-message from="planner-1">...</agent-message>`。执行中的工具**绝不被打断**。
- **续跑**：向终态 agent 发消息 → 以其保留的 memory 续跑一轮（§5.6）。

## 10. 模型别名

```js
modelAliases: {
  fast: { model: simpleModel, apiKey: simpleApiKey, url: simpleUrl },  // 默认
  main: { model, apiKey, url },                                        // 默认
}
```

`agent` / `graph_start` 的 `model` 参数 enum 在工具注入时由别名表的键生成，形状恒为 `{ type: 'string', enum: [...] }`。每个别名可独立指定 `provider` / `apiKey` / `url`，因此快模型可跨供应商。未指定 `model` → 用 `Agent_Type.model` → 未定义则继承父模型。

`agent` 的 `Tool_Def.description` 内含难易度指导：**机械、可枚举、结果易验证的任务用快模型；需要设计判断、跨文件推理、或产出会被直接采纳的任务用主力模型。** 判断权在主 agent，框架不做二次裁决（不额外起 sidecar 判难度 —— 主 agent 本来就在读上下文，它比 sidecar 更清楚这个任务有多重要）。

## 11. worktree 隔离（已搁置 — Node-only 实验特性）

> **状态：搁置。** 实现完整、17 个测试覆盖，但**不作为推荐的隔离路径**。
>
> 原因有二。其一，目标环境包含浏览器，那里没有 git worktree —— 一个在一半目标环境里不存在的机制，不能承担"隔离主方案"的角色；跨 agent 安全的主线是产物轨（§12）。其二，它与 DAG 的语义相冲突：一个 DAG 节点是一个子任务、由一个 subagent 执行，若每个 subagent 各自一个 worktree，下游节点看到的是上游动手**之前**的仓库状态，据此产生的修改必然与上游错位且不会报错。所以 `agent_graph` / `graph_start` **有意不提供** `isolation` 参数，图节点共享工作区。
>
> 它仍然适用于一种情形：Node 环境下、经 `agent` 工具直接派发的、彼此独立且不需要看到对方改动的并行任务。

`agents/isolation.js`，Node-only，动态 `import('node:child_process')`。

1. 前置检查：`git rev-parse --show-toplevel` 成功、`git` 可执行、`process.versions.node` 存在。任一不满足 → `failureKind: 'isolation_unavailable'` 软失败，提示模型不带该参数重试。
2. `git worktree add <repoRoot>/<worktreeBaseDir>/agent-<agentId> -b <branchPrefix><agentId>`，基点为当前 HEAD。分支名冲突加 `_2` 后缀。首次使用时若 `worktreeBaseDir` 未被 `.gitignore` 忽略 → 拒绝创建并说明原因（否则 worktree 内容会被提交进仓库）。
3. workspace 根作为**上下文事实**注入子 agent 首条消息（"你的工作目录是 X，所有相对路径以此为准"），并经 `ctx.cwd` 传给工具。**框架不重写工具入参** —— `read_file` / `shell_exec` 是主机提供的，框架无权改其语义；静默重写路径会造成"看起来隔离、实际没隔离"的错觉。主机工具是否采纳 `ctx.cwd` 由主机决定，spec 与 README 都明确写出这条边界。
4. 收尾：`git -C <wt> status --porcelain` 为空 → `git worktree remove` + 删分支；非空 → 保留，在 `Agent_Result` 报路径、分支、改动文件数，由主 agent 决定合并或丢弃。
5. `isolation: 'remote'` → 软失败（v1 无非 local transport）。

## 12. 产物轨

`artifact_write` → `sharedHistory.appendArtifact(Artifact_Record)`（RuntimeHistory 已有 `artifacts` 内置轨，只追加不覆盖，历史版本全留）。

**冲突检测**：同 `key` 的最新记录属于**另一个** `agentId`，且本次写入未在 `supersedes` 中显式引用该记录：

- `policy: 'warn'`（默认）→ 允许写入，返回 `⚠ key "x" 上一版属于 explore-1 (sha:a1b2c3d4, 3 分钟前)，你正在产生新版本。若非有意覆盖，先与其协调。`，并 emit `artifact.conflict`。
- `policy: 'deny'` → 拒绝写入，返回 owner 与 sha，让模型改 key 或先协调。

`sha` 用 FNV-1a 32 位（8 位十六进制），零依赖、Node/浏览器同实现，用途是变更与冲突检测，**非加密**，spec 与 JSDoc 都标注这点。

**诚实的局限**：绕过 `artifact_write`、直接用 `shell_exec` 改文件的行为框架检测不到 —— 产物轨是**记账约定**，不是强制隔离。

**但它是主方案，不是退路。** 目标环境包含浏览器，而浏览器里没有 git worktree、也没有 `shell_exec`。产物轨（归属记录 + 同 key 跨 agent 冲突 warn/deny）是唯一跨 Node 与浏览器都成立、每个 agent 都能用的跨 agent 护栏。`isolation: 'worktree'`（§11）是 **Node-only 的可选加强**，不是"需要硬保证时的正解"——它在一半的目标环境里根本不存在。这一层的强度就是这套系统跨 agent 安全的实际上限，不能再削弱。

## 13. 共享历史与检索

`memory.js` 的三个策略各自 `new RuntimeHistory()`，因此"共享一条轨"的挂载点选在**父 `Agent` 的 `memory.runtimeHistory`**：

```js
// agents/mirror.js
wrapMemoryForMirror(inner, { sharedHistory, agentId })
  → add(msg) { inner.add(msg); sharedHistory.appendMessage(msg, {
        topicId: agentId, tracks: ['all', 'internal', `agent:${agentId}`] }) }
  → 其余方法全部透传 inner
```

子 agent 以 `new Agent({ memory: wrapped })` 构造。`memory.js` **零改动**。子 agent 的消息进 `internal` 与 `agent:<id>` 轨，**不进 `model` 轨**，因此不会污染主 agent 的对话投影。自定义轨名无需 `registerTrack` —— `RuntimeHistory._eventsForTrack` 对未注册的轨名回落为"按 `event.tracks` 命中"，正是我们要的语义。

**一处必须显式处理的坑**：`RuntimeHistory.appendMessage` 遇到 `_isSummary` 的消息会转调 `appendSummary`，而该分支**不透传 `meta.tracks`**，tracks 落到默认值 `['all','model','internal']` —— 也就是子 agent 的摘要会进 `model` 轨。当前它靠 `projectMessages` 的 topicId 过滤侥幸不出事，但这是隐式依赖。因此 mirror 必须自己判断 `_isSummary` 并直接调 `appendSummary({ content, sourceEventIds, topicId: agentId, tracks: ['all','internal',`agent:${agentId}`] })`，不走 `appendMessage`。此点需有专门的回归测试。

父 memory 是自定义实现、无 `runtimeHistory` 时，runtime 自建一条独立 `RuntimeHistory` 兜底；此时 `history_search` 搜不到父历史，工具结果中明确说明这一点，不假装能搜。

- **`history_search`**：在共享轨的原始事件上过滤（子串默认，`regex: true` 时按正则，正则编译失败 → 降级为子串并说明）。匹配 `message.content`、工具名与工具结果文本。返回 `[{ eventId, ts, agentId, role, snippet }]`，`snippet` 为命中处 ±120 字符，单条截断 400 字符，`limit` 默认 20 —— 防止一次检索把子 agent 上下文打爆。
- **`history_get`**：按 `eventId` 取完整事件，`before` / `after` 各展开 N 条（各自上限 10）。
- 搜的是**原始事件**，所以被 `SummarizingMemory` 压缩掉的内容照样能捞回来 —— RuntimeHistory 的 summary 只影响投影时的跳过逻辑，不删原事件。这正是"找回记忆"的实现基础。

## 14. 提问路由

`AskRegistry` 分配 `askId`，登记 `Ask_Record` 与 `resolve` / `reject`。

- 提问期间 agent 状态 → `waiting_input`（在 `agent_status` 可见），不占用"运行中"的语义但仍占并发槽（它随时会继续）。
- 两条应答通道竞速，**先到先赢**，后到者 no-op（不抛错）：
  1. `hooks.onAskUser(question, meta)` 的返回值；
  2. `agent.answerQuestion(askId, answer)`。
- `agent.pendingQuestions()` 返回按提问时间排序的 `Ask_Record[]`（不含函数）。
- `ask.timeoutMs` 默认 `null`（永不超时，与现状一致）；配置后超时返回"用户未在 N 秒内回答"，由子 agent 自行决定猜默认值还是放弃。
- `cancelQuestion(askId, reason)` / agent 被取消 / `closeSubagents()` → reject 待答提问，工具返回 `Error: question cancelled (<reason>)`，避免悬挂 Promise 阻止进程退出。
- 事件：`ask.user`（提问时）、`ask.answered`（含 `via: 'hook' | 'api'`）、`ask.cancelled`。

## 15. 事件表

全部经父 `Agent._bus`，payload 均含 `traceId` / `agentId` / `parentAgentId`：

| 事件 | 关键字段 |
|---|---|
| `agent.spawn` | `agentId, name, type, description, model, depth, nodeId, isolation` |
| `agent.state` | `from, to` |
| `agent.retry` | `attempt, failureKind, delayMs` |
| `agent.succeeded` | `rounds, usage, wallClockMs, artifactKeys` |
| `agent.failed` | `failureKind, attempts, lastError` |
| `agent.cancelled` | `reason` |
| `graph.declared` | `accepted, total` |
| `graph.node.ready` | `nodeId, upstream: [{ nodeId, agentId, state }]` |
| `graph.node.auto_start` | `nodeId` |
| `graph.node.started` | `nodeId, subagentType` |
| `graph.node.settled` | `nodeId, state, agentId` |
| `graph.node.blocked` | `nodeId, reason: 'upstream_failed' \| 'upstream_cancelled' \| 'upstream_skipped' \| 'launch_failed', upstreamNodeId` |
| `graph.node.skipped` | `nodeId, reason, upstreamNodeId` |
| `graph.node.cancelled` | `nodeId, reason, previousState, agentId` |
| `graph.callback.error` | `nodeId, callback, error` |
| `graph.opened` | `graphId, label` |
| `graph.closed` | `graphId, label, reason, disposition, cancelled, stoppedAgents, outstanding`（后三个是**计数**，不是数组） |
| `graph.reopened` | `graphId, label, reason` |
| `graph.evicted` | `graphId, label, nodes` |
| `graph.reactivated` | `graphId, nodeIds, reason, reopened` |
| `graph.node.reactivated` | `nodeId, previousState, generation` |
| `graph.node.stale_report` | `nodeId, state, agentId, generation, currentGeneration` |
| `artifact.write` | `artifactId, key, sha, bytes` |
| `artifact.conflict` | `key, owner, ownerSha, policy` |
| `ask.user` / `ask.answered` / `ask.cancelled` | `askId, question, via, reason` |
| `a2a.delivered` | `envelopeId, from, to, kind` |
| `run.keep_alive.timeout` | `pendingAgents, pendingNodes, waitedMs`（`pendingNodes` 跨全部图，见 §7.1） |

子 agent 内部的 `llm.call` / `tool.call` / `round.start` / `round.end` 原样转发，仅追加归属字段。

## 16. 已知限制

1. **`plan_and_execute` 策略下不注入 agent 类型清单** —— `PlanAndExecuteStrategy` 自建 step system prompt，与 skill 系统同一既有限制。`agent` 工具在该策略下仍可调用，只是模型看不到类型清单（未指定 `subagent_type` 时落到 `general-purpose`）。**keep-alive 与 `_pendingInjections` 的轮边界排空同样只在 `react` 策略下生效** —— 该策略下后台 agent 的完成通知会滞留到下一次走 `react` 的调用，或只能经事件被主机感知。
2. **无沙箱** —— 子 agent 经主机工具执行命令，主机须用工具供给与 `hooks.beforeToolCall` 管控。
3. **产物轨是记账而非强制，且它是主方案** —— 见 §12。浏览器环境没有 worktree 也没有 `shell_exec`，产物轨是唯一跨环境成立的跨 agent 护栏。
4. **`isolation: 'worktree'` 已搁置为 Node-only 实验特性** —— 实现完整且有测试覆盖，但不作为推荐路径。原因见 §11 开头。
5. **DAG 节点共享工作区是有意设计，不是缺口** —— 一个 DAG 节点是一个子任务、由一个 subagent 执行；若每个 subagent 各自一个 worktree，下游节点看到的是上游动手**之前**的仓库状态，据此做的修改必然与上游错位，且静默产生冲突。流水线要成立，下游就必须看得见上游的改动。
6. **`ctx.cwd` 需要主机工具配合** —— 见 §11.3。
7. **`isolation: 'remote'` 未实现** —— 协议与注册表已就位，需第三方注册非 local transport。
8. **父 memory 无 `runtimeHistory` 时历史检索退化** —— 见 §13。
9. **"任务结束了"的判断只在 prompt 里** —— 弃图协议（§5.11）框架不强制、也无法强制。这是设计边界而不是遗漏：区分"续集"与"新任务"是语义判断。
10. **重新激活不自动扩散到下游，漏掉的下游不报错** —— 失效范围由模型决定（§7.3），框架只把判断依据摆出来。没被一并激活的下游会拿着过期认知继续跑，而图会在一个已经不成立的答案上报成功。
11. **`statusTable()` 不显示 `generation`** —— 一个正在重跑的节点与首次运行的节点在节点表里长得一样。字段在 `snapshot()` 里（宿主读得到），但模型看图的唯一窗口看不见它。为不改既有渲染契约而留下；若确认模型会把重跑误读成新工作，这里是最便宜的补法。
12. **`GraphEntry.label` 无唯一性约束** —— `agent_graph({ label })` 取**第一张** open 的同名图，所以两张图可以共用一个 label，第二张就再也无法用 label 命中。要让 label 成为稳定的任务键，约束属于 `newGraph`。
13. **重跑与产物冲突策略的组合** —— 激活刻意不动产物轨（§7.3），因此 `artifacts.policy: 'deny'` 下重跑写同一个 `key`、而上一代记录属于另一个 agent 时会被拒。既有语义，但"重跑 + deny"这个组合是新出现的。
14. **已关闭的图会被 FIFO 淘汰** —— `retainClosedGraphs`（默认 5）超限时整张淘汰，被淘汰的图既查不到也无法再激活（`graph_close` 的返回文本会据实分支说明）。有在飞节点的图永不淘汰。

## 17. 测试策略

沿用 native `node:test` + `node:assert`，测试文件与源码同目录，所有 HTTP 调用 mock，不需要真实 key。`fast-check` 用于调度器的性质测试。

| 测试文件 | 覆盖 |
|---|---|
| `agents/types.test.js` | 注册/校验/保留名/reset |
| `agents/contract.test.js` | 渲染确定性、`inputs` 展开、缺字段软失败 |
| `agents/registry.test.js` | id/name 分配与重名 `_2`、重名取最新、并发槽记账、完成态 LRU 淘汰 |
| `agents/runner.test.js` | 成功/失败结果格式、按 failureKind 决定是否重试、重试起全新实例、hooks 转发、遥测归属字段 |
| `agents/graph.test.js` | 状态机迁移、环检测（含多批声明）、ready 集、并发上限、**按 depth 分层的槽池：父辈同步派孙辈不死锁**、失败传播两种策略、惰性创建（未就绪节点不构造实例） |
| `agents/graph.property.test.js` | fast-check：随机 DAG 下"节点启动顺序恒满足拓扑序"、"无环图必然全部终态"、"有环必被拒绝" |
| `agents/graph-multi.test.js` | 多图容器：图级 `node_id` 命名空间、跨图 `hasInFlight()`、回报落回自己那张图、`runtime.graph` 无活跃图时为 `null`、closed 图的 FIFO 淘汰（有在飞节点的不淘汰）、`close()` 取消全部图 |
| `agents/graph-lifecycle.test.js` | 跨图 `pendingNodeCount()`；`graph_close` 两种 disposition（含"节点数 ≠ agent 数"的措辞）；节点重新激活：只收终态节点、closed 图重开、下游报告、`generation` 守卫挡住被放弃 agent 的迟到回报（正反两个方向都有回归） |
| `agents/mirror.test.js` | 消息镜像进 `internal` / `agent:<id>` 轨、**不进 `model` 轨**；`_isSummary` 消息走 `appendSummary` 且不落进 `model` 轨（回归）；其余方法透传 |
| `agents/mailbox.test.js` | 轮边界投递（不在工具执行中注入）、FIFO、>5 条合并、终态目标续跑 |
| `agents/a2a.test.js` | Envelope 编解码、畸形帧报错、transport 注册表保留名、local 路由 |
| `agents/ask.test.js` | 多路提问归属、乱序应答、双通道竞速、超时、取消 reject |
| `agents/artifacts.test.js` | 归属记录、同 key 跨 agent 冲突 warn/deny、`supersedes` 抑制告警、fnv1a32 稳定性 |
| `agents/history-search.test.js` | 子串/正则、过滤维度、被 summary 压缩过的事件仍可检出、limit 与截断 |
| `agents/isolation.test.js` | 非 git 仓库软失败、未 ignore 的 baseDir 拒绝、无改动自动清理、有改动保留并上报 |
| `agent-subagents.test.js` | Agent 集成：工具注入与 base tool 注册、类型清单注入、`enqueueMessage` 轮边界排空不破坏工具配对、keep-alive 三条分支、`closeSubagents` |

## 18. 导出

`src/index.js` 追加：`createSubagentRuntime`、`registerAgentType` / `listAgentTypes` / `unregisterAgentType` / `resetAgentTypes`、`registerA2ATransport`、`SubagentError` / `AgentTypeError` / `AgentGraphError` / `A2AError` / `WorktreeIsolationError`。`agents/__fixtures__/` 下的测试替身不导出（照 `mcp/__fixtures__` 先例）。

## 19. 兼容性

- 未配置 `opts.subagents` 时，行为与当前版本逐字节一致：无新工具、无新事件、`ctx` 多出的字段对既有工具无影响。
- `hooks.onAskUser` 的单参数写法继续工作。
- `lastStopReason` 取值集合不变。
- `BASE_TOOLS` 的运行时 CRUD 语义不变（元工具经 `registerBaseTool` 加入，`resetBaseTools()` 后需重新注册 —— 与 `skill` 现状一致）。
