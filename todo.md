# js-sdk Bug / 改进 TODO

> 来自一次完整源码审阅（`src/agent.js`、`src/memory.js`、`src/llm-client.js`、`src/tool.js`、`src/context-manager.js`、`src/intent-recognizer.js`、`src/tool-filter.js`、`src/plan-and-execute.js`、`src/providers.js`、`src/knowledge-base.js`、`src/index.js`）。
>
> 按严重程度分级：**P0 致命**（崩溃 / 数据损坏） → **P1 严重**（功能缺失 / 体验明显不对） → **P2 中等** → **P3 健壮性 / 细节**。
>
> 每条含触发场景、代码位置、修复建议。

## 当前修复进度

| 级别 | 总数 | 已修复 | 待办 |
|---|---|---|---|
| P0 致命 | 5 | **5** ✅ | 0 |
| R  回归 | 4 | **4** ✅ | 0 |
| P1 严重 | 6 | 0 | 6 |
| P2 中等 | 12 | 0 | 12 |
| P3 细节 | 11 | 0 | 11 |

P0 + R 全部已修，单元 / 属性 / 集成测试共 **38 条** 全绿（`npm test`）。R 是对 P0 修复后代码做整体审查（见下方"Post-P0 审查发现"）捕获并处理的回归。

---

## P0 致命 Bug

### [P0-1] ✅ 已修复 — `_buildSimpleBody()` 没处理异步 `getMessages()`，把 Promise 当 messages 发送

- 修复：新增 `Agent._getMessages()` 辅助方法统一兼容 sync/async；`_buildSimpleBody` 改为 async；`_reactLoop` / `_reactLoopStream` 两处调用点加 `await`。
- 测试：`src/agent.test.js` — 4 条，覆盖 SummarizingMemory / SlidingWindowMemory / TokenAwareMemory + JSON 序列化验证。
- 位置：`src/agent.js` 352–355
- 现象：
  ```js
  const messages = typeof this.memory.getMessages === 'function'
    ? this.memory.getMessages()
    : []
  ```
  对比第一轮 `_runPipeline`（177–182 行）已正确通过 `AsyncFunction` 检测并 `await`。
- 触发条件：使用 `SummarizingMemory`（`getMessages` 是 async）+ `maxRounds >= 2`。第二轮开始 `body.messages` 是 `Promise`，`JSON.stringify` 成 `{}`，API 400 / 模型胡乱回复。
- 修复：抽一个公共 `async _getMessages()`，两处统一调用。

### [P0-2] ✅ 已修复 — `SummarizingMemory.getHistory()` 把摘要系统消息过滤掉了

- 修复：
  - `_maybeSummarize` 给摘要消息打 `_isSummary: true` 标记；并顺手修掉"多次触发会堆叠旧摘要"的老 bug。
  - `SummarizingMemory.getHistory` 改为 async，主动触发 `_maybeSummarize`，保留带 `_isSummary` 的消息。
  - `ContextManager.assemblePrompt` 从 history 抽出 `_isSummary` 消息并合并进 system prompt 内容（同时计入 sysTokens）；不再作为独立 system 消息散落。
  - `Agent._getHistory()` 辅助方法统一兼容 sync/async `getHistory`。
  - `body.messages` 中不会泄漏 `_isSummary` 字段到 LLM。
- 测试：`src/p0-2.test.js` — 4 条，覆盖摘要保留 / ContextManager 合并 / Agent 端到端 / 摘要非累加。
- 位置：`src/memory.js` 138–140 vs 165–169
- 现象：`_maybeSummarize` 把摘要写成 `role: 'system'` 注入 `this.messages`，但 `getHistory()` 过滤所有 system → 摘要直接消失。
- 触发条件：`SummarizingMemory` + (`tokenBudget` 或 `knowledgeBase`)，此时走 `ContextManager` 路径，`_runPipeline` 调用 `memory.getHistory()`。
- 额外副作用：`ContextManager` 路径只调 `getHistory()`，永远不触发 `_maybeSummarize`；相当于摘要功能在此路径下完全不工作。
- 修复：把摘要用特殊 role 或加标记（如 `_isSummary: true`），`getHistory()` 保留它；同时让 `ContextManager` 路径主动触发一次摘要。

