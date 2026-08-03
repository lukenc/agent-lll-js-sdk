# Subagent 展示层实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 subagent 的运行过程在 `demo/`（服务端页 + 浏览器页）与 `examples/subagents.js` 里实时可见、可归属，而不是从派出到回来只有两条消息的黑盒。

**Architecture:** 纯展示层。框架已经把带 `agentId` 归属的 `tool.call` / `round.start` 转发到父总线，但**刻意不缓存**"某个 agent 调过哪些工具" —— 主机要自己攒。因此核心是一个可测的活动账本 reducer（`demo/lib/activity.js`）+ 一个可测的终端渲染器（`examples/subagent-render.js`），两个 HTML 页各自消费。`src/` 一行不动。

**Tech Stack:** 原生 ESM、`node:test` + `node:assert`、无新依赖、无构建步骤（`browser.html` 仍是单文件 + IIFE bundle）。

## Global Constraints

- **不改 `src/`**。改动了说明走错了方向 —— `npm test` 的 677 条应当保持逐条不变。
- **零新依赖**。Node 18+ 内置 + 浏览器原生 API。
- **不新增写类端点**。没有取消/关图/重激活按钮（spec §1 非目标）。
- **不做 DAG 图形化绘制**、**不做产物内容预览**。
- 归属规则唯一一条：`payload.agentId ?? 'main'` —— 主 agent 自己发的 `tool.call` 不带 `agentId`，`runner._forwardTelemetry` 转发子 agent 事件时才补上。
- 生命周期事件的字段名与形状（照抄错会渲染出一串 `undefined`）：
  - `agent.spawn` → `{ agentId, agentName, parentAgentId, type, description, depth, nodeId, model, isolation }`（是 `agentName`，**不是** `name`）
  - `agent.succeeded` → `{ agentId, agentName, parentAgentId, rounds, usage, wallClockMs, artifactKeys }`
  - `agent.failed` → `{ agentId, agentName, parentAgentId, failureKind, attempts, lastError }` —— **没有** `rounds` / `usage` / `wallClockMs`；这里的 `attempts` 是**数字**，而 `toStatus().attempts` 是**数组**，名字撞了类型不同
- `failureKind` **不在** `toStatus()` 顶层，在 `attempts[]` 里：取 `status.attempts.at(-1)?.failureKind`。`maxAttempts` 不在快照里，因此只显示 `attempt 2`，不写 `2/3`。
- 常量：`MAX_TOOLS = 20`、`MAX_AGENTS = 50`、`MAX_LIVE_ROWS = 8`。
- 中文按**显示宽度**计算（CJK 占 2 列），不是字符数。
- Task 3 / 4 / 6 / 7 的验收需要**真实 API Key**（`OPENAI_API_KEY` 或 `DEEPSEEK_API_KEY`）。

## 与 spec 的一处偏离（已知并有意）

spec §7.1 写的是"渲染器自包含在 `examples/subagents.js` 内"。本计划把它拆成 `examples/subagent-render.js` + 同名测试：一个 120 行、含 ANSI 光标算术和 CJK 宽度计算的模块，内联进一个有顶层副作用的示例文件后**没有任何办法写测试**。代价是使用方要拷两个文件而不是一个，在 `subagents.js` 顶部注释里说明。

## 文件结构

| 文件 | 职责 | 新建/修改 |
|---|---|---|
| `demo/lib/activity.js` | 活动账本 reducer（纯逻辑，无 I/O） | 新建 |
| `demo/lib/activity.test.js` | 上者的单测 | 新建 |
| `demo/server.js` | 挂账本、`/agents` 扩 `activity` 字段 | 修改 |
| `demo/index.html` | 面板重写、对话流精简、事件行补归属 | 修改 |
| `demo/browser.html` | 页面内账本（约 25 行内联副本）+ 同款面板 | 修改 |
| `examples/subagent-render.js` | 终端渲染器（TTY / 非 TTY / 宽度计算） | 新建 |
| `examples/subagent-render.test.js` | 上者的单测 | 新建 |
| `examples/subagents.js` | 所有输出改走渲染器 | 修改 |
| `package.json` | `test` 脚本 glob 加上 `demo` 与 `examples` | 修改 |
| `demo/README.md` | 补「事件带归属，攒成 UI 状态是主机的活」 | 修改 |

**关于 `browser.html` 的重复实现：** 它是刻意的单文件页面，靠 IIFE bundle 跑，没有模块加载器，**无法 import `demo/lib/activity.js`**。因此页面里内联一份等价实现，并在注释里指向 `demo/lib/activity.js` 说明"那份有测试，改这里记得同步"。这比为一个 demo 页引入打包步骤划算。

---

### Task 1: 活动账本 reducer

**Files:**
- Create: `demo/lib/activity.js`
- Test: `demo/lib/activity.test.js`
- Modify: `package.json`（`scripts.test`）

**Interfaces:**
- Produces: `createActivityLedger({ maxTools = 20, maxAgents = 50 } = {})` → `{ onRoundStart(payload), onToolCall(payload), snapshot(agentId), clear() }`
  - `snapshot(agentId)` → `{ rounds: number, tools: Array<{ name, ok, ms }>, truncated: number } | null`

- [ ] **Step 1: 写失败的测试**

