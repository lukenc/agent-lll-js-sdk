# 子 Agent 系统在 `agent.js` 侧的接线

> 父文档：[设计说明索引](README.md) · 系统内部机制见 [subagents.md](subagents.md)

七个接触点，**全部是增量的**。

---

## 1. 构造函数

`opts.subagents`（`types`、`defaultType`、`maxConcurrent` 4、`maxDepth` 2、`modelAliases`、
`retry`、`keepAlive` true、`keepAliveTimeoutMs` 600000、`maxConsecutiveWakes` 3、
`artifacts.policy`、`ask.timeoutMs`、`isolation`、`retainCompleted` 20、
`retainClosedGraphs` 5、`a2a.transport`）创建 `this.subagents`，追加 12 个元工具，
并为每一个调用 `registerBaseTool(name)`。

把它们注册成 base tool 是**强制的**，理由与 `skill` 需要它时相同（commit `20617d8`）：
`enableIntentRecognition` 开着时，`ToolFilter` 会把元工具裁掉，
而 system prompt 仍在广告 agent type 清单。

## 2. `enqueueMessage(message)` + `_pendingInjections`

一个 FIFO 队列，在 ReAct **轮边界**排空（在 `_buildSimpleBody()` / `_runPipeline()` 之前）——
那时上一轮的 `assistant(tool_calls)` 与它所有的 `tool` 结果已经在盘上配对完成，
所以插入一条 `user` 消息不可能破坏 `memory-policy.js` 依赖的配对不变量。

三个生产者共用它：后台 agent 的完成通知、graph 节点就绪通知、`send_message` 投递。

**轮边界排空本身不是一条投递路径** —— 它只在一个**活跃**循环内的 `round > 0` 运行，
而 `_signalEvent()` 只解析**已经**阻塞在 `nextEvent()` 上的等待者。
所以一条在 Agent 空闲时（没有在飞的 run）到达的通知**曾经无处可去**：
它成功入队，下一次 run 的 round 0 从不看它，
而一次单轮 run（模型直接回答 —— 常见情况）永远到不了 round 1。

那是客户报告 §4"结果永久丢失"背后**更深的根因**，而且它在 `keepAlive: false` 且
Agent **持久**的情况下也能复现，也就是说它独立于 sticky gate 与 per-instance runtime 两者。

三处新增把它闭合，都在 `agent.js`：

### 2.1 `_mergePendingIntoUserMessage(message)`

在 `chat()` 与 `stream()` 的 **round 0**：空闲期积压被合并**进**用户的新消息
（通知在前，然后是用户的文本），而不是作为第二条 `user` 消息追加，
因为两条相邻的 `user` 消息会触发某些供应商 —— 与 `INJECTION_MERGE_THRESHOLD` 同理。

它返回的是**写进 memory 的文本**，**不是**交给 `_reactLoop` 的文本，
所以意图识别与 `SkillFilter` 仍然看见用户的真实意图，而不是一条框架自撰的 `<agent-notification>`。

### 2.2 `run.wakeup`

当 `this._currentRun == null` 且 `_activeTurns === 0` 时由 `enqueueMessage` 发出。
`chat()` / `stream()` 在首次异步初始化之前占用轮次，避免通知开启重叠的 followup。
忙碌时通知由轮边界排空或 keep-alive 接走；成功退出时若还有积压，再补发唤醒。
这也覆盖消费者收到最终 `done` 后直接 `break` 的退出窗口。异常或提前取消不自动续跑。

### 2.3 `followup(opts?)`

宿主的重新调用入口，负责"父级空闲时"的那一半（父级忙时由轮边界排空接走）。
它排空队列并跑一轮；**队列为空或当前轮次忙碌时返回 `null` 且不发请求**，忙碌时保留队列
（一次空转的 LLM 调用烧 token，而"没有待处理"是正常情况）。
SDK **从不自己开那一轮** —— 一次新轮是该打扰用户还是该走宿主的流式渲染器，是宿主的决定。

