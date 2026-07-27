# Changelog

本文件记录 `lll-web-agent` 的显著变更。格式大致遵循 [Keep a Changelog](https://keepachangelog.com/)。

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