Create `demo/lib/activity.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert'
import { createActivityLedger } from './activity.js'

test('主 agent 的事件不带 agentId，归到 main', () => {
  const led = createActivityLedger()
  led.onToolCall({ name: 'calculate', ok: true, durationMs: 12 })
  assert.deepStrictEqual(led.snapshot('main'), { rounds: 0, tools: [{ name: 'calculate', ok: true, ms: 12 }], truncated: 0 })
})

test('转发来的子 agent 事件按 agentId 分账', () => {
  const led = createActivityLedger()
  led.onRoundStart({ agentId: 'agt_1', round: 0 })
  led.onToolCall({ agentId: 'agt_1', name: 'read_note', ok: true, durationMs: 200 })
  led.onToolCall({ agentId: 'agt_2', name: 'read_note', ok: true, durationMs: 300 })
  assert.strictEqual(led.snapshot('agt_1').tools.length, 1)
  assert.strictEqual(led.snapshot('agt_2').tools.length, 1)
  assert.strictEqual(led.snapshot('agt_1').rounds, 1)
  assert.strictEqual(led.snapshot('agt_2').rounds, 0)
})

test('rounds 取 round 字段的最大值 + 1，不是事件计数', () => {
  // 重试会让 round 从 0 重新开始；用计数会把两次尝试加起来虚报
  const led = createActivityLedger()
  led.onRoundStart({ agentId: 'a', round: 0 })
  led.onRoundStart({ agentId: 'a', round: 1 })
  led.onRoundStart({ agentId: 'a', round: 0 })
  assert.strictEqual(led.snapshot('a').rounds, 2)
})

test('工具流水超过 maxTools 时丢最旧的并计数', () => {
  const led = createActivityLedger({ maxTools: 3 })
  for (let i = 0; i < 5; i++) led.onToolCall({ agentId: 'a', name: `t${i}`, ok: true, durationMs: 1 })
  const s = led.snapshot('a')
  assert.deepStrictEqual(s.tools.map(t => t.name), ['t2', 't3', 't4'])
  assert.strictEqual(s.truncated, 2)
})

test('失败的工具调用记 ok:false', () => {
  const led = createActivityLedger()
  led.onToolCall({ agentId: 'a', name: 'boom', ok: false, durationMs: 5, errorKind: 'exception' })
  assert.deepStrictEqual(led.snapshot('a').tools, [{ name: 'boom', ok: false, ms: 5 }])
})

test('agent 数超过 maxAgents 时按插入顺序淘汰最旧的', () => {
  const led = createActivityLedger({ maxAgents: 2 })
  led.onToolCall({ agentId: 'a', name: 'x', ok: true, durationMs: 1 })
  led.onToolCall({ agentId: 'b', name: 'x', ok: true, durationMs: 1 })
  led.onToolCall({ agentId: 'c', name: 'x', ok: true, durationMs: 1 })
  assert.strictEqual(led.snapshot('a'), null)
  assert.ok(led.snapshot('b'))
  assert.ok(led.snapshot('c'))
})

test('未知 agentId 返回 null，不返回空壳', () => {
  assert.strictEqual(createActivityLedger().snapshot('nope'), null)
})

test('clear 清空全部', () => {
  const led = createActivityLedger()
  led.onToolCall({ agentId: 'a', name: 'x', ok: true, durationMs: 1 })
  led.clear()
  assert.strictEqual(led.snapshot('a'), null)
})

test('durationMs 缺失时 ms 记 null 而不是 NaN', () => {
  const led = createActivityLedger()
  led.onToolCall({ agentId: 'a', name: 'x', ok: true })
  assert.strictEqual(led.snapshot('a').tools[0].ms, null)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test demo/lib/activity.test.js`
Expected: FAIL — `Cannot find module .../demo/lib/activity.js`

- [ ] **Step 3: 写实现**

Create `demo/lib/activity.js`:

```js
/**
 * 活动账本 —— 从带归属的遥测事件里攒出"每个 agent 都调过哪些工具"。
 *
 * 框架**刻意不缓存**这份数据:`AgentHandle` 只记 metrics 聚合数,要展示流水必须
 * 主机自己攒。这是接入 subagent 时一定会遇到的第一个问题,所以这份实现同时是给
 * 使用方看的参考。
 *
 * 归属规则只有一条:`payload.agentId ?? 'main'`。主 agent 自己发的 `tool.call`
 * 不带 `agentId`,`runner._forwardTelemetry` 转发子 agent 事件时才补上。
 *
 * 注意:`tool.call` 是工具**执行完**才发的,所以流水里不存在"正在执行"的行。
 * 一个 agent 在 round.start 之后、下一条 tool.call 之前是"思考中",UI 按这个
 * 间隙表达,不要伪造一条进行中的工具行。
 */

/**
 * @param {{ maxTools?: number, maxAgents?: number }} [opts]
 *   maxTools: 每个 agent 保留的工具流水条数。一个跑飞的 agent 可能调几百次工具,
 *   无界数组会把内存和 /agents 的响应体一起撑爆。
 *   maxAgents: 账本里最多留几个 agent,按插入顺序 FIFO 淘汰。
 */
export function createActivityLedger({ maxTools = 20, maxAgents = 50 } = {}) {
  /** @type {Map<string, { rounds: number, tools: Array<{name:string, ok:boolean|null, ms:number|null}>, truncated: number }>} */
  const byAgent = new Map()

  function entry(agentId) {
    let e = byAgent.get(agentId)
    if (!e) {
      e = { rounds: 0, tools: [], truncated: 0 }
      byAgent.set(agentId, e)
      // Map 保持插入顺序,所以第一个 key 就是最旧的。
      while (byAgent.size > maxAgents) {
        const oldest = byAgent.keys().next().value
        if (oldest === agentId) break
        byAgent.delete(oldest)
      }
    }
    return e
  }

  return {
    onRoundStart(payload = {}) {
      const e = entry(payload.agentId ?? 'main')
      // 取 round 的最大值 + 1,不是事件计数 —— 重试会让 round 从 0 重来,
      // 计数会把两次尝试加起来虚报。
      const n = typeof payload.round === 'number' ? payload.round + 1 : e.rounds
      if (n > e.rounds) e.rounds = n
    },

    onToolCall(payload = {}) {
      const e = entry(payload.agentId ?? 'main')
      e.tools.push({
        name: String(payload.name ?? '?'),
        ok: typeof payload.ok === 'boolean' ? payload.ok : null,
        ms: typeof payload.durationMs === 'number' ? Math.round(payload.durationMs) : null,
      })
      while (e.tools.length > maxTools) {
        e.tools.shift()
        e.truncated += 1
      }
    },

    /** @returns {{rounds:number, tools:Array, truncated:number}|null} 未知 agent 返回 null */
    snapshot(agentId) {
      const e = byAgent.get(agentId)
      if (!e) return null
      return { rounds: e.rounds, tools: e.tools.map(t => ({ ...t })), truncated: e.truncated }
    },

    clear() {
      byAgent.clear()
    },
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test demo/lib/activity.test.js`
Expected: `# pass 9  # fail 0`

- [ ] **Step 5: 把 demo / examples 纳入测试 glob**

Modify `package.json`:

```json
"test": "node --test \"src/**/*.test.js\" \"demo/**/*.test.js\" \"examples/**/*.test.js\""
```

- [ ] **Step 6: 跑全量确认没有回归**

