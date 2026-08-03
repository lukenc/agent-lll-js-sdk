# Subagent 展示设计（demo 面板 + example 终端）

- 日期：2026-08-03
- 分支：`worktree-subagent-system`
- 基线：subagent 系统已实现并已接入 demo / example（只读、无展示层打磨）
- 状态：设计已确认，待实现计划

## 1. 背景

subagent 系统已经跑通，但在两个示例里它**是个黑盒**：从派出到回来之间，界面上只有 `🤖 派出 explorer-1` 和 `✅ explorer-1 完成` 两条消息。真模型下这中间是几十秒到几分钟，用户面对的只有一个转圈。

而数据其实全在。`runner._forwardTelemetry` 把子 agent 的 `llm.call` / `tool.call` / `round.start` / `round.end` 转发到父 agent 的总线上，**每条都带 `agentId` + `agentName`**；`handle.toStatus()` 给出 `metrics` / `attempt` / `nodeId` / 时间戳。现在只是把这些平铺进一条事件流，归属字段被浪费掉了。

`demo/` 和 `examples/` 是给使用方的集成参考、给用户的展示。"派生"是这套系统最难凭空想象的一件事，展示不出来，示例就没有尽到示例的责任。

### 目标

1. 子 agent 的运行过程在两个示例里都**可见、实时、可归属**。
2. 展示形态按**参考 UI 标准**做 —— 使用方能照抄进自己的产品，而不是照抄一份调试面板。
3. 顺带把已有但没露出的字段补上：耗时、token、步数、`attempt`、`failureKind`。

### 非目标（明确不做）

- **不加干预控制**：没有取消按钮、没有关图/重激活入口，不新增写类端点。卡住时仍由 keep-alive 超时兜底（模型会拿到"收尾或 agent_cancel"的提示）。
- **不做 DAG 图形化绘制**：依赖关系继续用缩进列表 + `← 上游` 表示，不引入 SVG/canvas 布局。
- **不做产物内容预览**：产物轨只显示 `key` / `sha` / 归属 / `summary`。
- **不改 `src/`**：这是纯展示层设计，框架侧一行不动。

## 2. 已确认的四个定位决定

| # | 决定 | 影响 |
|---|---|---|
| 1 | demo 与 example **都按参考 UI 标准**做，内部细节藏在 `DEBUG=1` 后面 | example 默认不打事件名/round 边界 |
| 2 | demo 里子 agent 的运行过程**全部放右侧面板**，对话流只留一行"派出/完成" | 对话区保持干净，不做内联卡片 |
| 3 | 面板**只读**，不加控制按钮 | 不新增 `POST /cancel` 等端点 |
| 4 | example 在 TTY 下**原地刷新**，管道下**降级逐行** | 需要 `isTTY` 分支与显示宽度计算 |

## 3. 共同基础：归属规则与活动流水账

### 3.1 归属规则

一条，且只有一条：

```js
const owner = payload.agentId ?? 'main'
```

主 agent 自己发的 `tool.call`（`agent.js` 构造的 `toolCallPayload`）**不带** `agentId`；`runner._forwardTelemetry` 转发子 agent 事件时显式补上 `agentId` / `agentName`。因此缺省即主 agent，不需要额外约定。

### 3.2 活动流水账

框架**刻意不缓存**"某个 agent 都调过哪些工具" —— `AgentHandle` 只记 `metrics` 聚合数。要展示流水，主机必须自己从事件流攒。这是使用方接入时一定会遇到的第一个问题，因此两个示例都要示范，且形状保持一致：

```js
/** @type {Map<string, AgentActivity>} */
{
  agentId: 'agt_00000001',
  agentName: 'explorer-1',
  rounds: 3,                       // round.start 计数
  tools: [                         // 环形缓冲，最多 MAX_TOOLS 条
    { name: 'read_note', ok: true, ms: 212, ts: 1785... },
    { name: 'artifact_write', ok: null, ms: null, ts: 1785... },   // ok=null 表示进行中
  ],
}
```

- `MAX_TOOLS = 20`：超出丢最旧的，行内标注 `…前 N 条已省略`。理由：一个跑飞的 agent 可能调几百次工具，无界数组会把内存和 `/agents` 响应体一起撑爆。
- `MAX_AGENTS = 50`：按 `createdAt` FIFO 淘汰**终态**条目，永不淘汰非终态条目。
- **工具调用的"进行中"状态**：`tool.call` 事件是在工具**执行完**才发的，所以流水里看不到"正在执行"。用 `round.start` 之后、下一条 `tool.call` 之前的间隙表示"思考中"，不伪造一条进行中的工具行。这一点要在注释里写清楚，否则后来者会以为漏了事件。