### [P0-3] ✅ 已修复 — `ContextManager.trimHistory` 切碎 tool-call 组，产生 orphan tool 消息

- 修复：
  - `memory.js` 把 `adjustCutPointForToolPairs` 改为 `export`。
  - `context-manager.js` 的 `trimHistory` 引入该函数，裁剪后若首条是 `tool`，优先把父 `assistant(tool_calls)` 并入；实在纳不下就丢弃首部 orphan tool，绝不会生成孤儿。
- 测试：`src/context-manager.test.js` — 4 条（最小复现 + 200 轮属性测试 + 多 tool_call 组 + 非 tool 边界保留）。
- 位置：`src/context-manager.js` 189–201
- 现象：`memory.js` 内有 `adjustCutPointForToolPairs` 专门处理 tool-call 组边界；context-manager 的 `trimHistory` 完全没做。
- 触发：历史长到被裁，切点正好落在 `role: 'tool'` 上 → 第一条是 tool 但前面无 `assistant(tool_calls)` → OpenAI 400: `messages with role 'tool' must be a response to a preceding message with 'tool_calls'`。
- 修复：将 `adjustCutPointForToolPairs` 从 `memory.js` 导出（或搬到公共 util），`trimHistory` 内复用。

### [P0-4] ✅ 已修复 — ReAct 达到 `maxRounds` 时 memory 留下"悬挂"的 assistant(tool_calls)

- 修复：`_reactLoop` / `_reactLoopStream` 超轮分支 return/yield `[max rounds exceeded]` 之前先 `this.memory.add({ role: 'assistant', content: '[max rounds exceeded]' })`，保证 memory 尾部合法可继续对话。
- 测试：`src/p0-4-5.test.js` — P0-4 共 3 条（sync 末尾是 assistant / 下一轮 chat 无非法序列 / stream 路径亦然）。
- 位置：`src/agent.js` 242–245

### [P0-5] ✅ 已修复 — 子轮次用全量 tools，不是第一轮过滤后的 tools

- 修复：
  - `_runPipeline` 返回值新增 `filteredTools`。
  - `_reactLoop` / `_reactLoopStream` 用 `roundTools` 记录首轮过滤结果，后续轮调 `_buildSimpleBody(roundTools)` 复用。
  - `_buildSimpleBody(tools = this.tools)` 支持显式传入 tools 集合。
- 测试：`src/p0-4-5.test.js` — P0-5 共 2 条（intent 过滤后第二轮仍是 filtered 子集 / 无 intent 情况下保持全量）。
- 位置：`src/agent.js` `_runPipeline`（过滤）vs `_buildSimpleBody` 356（全量）

---

## Post-P0 审查发现（R-1 ~ R-4）

> 这 4 条是在 P0 全部修完之后，对整体改动做"最佳实践/回归"审查时发现并修复的问题。R-1 已用 Node 脚本实测复现过，其余三条是潜在风险与一致性问题。

### [R-1] ✅ 已修复 — `_buildSimpleBody` 把 `_isSummary` 标记和双份 system 消息发到 LLM

- 现象（实测）：`SummarizingMemory` + **无 tokenBudget** 场景下，第 2 轮 ReAct 的 body.messages 包含 2 条 system（原 prompt + 摘要），且 `_isSummary: true` 字段随 JSON 上到线上。`ContextManager` 路径没有这个问题，两条路径对 LLM 呈现不一致。
- 根因：P0-2 只在 `ContextManager.assemblePrompt` 里做摘要合并，`_buildSimpleBody` 绕过了 ContextManager。
- 修复：新增 `projectSummaryForWire(messages)` 工具函数，将 `_isSummary` 系统消息合并进第一条常规 system 的 content、并剥除内部字段。`SummarizingMemory.getMessages()` 和 `getMessagesSync()` 都走它一道。`getHistory()` 仍保留标记（供 ContextManager 识别合并）。
- 测试：`src/review-r1-r4.test.js` — R-1 共 3 条（Agent 端到端 / getMessages 剥除 / getMessagesSync 一致）。
- 位置：`src/memory.js`（新增 `projectSummaryForWire` + 改写 `getMessages` / `getMessagesSync`）