`followup()` 传一个内部的 `opts._frameworkAuthored: true`（覆盖宿主提供的任何值 ——
那条路径**总是**框架发起的），这就是下面的唤醒预算区分
"用户又说话了"与"框架自己重新调用了自己"的方式。

## 3. `ask_user` 升级

注入条件：`hooks.onAskUser || opts.subagents`；hook 签名加宽为 `onAskUser(question, meta)`
（旧的单参数 hook 继续可用）；新增 `pendingQuestions()` / `answerQuestion(askId, answer)` /
`cancelQuestion(askId, reason)`。

**注入是包装一个宿主提供的 `ask_user`，不是替换它。** 一个同名的宿主工具保留它的
`description` 与 `parameters`（所以模型仍看见宿主的富 schema —— 通常是
`questions: [{ question, options }]`，那是 SDK 的单字符串形状表达不了的），
而它的 `execute` 成为**那个问题的投递通道**，作为每问题的 `notify` 传给 `AskRegistry.ask`；
SDK 只在其外围加上注册表记账，所以归属、`pendingQuestions()`、`answerQuestion` 与
`agent_cancel` 都能触达一个宿主自有的问题。

替换而非包装曾是一次**没有恢复路径的静默回归**：宿主的弹窗通道消失了，
而 SDK 自己的版本**没有**办法触达一个"配了 `subagents` 却没配 `hooks.onAskUser`"的宿主 ——
问题注册了，没有 hook 去通知，宿主不知道该调 `answerQuestion`，
而 `ask.timeoutMs` 默认为 `null`，于是工具调用**永久挂住**，
并表现为一次看起来像网络故障的看门狗超时。

wrapper 用 `Symbol.for('lll.askUser.wrapped')` 打标签，因为一个子 Agent 继承的是
**父级已经包装过的**闭包，而它自己的构造函数会再次进入这个分支 ——
没有标签，"包装现有的"要么会双重包装，要么会发出两个同名工具。

`notify` **取代**该问题的 `hooks.onAskUser` 而不是与它并跑
（两者都是"把这个摆到用户面前"；都跑就是为一个问题提示两次）。

`describeAskParams` 从宿主声明的任意形状里渲染注册表的字符串 `question` 字段 ——
宿主的 `execute` 仍收到未经触碰的原始参数。

## 4. `_withSubagentTypesNote(messages)`

每轮把 agent type 清单合并进 system 消息（**每轮重算**，因为 type 可以在运行时注册）。
**仅 ReAct。**

## 5. 工具执行上下文

`tool.execute(args, ctx)` 得到 `{ signal, cwd, agentId, agentName, depth, nodeId, attempt }`，
方式是展开 `this._toolContextExtra`。主 Agent 的 `cwd` 是 `null`
（且它不带 `nodeId` / `attempt`，所以 `artifact_write` 回退到 `null` / `1`）。
既有工具不受这些额外字段影响。

## 6. keep-alive 与唤醒预算

在"没有 tool calls → 返回"那个分支，`_keepAliveOnce()` 决定是否把这一轮继续挂住（hold the turn open）。
它三项检查的**顺序就是全部要点**：

1. **待注入** —— 在任何在飞检查**之前**排空（一个已完成的后台 agent 没有在飞的东西，
   但它的完成通知还在队列里），**并且**在预算检查**之前** ——
   预算约束的是**等待**，从来不是**投递**，所以耗尽的预算仍能接住一条迟到的通知。
2. **`subagents.hasInFlight()`** —— 刻意**不是** `hasPending()`，
   因为 `blocked` / `awaiting_confirm` 的 graph 节点在等编排者自己的下一步，
   不产生事件，会让每一轮都白烧一整个超时。这一步也必须在预算检查**之前**：
   一个没有在飞东西的 `'idle'` 是干净的结束，在那里发 `run.keep_alive.gave_up`
   就是关于"被抛弃的工作"的谎话。
3. **唤醒预算。**

