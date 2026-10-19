# Changelog

本文件记录 `lll-web-agent` 的显著变更。格式大致遵循 [Keep a Changelog](https://keepachangelog.com/)。

## Unreleased

### 新增

- **多模态（图片输入）** —— `new Agent({ vision: true })` 后 `chat()` / `stream()` 接受 OpenAI
  content parts；工具用 `contentResult([...])` 返回图片；新导出 `imagePart`、`contentResult`、
  `isContentResult`、`contentText`、`UnsupportedContentError`、`InvalidContentError`；新选项
  `simpleVision`、`imageLimits`、`maxImageBytes`、`imageTokenEstimator`、`unknownImageTokens`；
  新供应商 `xiaomi`（小米 MiMo）。见 `docs/design/multimodal.md`。
- **`Agent#followup(opts?)`** —— 把积压的待投递通知跑成一轮（空闲的父 agent 得到
  一次普通轮次）。**队列为空时返回 `null` 且不发任何请求** —— 空转一次 LLM 调用是纯烧
  token，而"没有待投递内容"是常态而非异常。这一轮**不补回** keep-alive 等待预算（内部以
  `_frameworkAuthored: true` 走 `chat()`）：它是框架自己开的轮次，消息也是框架自己排进
  队列的通知 —— 框架自己排进队列的通知不能回填它刚刚花掉的预算，所以回填只认用户
  自撰的输入。
- **`opts.subagents.maxConsecutiveWakes`（默认 `3`）** —— keep-alive 的等待预算，
  回填只发生在用户自撰输入上。非法取值（`0`、负数、非整数、`Infinity`、非 number）在**构造期**抛
  `TypeError`，不留到调用期 —— 留到调用期抛的话，一次本来成功的等待会变成整个 run 报错；
  配置错误应该让初始化失败，而不是让运行中的业务失败（与 `spill.maxToolResultBytes`
  同一先例）。计数器 `_spentKeepAliveWakes` 在 `Agent` 上，配置在 runtime 上。
- **`opts.subagents.retry.attemptTimeoutMs`（默认 `600000`）与 `Agent_Type.attemptTimeoutMs`**
  —— 单次 attempt 的截止时间。到点即 abort 与调用方 signal 融合后的那一个 signal，异常被
  分类成 `failureKind: 'timeout'`，而 `timeout` 本来就在 `RETRYABLE_KINDS` 里，因此按
  `maxAttempts` 自动重试（每次 attempt 各融一张新表，互不影响）。优先级与 `maxAttempts`
  同形：`subagents.retry.attemptTimeoutMs` > `Agent_Type.attemptTimeoutMs` > 默认值，
  且**默认值只在 runner 的回退链里解析一次** —— `runtime.js` 不 eager 回填 `retry`，
  否则类型级配置不可达（`maxAttempts` 已经踩过一次这个坑）。非法取值（`0`、负数、非整数、
  `Infinity`、非 number）在**构造期**抛 `TypeError`；`null` = 显式不设截止（与
  `ask.timeoutMs` 默认 `null` 同一拼法）。机制是 signal 融合、先到者胜、构造期校验；
  **不用 `AbortSignal.any` 也不用 `using`/`Symbol.dispose`** —— 支持下限是 Node 18
  且不做转译，`AbortSignal.any` 是 20.3.0+，仓内先例是 `mcp/transports/sse.js` 的
  `combineSignals`。两处**有意**的取舍：`Infinity` 是构造期报错而不是"不设界"的
  写法（不设界正是这个字段存在的理由所要防的失败形态），以及一次跑完的 attempt 即使与
  截止时刻擦肩也**照收**（丢弃超时结果只在结果可能是被掐断的半截输出时才合理，而这里
  手里是完整报告 —— 丢掉它去重跑是纯烧 token）。
- **新事件 `run.wakeup`** —— `enqueueMessage` 在**没有 run 在跑**（`_currentRun == null`）
  时发出，payload `{ pendingInjections, inFlightAgents }`。宿主据此决定要不要再跑一轮
  （典型接法：`agent.on('run.wakeup', () => agent.followup())`）。SDK 不自行开轮：一次新
  轮要不要惊动用户、要不要走宿主的流式渲染，是宿主的决定。run 正在进行时不发，那条通知
  会由轮边界的 drain 或 keep-alive 接走。
- **新事件 `run.keep_alive.gave_up`** —— 等待预算耗尽、仍有工作在飞时发出，payload
  `{ spent, budget, pendingAgents, pendingNodes, inFlight }`。`inFlight` 是全部在飞
  handle 的 `toStatus()` 快照（无函数字段、无 apiKey），它是宿主决定"要不要关、要不要
  告诉用户"的唯一依据；`pendingNodes` 跨**全部**图（含 closed），与超时提示同一口径。

### 行为变更

- **MCP 工具返回 png/jpeg/webp/gif 图片时**，结果从 `[mcp:image mimeType=…]` 占位字符串变为
  `contentResult`。`vision: false` 的 Agent 上这次工具调用会以 `unsupported_content` 失败
  （此前模型只看到占位文字）。宿主若依赖旧行为，需开启 `vision` 或不挂载返回图片的 MCP 工具。
- 流式 `tool_end.result` 与 `hooks.afterToolCall` 的 `result` 在工具返回图片时是 contentResult
  对象（`{ type: 'content_result', parts }`），不再一定是字符串。
- `tool.call` 事件的 `bytes` 对带图结果只计文本部分，并新增可选字段 `imageCount`。

### 变更

- **`Agent#lastKeepAliveTimedOut` 保留，但降级为纯告知旗子 —— 它不再闸住任何行为。**
  0.9.0 里 `_keepAliveOnce()` 拿它当"本 run 不再等第二次"的粘性闸门；现在闸门换成了
  `_spentKeepAliveWakes` 计数对 `maxConsecutiveWakes` 的比较。字段仍在第一次超时时置位、
  仍按 run 重置，订阅它的宿主不会中断，但**别再拿它做控制流判断**。行为差异：一次 run 内
  不再是"最多超时一次"，而是最多 `maxConsecutiveWakes` 次**白等**；显式配
  `maxConsecutiveWakes: 1` 可逐条复现旧的时间线。
- **等待预算数的是"白等"，不是"等待"。** 被事件唤醒（真有结果回来）既不花预算也不补预算
  —— 那一次等待买到了东西，把它算进"该放弃了"的证据里等于惩罚一个正在正常推进的 run；
  而允许事件补预算的话，一个不断 settle 的流就能让计数永远归零，交错出现的挂死子 agent
  于是把 run 拖到 `maxRounds` 耗尽。补回预算的只有用户亲手输入的新一轮（`chat()` /
  `stream()` 入口），以及 `reset()`。
- **`_keepAliveOnce()` 的三道判断重排**：待注入消息 → `hasInFlight()` → 预算。在飞判断
  必须在预算判断**之前**，否则一次干净收尾（没有东西在飞）也会发 `run.keep_alive.gave_up`，
  那是在谎报"我们丢下了工作"。待注入判断必须在最前面，因为预算约束的是**等待**而不是
  **投递**：预算耗尽也照样接住迟到的通知。
- **round 0 也排空待注入队列**（`_mergePendingIntoUserMessage`）。此前 `_drainPendingInjections()`
  只在 `round > 0` 跑。合并为**一条** user 消息而不是追加一条（通知在前、用户消息在后）：
  两条相邻的 user 会被部分供应商拒绝，与既有 `INJECTION_MERGE_THRESHOLD` 同一理由。写进
  memory 的是合并后的文本，而传给 `_runPipeline` 的 `userMessage` 仍是用户原话 —— 意图
  识别与 `SkillFilter` 看的是用户真实意图，一段框架自己写的 `<agent-notification>` 不该
  参与那个判断。队列为空时逐字节等同旧行为。

### 修复

- **空闲期到达的后台通知此前没有任何投递路径。** 这是"派一个慢任务、下轮再收结果"之所以
  不成立的**根因**，比表面症状深一层：`_drainPendingInjections()` 只在 `round > 0` 发生，
  而 `_signalEvent()` 只叫醒**已经**阻塞在 `nextEvent()` 上的等待方。于是一条在没有 run
  在跑时到达的完成通知入队成功，下一次 run 的 round 0 不看它，而那次 run 若只有一轮
  （模型直接给最终回答，这是最常见的情况），就再也不会有 round 1 —— 通知永久搁浅。用
  **持久 Agent 实例**且 **`keepAlive: false`** 同样复现，因此与粘性闸门、与 runtime 是否
  per-instance 都无关。现在由三条路径覆盖：round 0 合并、`run.wakeup`、`followup()`。
- **keep-alive 超时一次即永久放弃等待，run 在仍有子 agent 在飞时对外报
  `stopReason:'completed'`。** 模型说一句"任务重，我继续等通知"（这是它的合理推断：工具
  描述刚承诺过 "you will be notified when one completes"），整个 run 就地终止，在飞的
  子 agent 既不被取消也不被等待。等待预算该约束的是**再叫醒一次**，而不是**要不要等**
  —— 一次超时就永久关掉等待，正是缺陷本体。现在换成有界的等待
  预算，耗尽时发事件、附在飞清单，**且不取消在飞工作**（取消只发生在显式关闭时）。
- **`Agent#lastStopReason` 的取值集合仍未扩张**（`null` | `'completed'` |
  `'max_rounds'`，跨包契约）。
  让 `'completed'` 诚实的不是换一个枚举值，而是上面那条投递路径：结束本轮不再是弃置工作。
- **一个卡死的子 agent 此前没有任何时间上界，0.9.0 把这件事追认成了"刻意留白"。**
  那段话（见 0.9.0「消费方注意」）写的是"只受 `maxRounds` 与调用方 `signal` 约束"——
  而 `maxRounds` 数的是**轮**：一轮永不返回就永远不递增，所以那个界根本不存在。后果有
  三层，一层比一层贵：`run_in_background: false` 时父 agent 的那次 `agent` 工具调用
  **无上界地** await 下去（keep-alive 管不着它 —— 它压根没走到"最终回答"那个分支），
  于是父 run 整个挂死；后台派发时挂死的子 agent 永久占着它那一个 depth 层的并发槽，
  默认 `maxConcurrent: 4` 下四个就把池坐死，此后同层派活全部排队；而
  `classifyFailure` 的 `'timeout'` 分支与 `RETRYABLE_KINDS.has('timeout')` 从 0.9.0 起
  就是**死代码**——设计好的"超时→重试"这条路一次也没被触发过。现在由
  `retry.attemptTimeoutMs` 补上（见「新增」）。
  界之所以设在单次 attempt 上而不是更细的流读取空闲上：子 agent 走非流式
  `syncChat`，一次 `await` 就是一整段黑盒，没有"空闲"可观测。

- **注入 `ask_user` 时不再顶替宿主已提供的同名工具**（0.9.0 引入的回归）。此前只要配置了
  `opts.subagents`，构造函数就会无条件把 `tools` 里名为 `ask_user` 的宿主工具过滤掉，换成
  SDK 那个只有单个 `question` 字符串参数的版本。代价是静默的、且没有恢复路径：

  1. 宿主精心做的富 schema（典型形态 `questions: [{ question, options }]`）连同它那条真能
     到达用户界面的通道（IPC / 弹窗）一起消失，模型看到的参数退化成一个字符串；
  2. SDK 版在宿主**只配了 `subagents` 而没接 `hooks.onAskUser`** 时没有任何送达通道 ——
     问题登记进 `AskRegistry` 后既无 hook 可通知、宿主也不知道要调 `answerQuestion`，而
     `ask.timeoutMs` 默认 `null`（永不超时），于是那次工具调用**永久挂起**。表象是流上几
     分钟没有任何事件后被宿主看门狗掐断，看起来像网络故障。

  现在改为**包装而非替换**：宿主工具的 `description` / `parameters` 原样保留（模型看到的
  仍是宿主那张 schema），其 `execute` 成为该次提问的送达通道（作为 `AskRegistry.ask` 的
  逐问 `notify` 传入），SDK 只在外层补登记 —— 归属标注、`pendingQuestions()`、
  `answerQuestion` / `cancelQuestion` / `agent_cancel` / `closeSubagents()` 对宿主的提问
  同样有效。子 agent 经 `FLOOR_TOOLS` 继承同一条通道，提问带子 agent 自己的归属。

  实现细节：包装体带 `Symbol.for('lll.askUser.wrapped')` 标记 —— 子 agent 继承的是**父**
  的（已包装的）闭包，而子 `Agent` 的构造会再次进入注入分支，没有这个标记就会二次包装，
  同一次提问登记进两张表，命令式通道只答得掉外层那条，内层永远留在父表里成为答不掉的幽灵
  提问。`notify` **取代**而非叠加 `hooks.onAskUser`（两者都是"把问题送到用户面前"，同时
  触发等于一个问题弹两次窗）。宿主返回值不经 `String()`，字符串化仍由 `tool.js` 负责。

### 消费方注意

**"派慢任务、下一轮收结果"现在成立了，但宿主必须接一条叫醒通道。** 预算耗尽或
`keepAlive: false` 时本轮会收尾，结果躺在 `_pendingInjections` 里，送达靠三条路径之一：
下一次 `chat()` / `stream()` 的 round 0 合并（用户又说话了，自动生效）、或宿主订阅
`run.wakeup` 后调 `agent.followup()`（用户没说话，需要宿主主动开一轮）。只订阅事件不调
`followup()`，通知会一直等到用户下次开口。**推荐配置**：`keepAlive: false` + 订阅
`run.wakeup` + 调 `followup()` —— 不在轮内干等，而是结束本轮、稍后
叫醒，也避免流式宿主在 keep-alive 等待期间看不到任何 chunk。

**放弃等待 ≠ 放弃工作。** `run.keep_alive.gave_up` 之后在飞的子 agent 仍在跑，SDK 不会
替你取消（报告 §10 建议 #7 的"run 结束时自动 `closeSubagents()`"因此**未采纳** —— 那恰好
会杀掉它自己 §7 最想要的"派慢任务、下轮收结果"）。要真的停下来，宿主自己调
`closeSubagents()`，或让模型调 `agent_cancel`（超时提示里已经这么告诉它了）。

**`Agent#lastKeepAliveTimedOut` 别再拿来做控制流判断。** 它是 0.9.0 那道粘性闸门的残留，
如今只负责告知"最近一次 run 是否等超时过"，闸门换成了 `maxConsecutiveWakes` 计数。0.9.0
的 CHANGELOG 与 README 都写着"每轮对话最多超时一次"，那句话在本次改动之后**不再成立**；
需要旧时间线的宿主显式配 `maxConsecutiveWakes: 1` 即可逐条复现。

**0.9.0「消费方注意」里"单次 attempt 没有独立超时……这是刻意留白，而非疏漏，需要单次超时
请自行经 `signal` 实现"这段话不再成立** —— 它描述的正是本次修掉的缺陷（见「修复」）。
现在的行为与那段话有三处实质差别，配置过的宿主需要重新过一遍：

1. **最坏墙钟变了。** 一个跑不完的 attempt 的上界是 `maxAttempts × attemptTimeoutMs`
   加上退避间隔，默认值下 ≈ 3 × 10min + (1s + 2s) ≈ **30 分钟**；此前那个数是无穷。
   `run_in_background: false` 时父 agent 的 `agent` 工具调用同步等这 30 分钟 —— 宿主
   若有自己的看门狗，它得比这个大，否则会看到一个"SDK 还在重试、宿主已经掐断"的
   中间态。想关掉这个界，显式配 `attemptTimeoutMs: null`（而不是删掉配置）。
2. **这个界是协作式的，不是抢占式的。** 框架经 abort signal 通知，signal 到得了
   `fetch`（挂死的 LLM 请求因此真的有界）和 `tool.execute(args, ctx)` 的
   `ctx.signal`，但**宿主工具认不认它由宿主决定** —— 一个忽略 signal 的工具（典型：
   不接 signal 的 `child_process.exec`、裸 `await` 一个永不 settle 的 Promise）仍然
   无上界，超时只是把 `child.chat()` 的等待打断，而工具自己的异步尾巴还在跑。契约是：
   框架只经 abort signal 通知，每个工具仍然自己拥有停下手头工作的机制。我们**有意不**改成 race `chat()` 的 Promise：赢了
   race 会把 handle 标成 failed、释放并发槽，而子 Agent 还活着继续发遥测、写产物轨
   —— 一个框架账本上已死、物理上还活着的 agent 比没有超时更坏。宿主侧的对应动作是
   给自己的工具接上 `ctx.signal`。
3. **`send_message` 的续跑路径（`runtime._resume`）还没有装这张表** —— 已终态 agent
   被消息复活后的那一轮 `chat()` 只受调用方 signal 约束。`_resume` 与 `_runOnce` 不
   共用重试机制（它不走 attempt 循环），硬套 attempt 语义会把"续跑超时"错误地计入
   `maxAttempts`；这一条留待后续版本单独设计。

### 文档

- README「后台派发与 keep-alive」重写：等待预算（数白等、谁补回、构造期校验）、
  `run.keep_alive.gave_up` / `run.wakeup` / `followup()` 三者的接法、推荐配置
  （`keepAlive: false` + `run.wakeup` + `followup()`），以及 round 0 合并通知而不追加
  第二条 user 消息的理由；「宿主侧 API」清单补 `followup()`，并把
  `lastKeepAliveTimedOut` 标注为纯告知字段。
- README [提问路由](#提问路由)新增**接法 3：宿主自带 `ask_user` 工具**，并加了一条显式
  告警：只配 `subagents` 而三条应答通道一条都不给时提问会永久挂起，至少给一条通道或设
  `ask.timeoutMs` 兜底。

## 0.9.0 - 2026-08-04

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

- **Skill 系统**（`src/skills/`）：`SKILL.md` + YAML frontmatter 格式的 skill 包（含
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


### 客户端后台委派报告复核（2026-09-07）

- 修复用户轮次初始化与后台 followup 的并发窗口，以及 `stream()` 最终 done 前后到达通知的漏唤醒（含消费者在 done 后 break）。
- 子 Agent 运行期间更新 rounds、工具调用数和 lastToolCallAt，agent_status 列表展示实际进度。
- Node/浏览器 demo 接入同一会话 Agent 的自动续跑；新增本地 HTTP 和实模型综合 example。
- 保留 stopReason 的父轮次语义、会话级 runtime 和显式关闭行为。