### [R-2] ✅ 已修复 — `_maybeSummarize` 并发调用 race-rewrite `this.messages`

- 现象：同一 agent 被并发 `getMessages()` / `getHistory()` 时，两个 `_maybeSummarize` 都快照旧状态、各自 `await summarizer(...)`、最后两次赋值互相覆盖，期间新 add 的消息可能丢失。P0-2 改完后 `getHistory` 也会触发压缩，撞车概率上升。
- 修复：引入 `_summarizePromise` 在途 Promise 单飞；`_maybeSummarize` 改为"有则复用、无则创建、settle 后清空"。把原实现重命名为 `_doSummarize`。
- 测试：`src/review-r1-r4.test.js` — R-2 共 2 条（N 并发 → summarizer 调用次数 === 1；batch 解决后下一轮再次触发）。
- 位置：`src/memory.js` `SummarizingMemory._maybeSummarize` / `_doSummarize`

### [R-3] ✅ 已修复 — 新摘要不继承旧摘要文本，长对话随机失忆

- 现象：P0-2 的修复为防止旧摘要堆叠，在生成新摘要时把旧摘要直接 `filter(!m._isSummary)` 扔掉；`toSummarize` 只含上次摘要后新增的消息 → 长对话第 2、3 次摘要后早期语义彻底丢失。
- 修复：在调用 `summarizer` 的输入前面加一段 `[Previous summary]\n...\n\n[New messages]\n...`，把 `this.lastSummary` 作为上下文传递给 LLM，由 LLM 负责合并。
- 测试：`src/review-r1-r4.test.js` — R-3 共 1 条（捕获两次 summarizer 调用的 text，校验第二次前缀）。
- 位置：`src/memory.js` `SummarizingMemory._doSummarize`

### [R-4] ✅ 已修复 — 四处 `_trim` / `trimHistory` 对畸形历史的 orphan-tool 兜底不一致

- 现象：`adjustCutPointForToolPairs` 遇到"tool 消息前面不是 assistant(tool_calls)"的畸形输入时回退为原切点；`SlidingWindowMemory._trim` / `SummarizingMemory._doSummarize` / `TokenAwareMemory._trim` 三处直接用返回值，可能留下"memory 以 tool 起头"的非法序列；只有 `ContextManager.trimHistory` 额外做了首部剥除。不一致。
- 修复：新增公共工具 `sliceWithoutOrphanTools(nonSystem, cutIndex)`，先尝试把父 assistant 拉回，拉不回就剥掉首部 orphan tool；四处调用点全部切过来。额外把 `trimHistory` 重写简化（行数减半、语义等价）。
- 测试：`src/review-r1-r4.test.js` — R-4 共 5 条（helper 正负用例 + SlidingWindow / TokenAware / ContextManager 三处边界覆盖）。
- 位置：`src/memory.js`（新增 helper + 三处 `_trim`）；`src/context-manager.js`（`trimHistory` 复用 helper）

---

## P1 严重问题

### [P1-1] `_planAndExecuteStream()` 忘了写 memory

- 位置：`src/agent.js` 340–347
- 现象：
  ```js
  async *_planAndExecuteStream(message, { signal } = {}) {
    const strategy = this._getPlanAndExecuteStrategy({ useStreaming: true })
    for await (const event of strategy.stream(message, { signal })) {
      yield event
    }
    // 将最终结果写入 memory
    // (done event 中包含 content)  ← TODO 未实现
  }
  ```
- 结果：流式版 PlanAndExecute 调用一次后 memory 除 system 外仍为空；多轮对话完全失忆。
- 修复：循环内捕获 `event.type === 'done'` 的 `content`，循环结束后 `memory.add(user)` + `memory.add(assistant, content)`。参考 `_planAndExecuteChat`。

### [P1-2] `plan_and_execute` 策略完全绕过 Runtime 管线

