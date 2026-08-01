# Changelog

本文件记录 `lll-web-agent` 的显著变更。格式大致遵循 [Keep a Changelog](https://keepachangelog.com/)。

## 0.9.0（未发布）

### 新增

- **Subagent 系统**（`src/agents/`）：把一个明确、单一、描述完整的任务派给一个独立
  的 `Agent` 实例去做，主 agent 只收结论。补的是单 agent 运行时的老洞：要"读 8 个
  文件后给个结论"，主 agent 必须把全部中间产物吃进自己的上下文，压缩一次就丢一批
  事实。subagent 经一个普通 `Tool_Def`（`agent` 工具）暴露给模型，因此自动获得
  `ToolFilter` / `ContextManager` / telemetry 的既有处理。零新增 runtime 依赖。

  - **Agent as Tool**：10 个元工具，仅在配置 `opts.subagents` 后注入，全部经
    `registerBaseTool()` 注册为 base tool（否则开启 `enableIntentRecognition` 时
    `ToolFilter` 会把它们裁掉，而 system prompt 里的类型清单还在宣传它们——`skill`
    已经踩过这个坑）：`agent` / `agent_status` / `agent_cancel` / `agent_graph` /
    `graph_start` / `send_message` / `artifact_write` / `artifact_list` /
    `history_search` / `history_get`。新导出常量 `SUBAGENT_TOOL_NAMES`。
  - **Agent_Type 注册表**：`registerAgentType` / `getAgentType` / `listAgentTypes` /
    `unregisterAgentType` / `resetAgentTypes`，加上 `AGENT_TYPE_NAME_RE` 与
    `INITIAL_AGENT_TYPES`。内置 `general-purpose` 保留不可覆盖（与保留 MCP
    transport 名、保留 skill provider 类型同一策略）。类型清单每轮合并进 system
    消息，模型因此知道 `subagent_type` 能填什么。
  - **结构化结果与按类重试**：终态渲染成头部机器可读、正文人可读的 `Agent_Result`
    字符串。`failureKind` 为 `rate_limited` / `llm_error` / `network` / `timeout`
    时自动重试（默认 `maxAttempts: 3`，退避 `min(2^attempt·1000, 8000)ms`）；
    `max_rounds` / `tool_error` / `aborted` / `depth_exceeded` 不重试，直接作为
    结构化失败回给主 agent 定夺（换模型重发、缩小范围重发、或跳过继续）。重试起的是
    **同一份契约上的全新实例**，不续用失败实例被污染的 memory。契约缺字段、
    `subagent_type` 未注册、worktree 不可用等情况在创建实例**之前**就以一句可纠正的
    话软失败，不产生 handle、不计入重试。
  - **DAG 惰性调度**：`agent_graph` 只声明与排队，**不创建任何实例** ——
    `blocked` / `ready` / `awaiting_confirm` 的节点没有 handle、没有子 `Agent`、
    不占并发槽。默认路径下节点就绪时框架不启动它，而是把上游产物交回主 agent，由它
    看过实际产出后再用 `graph_start` 写最终契约（`on_ready: 'auto'` 是"活儿事先就
    定死了"的后门）。声明时做 Kahn 环检测，有环整批拒绝。并发槽**按 depth 分层**，
    否则父辈同步派孙辈会死锁。
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
    `graph.callback.error`；`artifact.write` / `artifact.conflict`；`ask.user` /
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

**`retry.attemptTimeoutMs` 目前是死配置** —— `agent.js` 有文档、`runtime.js` 有默认值，
但没有任何代码读它，**单次 attempt 超时并未被强制**。一个卡在挂死工具调用上的子 agent
只受 `maxRounds` 与调用方 `signal` 约束。请不要依赖这个选项。同一批里还有
**`Agent_Type.maxAttempts` 取不到效**：`runtime.js` 总会填上 `opts.retry.maxAttempts`
（默认 3），类型上那个值永远轮不到，实际生效的只有 `subagents.retry.maxAttempts`。

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
