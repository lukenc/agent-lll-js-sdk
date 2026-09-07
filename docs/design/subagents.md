# `agents/` — 子 Agent 系统（内部机制）

> 父文档：[设计说明索引](README.md) · 回到 [CLAUDE.md](../../CLAUDE.md)
> `agent.js` 侧的接线（注入队列、keep-alive 预算、`ask_user` 包装、生命周期）见
> [subagents-wiring.md](subagents-wiring.md)。

入口是 `agents/index.js`，导出：`createSubagentRuntime`、Agent_Type 注册表
（`registerAgentType` / `getAgentType` / `listAgentTypes` / `unregisterAgentType` /
`resetAgentTypes` / `AGENT_TYPE_NAME_RE` / `INITIAL_AGENT_TYPES`）、
`registerA2ATransport` / `RESERVED_A2A_TRANSPORTS`、`SUBAGENT_TOOL_NAMES`，以及五个错误类。

**其余全部是内部实现** —— `handle.js` / `registry.js` / `runner.js` / `graph.js` /
`mailbox.js` / `ask.js` / `isolation.js` / `mirror.js` / `contract.js` / `models.js` /
`artifacts.js` / `history-search.js` / `a2a/local.js`，由 runtime 组装并持有，不导出。
`agents/index.test.js` 是这条边界的**契约测试**：它点名每一个必须保持不导出的内部模块，
并对任何未登记的导出失败。

**零新增运行时依赖** —— 只用 Node 18+ 内置，且 `node:child_process` 仅由 `isolation.js`
**动态** import，所以浏览器构建永远不会把它拉进来。`fast-check`（devDependency）
只被 `graph.property.test.js` 使用。

---

## 内部布局

### `agents/errors.js`

`SubagentError` / `AgentTypeError` / `AgentGraphError` / `A2AError` / `WorktreeIsolationError`。
构造函数只接受白名单标量字段，与 `mcp/errors.js` 同一套模式
（所以 apiKey 绝不可能出现在 `err.message` 里）。

### `agents/types.js`

Agent_Type 注册表。`name` 匹配 `AGENT_TYPE_NAME_RE = /^[a-z0-9-]{1,64}$/`；
内置的 `general-purpose` 是保留项，不可被覆盖或注销
（与 MCP 保留传输名 / skill 保留 provider 类型同一策略）。

一个 type 携带：`description`（进 system prompt 的清单）、`systemPrompt`、`model`（别名）、
`tools`（`'*'` 或名字列表）、`maxRounds`（60）、`maxAttempts`（3）、
`attemptTimeoutMs`（未设 —— 回退到 runner 的默认值）、`temperature`（0.6）、
`canSpawn`（false —— **只**授予 `agent` 工具，绝不给 graph 工具）、
`enableIntentRecognition`（false）。

`normalizeAttemptTimeoutMs(value, where)` 是该字段校验的**唯一真源**，它住在这里
而**不是** `runner.js`，因为 runner 已经从这个模块 import `getAgentType`
（把校验助手放到另一个方向会成环）；`normalize()` 包一层，让 `TypeError` 以 `AgentTypeError` 浮现。

它的**三个哨兵值不可被 `??` 合并**：

- `undefined` = 未声明（回退链继续走 `subagents.retry.attemptTimeoutMs` → 默认值）
- `null` = 显式的"无截止"
- 正整数 = 就用它

`normalize()` **故意不填默认值** —— 急切填值会让调用级配置变得不可达，
那就是 `maxAttempts` 那个回归的原样重演。

**注册表是进程级全局的**，和 `BASE_TOOLS` 一样 —— `resetAgentTypes()` 会把宿主注册的类型
清回只剩内置项。

### `agents/contract.js`

`AGENT_TOOL_DESCRIPTION` / `AGENT_GRAPH_DESCRIPTION` / `GRAPH_CLOSE_DESCRIPTION` /
`GRAPH_REACTIVATE_DESCRIPTION`（这些 `Tool_Def.description` 常量是模型**唯一**的指导来源：
怎么写任务契约、什么时候边是必需的、一个 graph 的任务何时算结束、重新激活一个节点会使什么失效）
+ `renderContract({ description, prompt, inputs, cwd })`，确定性地渲染子 Agent 的第一条用户消息。