### 3.3 两处实现位置

| 位置 | 攒在哪 | 为什么 |
|---|---|---|
| `demo/server.js` | 服务端进程内 | Agent 在服务端；`/agents` 一并下发，刷新页面不丢状态 |
| `demo/browser.html` | 页面内 | Agent 就跑在页面里，直接 `agent.on(...)` |

`examples/subagents.js` 也需要同一份账，但它渲染完即弃，不需要淘汰策略之外的持久化。

## 4. demo 服务端改动（`demo/server.js`）

### 4.1 新增：活动账本

```js
const activity = new Map()   // agentId -> AgentActivity
function trackActivity(agent) { /* 订阅 tool.call / round.start，按 §3 规则记账 */ }
```

订阅时机：`createAgent()` 之后立即挂上（含 `/strategy` 与 `/reset` 重建 Agent 的路径 —— 重建时 `activity.clear()`）。

### 4.2 扩展：`GET /agents`

响应体在现有基础上，给每个 agent 追加 `activity` 字段：

```jsonc
{
  "enabled": true,
  "agents": [
    {
      "agentId": "agt_00000001", "name": "explorer-1", "type": "explorer",
      "state": "running", "nodeId": null, "attempt": 1,
      "metrics": { "rounds": 3, "llmCalls": 4, "toolCalls": 2, "usage": {...}, "wallClockMs": 12400 },
      "startedAt": 1785..., "endedAt": null,
      "activity": { "rounds": 3, "tools": [ { "name": "read_note", "ok": true, "ms": 212 } ], "truncated": 0 }
    }
  ],
  "graphs": [...], "artifacts": [...], "questions": [...]
}
```

**不新增端点**，只扩字段 —— 面板已经在轮询 `/agents`。

### 4.3 事件流补归属

`pipeTelemetry` 转发到 SSE 的 payload 原样带着 `agentId`，前端事件行末尾渲染 `@explorer-1`。主 agent 的事件不加标记（缺省即主）。

## 5. demo 前端面板（`demo/index.html`）

### 5.1 布局

```
🤖 SUBAGENTS                                    1 在跑 / 4 总计
──────────────────────────────────────────────────────────
▼ ● explorer-1      explorer          12.4s · 1.2k tok
    ├ read_note                    ✓   0.2s
    └ artifact_write               ●
▶ ✓ explorer-2      node=modules      8.4s · 1.1k tok · 3 步
▶ ✓ explorer-3      node=changes      7.9s · 0.9k tok · 3 步
▶ ✗ explorer-4      attempt 2          max_rounds
── 图 gph_00000001 「发布说明」 [open · active] ──────────
  ✓ modules    统计模块清单
  ✓ changes    读取变更记录
  ⏸ summary    汇总发布说明   ← modules, changes
── 产物轨 (4) ─────────────────────────────────────────
  notes/error-handling.md   sha:a2003901   explorer-1
```

### 5.2 规则

1. **展开策略**：非终态默认展开，终态默认折叠；用户手动切换后**记住该 agent 的选择**（`Set<agentId>` 记录被手动改过的，重绘时不覆盖）—— 否则 1s 一次的轮询会把用户刚展开的又折上。
2. **右侧固定三元组**：`耗时 · token · 步数`，全部取自 `metrics`。运行中 `wallClockMs` 还没落定，用 `Date.now() - startedAt` 现算。
3. **失败与重试进第一屏**：`attempt N`、`failureKind` 直接跟在名字后。现在这两个字段拿得到但没显示，一个重试过的 agent 和首次运行的长得一模一样。
   注意取值路径：`attempt` 是 `toStatus()` 顶层字段，但 **`failureKind` 不在顶层** —— 它在 `attempts[]` 里逐次尝试记录，取最后一条：`status.attempts.at(-1)?.failureKind`。`maxAttempts` 也不在快照里（它是 `Agent_Type` 的字段），所以分母写死 3 是错的：只显示 `attempt 2`，不写 `2/3`。
4. **图与产物轨维持现状**，只把节点行的 `blockedReason` 补上。

### 5.3 对话流

保持一行制：`🤖 已派出 explorer-1（explorer）` / `✅ explorer-1 完成（3 步）` / `❌ explorer-4 失败：max_rounds`。删掉现在落在对话区的 `graph.node.settled` 逐节点消息（面板里有，重复且吵）。

### 5.4 调试视角

**不另做开关。** 下方已有的事件流面板就是调试视角，只在事件行补 `@agentName` 归属标记。它是这个 demo 原本的卖点，不该被藏起来。

## 6. `demo/browser.html`