### 等待预算约束的是什么

旧代码每个 run 只设一次 `lastKeepAliveTimedOut`，此后就不再等待（客户报告 §3）。
父 run 在子 Agent 仍运行时以 `completed` 结束，本身符合后台任务语义。
已确认的缺口是迟到通知的投递和续跑。把等待次数从一次改成三次，并不能单独解决这个缺口 ——
迟到通知靠的是接触点 2 的重新调用路径（父级空闲时 `followup`，忙碌时轮边界排空），
不依赖轮内 keep-alive。

所以 `subagents.maxConsecutiveWakes` 约束的是**轮内等待超时**，不是"再唤醒一次"，
也不限制跨轮续跑次数（那由宿主控制）。它默认 3
（对 `0` / 负数 / 非整数 / `Infinity` 在**构造时** `TypeError` ——
调用时抛会把一次成功的等待变成一次失败的 run），计的是**超时**（白等）而不是等待次数：
一次事件唤醒买到了东西，所以把它算进"该放弃了"会惩罚一个正常推进的 run，
因此事件唤醒**既不消耗也不回填**（让它们回填会让一串结算把计数器压在零，
而交错着的挂死孩子会把 run 拖到 `maxRounds`）。

回填**只**发生在**用户自撰**的输入上 —— 经由 `_refillKeepAliveBudget(opts)` 的
`chat()` / `stream()`，以 `opts._frameworkAuthored` 门控 ——
框架自己排进队列的通知绝不能回填它刚花掉的预算。

计数器住在 **Agent** 上而不是 runtime 上：只有 Agent 知道用户是否说话了，
而 runtime 看见的是 `enqueueMessage`，那同样可能是一次 agent 间的 `send_message`，
它不算用户输入。配置则住在 runtime 上。

`_spentKeepAliveWakes` **刻意不在 `_runWithSession` / `_runWithSessionStream` 里重置**
（它跨 run 累积；在共享入口处清零会让一条框架通知回填它自己刚花掉的预算），
但**会**被 `reset()` 重置，因为一次 `reset()` 之后可能跟着 `followup()`，而后者不回填。

### 耗尽

发 **`run.keep_alive.gave_up`**，携带 `{ spent, budget, pendingAgents, pendingNodes, inFlight }` ——
在飞快照是宿主决定"关闭、取消，还是告诉用户"的唯一依据（报告 §5）。

放弃**不取消**任何东西：取消只发生在显式处置时（`closeSubagents()` / `agent_cancel` / `reset()`），
而报告 §10 #7 那条"run 结束时自动 `closeSubagents()`"的建议正是因此被拒绝 ——
它会杀掉它自己 §7 想要的"派一个慢任务，下一轮收结果"这个用例。

所以 `'idle'` 有两个含义（干净结束 vs. 预算耗尽），
**由事件区分，不由返回值区分** —— 返回值集合未变。
`lastStopReason` 同样保持 `'completed'`：那个 enum（`null | 'completed' | 'max_rounds'`）
是一份跨包的既有契约，keep-alive 放弃时它仍是 `completed`，
而让它诚实的是**重新调用路径**（接触点 2），不是一个新的 enum 值。
结束等待之所以诚实，**只因为那条路径先落地了** ——
通知仍留在队列里，由 round-0 合并、`run.wakeup` 或 `followup()` 投递。

`lastKeepAliveTimedOut` 作为公开字段保留，任何超时都会设它，
并被记录为**仅供信息**：它不再 gate 任何东西，**没有人应该重新引入那个**。

超时事件、wind-down 通知与 `gave_up` 里的 `pendingNodes` 数字来自
`subagents.pendingNodeCount()`，它跨越每一个 graph：**决定**一直是跨 graph 的，
而在模型正要决定是否停止的那一刻告诉它"0 个 graph 节点未完成"、
另一个 graph 却持有好几个，是错的。单轮由 `maxRounds` 限界，跨轮自动续跑预算由宿主控制。