**这些常量是机制，不是文档。** 弃权协议（abandonment protocol）只住在这里：
话题转变就是任务结束的信号，而一个仍有未完成节点的 graph 在 `ask_user` 问过用户
"要拿它们怎么办"之前不得关闭。框架做不了这个判断 ——
一条新的用户消息是延续当前任务还是开启另一个任务，是**语义判断**，
而猜错的代价（取消掉做到一半的工作）不该由框架来花。
`GRAPH_REACTIVATE_DESCRIPTION` 必须写明"未被重新激活的下游消费者会继续基于陈旧知识运行"，
也是同一个理由：失效范围是模型的决定，所以后果必须摆在它面前。

### `agents/models.js`

模型别名表。默认：`fast` → 父 Agent 的 `simpleModel`/`simpleApiKey`/`simpleUrl` 三元组，
`main` → 父 Agent 的 `model`/`apiKey`/`url`。`modelEnum` 在**工具注入时**生成 `model` 参数的 enum
（**绝不是**硬编码的模型列表 —— 这个 SDK 是多供应商的），所以一个 fast 别名可能住在另一个供应商上。
解析顺序：调用参数 → `Agent_Type.model` → 继承父级。

### `agents/handle.js`

`AgentHandle`：身份、指标，以及一个**带校验的状态机**
（`pending → queued → running → succeeded|failed|cancelled`，
问题未决期间 `running ⇄ waiting_input`）。非法转移**抛异常**
（那是编程错误，不是软失败）。`toStatus()` 返回一个不含函数、不含 apiKey 的快照。

### `agents/registry.js`

agentId / name 分配（`agt_` + 计数器；重名加 `_2`/`_3`，按名字查找解析到**最新**的那个）、
**按深度划分的并发槽池**，以及已完成 agent 的 LRU 保留（`retainCompleted`，默认 20），
使 `send_message` 能恢复一个已结束的 agent。

槽池按深度划分是**结构性原因**：一旦 `maxConcurrent` 个父 Agent 各自同步 spawn 一个孩子，
单一共享池就会死锁。

### `agents/runner.js`

把每个子 Agent 构造成一个普通的 `new Agent({...})`（**组合**，不是分叉的 ReAct 循环），
按 `failureKind` 重试，把终态渲染成 `Agent_Result` 字符串，并带归属字段转发 telemetry。

`run()` **永不抛** —— 每个失败都以结构化结果回到父级供其处置。

还导出 `cancelHandle`，这是 `agent_cancel` 工具与 `runtime.close()` 共享的**唯一取消路径**：
它**先**把 handle 转到 `cancelled` **再** abort，所以一次取消绝不会被重新归类成失败。

**一次重试是同一契约上的全新子 Agent 实例** —— 失败实例的 memory 被刻意不复用。

### `agents/graph.js`

纯逻辑（状态机、Kahn 环检测、ready 集计算），**无 I/O**。

一个 `AgentGraph` 实例是**一个任务**；容纳多个 graph 的容器是 `runtime.js`，
所以 `node_id` 的唯一性是**按 graph** 而不是按 session。

**声明不等于创建**：`blocked` / `awaiting_confirm` 节点不持有 handle、不持有 `Agent`、
不占并发槽（**不存在**静止的 `ready` 状态 —— 依赖已满足的节点在一次 `tick()` 内
直接进入 `awaiting_confirm` 或 `queued`）。

默认路径上，一个依赖全部成功的节点**不会自动启动** —— 上游结果回到编排者手里，
再由它通过 `graph_start` 写出该节点的最终契约。`on_ready: 'auto'` 是给
"完全预先确定的工作"留的逃生门。

#### `reactivate(nodeIds)` 是缓存失效

它把**仅被点名的 terminal 节点**送回 `blocked`（非 terminal 节点被拒绝 ——
一个还在跑的节点没有陈旧产物；那是 `agent_cancel` 的活），清除 `agentId` / `result` / `error`，
递增每节点的 `generation`，**保留 `prompt`**（所以一个 `on_ready: 'auto'` 节点会以同一契约自我重启），
并为整批 tick 一次。它**刻意不向下游扩散**。

每个节点在 `snapshot()` 里携带 `generation`，而 `onAgentSettled` 现在按
**一份报告属于哪一轮**来判定，而不只看节点的当前状态：
`generation != null && generation !== node.generation` → 发 `graph.node.stale_report` 并丢弃。