Run: `npm test`
Expected: `# pass 686  # fail 0`（677 + 新增 9），`src/` 那 677 条逐条不变

- [ ] **Step 7: 提交**

```bash
git add demo/lib/activity.js demo/lib/activity.test.js package.json
git commit -m "feat(demo): add attributed activity ledger for subagent display"
```

---

### Task 2: 服务端挂账本 + `/agents` 扩字段

**Files:**
- Modify: `demo/server.js`
- Test: `demo/lib/activity.test.js`（复用，不新增文件）

**Interfaces:**
- Consumes: Task 1 的 `createActivityLedger`
- Produces: `GET /agents` 的每个 agent 对象多一个 `activity: { rounds, tools, truncated } | null` 字段；`agents[]` 之外新增顶层 `main: { rounds, tools, truncated } | null`（主 agent 自己的流水，面板不显示但使用方会想要，且证明归属规则работает）

- [ ] **Step 1: 加 import 与账本实例**

Modify `demo/server.js`，在 import 段追加：

```js
import { createActivityLedger } from './lib/activity.js'
```

在 `let currentStrategy = 'react'` 附近追加：

```js
// 活动账本 —— 见 demo/lib/activity.js 的头注释:框架不缓存工具流水,主机自己攒。
const activityLedger = createActivityLedger()
```

- [ ] **Step 2: 在 createAgent 之后挂订阅**

在 `demo/server.js` 的 `createAgent()` **函数体末尾**（`return new Agent({...})` 改成先存变量再订阅）：

```js
function createAgent(strategy) {
  currentStrategy = strategy || 'react'
  if (!API_KEY) return null
  const created = new Agent({ /* ...既有配置原样不动... */ })
  // 账本跟着 Agent 走:每次重建(切策略 / 新会话)都清空,否则新会话会挂着上一轮的流水。
  activityLedger.clear()
  created.on('round.start', (p) => activityLedger.onRoundStart(p))
  created.on('tool.call', (p) => activityLedger.onToolCall(p))
  return created
}
```

- [ ] **Step 3: `/agents` 快照里带上 activity**

修改 `buildSubagentSnapshot()` 的 `agents` 映射：

```js
    agents: rt.registry.list({ includeFinished: true }).map((h) => {
      const status = h.toStatus()
      return { ...status, activity: activityLedger.snapshot(status.agentId) }
    }),
```

并在返回对象里追加：

```js
    main: activityLedger.snapshot('main'),
```

- [ ] **Step 4: 手工验证接口形状**

Run:
```bash
OPENAI_API_KEY=$OPENAI_API_KEY PORT=3111 node demo/server.js &
sleep 2
curl -sN -X POST http://localhost:3111/chat -H 'Content-Type: application/json' \
  -d '{"message":"用一个 explorer 在后台调研这个仓库的错误处理约定"}' > /dev/null
curl -s http://localhost:3111/agents | python3 -m json.tool | head -40
kill %1
```
Expected: 至少一个 agent 带 `"activity": {"rounds": N, "tools": [{"name":"read_note",...}], "truncated": 0}`，顶层 `main.tools` 里能看到 `agent` 这一条

- [ ] **Step 5: 提交**

```bash
git add demo/server.js
git commit -m "feat(demo): expose per-agent tool activity through /agents"
```

---

### Task 3: 服务端页面板重写

**Files:**
- Modify: `demo/index.html`

**Interfaces:**
- Consumes: Task 2 的 `/agents` 响应（每个 agent 带 `activity`）
- Produces: 无（页面终点）

- [ ] **Step 1: 加面板所需 CSS**

在 `demo/index.html` 的 `.sa-node { padding-left: 10px; }` 之后追加：

```css
.sa-head { display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; padding: 4px 0; }
.sa-head .sa-caret { color: #999; width: 10px; display: inline-block; }
.sa-head .sa-cost { margin-left: auto; color: #888; font-size: 10px; font-family: 'SF Mono', Menlo, monospace; }
.sa-tools { padding: 2px 0 4px 20px; }
.sa-tool { display: flex; gap: 6px; font-family: 'SF Mono', Menlo, monospace; font-size: 11px; color: #555; padding: 1px 0; }
.sa-tool .sa-tool-ms { margin-left: auto; color: #aaa; }
.sa-tool.bad { color: #b42318; }
.sa-thinking { color: #8a5a00; font-style: italic; }
.sa-truncated { color: #aaa; font-size: 10px; padding-left: 20px; }
.sa-fail { color: #b42318; font-size: 10px; }
```

- [ ] **Step 2: 加展开状态与格式化工具函数**

在 `demo/index.html` 的 `function esc(s)` 之前追加：

```js
// 用户手动切换过的 agentId。1s 一次的轮询会重绘整块 DOM —— 不记住手动选择，
// 用户刚展开的卡片下一秒就被默认策略折回去了。
const saManual = new Map()   // agentId -> boolean(expanded)

function saToggle(agentId, defaultExpanded) {
  const cur = saManual.has(agentId) ? saManual.get(agentId) : defaultExpanded
  saManual.set(agentId, !cur)
  refreshSubagents()
}

function saExpanded(a) {
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(a.state)
  return saManual.has(a.agentId) ? saManual.get(a.agentId) : !terminal
}

/** 耗时 · token · 步数。运行中 wallClockMs 还没落定，用 startedAt 现算。 */
function saCost(a) {
  const m = a.metrics || {}
  const running = !['succeeded', 'failed', 'cancelled'].includes(a.state)
  const ms = running && a.startedAt ? Date.now() - a.startedAt : m.wallClockMs
  const u = m.usage || {}
  const tok = (u.input_tokens || 0) + (u.output_tokens || 0)
  const parts = []
  if (ms) parts.push(formatDuration(ms))
  if (tok) parts.push(tok >= 1000 ? (tok / 1000).toFixed(1) + 'k tok' : tok + ' tok')
  if (m.rounds) parts.push(m.rounds + ' 步')
  return parts.length ? parts.join(' · ') : '—'
}

/** failureKind 不在 toStatus() 顶层，在 attempts[] 里逐次记录，取最后一条。 */
function saFailure(a) {
  const last = (a.attempts || []).at(-1)
  return last && last.failureKind ? last.failureKind : null
}
```

- [ ] **Step 3: 重写 renderSubagents 的 agent 段**