同 §5 的面板与规则，数据源换成本地 `agent.subagents` + 页面内活动账本。差异只有一处：浏览器端 Agent 的提问走 `hooks.onAskUser` 弹层（既有），不是横幅。

## 7. example 终端（`examples/subagents.js`）

### 7.1 渲染器

自包含在示例文件内（使用方拷一个文件就能跑），约 120 行。对外三个方法：

```js
const r = createRenderer()      // 自动探测 isTTY
r.log(line)                     // 普通输出，必定落在活动区上方
r.update(activityMap)           // 重绘活动区
r.done()                        // 清空活动区并恢复光标
```

### 7.2 TTY 分支

```
第 5 幕 · DAG 编排
⠋ modules    read_note          4.2s
⠋ changes    artifact_write     3.8s
⏸ summary    等上游
```

- 10fps 定时重绘：`\x1b[<n>A` 上移 + `\x1b[2K` 清行。
- 某个 agent 落终态 → 把它从活动区移除，用 `r.log()` 固化成一行 `✓ modules  3 步 · 1.1k tok · 8.4s` 打在上方。
- 活动区最多 `MAX_LIVE_ROWS = 8` 行，超出显示「还有 N 个在跑」。

### 7.3 非 TTY 分支

一个 ANSI 字节都不吐，全部退化为追加：

```
[modules] 开始（explorer）
[modules] read_note ✓
[modules] ✓ 3 步 · 1.1k tok · 8.4s
```

### 7.4 `DEBUG=1`

额外逐条打印带归属的事件：round 边界、`llm.call` 的 token 数、工具入参摘要（截断到 80 列）。默认全部不打。

### 7.5 必须处理的四个细节

1. **中文按显示宽度截断** —— CJK 字符占 2 列。需要一个 `displayWidth(str)`（`ᄀ-ᅟ`、`⺀-꓏`、`가-힣`、`豈-﫿`、`︰-﹯`、`＀-｠`、`￠-￦` 记 2，其余记 1）。按字符数截断会让中文行超宽，把活动区的行数算错，重绘位置就全乱了。
2. **按 `process.stdout.columns` 裁行**，取不到时按 80。
3. **退出前清理**：`finally` 与 `SIGINT` 都要调 `r.done()`，否则终端留残影、光标可能还是隐藏状态。
4. **所有输出统一走渲染器**，示例里不再直接 `console.log` —— 直接打会插进活动区把画面打乱。

## 8. 边界情况

| 情况 | 处理 |
|---|---|
| 工具调用超过 `MAX_TOOLS` | 环形缓冲丢最旧，行尾标 `…前 N 条已省略` |
| agent 数超过 `MAX_AGENTS` | FIFO 淘汰终态条目，非终态永不淘汰 |
| `/reset` 重建 Agent | `activity.clear()`，面板同步清空（既有行为） |
| 轮询与用户展开操作打架 | 手动切换过的 agentId 记在 `Set` 里，重绘不覆盖 |
| 运行中 `wallClockMs` 尚未落定 | 用 `Date.now() - startedAt` 现算 |
| 非终态 agent 的 `metrics` 全为 0 | 显示 `—` 而不是 `0 步 · 0 tok` |
| 终端窗口在运行中被拉窄 | 每次重绘现读 `columns` |
| 未配置 subagents（`SUBAGENTS=0`） | 面板整体隐藏（既有行为） |

## 9. 验收

沿用 `CLAUDE.md` 的 Definition of Done，本设计额外要求：

1. `node examples/subagents.js` —— TTY 下肉眼确认活动区刷新正常、结束后无残影；`node examples/subagents.js > /tmp/x.log` 确认日志里没有 ANSI 转义序列。
2. demo 两个页面各跑一遍第 4/5 幕对应的话术，确认：并发两个节点时面板同时出现两张展开的卡片、工具流水实时增长、终态后自动折叠且三元组有值、失败时 `attempt` 与 `failureKind` 可见。
3. `npm test` 保持全绿（本设计不碰 `src/`，理应零影响 —— 若有变化说明碰到了不该碰的地方）。

## 10. 文件清单

| 文件 | 改动 |
|---|---|
| `demo/server.js` | 新增活动账本 + `/agents` 扩 `activity` 字段 |
| `demo/index.html` | 面板重写（展开/折叠、三元组、失败态）、对话流精简、事件行补归属 |
| `demo/browser.html` | 同上，数据源为本地 runtime |
| `examples/subagents.js` | 内置终端渲染器，所有输出改走渲染器 |
| `demo/README.md` | 补一节「事件带归属，攒成 UI 状态是主机的活」 |
| `src/**` | **不动** |