那个守卫是为**一个可达的 ABA** 而存在的，不是为了整洁 ——
`agent_cancel`（或 `graph_close cancel_outstanding`）会在一个节点的 agent **仍在运行**时
把它变成 terminal，`graph_reactivate` 随后把它移出 terminal 状态，
于是被抛弃的 agent 那份迟到的报告会**穿过**旧的"是否 terminal"守卫，
复活一个陈旧的 `succeeded`，并释放本该重跑的下游节点。
`agentId` 赋值放在**两道守卫之后**，同理：一份不可信的报告，其身份信息也不可信。
这不会丢东西，因为 `onHandle` 在 `spawn` 的同步序幕里就写下了 `agentId`，
所以一份迟到的 terminal 报告从不携带新身份。

省略 `generation` 的报告仍然被采信，所以宿主代码与旧调用点只需 terminal 状态守卫即可继续工作。

`tick()` 还会清掉已经变成谎言的 `blockedReason`（`upstream_cancelled` 之类，
而其上游刚被重新激活）—— `statusTable()` 是模型看向 graph 的**唯一窗口**。

### `agents/mailbox.js`

每个 agent 一个收件箱。消息**永不打断一个正在运行的 tool**；它们在目标的 ReAct 轮边界被排空，
并以 `role: 'user'` 注入、外面包 `<agent-message>`
（**不是** `assistant` —— 伪造一个 assistant 轮会让模型以为那是它自己说的）。

待注入数超过 `INJECTION_MERGE_THRESHOLD`（5）时合并为**单条**消息，
因为连续多条 `user` 消息会触发某些供应商的校验。

### `agents/ask.js`

`AskRegistry`：多路复用的问题路由。每个问题（**包括主 Agent 的**）都得到一个带归属的 `askId`，
所以宿主可以乱序回答。

**两条回答通道竞争，先到者胜，迟到者是静默 no-op** ——
两者同时存在是合法的宿主配置，所以对失败者抛异常会让一次正常的竞态搞崩宿主，
而让失败者覆盖则会把别人的答案交给等待者。

### `agents/artifacts.js`

共享 RuntimeHistory `artifacts` 轨上的归属记录 + 同键跨 agent 冲突检测
（`policy: 'warn'` 默认 / `'deny'`；其他任何值在**构造时抛**而不是被强制成 `'warn'` ——
这条轨是浏览器**唯一**的跨 agent 守卫，所以把一个打错的 `'DENY'` 静默降级，
等于在调用方以为 deny 开着的时候把它解除武装），以及 `fnv1a32`
（8 位十六进制、零依赖、在 Node 与浏览器里完全一致；用于**变更/冲突检测，不是密码学**）。

记录携带 `nodeId` 与 `attempt`，由 runner 的 `_runOnce` 通过 `_toolContextExtra` 从 handle 串下来，
所以一个 graph 节点的产出是可归属的，而一个被重试的 agent 对同一键的两次写入仍可区分。

### `agents/history-search.js`

在共享轨的**原始事件**上做子串/正则搜索，所以已经被 `SummarizingMemory` 压缩掉的内容
**仍可恢复**（摘要只影响投影，不删除事件）。这就是子 Agent 得以跳过继承父上下文的原因。
片段 ±120 字符，上限 400，`limit` 默认 20。

### `agents/mirror.js`

`wrapMemoryForMirror(inner, { sharedHistory, agentId })` 把子 Agent 的消息**单向**镜像进父级的
`RuntimeHistory`，落在 `all` / `internal` / `agent:<id>` 轨上 —— **绝不落 `model` 轨**，
所以父级的对话投影保持干净。`memory.js` 未改动。

摘要消息被**显式**走 `appendSummary` 路由，因为 `appendMessage` 的 `_isSummary` 分支
不会转发 `meta.tracks`，会把它们落到 `model` 轨上。

### `agents/a2a/index.js`

信封编解码（JSON-RPC 2.0 形状）+ 传输注册表。保留名 `local` / `http` / `grpc`
不可被用户代码覆盖。`agents/a2a/local.js` 是进程内传输，
并且**即使没什么需要序列化也照样跑 encode/decode**，
所以一个畸形信封会在本地失败，而不是在有人接上远程传输的那天失败。

### `agents/isolation.js`

worktree 隔离（仅 Node，动态 `import('node:child_process')`）。**已搁置 —— 见下文。**

### `agents/tools.js`