把 `renderSubagents(snap)` 里那段 `for (const a of agents) { ... }` 整体替换为：

```js
  for (const a of agents) {
    const expanded = saExpanded(a)
    const meta = [a.type, a.nodeId ? 'node=' + a.nodeId : null, a.attempt > 1 ? 'attempt ' + a.attempt : null]
      .filter(Boolean).join(' · ')
    const fail = saFailure(a)
    parts.push(
      `<div class="sa-head" onclick="saToggle('${esc(a.agentId)}', ${!['succeeded','failed','cancelled'].includes(a.state)})">`
      + `<span class="sa-caret">${expanded ? '▼' : '▶'}</span>`
      + `<span class="sa-state ${esc(a.state)}">${esc(a.state)}</span>`
      + `<span class="sa-name">${esc(a.name)}</span>`
      + `<span class="sa-meta">${esc(meta)}</span>`
      + (fail ? `<span class="sa-fail">${esc(fail)}</span>` : '')
      + `<span class="sa-cost">${esc(saCost(a))}</span></div>`
    )
    if (!expanded) continue
    const act = a.activity
    parts.push('<div class="sa-tools">')
    if (act && act.truncated > 0) {
      parts.push(`<div class="sa-truncated">…前 ${act.truncated} 条已省略</div>`)
    }
    for (const t of (act ? act.tools : [])) {
      const mark = t.ok === false ? '✗' : '✓'
      parts.push(`<div class="sa-tool${t.ok === false ? ' bad' : ''}">`
        + `<span>${mark} ${esc(t.name)}</span>`
        + `<span class="sa-tool-ms">${t.ms == null ? '' : t.ms + 'ms'}</span></div>`)
    }
    // tool.call 是执行完才发的，所以没有"进行中"的工具行。运行中而流水没长出新条目
    // 时，agent 正在等 LLM —— 用一行"思考中"表达，不伪造一条工具行。
    if (!['succeeded', 'failed', 'cancelled'].includes(a.state)) {
      parts.push('<div class="sa-tool sa-thinking">● 思考中…</div>')
    }
    parts.push('</div>')
  }
```

- [ ] **Step 4: 图节点补 blockedReason，对话流精简**

在 `renderSubagents` 的节点循环里，`why` 已经渲染了 `blockedReason`，确认保留即可。
在 `renderTelemetry` 里**删掉**这一段（面板里已有，重复且吵）：

```js
  if (name === 'graph.node.settled') {
    addMsg('step', `${payload.state === 'succeeded' ? '✅' : '⚠️'} 节点 ${payload.nodeId} → ${payload.state}`)
  }
```

- [ ] **Step 5: 事件行补归属**

在 `renderTelemetry` 里，`detail.textContent = formatDetail(name, payload)` 之后追加：

```js
  // 主 agent 的事件不带 agentId（缺省即主），只给子 agent 的事件打标记。
  if (payload.agentName) {
    const who = document.createElement('span')
    who.className = 'evt-meta'
    who.textContent = '@' + payload.agentName
    row.appendChild(who)
  }
```

- [ ] **Step 6: 浏览器里验证**

Run:
```bash
OPENAI_API_KEY=$OPENAI_API_KEY node demo/server.js
```
打开 `http://localhost:3000/`，依次说：
1. `用一个 explorer 在后台调研这个仓库的错误处理约定`
2. `用 agent_graph 声明一张依赖图：并行统计模块清单和变更记录，第三个节点依赖前两个负责汇总`

Expected:
- 运行中的卡片自动展开，工具流水一条条长出来，右侧耗时在走
- 并发两个节点时同时有两张展开的卡片
- 落终态后自动折叠，右侧变成 `8.4s · 1.1k tok · 3 步`
- 手动展开一张已完成的卡片，**等 3 秒不会被轮询折回去**
- 事件流面板里子 agent 的行末尾有 `@explorer-1`
- 对话区不再出现逐节点的 `节点 modules → succeeded`

- [ ] **Step 7: 提交**

```bash
git add demo/index.html
git commit -m "feat(demo): live per-subagent tool timeline in the panel"
```

---

### Task 4: 浏览器端页同款面板

**Files:**
- Modify: `demo/browser.html`

**Interfaces:**
- Consumes: 无（页面内自持 Agent）
- Produces: 无

- [ ] **Step 1: 内联账本**

在 `demo/browser.html` 的 `var BROWSER_SUBAGENT_TYPES = [` 之前追加：

```js
/**
 * 活动账本 —— 与 demo/lib/activity.js **逻辑等价的内联副本**。
 * 这个页面是刻意的单文件 + IIFE bundle，没有模块加载器，import 不进来。
 * 改这里记得同步那一份（那份有单测）。
 */
function createActivityLedger(maxTools, maxAgents) {
  maxTools = maxTools || 20
  maxAgents = maxAgents || 50
  var byAgent = new Map()
  function entry(id) {
    var e = byAgent.get(id)
    if (!e) {
      e = { rounds: 0, tools: [], truncated: 0 }
      byAgent.set(id, e)
      while (byAgent.size > maxAgents) {
        var oldest = byAgent.keys().next().value
        if (oldest === id) break
        byAgent.delete(oldest)
      }
    }
    return e
  }
  return {
    onRoundStart: function(p) {
      var e = entry((p && p.agentId) || 'main')
      var n = p && typeof p.round === 'number' ? p.round + 1 : e.rounds
      if (n > e.rounds) e.rounds = n
    },
    onToolCall: function(p) {
      p = p || {}
      var e = entry(p.agentId || 'main')
      e.tools.push({
        name: String(p.name || '?'),
        ok: typeof p.ok === 'boolean' ? p.ok : null,
        ms: typeof p.durationMs === 'number' ? Math.round(p.durationMs) : null,
      })
      while (e.tools.length > maxTools) { e.tools.shift(); e.truncated += 1 }
    },
    snapshot: function(id) {
      var e = byAgent.get(id)
      return e ? { rounds: e.rounds, tools: e.tools.slice(), truncated: e.truncated } : null
    },
    clear: function() { byAgent.clear() },
  }
}

var activityLedger = createActivityLedger()
```

- [ ] **Step 2: 在 initAgent 里订阅**

在 `demo/browser.html` 的 `agent = new Agent(agentOpts)` 之后、订阅遥测那一段之前追加：

