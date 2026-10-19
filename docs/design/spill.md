# `output-retention.js` + `spill/` — 工具输出限界

> 父文档：[设计说明索引](README.md) · 回到 [AGENTS.md](../../AGENTS.md)

让一个超尺寸的工具结果**离开模型的上下文但不丢失**。
逐条行为契约由**测试**钉住（见文末"相关测试"），而不是由散文描述。

---

## `output-retention.js`

`TextRetainer`（按字节预算的 `head` / `tail` / `headTail`）与 `ItemRetainer`（按条数预算），
外加 `describeOmitted` / `formatRetentionNotice`。零依赖，只用 `TextEncoder`/`TextDecoder`，
所以能打进浏览器包。

**四个行为是承重的，不是附带的：**

1. **预算是字节，不是字符** —— 一个 CJK 字符是 3 字节，
   所以一个按字符的预算会**静默地把真实大小变成三倍**。
2. **每个切口都被回退到一个 UTF-8 边界**，所以切口本身永不发出 U+FFFD；
   而一串末尾的裸续字节或一个非法前导字节则**原样留给解码器**。
3. **预算未被超出时，head 与 tail 是同一条流的相邻切片**，
   所以它们被拼接并**作为一个 buffer** 解码
   （分别裁剪或分别解码两半会损坏一个跨越那个人为分割点的码点 ——
   `headTail{head:1,tail:3}` 作用于 `'éab'` 必须返回 `'éab'`，不是 `'ab'`）。
4. **`omitted` 计的是实际不存在于返回文本里的字节数**，不是裁剪前的预算，
   因为一次边界回退也会丢字节，而一个由预算推导出的计数会让
   "Omitted N bytes" 那句通知变成模型随后据以推理的**谎话**。

## `spill/index.js`

一个契约下的多种 `SpillStore` 实现（`saveText` / `readText(locator, {offset, limit})` /
`clear(sessionId)`）：

| 实现 | 说明 |
|---|---|
| `createNodeSpillStore` | 私有 `mkdtemp` 根目录，`session-<hash>` 目录权限 `0o700`，`<random>-<encodeSegment(tool)>.txt` 文件以 `'wx', 0o600` 打开，所以一个预先植入的符号链接**无法劫持这次写入** |
| `createIndexedDBSpillStore` | 浏览器那一半 —— 浏览器里没有文件系统可写 |
| `MemorySpillStore` | FIFO 上限；既是测试替身也是最后手段的回退 |
| `createDefaultSpillStore` | 按环境选择 |

`node:fs/promises` 是**动态** import 的，与 `skills/providers/local.js` 同理，
所以浏览器构建永远不会把它拉进来。

`encodeSegment` 在**所有** JS 字符串上是单射的（`~XXXX` 转义、`~` 自身被转义、
整段的 `.`/`..` 被转义），所以不可信的工具名无法遍历目录或产生碰撞。
`sliceUtf8` 对带范围的读取施加同一套边界纪律。

## `spill/policy.js`

`createSpillPolicy({ maxInlineBytes, store, ... })` 决定**何时**溢出与**告诉模型什么**；
`maxInlineBytes` 缺失时返回 `null`（一个真正的 no-op，
所以调用方的 `if (this._spill)` 读起来是诚实的）。

**五条规则是机制：**

1. 一个非法的 cap **在构造时抛**，绝不在调用时
   （调用时抛会把一次成功的工具调用变成一次错误）。
2. 通知的字节开销被**保留在 cap 之内** ——
   方式是在计算 preview 预算之前，按**最坏情况**的 omission 计数给它定价。
3. 如果替换后仍超过 cap，policy **保留原文**并 warn
   （cap 是一条硬不变量 —— 而且由于一个合规的替换总是小于一个超限的原文，
   那一个检查就包含了"绝不大于原文"）。
4. **每一条失败路径**（没有 store、没有 session、`saveText` 抛了）
   都**保留原始内容并 warn**，而不是让调用失败或把输出藏起来。
5. preview 是 `headTail`，预算**对半分** ——
   因为结论（退出码、总计、最终错误）通常在**尾部**。

### `spill_search` 是刻意自带的

只提示模型"用 offset/limit 读，**或者 grep 这个路径**"，就等于假设宿主已经带了一个能搜真实路径的 `grep`。
**我们是一个库**：宿主可能没有 grep，而浏览器没有路径可供 grep。