`SUBAGENT_TOOL_NAMES` 加 12 个元工具定义：`agent`、`agent_status`、`agent_cancel`、
`agent_graph`、`graph_start`、`graph_close`、`graph_reactivate`、`send_message`、
`artifact_write`、`artifact_list`、`history_search`、`history_get`。

**全部软失败**（未注册的 type、未知的目标、状态不对的节点、活在另一个 graph 里的 `node_id`，
都返回一句可纠正的话，绝不抛）。

每个面向 graph 的工具 —— `agent_graph` / `graph_start` / `graph_close` / `graph_reactivate`，
外加 `agent_status` / `agent_cancel` —— 都接受一个可选的 `graph_id`，默认为模型正在工作的那个 graph；
`agent_graph` 还接受 `label`（任务的名字），`agent_status` 接受 `graph_id: 'all'`。

这个文件里有两处渲染是**承重机制而非格式化**：

1. `graph_close` 的回复区分被取消的**节点**与被停止的**agent**
   （一个 `blocked` / `awaiting_confirm` 节点从来没有 agent，
   而告诉模型"那些 agent 已被停止"会让它向用户转述一件没有发生的事）。
2. `renderReactivation` 列出被重新激活集合在拓扑上的**每一个**下游节点、
   其中哪些读了刚被失效的 artifact 键、以及那些里**哪些没有被本次调用点名** ——
   一个从可能已被压缩的上下文里挑节点的模型**会漏掉一个**，
   而被漏掉的消费者会继续基于陈旧知识运行，且没有任何东西会把这件事提出来。

`graph_close` 传的是 `disposition ?? null` 而不是原样转发，
因为 `undefined` 会撞上 `closeGraph` 的 `keep_running` 默认值，
从而静默关闭一个模型从未对其做过决定的 graph。

graph 路径里有三个字符串以**实际的**关闭后状态为条件，而不是假设被关闭的 graph 就是当前活动的那个
（`graph_id` 存在正是为了能关闭一个非活动的 graph，而 `closeGraph` 只在被关闭者确实活动时
才清 `activeGraphId`）：关闭摘要会点名仍然活动的 graph 而不是宣布"你现在没有活动 graph 了"；
`awaiting_confirm` 提示会说"一个已关闭的 graph 绝不可能是你正在工作的那个"而不是"不再活动"；
`resolveDeclareTarget` 的"已关闭 graph"拒绝会指向活动的 graph，而不是承诺省略 `graph_id` 就会开一个新的。
这三处谎话里的每一处都会把**下一个任务的节点塞进上一个任务的 graph**，
而那正是"按任务拆分 graph"要防止的事。

#### 子 Agent 实际拿到什么

由 `runner.buildChildOptions` 里的 `Agent_Type.tools` 决定，经过两道**独立**的排除：

- 四个 graph 工具（`GRAPH_TOOLS` —— `agent_graph` / `graph_start` / `graph_close` /
  `graph_reactivate`）被**无条件移除，`canSpawn` 也不例外**；
- `agent`（`SPAWN_TOOLS`）除非该 type 设了 `canSpawn: true`，否则移除。

所以 `'*'` 继承父级的整个工具集**减去**上述那些；而一个显式数组只保留它列出的名字，
**外加一层固定的基础设施底线**：`artifact_write` / `artifact_list` / `history_search` /
`history_get` / `send_message` / `ask_user`（`runner.js` 里的 `FLOOR_TOOLS`）总是随行，
并与父级实际拥有的集合取交集（父级没有的 floor tool 绝不会被凭空造出来）。

一个写着 `tools: ['read_file']` 的 type，意思是"这个 agent 只读"，
**不是**"而且它不可以记录自己产出了什么、不可以搜历史、不可以问用户" ——
与 `tool-filter.js` 里 `BASE_TOOLS` 的先例相同（commit `20617d8`），
`ToolFilter` 无论意图过滤如何都保留它们。

**`canSpawn: true` 授予 `agent`，且只有 `agent`。** graph 工具操作的是
**编排者的** graph 容器，而孩子收到的是**父级的**工具闭包 ——
闭包捕获的是父级的 runtime，且工具没有"谁在调用我"的概念。
把它们下发不是"更宽的权限"，而是三个静默缺陷：

1. 孩子的 `agent_graph` 会重定向父级的 `activeGraphId`；
2. 它的 `graph_close` 能结束父级正在编排的任务；
3. 它的节点全部归属到 `main`。

