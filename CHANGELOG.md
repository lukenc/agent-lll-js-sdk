# Changelog

本文件记录 `lll-web-agent` 的显著变更。格式大致遵循 [Keep a Changelog](https://keepachangelog.com/)。

## 0.9.0（未发布）

### 新增

- **Subagent 系统**（`src/agents/`）：把一个明确、单一、描述完整的任务派给一个独立
  的 `Agent` 实例去做，主 agent 只收结论。补的是单 agent 运行时的老洞：要"读 8 个
  文件后给个结论"，主 agent 必须把全部中间产物吃进自己的上下文，压缩一次就丢一批
  事实。subagent 经一个普通 `Tool_Def`（`agent` 工具）暴露给模型，因此自动获得
  `ToolFilter` / `ContextManager` / telemetry 的既有处理。零新增 runtime 依赖。

  - **Agent as Tool**：12 个元工具，仅在配置 `opts.subagents` 后注入，全部经
    `registerBaseTool()` 注册为 base tool（否则开启 `enableIntentRecognition` 时
    `ToolFilter` 会把它们裁掉，而 system prompt 里的类型清单还在宣传它们——`skill`
    已经踩过这个坑）：`agent` / `agent_status` / `agent_cancel` / `agent_graph` /
    `graph_start` / `graph_close` / `graph_reactivate` / `send_message` /
    `artifact_write` / `artifact_list` / `history_search` / `history_get`。新导出常量
    `SUBAGENT_TOOL_NAMES`。
  - **Agent_Type 注册表**：`registerAgentType` / `getAgentType` / `listAgentTypes` /
    `unregisterAgentType` / `resetAgentTypes`，加上 `AGENT_TYPE_NAME_RE` 与
    `INITIAL_AGENT_TYPES`。内置 `general-purpose` 保留不可覆盖（与保留 MCP
    transport 名、保留 skill provider 类型同一策略）。类型清单每轮合并进 system
    消息，模型因此知道 `subagent_type` 能填什么。
  - **结构化结果与按类重试**：终态渲染成头部机器可读、正文人可读的 `Agent_Result`
    字符串。`failureKind` 为 `rate_limited` / `llm_error` / `network` / `timeout`
    时自动重试，退避 `min(2^attempt·1000, 8000)ms`；`maxAttempts` 优先级
    `subagents.retry.maxAttempts` > `Agent_Type.maxAttempts` > 默认 `3`。
    `max_rounds` / `tool_error` / `aborted` / `depth_exceeded` 不重试，直接作为
    结构化失败回给主 agent 定夺（换模型重发、缩小范围重发、或跳过继续）。重试起的是
    **同一份契约上的全新实例**，不续用失败实例被污染的 memory。契约缺字段、
    `subagent_type` 未注册、worktree 不可用等情况在创建实例**之前**就以一句可纠正的
    话软失败，不产生 handle、不计入重试。
  - **DAG 惰性调度**：`agent_graph` 只声明与排队，**不创建任何实例** ——
    `blocked` / `awaiting_confirm` 的节点没有 handle、没有子 `Agent`、
    不占并发槽。默认路径下节点就绪时框架不启动它，而是把上游产物交回主 agent，由它
    看过实际产出后再用 `graph_start` 写最终契约（`on_ready: 'auto'` 是"活儿事先就
    定死了"的后门）。声明时做 Kahn 环检测，有环整批拒绝。并发槽**按 depth 分层**，
    否则父辈同步派孙辈会死锁。
  - **图按任务划分（多图共存）**：图跟的是**任务**而不是 `Agent` 实例 —— 同一任务始终
    往同一张图里加节点、图可以一直改，任务变了就换一张新图，因此一个主 agent 可以同时
    持有多张图。`node_id` 的唯一性随之收窄到**图级**：单图时代第二个任务复用 `n1` 会被
    判重复、整批声明被拒，那是个真实缺陷。四个图工具（`agent_graph` / `graph_start` /
    `graph_close` / `graph_reactivate`）与 `agent_cancel` / `agent_status` 都新增可选
    `graph_id`（省略 = 当前在用的那张图）；`agent_graph` 另有 `label`（任务名，同名接着
    加、换名开新图），`agent_status({ graph_id: 'all' })` 列出全部图含已关闭的。
    `graphId` 形如 `gph_00000001`（单调计数器，**不混时间位**）。容器是惰性的：
    `activeGraphId` 与 `agent.subagents.graph` 起手都是 `null`（见"消费方注意"）。
  - **图生命周期与弃图协议**：新工具 `graph_close({ graph_id?, disposition, reason? })`
    —— `'cancel_outstanding'` 把每个未走到终态的节点过一遍取消路径（连它挂在 `ask_user`
    上的提问一起结算），`'keep_running'` 只把图关掉不再收新节点、在飞 agent 继续跑完。
    `retainClosedGraphs`（默认 `5`）按 FIFO 整张淘汰多余的已关闭图，但**永不淘汰还有在飞
    节点的图**。已关闭的图只有**声明**被拦，`graph_start` / `agent_cancel` /
    `agent_status` / `graph_reactivate` 照旧可达 —— 里面还在飞的节点必须仍能启动、取消、
    查看。**"任务结束了"这个判断只在 prompt 里**，框架不强制也无法强制，详见"消费方注意"。
  - **节点重新激活（缓存失效）**：新工具
    `graph_reactivate({ graph_id?, node_ids, reason? })` 把点名的**终态**节点送回
    `blocked`（清空 `agentId` / `result` / `error`，自增该节点的 `generation`，保留
    `prompt`），由主 agent 用 `graph_start` 写新契约；已关闭的图也可激活，激活会重新把它
    置为 open 并成为在用的那张图。**框架不自动扩散到下游**：失效范围由模型决定，但返回值
    会列出下游有哪些节点、其中哪些读过刚被作废的产物 key、以及这些里哪些没被本次点名。
    图内新增 `generation` 令牌挡一处 ABA：一个被取消（终态）而 agent 仍在跑的节点被重新
    激活后，旧那一轮 agent 的迟到回报会穿过"终态不被复活"的守卫，把陈旧结果写回并放行本该
    重跑的下游；回报带回启动时捕获的 generation，对不上就丢弃并发
    `graph.node.stale_report`。
  - **不打断的消息投递**：`Agent#enqueueMessage(message)` 与轮边界排空。后台 agent
    终态通知、图节点就绪通知、`send_message` 投递三者共用这一个机制，一律只在 ReAct
    轮边界汇入上下文，**绝不打断正在执行的工具**。选在轮边界是因为那时上一轮的
    `assistant(tool_calls)` 与全部 `tool` 结果消息已经成对落盘，插入 `user` 消息不会
    破坏 `memory-policy.js` 依赖的工具调用配对不变量。
  - **多路提问路由**：多个 agent 可同时提问，每个问题带 `askId` 与归属，回答定向送回
    提问者，主机可乱序回答。`Agent#pendingQuestions()` /
    `answerQuestion(askId, answer)` / `cancelQuestion(askId, reason)`。
  - **产物轨**：`artifact_write` 把产出登记到共享 `RuntimeHistory` 的 `artifacts`
    轨（只追加不覆盖），同 `key` 被他人覆盖时按 `artifacts.policy` 告警（`'warn'`
    默认）或拒绝（`'deny'`）。`Agent#getArtifacts()` 新增可选 `{ agentId }` 过滤。
  - **记忆找回**：`history_search` / `history_get` 检索共享轨上的**原始事件**，
    因此被 `SummarizingMemory` 压缩掉的内容照样能捞回来。子 agent 的消息单向镜像进
    父 `RuntimeHistory` 的 `internal` / `agent:<id>` 轨，**不进 `model` 轨**，
    不污染主 agent 的对话投影。`memory.js` 零改动。
  - **A2A 协议**：JSON-RPC 2.0 形状的 Envelope + transport 注册表
    （`registerA2ATransport` / `RESERVED_A2A_TRANSPORTS`）。v1 只实现进程内
    `local`，但即使无需序列化也走一遍 encode/decode，让形状错误在本地就暴露。
  - **模型别名**：默认 `fast`（父 `simpleModel` 三件套）与 `main`（父 `model` 三件套）。
    `agent` / `graph_start` 的 `model` 参数 enum 在工具注入时由别名表的键生成，不写死
    型号；每个别名可独立指定 `apiKey` / `url`，因此快模型可跨供应商。
  - **`ctx` 扩展**：`tool.execute(args, ctx)` 的第二参从 `{ signal }` 扩展为
    `{ signal, cwd, agentId, agentName, depth }`。主 agent 的 `cwd` 恒为 `null`。
  - **生命周期**：`Agent#closeSubagents()` 取消全部在跑 agent、reject 全部待答提问
    （避免悬挂 Promise 卡住进程退出）、清理未改动的 worktree；`reset()` 已包含它。
    **后台 agent 不随 `chat()` 返回而终止**，CLI 类主机应在退出前显式调用它。
  - **新增事件**：`agent.spawn` / `agent.state` / `agent.retry` / `agent.succeeded` /
    `agent.failed` / `agent.cancelled`；`graph.declared` / `graph.node.ready` /
    `graph.node.auto_start` / `graph.node.started` / `graph.node.settled` /
    `graph.node.blocked` / `graph.node.skipped` / `graph.node.cancelled` /
    `graph.callback.error`；多图与生命周期另有 `graph.opened` / `graph.closed` /
    `graph.reopened` / `graph.evicted` / `graph.reactivated` /
    `graph.node.reactivated` / `graph.node.stale_report`（`graph.closed` 的 payload 含
    `disposition` 与 `cancelled` / `stoppedAgents` / `outstanding` 三个**计数**）；
    `artifact.write` / `artifact.conflict`；`ask.user` /
    `ask.answered` / `ask.cancelled`；`a2a.delivered`。子 agent 内部的 `llm.call` /
    `tool.call` / `round.*` 原样转发到父 bus，仅追加 `agentId` / `parentAgentId` /
    `agentName`，主机注册一个监听器即可看到整棵树。
  - **新增错误类**：`SubagentError` / `AgentTypeError` / `AgentGraphError` /
    `A2AError` / `WorktreeIsolationError`。构造函数只接受白名单标量字段（照
    `mcp/errors.js`），apiKey 不会漏进 `err.message`。
  - **`isolation: 'worktree'`（Node-only，已搁置为实验特性）**：实现完整、有测试覆盖、
    代码保留，但**不作为推荐的隔离路径**，详见下方"消费方注意"。

- **Subagent keep-alive**（`opts.subagents.keepAlive`，默认开启）：还有后台
  subagent 或图节点在飞时，模型给出的"无工具调用的最终回答"不再立刻收尾本轮，
  而是等下一个 subagent 事件回来、把结果带进上下文让模型继续决策。补的是这个
  洞：编排者派出三个后台 agent 并说"我等它们回来"，ReAct 循环却在这句话之后
  立即返回，结果回来时已经没人读了。轮次仍受 `maxRounds` 约束。
  - `opts.subagents.keepAliveTimeoutMs`（默认 `600000`）——单次等待上限。
  - `Agent#lastKeepAliveTimedOut`（boolean）——最近一次运行是否在还有后台工作
    未完成时放弃了等待。**每轮对话最多超时一次**：超时后会给模型留一条"收尾或
    `agent_cancel`"的提示，此后的最终回答直接收尾，不再重复等待。
  - 新增事件 `run.keep_alive.timeout`，payload
    `{ pendingAgents, pendingNodes, waitedMs }`。
  - `keepAlive: false` 可完全关闭该等待，恢复"最终回答一律立刻收尾"的旧行为；
    未配置 `opts.subagents` 时行为与旧版本逐字节一致。
  - **`Agent#lastStopReason` 的取值集合未扩张**（仍为 `null` | `'completed'` |
    `'max_rounds'`，跨包契约）——keep-alive 超时经上面那面独立的旗子与事件浮出，
    不新增枚举值，现有消费方无需改动。

- **Skill 系统**（`src/skills/`）：兼容 Claude Code 格式的 skill 包（`SKILL.md` +
  `scripts/` / `references/` 等捆绑文件），可从本地目录或 HTTP manifest 加载。
  Level 1 清单自动注入 system prompt，内置 `skill` 元工具按需注入正文（Level 2），
  浏览器运行时新增 `skill_resource` 工具读取捆绑资源（Level 3），并提供基于 LLM
  的 Top-K `SkillFilter`（fail-open）应对超阈值的大规模 skill 集合。零新增
  runtime 依赖。

### 向后兼容性

- **未配置 `opts.subagents` 时行为与旧版本逐字节一致**：`agent.subagents` 恒为
  `null`，不注入任何工具、不改 `BASE_TOOLS`、不发任何新事件，`_withSubagentTypesNote`
  原样返回入参（连引用身份都不变），`reset()` 不多创建一个 Promise。
- **`hooks.onAskUser` 的单参数写法继续可用**。签名扩展为
  `onAskUser(question, meta)`，JS 忽略多余实参，旧 hook 无需改动。注入条件从
  `hooks.onAskUser` 放宽为 `hooks.onAskUser || opts.subagents`（主机可以只用
  `pendingQuestions()` / `answerQuestion()` 这条命令式通道而不提供 hook）。
- **`Agent#lastStopReason` 的取值集合未变**（`null` | `'completed'` |
  `'max_rounds'`）。
- **`tool.execute(args, ctx)` 的既有工具无需改动** —— `ctx` 多出的
  `cwd` / `agentId` / `agentName` / `depth` 对不读它们的工具无影响。
- **`getArtifacts()` 无参调用行为不变**，新增的 `{ agentId }` 是可选过滤。
- **`BASE_TOOLS` 的运行时 CRUD 语义不变** —— 元工具经 `registerBaseTool()` 加入，
  因此 `resetBaseTools()` 之后需要重新构造 `Agent` 才会重新注册（与 `skill` 现状
  一致）。
- **`memory.js` / `tool.js` / `context-manager.js` / `plan-and-execute.js` 零改动。**

### 消费方注意

**Agent_Type 注册表是进程级全局的**，与 `BASE_TOOLS` 同。多个 `Agent` 实例共享同一张
表，`opts.subagents.types` 里的类型是**追加注册**而非实例私有；`resetAgentTypes()` 会
把它清回内置类型，进而影响所有实例。测试之间需要隔离时请显式调用它。

**`agent.subagents.graph` 起手是 `null`。** 图容器是惰性的（一个主 agent 可以持有多张
图，凭空建一张空图没有意义），第一次声明才建图。主机若直接读这个 getter（例如自己
`declare()`），要么先调 `agent.subagents.newGraph({ label })`，要么判空。全部图在
`agent.subagents.graphs`（`Map<graphId, GraphEntry>`）里；主机侧关图入口是
`closeGraph(graphId, { reason, disposition })`，`disposition` 缺省为 `'keep_running'`
（只标记，不动在飞的 agent）。

**"任务结束了"的判断只在 prompt 里，这是设计边界而不是遗漏。** 框架分不清用户的新消息是
同一个任务的续集还是另一个任务 —— 那是语义判断，只有看得见话题变化的模型（或有显式"新任务"
入口的主机）做得出来。所以弃图协议写在模型读得到的地方（`AGENT_GRAPH_DESCRIPTION` 与
`graph_close` 的 `Tool_Def.description`）：话题变了就是上一个任务结束的信号，而关闭一张
**仍有未完成节点**的图之前必须先用 `ask_user` 问用户（等它们跑完 / 取消掉 / 留着不管）。
框架不强制、也无法强制：猜错的代价是取消掉别人跑了一半的活，那个代价该由用户决定。要在
主机侧接这条协议，用 `pendingQuestions()` / `answerQuestion()` 那对既有 API 即可，无需
新机制。

**"还有活在飞"的判断跨全部图，含已关闭的图。** `hasInFlight()` / `hasPending()` /
`pendingNodeCount()` 都是跨图聚合 —— 一个在飞的 agent 不因为它所属的图被关掉就停止存在。
主机若自己实现类似的等待逻辑，请照此处理，否则一切换（或关闭）活跃图，就不再等旧图里还在
跑的 agent，那些结果没人接。

**重新激活不自动扩散到下游，漏掉的下游不会报错。** `graph_reactivate` 只激活点名的节点：
失效范围由模型决定，框架把"哪些下游读过刚作废的产物、其中哪些没被点名"摆到它面前，但不替它
决定。没被一并激活的下游会拿着过期认知继续跑，而且图会在一个已经不成立的答案上报成功。
另外激活**不动产物轨**（旧记录留着好做对比），所以 `artifacts.policy: 'deny'` 下重跑写同
一个 `key`、而上一代记录属于另一个 agent 时，写入会被拒 —— 既有语义，但"重跑 + deny"这个
组合是新出现的。

**已关闭的图会被 FIFO 淘汰（`retainClosedGraphs`，默认 5）。** 被淘汰的图既查不到也无法
再激活，`graph_close` 的返回文本会据实分支说明这一点。有在飞节点的图永不淘汰。

**跨 agent 安全的主方案是产物轨，不是 worktree。** 目标环境包含浏览器，那里既没有 git
worktree 也没有 `shell_exec`。产物轨（归属记录 + 同 key 跨 agent warn/deny）是唯一在
Node 与浏览器都成立、每个 agent 都能用的护栏，**这一层的强度就是这套系统跨 agent 安全
的实际上限**。同时它是**记账约定，不是强制隔离**：绕过 `artifact_write`、直接改文件的
subagent 框架检测不到。

**`isolation: 'worktree'` 是 Node-only 实验特性，已搁置，请勿把它当作隔离主方案。**
它在一半的目标环境里不存在，并且与 DAG 语义相冲突：一个 DAG 节点是一个子任务、由一个
subagent 执行，若每个 subagent 各自一个 worktree，下游节点看到的是上游动手**之前**的
仓库状态，据此产生的修改必然与上游错位且不会报错。因此 `agent_graph` / `graph_start`
**有意不提供** `isolation` 参数 —— **图节点共享工作目录是设计决策，不是缺口**，请勿
"修复"。直接后果：**两个之间没有依赖路径的图节点会并行跑在同一个目录里，底下没有任何
隔离**，所以 `depends_on` 是安全边界而不是调度提示，漏一条边是正确性问题，且不会报错。

**`ctx.cwd` 是通告，不是保证。** 主机工具认不认它由主机决定；框架**有意**不重写工具
入参，因为静默重写路径会造出"看起来隔离、实际没隔离"的错觉 —— 那比没有隔离更坏，因为
主机会信它。

**单次 attempt 没有独立超时。** 一个卡在挂死工具调用上的子 agent 只受 `maxRounds` 与
调用方 `signal` 约束；`subagents.retry` 只控制"重试几次、多久退避一次"（`maxAttempts`
优先级：`subagents.retry.maxAttempts` > `Agent_Type.maxAttempts` > 默认 `3`），不控制
"单次 attempt 能跑多久"——这是刻意留白，而非疏漏，需要单次超时请自行经 `signal` 实现。

**保留下来的 worktree 会在 `.git/worktrees/<name>` 留下管理项并逐渐累积。** 主机应自行
`git worktree prune`；框架**有意**不做，因为 prune 是仓库级操作，会碰到本 SDK 之外的
worktree。

**只在 ReAct 策略下生效**：类型清单注入、轮边界注入、keep-alive、以及 `ctx` 的归属字段
都住在 `_reactLoop` / `_reactLoopStream` 里。`strategy: 'plan_and_execute'` 下这些一概
没有 —— `agent` 工具仍可调用，但模型看不到类型清单，后台 agent 的完成通知会滞留到下一
次走 `react` 的调用，或只能经事件被主机感知。与 skill 清单注入是同一个既有限制。

**无沙箱**：subagent 经主机提供的工具执行命令，与 skill 系统同一安全模型。主机须用
工具供给 + `hooks.beforeToolCall` 自行把关。注意 `beforeToolCall` / `afterToolCall` /
`onError` 会**转发给每个子 agent** —— 这是安全边界，不是便利：不转发的话主机的工具管控
策略对子 agent 就失效了。


## 0.8.0

### 新增

- **流式响应完整性校验**：`streamChatIter` / `streamChat` 新增语义层校验——正常
  完成的 OpenAI 兼容流，最后一个内容 chunk 必须带非空 `finish_reason`；否则视为
  被服务端/代理提前截断，抛出新增的 `LlmStreamIncompleteError`（默认开启）。
  `Agent` 暴露对应的 `validateStreamCompletion` 选项（默认 `true`），设为 `false`
  可恢复旧的容忍行为，适配合法省略 `finish_reason` 的网关。`react` 与
  `plan_and_execute` 两种策略下的所有内部 LLM 调用均遵循该选项。
- **`LlmStreamIncompleteError`**：新导出的错误类，`name` 固定为
  `'LlmStreamIncompleteError'`（跨包契约，见下方"消费方注意"）；零 chunk 流恒
  抛出，不受 `validateStreamCompletion` 影响。
- **`done` 事件携带结构化 `stopReason`**：`agent.stream()` 的 `done` 事件新增
  `stopReason`（`'completed'` | `'max_rounds'`）与轮次耗尽时的 `rounds` 字段，
  消费方不再需要用哨兵字符串 `'[max rounds exceeded]'` 做字符串匹配（该哨兵仍
  保留以兼容旧消费方）。`Agent#lastStopReason` 属性同步反映最近一次 `react`
  策略运行的结束原因。
- **重试策略对齐 openai-node / anthropic-sdk**：`withRetry` / `isRetryableError`
  重试 408/409/429/5xx 与网络层错误（undici 的 `TypeError: fetch failed` /
  `terminated`，或带 `.cause` 的 `TypeError`）；4xx 其余状态码、`AbortError`、
  以及流开始后的截断（`LlmStreamIncompleteError`，部分数据已交付消费方，重放
  不安全）不重试。退避采用 `min(baseDelayMs·2^attempt, 8s)` 乘 `[0.75, 1.0]`
  减法抖动；服务端 `Retry-After-Ms` / `Retry-After` 响应头优先，钳制到 60s。

### 修复

- `validateStreamCompletion: false` 现在对 `plan_and_execute` 策略的所有内部
  LLM 调用（planner / replan / synthesizer / 单步 ReAct）同样生效——此前仅
  `_reactLoopStream` 收到该选项，`plan_and_execute` 下这个逃生舱其实是失效的。
- `isRetryableError` 不再无脑重试任意 `TypeError`。收窄为"网络形状"的
  `TypeError`（消息含 `fetch failed` / `terminated`，或带 `.cause`），避免把
  被重试闭包内部的确定性程序员错误（例如 `JSON.stringify(BigInt)`）也当成
  网络抖动重试 ~7s。
- `Agent#lastStopReason` 不再在切换到 `plan_and_execute` 策略后残留上一次
  `react` 运行的值——重置时机从循环内部（`_reactLoop` / `_reactLoopStream`）
  移到会话入口（`_runWithSession` / `_runWithSessionStream`），覆盖全部四条
  `chat()`/`stream()` × `react`/`plan_and_execute` 路径。

### 消费方注意

`LlmStreamIncompleteError` 通过 `err.name === 'LlmStreamIncompleteError'`
识别，而非 `instanceof`——跨包场景（例如 symlink 安装）下 `instanceof` 可能因
双份 class 身份而失效，`.name` 更可靠。重命名该字符串会破坏下游消费方，请勿
无预警变更。