- 位置：`src/agent.js` `_getPlanAndExecuteStrategy`
- 现象：`PlanAndExecuteStrategy` 独立运行，**不使用** Agent 的：
  - `enableIntentRecognition`
  - `knowledgeBase`
  - `tokenBudget`
  - `ToolFilter`
  - `memory`（包括 SummarizingMemory）
  - `systemPrompt`（被 plan/step/synthesis 内置 prompt 覆盖）
- 用户按 README 配了一堆"Runtime 模式"参数切到 PlanAndExecute 会发现这些参数全部静默失效。
- 修复方案（二选一）：
  - A. 让 PlanAndExecute 也接入管线（更大改造）。
  - B. README 明确标注"PlanAndExecute 当前是纯无状态策略，不复用 Agent memory / 知识库 / tokenBudget / systemPrompt"，并在构造时检测到冲突参数给 warning。

### [P1-3] `_reactLoopStream` 不是真正的流式

- 位置：`src/agent.js` 271–279，`src/llm-client.js` 的 `onDelta`
- 现象：把 `onDelta` 传成空函数后再 `yield { type: 'delta', content: textContent }`，其中 `textContent` 是整轮完整文本。API 名字是 `delta`，行为是"一次性全量"，用户无法实现打字机效果。
- 修复（择一）：
  - 在生成器里维护一个 queue，`onDelta` 推队列，generator 逐个 `yield`；
  - 或者重命名事件为 `message` / `content`，避免名字欺骗。

### [P1-4] 构造 Agent 传入自定义 `memory` 时会塞重复的 system

- 位置：`src/agent.js` 71–72
- 现象：`this.memory = opts.memory ?? ...; this.memory.add({ role: 'system', ... })` 无条件 add。外部若已有 system（尤其会话恢复 / 持久化场景）→ 两条互相冲突的 system。
- 修复：若 `opts.memory` 已含 system 则跳过；或加 `skipSystemPrompt` 选项。

### [P1-5] `Agent.reset()` 不中止在途请求

- 位置：`src/agent.js` 127–131
- 现象：`chat()` / `stream()` 还在跑的时候调用 reset，memory 清空后原 Promise 继续向新 memory 写 assistant/tool。
- 修复：Agent 内部维护 `AbortController`，reset 时调 `abort()` 并重建；或文档明示。

### [P1-6] 并发 `chat()` / `stream()` 撕裂 memory

- 位置：`src/agent.js` 全局
- 现象：同一个 Agent 实例并发两个 `chat()`，都往 `this.memory` 写消息且顺序交错，会话状态永久损坏。
- 修复：内部 Promise 串行队列（每次 chat await 前一个），或文档明确"同实例请串行"。

---

## P2 中等问题

### [P2-1] `providers.js` 的 `anthropic` 入口误导

- 位置：`src/providers.js` 13–17
- 现象：注释写"不支持"，但 `resolveProviderUrl('anthropic')` 仍返回 URL → 直发 OpenAI 格式请求被 Anthropic 拒。
- 修复：在 `resolveProviderUrl` 对 anthropic 显式 throw，指引使用 custom url + 代理。

### [P2-2] `safeParseJSON` 静默吞参数错误

- 位置：`src/tool.js` 78–80
- 现象：`tc.function.arguments` JSON 坏了直接变 `{}`，工具以空参运行，看似成功实则错。
- 修复：失败时返回 `{ __parseError: true, raw: str }` 或直接把 raw 塞进 `_raw` 字段，工具层可选择处理。

### [P2-3] `IntentRecognizer.analyze` 无差别降级

- 位置：`src/intent-recognizer.js` 79–82
- 现象：network error / 4xx / AbortError 全部 `console.warn` 后 fallback 到默认。AbortError 应传播，鉴权 / 额度错误应该明确抛或至少醒目上报。
- 修复：
  ```js
  if (e.name === 'AbortError') throw e
  ```
  并区分 `LlmApiError.status` 做上报策略。

### [P2-4] `PlanAndExecute.callWithTimeout` 超时后 fetch 还在跑