外加按深度的并发池会自我竞争（`_startNode` 以硬编码的 `depth: 1` spawn，
所以一个 depth-1 的孩子调用 `graph_start({ run_in_background: false })`
会等待它自己正占着的那个池槽，四个这样的孩子在默认 `maxConcurrent: 4` 下就卡死）。
`maxDepth` 与按深度的池沿 `agent` 路径仍然是健全的，那条路径会串下 `ctx.depth + 1`。
底线（floor）**刻意**不含这五个。

`runner.test.js` 把这三组都绑回 `SUBAGENT_TOOL_NAMES` 并显式断言剩下的部分，
所以重命名一个元工具会**大声失败**，而不是静默地给孩子一个 spawn 工具或丢掉一个 floor 工具。

### `agents/runtime.js`

`createSubagentRuntime({ parent, ...opts })` 组装并持有上述全部，
且是 `agent.js` 唯一对话的对象。

它还持有**多图容器**：`graphs: Map<graphId, GraphEntry>`
（`{ graph, graphId, label, state: 'open'|'closed', createdAt, closedAt }`）、
`activeGraphId`（**起始为 `null`** —— 容器是懒的，构造时什么都不创建），
外加 `newGraph` / `closeGraph` / `reactivateNodes` / `_lookupGraph`（只查，绝不创建）/
`_resolveGraph`（没给 id 且没有活动 graph 时创建并激活）/ `findNodeGraphs` /
`statusTable({ graphId })` / `pendingNodeCount()`。

Graph 跟踪**任务** —— 同一个任务用同一个可变 graph；一个 agent 可以同时持有多个，
因为它可以同时在多个任务上工作。`node_id` 的唯一性因此是按 graph 的，
这修的是一个真实缺陷而不仅仅是放宽规则：在只有单个 session 级 graph 时，
第二个任务复用 `n1` 会导致它的**整批声明被拒**。

`statusTable()` 默认只渲染活动 graph（`graph_id: 'all'` 渲染每一个 graph，含已关闭的）。
`runtime.graph` 仍是一个指向活动 graph 的 `AgentGraph` 的 getter，没有活动 graph 时为 `null`。

**只有声明（`agent_graph`）走 `_resolveGraph`**；cancel / close / inspect / `graph_start`
走 `_lookupGraph`，所以一次注定失败的 `agent_cancel` 不能凭空造出一个空 graph
并顺手把它变成活动的。

#### 三件事不得回归

1. `hasInFlight()` / `hasPending()` / `pendingNodeCount()` 在**每一个** graph 上聚合，
   **包括已关闭的**（一个在飞的 agent 不会因为它的 graph 被关闭就不存在了 ——
   漏掉这点，切换或关闭活动 graph 会让父级停止等待仍在运行的 agent，
   并让 keep-alive 超时时报出的节点数变成模型随后据以行动的错误数字）。
2. 每个 graph 的 `onReadyNode` / `onAutoStart` 闭包捕获**它们自己的** `graphId`，
   而不是去读活动 graph 的 getter；`_startNode` 在入口处解析一次 graph，
   于是 `settle` 会报告回节点**自己的** graph ——
   `AgentGraph.onAgentSettled` 对未知 nodeId 静默返回，
   所以一份路由错误的报告不会抛出任何东西，只会把节点永久留在 `running`。
3. `retainClosedGraphs`（默认 5）按 FIFO 逐出整个已关闭的 graph，
   但**绝不逐出仍有在飞节点的那个**，否则会让一个在跑 agent 的节点归属变成孤儿。

`graphId` 是 `gph_` + 8 位十六进制的单调计数器，**没有时间位**
（与 `newAgentId` / `newEnvelopeId` 同理）。

#### 生命周期

`closeGraph(graphId?, { reason, disposition })`：

- `'cancel_outstanding'` 把每个非 terminal 节点经 `_cancelNode` → `cancelHandle` 路由
  （后者也会 settle 那个节点的 agent 正阻塞着的任何 `ask_user` 问题）；
- `'keep_running'` 把 graph 标记为已关闭，同时让其在飞的 agent 跑到完成。

关闭活动 graph 会把 `activeGraphId` 留成 `null`，
所以下一次不带 `graph_id` 的 `agent_graph` 会开一个**新** graph 而不是堆到一个已关闭的上头。