只有顺序读取时，一次针对 DeepSeek 的真实运行花了 **7 次 `spill_read`** 扫一个 150 KB 的日志，
**仍然**撞上 `[max rounds exceeded]`；有了搜索，它在 2–3 次调用内解决。

`ignore_case` 出于同一个经验理由：模型写了 `error|Error`，漏掉了全大写的 `ERROR`，
然后断定这个日志是干净的。

### 两个工具都注册为 base tool

`registerBaseTool`，与 `skill` 和子 Agent 元工具同一先例：通知告诉模型去调用它们，
所以 `enableIntentRecognition` 下 `ToolFilter` 把它们裁掉，
会让那条指令变成一个工具集兑现不了的承诺。

它们也在 policy 自己的**跳过列表**里 —— 溢出一次检索结果就是那个
`read → spill → read` 循环，而跳过列表正是为防它而存在的。

### 检索提示的长度是一条真实约束，不是散文

它被计入 cap 保留，所以一条更长的提示留给 preview 的空间更少；
长到一定程度，小 cap 就**完全没有**合规的替换可用，并静默回退到原文。
`spill/policy.test.js` 用一个 **400 字节 cap 的守卫**钉住这一点，提示一变长就失败。

---

## Agent 侧接线（`agent.js`）

全部增量：

- `opts.spill.maxToolResultBytes` 创建 `this._spill`
  （否则它保持 `null`，工具结果与从前**逐字节相同**）。
- `_applySpill(call, result)` 由两个 ReAct 循环共享，运行在 **`afterToolCall` 之后**
  （hook 看见原始输出，模型看见限界后的输出），且**永不抛**。
- `this._spillSessionId` 是一个稳定的 **per-instance** id ——
  用 `_currentRun.traceId` 是一个真实缺陷，因为它在 run 之间被置空，
  于是 `reset()` 会算出一个**不同的** id，清理因此静默地漏掉所有东西。
- `reset()` 轮换该 id 并触发清理，**不 await**，从而保持它同步返回 `undefined`。

---

## 已知限制

1. **仅 ReAct** —— `_applySpill` 住在 `_reactLoop` / `_reactLoopStream` 里，
   所以 `strategy: 'plan_and_execute'` 什么都不限界；
   与已记录的 skill 清单、子 Agent 注入限制同一形状。
2. **整条结果粒度** —— 一条结果要么整体溢出要么整体保留；
   没有按 block 或按字段的限界，因为我们的工具结果是纯字符串。
3. **浏览器配额不做预检** —— 一个 IndexedDB `QuotaExceededError`
   经由正常的失败路径浮现（保留原文 + warn），而不是被预料到。

---

## 相关测试

- `output-retention.test.js` — UTF-8 边界裁剪（2/3/4 字节的部分字符、裸续字节串、非法前导字节）、
  相邻切片的整 buffer 解码、诚实的裁剪后 omission 计数、有界内存、零预算。
- `spill/index.test.js` — 一套共享的契约测试同时跑在 `MemorySpillStore` 与 `NodeSpillStore` 上，
  外加仅 Node 的安全断言（`0700`/`0600` 权限、不可预测的文件名、
  遍历形状的工具名被消毒成单个段），以及一条回归：对已清除 locator 的 `readText`
  **抛异常**而不是返回 `undefined` —— IndexedDB 后端曾经做后者，
  而**只有一次真实浏览器运行**才让它现形。
- `spill/policy.test.js` — 上面五条规则：未配置时 no-op、坏 cap 构造时抛、
  在许多 cap 尺寸下 cap 作为硬不变量被守住、每条失败路径都保留原文、跳过列表，
  以及那个 400 字节 cap 守卫（检索提示长到挤掉 preview 就失败）。
- `agent-spill.test.js` — Agent 接线：默认关闭时逐字节等价、两个 ReAct 循环都被限界、
  `spill_read`/`spill_search` 被注入并注册为 base tool、`reset()` 清理，
  以及一次"store 坏掉"的运行证明对话仍能完成。

## 来源

- `CLAUDE.md` Supporting modules 的 `output-retention.js` + `spill/` 条目
  （2026-09-07 精简前的版本）