- 位置：`src/plan-and-execute.js` 560–568
- 现象：超时只 reject 外层 Promise，内部 fetch 继续，浪费 token/带宽。
- 修复：在 `callWithTimeout` 内建子 `AbortController`，超时 `abort()` 并把 signal 传给 `fn`。同时 `signal` 需要和外部用户的 signal 做 `AbortSignal.any([userSignal, timeoutCtrl.signal])`。

### [P2-5] 浏览器使用安全警示不足

- 位置：`demo/browser.html` + README
- 现象：鼓励浏览器里直接 `new Agent({ apiKey })`；API key 暴露、OpenAI / DeepSeek 没 CORS、流式只能拿到一次 delta（Bug P1-3）。
- 修复：
  - README 加醒目"生产必须走代理"章节；
  - `demo/browser.html` 示例默认指向 `demo/server.js` 代理；
  - 构造函数检测 `typeof window !== 'undefined'` 时 `console.warn` 一次。

### [P2-6] `streamChat` SSE 解析 / 鲁棒性小问题

- 位置：`src/llm-client.js` 41–59
- 问题列表：
  - 按 `\n` 切而非 SSE 标准 `\n\n` 事件边界（OpenAI 目前 OK，其他代理可能合并事件）。
  - `response.body` 无 null 校验（老环境 NPE）。
  - 读取抛异常后 reader 未 `releaseLock()`。
  - 非法 JSON chunk 用 `catch { }` 静默吞，连 log 都无，难以排查供应商行为异常。
  - 请求头缺 `Accept: text/event-stream`（部分网关会 gzip 缓冲导致"卡很久才开始吐"）。
- 修复：逐条补齐。

### [P2-7] `ContextManager` 多轮内不再裁剪

- 位置：`src/agent.js` `_reactLoop`，每轮只在 round 0 走 pipeline
- 现象：单轮里模型连调 N 次工具，tool 消息堆满也不会重新裁剪，容易超 context window。
- 修复：每轮前做一次廉价 token 估算；或把裁剪能力下沉到 memory（add 时联动）。

### [P2-8] Tool 执行异常信息直接回给模型

- 位置：`src/agent.js` 233–238
- 现象：`err.message` 原封不动放入 tool result → 可能带上栈、绝对路径、env 变量，模型可能把这些泄漏给终端用户。
- 修复：加一个 `errorFormatter` 钩子，默认做基本脱敏。

### [P2-9] Tool 重名静默覆盖

- 位置：`src/agent.js` 199
- 现象：`Object.fromEntries(tools.map(t => [t.name, t]))` 重名后者覆盖，无 warning。
- 修复：构造时检测重复 name，throw 或 warn。

### [P2-10] `IntentRecognizer` JSON 抽取粗暴

- 位置：`src/intent-recognizer.js` 97–101
- 现象：`indexOf('{')` + `lastIndexOf('}')` 若 reasoning 里含括号会破坏 JSON → parse fail → 默认值。
- 修复：改用栈匹配或让模型通过 `response_format: { type: 'json_object' }`（OpenAI 支持的话）。

### [P2-11] `trimTools` 当 BASE_TOOLS 已超预算时仍返回全部 base

- 位置：`src/context-manager.js` 170–186
- 现象：`base` 无条件全保留；接下来 `remaining` 可能为负，虽代码做了 `<=0` 置零但仍整体击穿预算。
- 修复：`trimTools` 内再按 token 对 base 做二次裁剪（保留前 K 个）。

### [P2-12] `formatToolResult` 对 `undefined` 处理缺陷

- 位置：`src/tool.js` 73–75
- 现象：`JSON.stringify(undefined) === undefined`（非字符串），`content: undefined` 被 OpenAI 拒绝。
- 修复：
  ```js
  content: result == null ? '' : (typeof result === 'string' ? result : JSON.stringify(result))
  ```

---

## P3 健壮性 / 细节