宿主侧默认是 `keep_running`；`graph_close` 工具用 `null` 覆盖它，
于是缺失的 `disposition` 变成一次列出两个值的软失败。

**只有 `agent_graph` 拒绝已关闭的 graph**（声明进一个 FIFO 逐出可能丢掉的 graph 就是静默的工作丢失）；
`graph_start` / `agent_cancel` / `agent_status` / `graph_reactivate` 都仍能触达它，
因为一个已关闭 graph 里的在飞节点必须保持可启动、可取消、可检视。

`reactivateNodes` **可以**重新激活一个**已关闭**的 graph —— 那才是真正的用例
（一个任务收尾了，随后来了一个局部变更请求）—— 这会把它重新打开（`graph.reopened`）
并使其成为活动 graph，正如一次成功的声明会做的那样，于是下一次 `graph_start` 落在正确的 graph 上。

它在调用 `graph.reactivate` **之前**捕获每个被重新激活节点的 artifact 键，
因为重新激活会清掉 `agentId`，而 artifact 轨是以 agentId 为键的；
`describeDownstream` 随后从"直接依赖 ∩ 被重新激活集合"报告 `consumedKeys`，
而这正好就是 `_startNode` 喂给一个节点作为 `inputs` 的东西，
并把更远的标为 `further downstream (via …)`，而不是编造它从未读过的键。

---

## 三条跨模块的设计立场

### 安全告诫：没有沙箱

子 Agent 通过宿主提供的工具执行命令，与 skill 系统完全一样 ——
宿主必须通过 tool provisioning 与 `hooks.beforeToolCall` 自行把关。
注意 `hooks.beforeToolCall` / `afterToolCall` / `onError` 会被转发给**每一个**子 Agent；
**那份转发是一道安全边界，不是一项便利。**

### artifact 轨是首要的跨 agent 守卫

归属记录 + 同键跨 agent 的 warn/deny，是**两个目标环境里都成立**的唯一机制 ——
浏览器既没有 git worktree 也没有 `shell_exec`。所以它的强度就是这里跨 agent 安全性的**实际上限**。

### `isolation: 'worktree'` 已搁置

仅 Node、实验性、已完整实现并有测试、代码保留，但**不是推荐路径**。
它在半数目标环境里不存在，而且它与 DAG 语义冲突：一个 DAG 节点是由一个子 Agent 跑的一个子任务，
所以按节点的 worktree 会让下游节点看到的仓库停在**它的上游做任何工作之前**的样子，
产出静默冲突的编辑。

`agent_graph` / `graph_start` 因此**刻意省略** `isolation` 参数 ——
graph 节点按设计共享同一个工作目录。其后果由 `AGENT_GRAPH_DESCRIPTION` 向模型陈述：
**两个之间没有 `depends_on` 路径的节点会在同一目录里并发运行，没有任何东西隔离它们**，
所以缺一条边是**正确性 bug**，不是调度上的不完美。

### 一个 graph 一个任务，而任务边界是 prompt 级协议 —— 刻意为之，不是疏漏

一个 graph 跟踪一个任务，并在该任务持续期间保持可变；新任务得到新 graph，
一个 Agent 可以同时持有多个。但框架无法判断用户的下一条消息是延续当前任务还是开启另一个任务：
那是语义判断，只有模型（它看得见话题转变）或带有显式"新任务"入口的宿主才拿得到。

所以协议住在 `AGENT_GRAPH_DESCRIPTION` 与 `GRAPH_CLOSE_DESCRIPTION` 里，在模型读得到的地方 ——
话题转变就是上一个任务结束的信号，而一个仍有节点未达 terminal 状态的 graph，
在 `ask_user` 问过"等它们、取消它们，还是让它们继续跑"之前不得关闭。

**没有任何东西强制它，也没有任何东西能强制它**：猜错会取消掉做到一半的工作，
那是用户的决定权；而既有的 `AskRegistry`（带归属、可乱序回答）已经是这个协议需要的机制。

### 重新激活是缓存失效，其范围是模型的决定

`graph_reactivate` 把点名的 terminal 节点送回 `blocked`，且**不**向它们的下游消费者扩散。
框架没有依据判断哪些下游结果仍然成立，所以它**报告而不行动**：
哪些节点在下游、其中哪些消费了被失效的 artifact 键、其中哪些没有被本次调用点名。