```js
  // 重连即新会话，账本跟着清。
  activityLedger.clear()
  agent.on('round.start', function(p) { activityLedger.onRoundStart(p) })
  agent.on('tool.call', function(p) { activityLedger.onToolCall(p) })
```

- [ ] **Step 3: 复制 CSS 与展开逻辑**

把 Task 3 Step 1 的 CSS 原样加到 `demo/browser.html` 的 `.sa-node{padding-left:10px}` 之后（该文件 CSS 是单行紧凑风格，压成单行以匹配）。
把 Task 3 Step 2 的 `saManual` / `saToggle` / `saExpanded` / `saCost` / `saFailure` 五个函数加到 `renderBrowserSubagents` 之前，其中：
- `saToggle` 里的 `refreshSubagents()` 改为 `renderBrowserSubagents()`
- `formatDuration` 该文件已有，直接用

- [ ] **Step 4: 重写 renderBrowserSubagents 的 agent 段**

把 `agents.forEach(function(a) { ... })` 整段替换为 Task 3 Step 3 的同款渲染，两处差异：
- 数据源：`var act = activityLedger.snapshot(a.agentId)`（不是 `a.activity`）
- 字符串拼接用 `var` 与 `+`，不用模板字面量（与该文件既有风格一致）

- [ ] **Step 5: 浏览器里验证**

Run:
```bash
npm run build && node demo/server.js
```
打开 `http://localhost:3000/browser`，填 key → 连接 → 说 `派一个 agent 去查北京天气`，再说 `并行查北京和上海的天气，最后汇总对比`

Expected：与 Task 3 Step 6 同样的四条现象；浏览器控制台**零 error**

- [ ] **Step 6: 提交**

```bash
git add demo/browser.html
git commit -m "feat(demo): mirror the live subagent panel in the browser-side demo"
```

---

### Task 5: 终端渲染器

**Files:**
- Create: `examples/subagent-render.js`
- Test: `examples/subagent-render.test.js`

**Interfaces:**
- Produces:
  - `displayWidth(str): number` —— CJK 记 2 列
  - `truncateToWidth(str, cols): string` —— 按显示宽度截断，超出时结尾补 `…`
  - `formatSettled({ label, rounds, tokens, ms, ok }): string` —— 固化行，如 `✓ modules    3 步 · 1.1k tok · 8.4s`
  - `formatLive({ label, detail, ms }, frame): string` —— 活动行，如 `⠋ modules    read_note        4.2s`
  - `createRenderer({ stream = process.stdout, isTTY = stream.isTTY, maxRows = 8 } = {})` → `{ log(line), update(rows), settle(row), done() }`

- [ ] **Step 1: 写失败的测试**

Create `examples/subagent-render.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert'
import { displayWidth, truncateToWidth, formatSettled, formatLive, createRenderer } from './subagent-render.js'

test('displayWidth: CJK 记 2 列，ASCII 记 1 列', () => {
  assert.strictEqual(displayWidth('abc'), 3)
  assert.strictEqual(displayWidth('模块清单'), 8)
  assert.strictEqual(displayWidth('a模块'), 5)
  assert.strictEqual(displayWidth(''), 0)
})

test('truncateToWidth 按显示宽度而不是字符数截断', () => {
  // 6 个字符 = 12 列；截到 8 列应当只剩 3 个汉字 + 省略号
  assert.strictEqual(displayWidth(truncateToWidth('统计模块清单表', 8)) <= 8, true)
  assert.strictEqual(truncateToWidth('abcdef', 100), 'abcdef')
  assert.strictEqual(truncateToWidth('abcdef', 4), 'abc…')
})

test('formatSettled 成功与失败前缀不同', () => {
  const ok = formatSettled({ label: 'modules', rounds: 3, tokens: 1100, ms: 8400, ok: true })
  assert.match(ok, /^✓ modules/)
  assert.match(ok, /3 步/)
  assert.match(ok, /1\.1k tok/)
  assert.match(ok, /8\.4s/)
  assert.match(formatSettled({ label: 'x', rounds: 1, tokens: 0, ms: 100, ok: false }), /^✗ x/)
})

test('formatLive 带 spinner 帧', () => {
  const line = formatLive({ label: 'modules', detail: 'read_note', ms: 4200 }, 0)
  assert.match(line, /modules/)
  assert.match(line, /read_note/)
  assert.match(line, /4\.2s/)
  assert.notStrictEqual(formatLive({ label: 'a', detail: '', ms: 0 }, 0), formatLive({ label: 'a', detail: '', ms: 0 }, 1))
})

/** 收集写入内容的假 stream */
function fakeStream(isTTY) {
  const chunks = []
  return { isTTY, columns: 80, write: (s) => { chunks.push(s); return true }, out: () => chunks.join('') }
}

test('非 TTY:一个 ANSI 字节都不吐', () => {
  const s = fakeStream(false)
  const r = createRenderer({ stream: s, isTTY: false })
  r.log('第 5 幕')
  r.update([{ label: 'modules', detail: 'read_note', ms: 4200 }])
  r.settle(formatSettled({ label: 'modules', rounds: 3, tokens: 1100, ms: 8400, ok: true }))
  r.done()
  assert.ok(!/\x1b\[/.test(s.out()), '非 TTY 输出里不应出现 ANSI 转义')
  assert.match(s.out(), /第 5 幕/)
  assert.match(s.out(), /modules/)
})

test('非 TTY:update 不重复刷屏，只在内容变化时追加一行', () => {
  const s = fakeStream(false)
  const r = createRenderer({ stream: s, isTTY: false })
  r.update([{ label: 'a', detail: 'read_note', ms: 1 }])
  r.update([{ label: 'a', detail: 'read_note', ms: 2 }])   // detail 没变 → 不再打
  r.update([{ label: 'a', detail: 'artifact_write', ms: 3 }])
  assert.strictEqual(s.out().match(/read_note/g).length, 1)
  assert.strictEqual(s.out().match(/artifact_write/g).length, 1)
})

test('TTY:重绘会先上移并清掉上一次的行数', () => {
  const s = fakeStream(true)
  const r = createRenderer({ stream: s, isTTY: true })
  r.update([{ label: 'a', detail: '', ms: 0 }, { label: 'b', detail: '', ms: 0 }])
  const before = s.out()
  r.update([{ label: 'a', detail: '', ms: 0 }, { label: 'b', detail: '', ms: 0 }])
  const added = s.out().slice(before.length)
  assert.match(added, /\x1b\[2A/, '两行活动区应当上移 2 行')
  assert.match(added, /\x1b\[2K/, '应当逐行清除')
})

test('TTY:活动行超过 maxRows 时收敛成一行提示', () => {
  const s = fakeStream(true)
  const r = createRenderer({ stream: s, isTTY: true, maxRows: 2 })
  r.update([1, 2, 3, 4].map(i => ({ label: 'a' + i, detail: '', ms: 0 })))
  assert.match(s.out(), /还有 2 个/)
})

test('done 之后再 update 不再写任何东西', () => {
  const s = fakeStream(true)
  const r = createRenderer({ stream: s, isTTY: true })
  r.update([{ label: 'a', detail: '', ms: 0 }])
  r.done()
  const before = s.out().length
  r.update([{ label: 'b', detail: '', ms: 0 }])
  assert.strictEqual(s.out().length, before)
})

test('done 恢复光标显示', () => {
  const s = fakeStream(true)
  const r = createRenderer({ stream: s, isTTY: true })
  r.update([{ label: 'a', detail: '', ms: 0 }])
  r.done()
  assert.match(s.out(), /\x1b\[\?25h/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test examples/subagent-render.test.js`