## 7. 生命周期

- `getArtifacts({ agentId })` 增加一个可选过滤器（无参行为不变）。
- 新增 `closeSubagents()`：取消在跑的 agent、拒绝待决问题、清理未修改的 worktree；
  `reset()` 会调用它。
- `reset()` 还**同步**调用 `subagents.beginClose()`，在安排那次 fire-and-forget 拆除**之前**：
  清 `_pendingInjections` 是同步的而拆除不是，所以一个被取消的子 Agent 会在清除**之后**结算，
  而它的 `<agent-notification state="cancelled">` 会向新对话的 round 1 讲一个它从未 spawn 过的 agent。
- `beginClose()` 递增一个 `notifyEpoch`，在 spawn 时盖到每个 handle 上，
  于是 `_onBackgroundSettled` 丢弃来自早于拆除的 handle 的通知，同时仍向 keep-alive 等待者发信号。
  它用一个 epoch 而不是一个 "closing" 标志，因为 runtime 在 `close()` 之后仍可用 ——
  一扇永久关上的门会让**下一个** session 自己的后台 agent 变哑。

---

## demo 侧的两个易踩点（承重，不是装饰）

1. **`refreshAgentTools()` 必须保留 `META_TOOL_NAMES`** ——
   从面板挂载一个 MCP server 否则会抹掉 12 个子 Agent 元工具，
   而 system prompt 仍在广告 agent type 清单；`spill_read` / `spill_search`
   在那个集合里是同一个理由，而且**Node 与浏览器两份列表必须保持同步**。
2. **`/reset` 重建 Agent，而不只是调用 `reset()`** ——
   `AgentRegistry` 按设计保留已完成的 handle，所以"新会话"否则会显示上一个 session 的 agent。

---

## 相关测试

- `agent-subagents.test.js`、`agent-injection.test.js`、`agent-keepalive.test.js`、
  `agent-ask-routing.test.js` — Agent 侧接线：元工具 + base tool 注册、type 清单注入、
  不破坏 tool-call 配对的轮边界排空、keep-alive 各分支、多路复用问题路由、`closeSubagents()`。
- `agent-keepalive-budget.test.js` — 取代 keep-alive sticky gate 的唤醒预算：
  **计数而非布尔**（三次超时每次都真的等满 `keepAliveTimeoutMs`，第四次立刻返回 `'idle'`）、
  `run.keep_alive.gave_up` 载荷及其 `inFlight[]` 快照、用户自撰的 `chat()` / `stream()` 回填
  对比 `followup()` **不**回填（两者都跨两个 run 以 `run.keep_alive.timeout` 事件计数 ——
  只读 `_spentKeepAliveWakes` 分不清"回填后重新花掉"与"从未回填"）、
  事件唤醒既不消耗也不回填、放弃永不取消在飞工作、
  对 `0` / 负数 / 非整数 / `Infinity` 的构造时拒绝，
  以及端到端的"无静默抛弃"用例（预算耗尽 → 孩子在空闲时结算 → `run.wakeup` →
  `followup()` 把通知送上线路）。
- `agent-wakeup.test.js` — 空闲期投递，其缺失正是报告 §4 的实际根因
  （一条在没有在飞 run 时到达的通知无处可去：`_drainPendingInjections` 只在 `round > 0` 运行，
  而 `_signalEvent()` 只解析**既有**的等待者）。覆盖 round-0 合并
  （`_mergePendingIntoUserMessage` 写进 memory 但不写进交给 `_runPipeline` 的 `userMessage`，
  所以意图识别与 `SkillFilter` 仍看见用户的真实消息）、
  `run.wakeup` 只在 `_currentRun == null` 时发、
  以及 `followup()` 在队列为空时返回 `null` 且不发请求。

## 来源

- `CLAUDE.md` 的 "Agent touchpoints (`agent.js`), all additive" 七条
  与 demo 集成一节的两处提醒（2026-09-07 精简前的版本）