那份报告是信息性的 —— 一个被漏掉的节点保留它的旧结果，
而建在其上的每一步都继续从陈旧版本出发运行，**而且那个失败是静默的**
（graph 在一个已不再为真的答案上报告成功）。
`renderReactivation` 与 `GRAPH_REACTIVATE_DESCRIPTION` 的措辞是这样选的：
漏掉一个读起来像**一次决定**，而不是一条可以被略读过去的提示。

---

## 已知限制

1. **仅 ReAct** —— agent type 清单、轮边界注入（`_pendingInjections`）、keep-alive、
   `_toolContextExtra` 全都住在 `_reactLoop` / `_reactLoopStream` 里。
   在 `strategy: 'plan_and_execute'` 下它们都不适用：`agent` 工具仍可调用，
   但模型看不到 type 清单，而一个后台 agent 的完成通知会躺在队列里，
   直到下一次 `react` 调用（或只通过 telemetry 对宿主可见）。
   与已记录的 skill 清单限制同一形状。
2. **没有沙箱** —— 见上。
3. **artifact 轨是一套记账约定** —— 一个跳过 `artifact_write` 直接改文件的子 Agent，
   对框架来说是不可检测的。
4. **`ctx.cwd` 是建议性的** —— 宿主工具是否遵从由宿主决定。框架**刻意不重写工具参数**：
   静默重写路径会产出"看起来隔离了但其实没有"的东西，那比没有隔离更糟，因为宿主会信任它。
5. **`isolation: 'remote'` 未实现** —— 协议与传输注册表就位，但没有随附任何非 local 的 A2A 传输，
   所以 `agent` 工具在它上面软失败。
6. **被保留的 worktree 会留下 `.git/worktrees/<name>` 管理条目**，跨运行累积。
   宿主应自行执行 `git worktree prune`；框架刻意不做，因为 prune 是仓库级的，
   会伸到本 SDK 自己的 worktree 之外。
7. **父级 memory 没有 `runtimeHistory` 时历史搜索会退化** —— runtime 回退到一个私有的
   `RuntimeHistory`，而 `history_search` 会在结果里**说明这一点**，而不是假装搜了父级的历史。
8. **`statusTable()` 不渲染 `generation`** —— 一个处于第二次运行的节点看起来与第一次完全相同。
   该字段在 `snapshot()` 里，所以宿主读得到，但模型看向 graph 的唯一窗口不显示它。
   放着不管是为了不改动既有的渲染契约；如果模型确实把一次重跑误读成新工作，
   这里是最便宜的修复点。
9. **`GraphEntry.label` 没有唯一性约束** —— `agent_graph({ label })` 选中**第一个**标签匹配的
   **打开的** graph（`resolveDeclareTarget`），所以两个 graph 可以带同一个 label，
   而第二个按 label 不可达。要让 `label` 成为稳定的任务键，就得在 `newGraph` 里强制它。
10. **一次重跑写同一个 artifact 键会撞上既有的冲突策略** ——
    重新激活刻意不动 artifact 轨（旧记录保留，所以重跑可以与它们对比），
    于是在 `artifacts.policy: 'deny'` 下，一次重跑可能在**它自己的键**上被拒，
    因为上一代记录属于另一个 agent。这是既有语义，未被重新激活改变，但这个**组合**是新的。

---

## 相关测试

- `agents/*.test.js` — 各单元：`types` / `contract` / `handle` / `registry` / `runner` /
  `graph`（+ fast-check 下的 `graph.property.test.js`）/ `graph-tools` /
  `graph-multi`（多图容器：按 graph 的 `node_id` 命名空间、跨 graph 的 `hasInFlight`、
  按 graph 的回调绑定、已关闭 graph 的 FIFO 逐出）/
  `graph-lifecycle`（跨 graph 的 `pendingNodeCount`、两种 disposition 下的 `graph_close`、
  含 generation 守卫的节点重新激活 —— 防被抛弃 agent 的陈旧迟到报告）/
  `mailbox` / `a2a` / `ask` / `artifacts` / `history-search` / `mirror` / `isolation` /
  `tools` / `errors` / `models`
- `agents/index.test.js` — 公开导出边界契约
- Agent 侧接线测试见 [subagents-wiring.md](subagents-wiring.md#相关测试)

## 来源

- `CLAUDE.md` Supporting modules 的 `agents/` 条目（2026-09-07 精简前的版本，含 `attemptTimeoutMs` 增补）