Expected: FAIL — `Cannot find module .../examples/subagent-render.js`

- [ ] **Step 3: 写实现**

Create `examples/subagent-render.js`:

```js
/**
 * 终端渲染器 —— 把并发 subagent 的进展画成一个活动区。
 *
 * 接终端(TTY)时底部维持一块原地刷新的区域,每个在跑的 agent 占一行;某个 agent
 * 落终态就把它固化成一行打在活动区上方。被重定向到文件/管道时**整块降级**为逐行
 * 追加,一个 ANSI 字节都不吐 —— 否则日志里全是转义序列,没法看。
 *
 * 拆成独立文件而不是内联进 examples/subagents.js:ANSI 光标算术和 CJK 宽度计算
 * 是这里最容易写错的两处,内联进一个有顶层副作用的示例文件就没法写测试了。
 */

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/**
 * 字符串的**显示宽度**。CJK / 全角字符占 2 列。
 * 按字符数算会让中文行超宽,把活动区的行数算错,重绘的上移行数就跟着错,画面会烂。
 */
export function displayWidth(str) {
  let w = 0
  for (const ch of String(str ?? '')) {
    const c = ch.codePointAt(0)
    w += (
      (c >= 0x1100 && c <= 0x115f) ||   // 韩文字母
      (c >= 0x2e80 && c <= 0xa4cf) ||   // CJK 部首 · 汉字 · 假名
      (c >= 0xac00 && c <= 0xd7a3) ||   // 韩文音节
      (c >= 0xf900 && c <= 0xfaff) ||   // CJK 兼容汉字
      (c >= 0xfe30 && c <= 0xfe6f) ||   // CJK 兼容标点
      (c >= 0xff00 && c <= 0xff60) ||   // 全角 ASCII
      (c >= 0xffe0 && c <= 0xffe6)      // 全角符号
    ) ? 2 : 1
  }
  return w
}

/** 按显示宽度截断,超出时结尾补 `…`（省略号本身占 1 列，已计入）。 */
export function truncateToWidth(str, cols) {
  const s = String(str ?? '')
  if (displayWidth(s) <= cols) return s
  let out = ''
  let w = 0
  for (const ch of s) {
    const cw = displayWidth(ch)
    if (w + cw > cols - 1) break
    out += ch
    w += cw
  }
  return out + '…'
}

function fmtMs(ms) {
  if (!ms) return ''
  if (ms < 1000) return Math.round(ms) + 'ms'
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's'
  return Math.floor(ms / 60000) + 'm' + Math.round((ms % 60000) / 1000) + 's'
}

function fmtTok(n) {
  if (!n) return ''
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k tok' : n + ' tok'
}

function pad(label, cols) {
  const w = displayWidth(label)
  return label + ' '.repeat(Math.max(1, cols - w))
}

/** 固化行:`✓ modules    3 步 · 1.1k tok · 8.4s` */
export function formatSettled({ label, rounds, tokens, ms, ok = true }) {
  const bits = [rounds ? rounds + ' 步' : '', fmtTok(tokens), fmtMs(ms)].filter(Boolean)
  return `${ok ? '✓' : '✗'} ${pad(String(label), 12)}${bits.join(' · ')}`
}

/** 活动行:`⠋ modules    read_note        4.2s` */
export function formatLive({ label, detail, ms }, frame = 0) {
  return `${SPINNER[frame % SPINNER.length]} ${pad(String(label), 12)}${pad(String(detail ?? ''), 18)}${fmtMs(ms)}`
}

/**
 * @param {{ stream?: NodeJS.WriteStream, isTTY?: boolean, maxRows?: number }} [opts]
 */
export function createRenderer({ stream = process.stdout, isTTY = stream.isTTY, maxRows = 8 } = {}) {
  let liveLines = 0        // 当前活动区占了几行
  let frame = 0
  let finished = false
  let lastKey = ''         // 非 TTY 下用来抑制重复行

  const cols = () => stream.columns || 80

  function clearLive() {
    if (!isTTY || liveLines === 0) return
    // 光标此刻在活动区下方一行:逐行上移并清除。
    stream.write(`\x1b[${liveLines}A`)
    for (let i = 0; i < liveLines; i++) stream.write('\x1b[2K\x1b[1B')
    stream.write(`\x1b[${liveLines}A`)
    liveLines = 0
  }

  function writeLive(rows) {
    const shown = rows.slice(0, maxRows)
    const lines = shown.map(r => truncateToWidth(formatLive(r, frame), cols()))
    if (rows.length > shown.length) lines.push(`  …还有 ${rows.length - shown.length} 个在跑`)
    for (const l of lines) stream.write(l + '\n')
    liveLines = lines.length
  }

  return {
    /** 普通输出。必定落在活动区上方。 */
    log(line = '') {
      if (finished) return
      clearLive()
      stream.write(line + '\n')
    },

    /** 固化一行（某个 agent 落终态）。语义等同 log，单独开一个名字是为了读起来清楚。 */
    settle(line) {
      this.log(line)
    },

    /** 重绘活动区。rows: Array<{label, detail, ms}> */
    update(rows = []) {
      if (finished) return
      if (!isTTY) {
        // 降级:只在"某一行的内容真的变了"时追加一条，否则 10fps 会把日志刷爆。
        const key = rows.map(r => `${r.label}|${r.detail}`).join(';')
        if (key === lastKey || rows.length === 0) return
        lastKey = key
        for (const r of rows) stream.write(`[${r.label}] ${r.detail || '进行中'}\n`)
        return
      }
      if (liveLines === 0) stream.write('\x1b[?25l')   // 隐藏光标
      clearLive()
      frame += 1
      writeLive(rows)
    },

    /** 清空活动区并恢复光标。finally 与 SIGINT 都必须调,否则终端留残影。 */
    done() {
      if (finished) return
      finished = true
      if (isTTY) {
        clearLive()
        stream.write('\x1b[?25h')   // 恢复光标
      }
    },
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test examples/subagent-render.test.js`
Expected: `# pass 10  # fail 0`

- [ ] **Step 5: 跑全量**

Run: `npm test`
Expected: `# pass 696  # fail 0`（677 + 9 + 10）

- [ ] **Step 6: 提交**

```bash
git add examples/subagent-render.js examples/subagent-render.test.js
git commit -m "feat(examples): add TTY-aware subagent progress renderer"
```

---

### Task 6: 示例改走渲染器

**Files:**
- Modify: `examples/subagents.js`

**Interfaces:**
- Consumes: Task 5 的 `createRenderer` / `formatSettled`
- Produces: 无（示例终点）

- [ ] **Step 1: 引入渲染器与活动状态**

在 `examples/subagents.js` 的 import 段追加：

```js
import { createRenderer, formatSettled } from './subagent-render.js'
```

在 `const seen = {...}` 附近追加：

```js
const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true'
const render = createRenderer()
/** agentId -> { label, detail, ms, startedAt } —— 只放**在跑**的，落终态即移除 */
const live = new Map()
let ticker = null

function startTicker() {
  if (ticker) return
  ticker = setInterval(() => {
    const now = Date.now()
    render.update([...live.values()].map(v => ({ label: v.label, detail: v.detail, ms: now - v.startedAt })))
    if (live.size === 0) { clearInterval(ticker); ticker = null; render.update([]) }
  }, 100)
  ticker.unref?.()
}
```

- [ ] **Step 2: 事件订阅改写**

把现有的 6 个 `agent.on(...)` 订阅整体替换为：

```js
agent.on('tool.call', (p) => {
  seen.toolCalls++
  if (p.agentId && live.has(p.agentId)) live.get(p.agentId).detail = p.name
  if (DEBUG) render.log(`    · [tool.call] ${p.name} ${p.ok === false ? '✗ ' + p.errorKind : ''} @${p.agentName ?? 'main'}`)
})
agent.on('round.start', (p) => {
  if (DEBUG) render.log(`    · [round.start] #${p.round} @${p.agentName ?? 'main'}`)
})
agent.on('llm.call', (p) => {
  if (DEBUG) {
    render.log(`    · [llm.call] ${p['gen_ai.usage.input_tokens'] ?? '—'}↓/${p['gen_ai.usage.output_tokens'] ?? '—'}↑ @${p.agentName ?? 'main'}`)
  }
})
agent.on('agent.spawn', (p) => {
  seen.spawn++
  // payload 的字段名是 agentName（不是 name），且一定带 agentId。
  live.set(p.agentId, { label: p.nodeId ?? p.agentName, detail: '启动中', startedAt: Date.now() })
  render.log(`🤖 派出 ${p.agentName}（${p.type ?? '?'}）`)
  startTicker()
})
agent.on('agent.succeeded', (p) => {
  seen.succeeded++
  live.delete(p.agentId)
  const u = p.usage || {}
  render.settle(formatSettled({
    label: p.agentName, rounds: p.rounds,
    tokens: (u.input_tokens || 0) + (u.output_tokens || 0),
    ms: p.wallClockMs, ok: true,
  }))
})
agent.on('agent.failed', (p) => {
  seen.failed++
  live.delete(p.agentId)
  // 注意：`agent.failed` 的 payload 与 `agent.succeeded` **不同构** —— 它只有
  // { agentId, agentName, parentAgentId, failureKind, attempts, lastError }，
  // 没有 rounds / usage / wallClockMs。照着成功那条抄会渲染出一串 undefined。
  // 另外这里的 `attempts` 是**数字**（第几次尝试），而 `toStatus().attempts` 是
  // 数组，名字撞了但类型不同，别混用。
  render.settle(`✗ ${p.agentName}  ${p.failureKind ?? '失败'}（尝试 ${p.attempts} 次）`)
  if (p.lastError) render.log(`    · ${String(p.lastError).slice(0, 120)}`)
})
agent.on('agent.cancelled', (p) => { live.delete(p.agentId) })
agent.on('artifact.write', (p) => {
  seen.artifacts++
  render.log(`    · 产物 ${p.key} sha:${p.sha} by ${p.agentName}`)
})
agent.on('graph.node.settled', (p) => { seen.graphNodes++ })
agent.on('ask.user', () => { seen.asks++ })
agent.on('run.keep_alive.timeout', (p) => render.log(`    · keep-alive 等了 ${Math.round(p.waitedMs)}ms`))
```

- [ ] **Step 3: 所有 console 输出改走 render.log**

把 `examples/subagents.js` 里所有 `console.log(...)` 替换为 `render.log(...)`，`console.error(...)` 替换为 `render.log(...)`（退出码逻辑那几行除外，见 Step 5）。涉及 `check()`、`section()`、`act()` 与开头的配置打印。

`section()` 改为：

```js
function section(title) {
  render.log(`\n${'━'.repeat(72)}\n${title}\n${'━'.repeat(72)}`)
}
```

- [ ] **Step 4: 收尾清理**

在 `finally` 块最前面追加：

```js
  if (ticker) clearInterval(ticker)
  render.done()
