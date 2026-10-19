# `context-manager.js` — Token 计价与 usage 锚定

> 父文档：[设计说明索引](README.md) · 回到 [AGENTS.md](../../AGENTS.md)

`context-manager.js` 组装 prompt（system + knowledge + history + tools）并执行 token 预算。
裁剪优先级：**TOOLS → HISTORY → KNOWLEDGE**。

Token accounting 的行为契约由**测试**钉住（见文末"相关测试"），而不是由散文描述；
本文解释这些契约背后的理由。

---

## 1. 它做了三件 `chars/4` 不做的事

### 1.1 结构化开销（Structural overhead）

`estimateMessageTokens`（定义在 `memory-policy.js` —— 依赖方向就是这样，
`context-manager` 只是再导出）会：

- 每条消息加 `ROLE_OVERHEAD`，每个 block 加 `BLOCK_OVERHEAD`；
- 把 `tool_calls` 按 `name + arguments + block` 计价；
- 给 `tool` 结果单独再加一个 block。

**校准锚点**（由 `token-accounting.test.js` 断言）：一条 4 字符的 text 消息是 **9** tokens。

`estimateToolsTokens` 计价的是**真实 JSON Schema**，而不是 markdown 描述 ——
对一个参数对象不那么平凡的工具来说这要大好几十倍，而且一旦挂载 MCP server 它就会主导整个预算
（某次真实 demo 运行测到 `tools=5407`，而 `total=5508`）。旧路径把这部分全漏了，
而且漏的方向是危险的：**低估意味着请求发出去时自以为塞得下，然后被供应商拒掉。**

### 1.2 usage 锚定（Usage anchoring）

`assemblePrompt({ anchor })` 复用上一次成功调用的真实 usage 作为基线，
只在其上估算 delta，并返回 `tokenConfidence: 'usage' | 'estimated'`，
让调用方知道这个数字是**测出来的**还是**猜出来的**。

两个守卫是承重的：

1. **守恒检查**（`anchor.totalTokens >= anchor.estimatedAtAnchor`）——
   拒绝一个比它自己同期估算值还小的锚。因为从一个过小的锚出发，带符号的 delta 会**永久向下漂移**。
2. **delta 是带符号的** —— 因为对 memory 做摘要会让 history **变小**。

任何信封（envelope）变化都会让锚失效：`headerFingerprint(systemPrompt, tools)`
**先按名字排序**工具，所以一个"顺序不同但内容相同"的工具列表不会把锚扔掉，
而真正的成员变化或 schema 变化会。

### 1.3 ⚠️ 锚**不**把 cache 字段再加一遍

如果 usage 各字段是**互斥**的（cache 命中已从 `prompt_tokens` 里减掉），
正确的求和是 `input + cacheRead + cacheWrite + output`；但我们拿到的不是这种形状。

我们的 `telemetry.extractUsage` 把 OpenAI 形状**原样透传**，其中 `prompt_tokens`
**已经包含**了 cache 命中 —— 所以锚是 `input_tokens + output_tokens`。
套用 `input + cacheRead + cacheWrite + output` 会把缓存部分重复计入，得到一个**永久虚高**的锚。

`extractUsage` 本身没有改动：它的 `gen_ai.usage.*` 输出是一份既有的 telemetry 契约。

---

## 2. 最小消息下限（Minimum-message floor）

有了结构化开销之后，单条消息至少就要花 `BLOCK + ROLE`，
所以一个很小的预算过去会把 history 裁到**什么都不剩** —— 让模型看不见用户刚说的话。

`trimHistory` 和 `TokenBudgetPolicy.apply` 现在都**无论如何保留最近一条消息**，
这与 `sliceWithoutOrphanTools` 做的是同一个取舍：**协议有效性优先于严格预算**。

`memory.test.js` 的预算属性测试因此这样陈述不变量：**在预算内，或者恰好保留一条消息**。

---

## 3. Agent 侧接线

| 成员 | 说明 |
|---|---|
| `this._tokenAnchor` / `this._lastAssembly` | 首次成功调用前都是 `null` |
| `_recordTokenAnchor(ev)` | 挂在两个 `llm.call` 监听器上 |
| `getTokenAnchor()` | 返回副本 |
| `context.assembled` telemetry 事件 | 携带分段明细 + `tokenConfidence` |
| `reset()` | 清除锚 —— 新对话不得继承旧基线，否则旧 `historyTokens` 会产生一个巨大的负 delta |

---

## 4. 已知限制

1. **锚定只在配置了 `tokenBudget` 或 `knowledgeBase` 时生效** ——
   两者都没有时 `_runPipeline` 走 simple path，根本到不了 `ContextManager`。
   （demo 两侧因此都显式配置了 `tokenBudget: defaultTokenBudget()`。）
2. **意图识别与锚定互相拉扯** —— `ToolFilter` 每轮返回不同的工具子集
   （某次真实浏览器运行看到 18 → 28 → 28），而不同的工具集**确实**就是不同的请求，
   所以锚失效是正确行为。顺序噪声已被排序指纹消除；成员抖动是固有的。
   这是意图层带来的交互，不是锚定本身的缺陷。
   实测效果：**关掉意图识别后，第 2 轮起稳定锚定**
   （测到 6851，而纯估算是 6168 —— 避免了 683 tokens 的低估）。
3. **密度仍然是 `chars/4`** —— 缺口从来不在启发式本身，但 **CJK 依然被低估**。

---

## 5. 相关测试

- `token-accounting.test.js` — 结构化开销计价（9-token 校准锚、`tool_calls`、`tool` 结果、真实 schema 计价）、
  信封指纹（顺序不敏感、成员敏感、空等于缺失）、带守恒检查与 signed delta 的锚复用、最小消息下限。
- `agent-token-anchor.test.js` — Agent 接线：从 `llm.call` 捕获 usage、latest-wins 锚定、
  system prompt / 工具集变化时失效、真实数据上的守恒拒绝、`reset()` 清除、`context.assembled` 携带 confidence。
- `memory.test.js` — 预算属性测试（"在预算内 **或** 恰好一条消息"）。
- `context-manager.test.js` — prompt 组装、token 裁剪、tool-call 组保留。

## 来源

- `CLAUDE.md` Architecture 第 4 条（2026-09-07 精简前的版本）