- [P3-1] `resolveProviderUrl` 对 `provider` 非 string / 空字符串无校验（`registerProvider(undefined, ...)` 会写键）。
- [P3-2] `KnowledgeBase` 无大小上限，误加海量条目时 `buildKnowledgePrompt` 生成巨大字符串后才裁剪。建议 add 时做 size 保护。
- [P3-3] `PlanAndExecuteStrategy` `stepsContext` 强截 500 字符，大项目上下文流失严重。应提供 `stepSummarizer` 钩子。
- [P3-4] `PlanAndExecuteStrategy._reactLoop` 对 `content: null` 的 assistant 消息兼容性问题（某些 OpenAI 兼容服务期望 `""`）。
- [P3-5] 所有 `fetch` 无默认超时，全靠调用方传 `signal`。建议 Agent 加 `requestTimeoutMs` 默认。
- [P3-6] `parseToolCalls` 不校验 `tc.id` / `tc.function.name` 是否存在，空 id 会污染 `tool_call_id`。
- [P3-7] `parsePlan` 严格 `JSON.parse`，不容忍尾逗号 / 单引号 / 注释 —— LLM 常产出这些。建议用宽松 JSON 解析器或预处理。
- [P3-8] `parsePlanFromText` 正则对 `"Step1:"`（无空格）等变体 miss。
- [P3-9] `TokenAwareMemory` system 消息无上限累积，最终可能吃光预算；应 warn。
- [P3-10] `estimateTokens` 用 chars/4 估算，中文严重偏差；对用 token 预算的中文场景误差很大。建议暴露 `tokenEstimator` 钩子允许接真 tokenizer（tiktoken / wink 等）。
- [P3-11] `index.js` 未导出一些内部类型常量（`StepStatus` 导出了，但如 `adjustCutPointForToolPairs` 之类公用 util 无法复用）。

---

## 建议修复顺序

按 "崩溃风险 × 触发概率" 排序，优先级最高的 8 条：

1. ✅ **P0-1** `_buildSimpleBody` 异步 memory 处理（抽 `_getMessages` 辅助）
2. ✅ **P0-3** `ContextManager.trimHistory` 复用 tool-pair 调整
3. ✅ **P0-4** 超轮补写 final assistant 消息
4. ✅ **P0-5** 子轮次复用 filteredTools
5. ⬜ **P1-5** `Agent.reset()` 中止在途请求
6. ⬜ **P1-6** 并发调用串行化
7. ⬜ **P1-1** `_planAndExecuteStream` 写回 memory
8. ✅ **P0-2** `SummarizingMemory.getHistory` 保留摘要系统消息 + `ContextManager` 路径触发摘要

P0 全部完成（5/5）+ Post-P0 审查发现的 4 条回归（R-1 ~ R-4）也全部完成。剩 P1-5 / P1-6 / P1-1 是下一批建议优先处理的"严重但非崩溃"问题（其中 P1-6 并发问题已经被 R-2 的在途 Promise 机制解决了摘要这一小块）。后续 P2 / P3 属于用户体验和边界健壮性，可以分批补。

**API 破坏性变更提醒（需在 README / CHANGELOG 里写明）：**

- `SummarizingMemory.getHistory()` 从同步变为 `async`。任何直接 `memory.getHistory()` 然后当数组用的外部代码需要改为 `await memory.getHistory()`。
- `SlidingWindowMemory.getHistory()` / `TokenAwareMemory.getHistory()` 保持同步，三者 API 不再完全对称——若用户写了对三者统一处理的代码，需统一 `await`。

---

## 建议补充的测试

- 多轮 ReAct + `SummarizingMemory`，验证 P0-1、P0-2 不复现。
- 历史极长导致 `ContextManager.trimHistory` 需要切到 tool 消息，验证不出现 orphan tool（P0-3）。
- ReAct 设极小 `maxRounds`，验证 memory 末尾必有 assistant 文本（P0-4）。
- Intent 返回 `filteredToolNames = ['a']`，跑 2 轮以上，验证第二轮 request body 的 `tools` 仅含 filtered 集合（P0-5）。
- 并发调用同一 agent 两次 `chat()`，验证消息顺序或抛错（P1-6）。
- 流式 PlanAndExecute 跑完一轮后 `agent.memory.getMessages()` 包含 user+assistant（P1-1）。
- `provider: 'anthropic'` 构造时抛错（P2-1）。
- 工具返回 `undefined` 不让 API 炸（P2-12）。