```

并在文件靠前处（`const render = ...` 之后）追加：

```js
// Ctrl-C 也要清活动区并恢复光标，否则终端留残影、光标可能一直是隐藏的。
process.on('SIGINT', () => { render.done(); process.exit(130) })
```

- [ ] **Step 5: 顶部注释说明两文件**

把文件头注释的运行说明改为：

```
 * 运行（需要真实 API Key）:
 *
 *   OPENAI_API_KEY=sk-xxx node examples/subagents.js
 *   DEBUG=1 OPENAI_API_KEY=sk-xxx node examples/subagents.js   # 逐条打印带归属的事件
 *
 * 终端进度条的实现在同目录的 subagent-render.js —— 拷贝这个示例时两个文件一起拷。
```

- [ ] **Step 6: TTY 下验证**

Run: `OPENAI_API_KEY=$OPENAI_API_KEY node examples/subagents.js`
Expected:
- 第 4/5 幕能看到活动区里的 spinner 在转、`detail` 随工具调用变化
- 并发两个节点时活动区同时有两行
- 每个 agent 结束时活动区少一行、上方多一行 `✓ …`
- 跑完后终端**没有残影**，光标可见（随便敲个 `ls` 确认）
- 退出码 0（`echo $?`）

- [ ] **Step 7: 管道下验证**

Run: `OPENAI_API_KEY=$OPENAI_API_KEY node examples/subagents.js > /tmp/sub.log 2>&1; echo "exit=$?"`
Then: `grep -c $'\x1b\\[' /tmp/sub.log`
Expected: `0`（一个 ANSI 转义都没有），`exit=0`，日志里能看到 `[modules] read_note` 这类降级行

- [ ] **Step 8: DEBUG 验证**

Run: `DEBUG=1 OPENAI_API_KEY=$OPENAI_API_KEY node examples/subagents.js 2>&1 | grep -c '@explorer'`
Expected: 大于 0 —— 带归属的事件行确实打出来了

- [ ] **Step 9: 提交**

```bash
git add examples/subagents.js
git commit -m "feat(examples): render live subagent progress in the terminal"
```

---

### Task 7: 文档与全量验收

**Files:**
- Modify: `demo/README.md`

- [ ] **Step 1: 补一节**

在 `demo/README.md` 的「用法四：Subagent」一节末尾追加：

```markdown
### 事件带归属，攒成 UI 状态是主机的活

`runner._forwardTelemetry` 把每个 subagent 的 `llm.call` / `tool.call` /
`round.start` / `round.end` 转发到**父 agent 的同一条总线**上，并补上 `agentId`
与 `agentName`。主 agent 自己发的事件不带这两个字段 —— 所以归属规则只有一条：

```js
const owner = payload.agentId ?? 'main'
```

但框架**刻意不缓存**"某个 agent 都调过哪些工具"：`AgentHandle` 只记 `metrics`
聚合数。要在界面上画出工具流水，主机必须自己从事件流攒一份账。两个 demo 页面各
示范了一遍：

- 服务端页：`demo/lib/activity.js`（有单测），`/agents` 响应里每个 agent 带
  `activity: { rounds, tools, truncated }`
- 浏览器页：同一份逻辑的内联副本（单文件页面没有模块加载器，import 不进来）

两处都有上限（每个 agent 最多 20 条工具流水、最多 50 个 agent），因为一个跑飞的
agent 可能调几百次工具，无界数组会把内存和响应体一起撑爆。
```

- [ ] **Step 2: 全量测试**

Run: `npm test`
Expected: `# pass 696  # fail 0`，且 `src/` 的 677 条一条不少、一条不变

- [ ] **Step 3: 构建**

Run: `npm run build`
Expected: `dist/lll-web-agent.js` 生成成功

- [ ] **Step 4: 按 CLAUDE.md 的 Definition of Done 走一遍**

- `OPENAI_API_KEY=… node examples/subagents.js` → 断言全绿、退出码 0
- `OPENAI_API_KEY=… node demo/server.js` → `/` 与 `/browser` 各跑一遍第 4/5 幕话术
- 浏览器控制台零 error
- 记录实际执行的命令与输出，写进交付说明

- [ ] **Step 5: 提交**

```bash
git add demo/README.md
git commit -m "docs(demo): explain event attribution and host-side activity ledger"
```

---

## 自查

**Spec 覆盖：**

| spec 节 | 对应任务 |
|---|---|
| §3.1 归属规则 | Task 1（reducer 默认 `main`）+ Task 3 Step 5（事件行标记） |
| §3.2 活动流水账（MAX_TOOLS / MAX_AGENTS / 不伪造进行中） | Task 1 + Task 3 Step 3（思考中行） |
| §3.3 两处实现位置 | Task 2（服务端）+ Task 4（页面内联副本） |
| §4.1 账本 | Task 2 Step 1–2 |
| §4.2 `/agents` 扩字段 | Task 2 Step 3 |
| §4.3 事件流补归属 | Task 3 Step 5 |
| §5.1 布局 | Task 3 Step 1–3 |
| §5.2 四条规则（展开/三元组/失败态/blockedReason） | Task 3 Step 2–4 |
| §5.3 对话流精简 | Task 3 Step 4 |
| §5.4 不另做调试开关 | 计划中无此项任务 = 保持现状，符合 |
| §6 browser.html | Task 4 |
| §7.1–7.4 渲染器 / TTY / 非 TTY / DEBUG | Task 5 + Task 6 |
| §7.5 四个细节（宽度/裁行/清理/统一出口） | Task 5 Step 3（前两项）+ Task 6 Step 3–4（后两项） |
| §8 边界情况 | 逐条落在 Task 1（前两条）、Task 2 Step 2（reset 清空）、Task 3 Step 2（展开冲突、运行中耗时、metrics 为 0 显示 `—`）、Task 5（终端宽度现读） |
| §9 验收 | Task 7 Step 2–4 |
| §10 文件清单 | 与本计划「文件结构」一致，另加 `package.json`（测试 glob）与两个测试文件 |

**类型一致性：** `createActivityLedger` 的 `snapshot()` 在 Task 1 定义为返回 `{rounds, tools, truncated} | null`，Task 2 Step 3、Task 3 Step 3、Task 4 Step 4 都按这个形状消费，未知 agent 一律判 `null`。`createRenderer` 的四个方法（`log` / `settle` / `update` / `done`）在 Task 5 定义、Task 6 全部按名使用。

**已知缺口（有意留下）：** `demo/browser.html` 的内联账本没有单测 —— 单文件页面没法 import 被测模块，只能靠 Task 4 Step 5 的浏览器验证兜底。注释里已指向有测试的那一份。
