# lll-web-agent SDK 问题报告：后台 subagent 委派在主 agent 收尾时被静默弃置

- **报告对象**：`lll-web-agent` SDK 维护者
- **SDK 版本**：`0.9.0`（git HEAD `5bce8ee`）
- **调用方**：`edu-desktop-app`（Electron 三进程桌面应用，agent 跑在 main 进程）
- **报告日期**：2026-09-07
- **复现脚本**：`docs/repro/keepalive-sticky.mjs`（本报告附录 A 有全文，可直接在 SDK 仓库根目录 `node` 跑，零依赖、零改动）

---

## 0. 一句话结论

**当主 agent 派了后台 subagent、并且一次 keep-alive 等待超时之后，主 agent 会在「仍有子 agent 在飞」的状态下结束整个 run，对外报告 `stopReason: 'completed'`；那些子 agent 从此进入无人认领的状态 —— 没有人取消它们，没有人给它们超时，它们的结果也没有任何去处。**

对用户呈现的现象就是：主 agent 说「等 subagent 完成会自动通知我」，然后它停了，subagent 也停了（实际上 subagent 没停，但再也产不出任何可见结果，等同于停了）。

这不是罕见路径。在我们真实的多产物并行任务里 **5/5 次全部触发**（见 §6）。最终结果是模型自己学会了不再委派 —— 它在连续三次委派失败后放弃 subagent，改为自己串行干完全部工作。

---

## 1. 环境与我们的配置

主 agent 的构造参数（`src/main/ai-agent/create-agent.ts`）：

```js
new Agent({
  // ...provider / model / tools
  maxRounds: 50,
  subagents: {
    maxConcurrent: 4,
    maxDepth: 2,
    keepAliveTimeoutMs: 240_000,   // 240s，我们显式传的，不是 SDK 默认的 600s
  },
})
```

`keepAliveTimeoutMs` 之所以是 240s 而不是默认的 600s：我们另外给 `agent.stream()` 包了一层流静默看门狗（660s）。因为 subagent 的活动只走 telemetry bus、**不进父 agent 的 `stream()`**，主 agent 在 `_keepAliveOnce()` 里干等时对看门狗而言与断网无异，所以 keep-alive 必须先到点、把流唤醒。这条排序不变量我们甚至写成了模块加载时的 `throw`（`src/main/ai-agent/timeouts.ts`）。

**也就是说：240s 这个值不是随手填的，它是被我们另一条保护机制倒逼出来的下限附近取值。SDK 默认 600s 会让问题更晚出现，但不会让它消失**（§6 里 453s / 459s 的两次 run 就是证据）。

---

## 2. 最小复现

### 2.1 怎么跑

```bash
cd /path/to/agent-lll-js-sdk        # SDK 仓库根目录
node /path/to/keepalive-sticky.mjs   # 或 LLL_SDK=/abs/path/to/src/agent.js node ...
```

脚本 mock 掉 `globalThis.fetch`，不碰网络、不碰我们的应用代码。它构造的正是真实场景的形状：

- 主 agent 第 0 轮调 `agent` 工具派一个后台子 agent；
- 之后每一轮主 agent **只输出文本、不带工具调用**，内容是「子 agent 还在跑，我继续等它的通知」—— 这就是模型在真实对话里干的事（§6 有原文）；
- 子 agent 的那次 LLM 请求永久挂起（既不 resolve 也不 reject）—— 模拟一次「憋大招」式的大 payload 生成。

为了让复现秒级完成，`keepAliveTimeoutMs` 缩到 300ms。**缩放只改变触发时刻，不改变行为**：我们在生产值 240s 下也复现过（§6 的五次 run 就是）。

### 2.2 实际输出

```
--- run 结束时的状态 ---
主 agent 的最终回答      : "第 3 轮：子 agent 还在跑，我继续等它的通知。"
lastStopReason           : completed
run 耗时 ms              : 305 (keepAliveTimeoutMs=300)
主 agent 轮数            : 3
keep_alive.timeout 次数  : 1 [{"pendingAgents":1,"pendingNodes":0,"waitedMs":301.472666}]
子 agent 终态/重试事件   : 0 []
run 结束时 hasInFlight() : true
注册表（含终态）         : [ 'general-purpose-1:running' ]
子 agent 的 LLM 调用次数 : 1
子 agent signal 被 abort : null

--- run 结束 800ms 后 ---
hasInFlight()            : true
子 agent 终态/重试事件   : 0
_pendingInjections       : 0

--- 断言 ---
全部断言通过 —— 缺陷复现成功。
```

（上面是 2026-09-07 在 SDK HEAD `5bce8ee` 上重跑的原样输出。`run 耗时` 和 `waitedMs` 两个数会随机器抖动几毫秒，其余每一行都是确定的。）

五个断言逐条对应的含义：

| 断言 | 含义 |
|---|---|
| `keepAliveTimeouts.length === 1` | keep-alive 确实超时过一次，闸门已落下 |
| `hasInFlight() === true` | **run 结束时子 agent 仍在飞** |
| `lastStopReason === 'completed'` | 对外却报告「正常完成」 |
| `terminalEvents.length === 0` | 子 agent 没有 succeeded / failed / cancelled / retry 中的任何一个 |
| `childSignalAborted === null` | 子 agent 的 AbortSignal 从未被 abort —— 它没被取消，只是被丢下了 |

---

## 3. 缺陷一（核心）：粘性 keep-alive 闸门让「模型想继续等」和「模型说完了」无法区分

### 3.1 代码路径

`src/agent.js:1651` `_keepAliveOnce()` 的三道判断，第二道就是闸门：

```js
async _keepAliveOnce({ signal } = {}) {
  if (!this.subagents || !this.subagents.keepAlive) return 'idle'

  // (1) 待注入消息先于任何在飞判断
  if (this._pendingInjections.length > 0) return 'injected'

  // (2) 本 run 已经等超时过一次就不再等第二次
  if (this.lastKeepAliveTimedOut) return 'idle'        // ← 闸门，:1665

  // (3) 没有在飞的就收尾
  if (!this.subagents.hasInFlight()) return 'idle'

  const outcome = await this.subagents.nextEvent({ signal, timeoutMs: ... })
  if (outcome === 'timeout') {
    this.lastKeepAliveTimedOut = true                   // ← :1677，此后再不重置
    this._safeEmit('run.keep_alive.timeout', {...})
    this.enqueueMessage({ role: 'user', content: '<agent-notification>还有 N 个 agent、M 个图节点未完成，但已等待超过 …ms。请收尾：说明哪些工作仍在进行，或用 agent_cancel 取消它们。</agent-notification>' })
  }
  return outcome
}
```

`lastKeepAliveTimedOut` 只在一处被重置：run 入口（`:1141` `_runWithSession` / `:1213` `_runWithSessionStream`）。**它在整个 run 内是粘性的。**

而调用方把 `'idle'` 当成「模型说完了」：

```js
// _reactLoop :1979-1988（_reactLoopStream :2197-2207 完全同形）
if (toolCalls.length === 0) {
  this.memory.add({ role: 'assistant', content: textContent })
  const outcome = await this._keepAliveOnce({ signal })
  if (outcome !== 'idle') continue
  this.lastStopReason = 'completed'          // ← 与 hasInFlight() 无关
  yield { type: 'done', content: textContent, stopReason: 'completed' }
  return
}
```

**关键：`'idle'` 这个返回值同时承载三种完全不同的语义**，调用点无法区分：

1. keep-alive 没开（`!this.subagents.keepAlive`）
2. 真的没有在飞的东西了（`!hasInFlight()`）—— 唯一的「真完成」
3. **还有东西在飞，但本 run 已经超时过一次了**（粘性闸门）

第 3 种被当成第 2 种处理，于是 `stopReason` 写成 `'completed'`。

### 3.2 我们知道这是有意设计，问题在于它的前提

`src/agent.js:277` 的 JSDoc 和 `:1665` 上方的内联注释都写得很清楚，我们完整引用，因为它就是本报告要讨论的那个决定：

> (2) 本 run 已经等超时过一次就不再等第二次。超时那次已经给模型留了「收尾或 agent_cancel」的话；它若不接手，再等一个完整超时只是把同一次干等重放一遍 —— `maxRounds` 默认 300，那是 300 × 10 分钟 ≈ 50 小时的挂起和 300 次超时事件。注意这道闸在 (1) 之后：抑制的是第二次**等待**，不是第二次**投递**，迟到的完成通知照样会被 (1) 接住。

而 keep-alive 这套机制**本身**要修的那个洞，`CHANGELOG.md:147-149` 是这样描述的：

> 洞：编排者派出三个后台 agent 并说"我等它们回来"，ReAct 循环却在这句话之后立即返回，结果回来时已经没人读了。

**这正是本报告描述的现象，一字不差。** keep-alive 修好了它 —— 但只修好了第一次超时之前。粘性闸门落下之后，同一个洞以完全相同的形状重新打开：编排者说「我等它们回来」，循环立即返回，回来时没人读了。§6.3 里模型那四段原话（「完成后会自动通知我」「我选择让它们继续跑完」）就是这个洞在真实对话里的样子，而它们出现在 keep-alive 已经上线的版本上。

换句话说：**keep-alive 的保险丝是一次性的，烧掉之后系统退回到它被设计来修复的那个状态。**

这个理由在「防止 50 小时挂起」这个目标上完全成立，我们不是来要求删掉它的。**问题是它把「防挂起」的责任放在了错误的位置上**：

- 它防的是「主 agent 反复干等」。但真正的挂起风险来源不是主 agent 的等待（那个等待有 `keepAliveTimeoutMs` 兜着，是有界的），而是**子 agent 那次没有任何超时保护的 LLM 调用**（§4）。
- 闸门落下后，主 agent 唯一能做的「接手」动作是 `agent_cancel`。但模型不会取消 —— 因为工具描述（`src/agents/tools.js:39`）刚刚告诉过它：

  > `'Agents run in the background by default; you will be notified when one completes. '`

  而 keep-alive 注入的那句「请收尾」也没有说「不会再有第二次通知了」。所以模型的合理推断是：*任务很重，超过 4 分钟正常，我继续等通知*。这正是 §6 里那五次 run 中模型的原话。
- 于是闸门 + 模型的合理推断 = **模型说一句「我继续等」，整个 run 就地终止**。而 run 一终止，(1) 那条「迟到的通知照样会被接住」的补救也一起失效了 —— 队列再也没有人去排空。

换句话说：这道闸门把「模型表达『我要继续等』」这个合法意图，翻译成了「run 结束」。

### 3.3 根子上的设计缺口：模型没有办法表达「继续等」

React loop 用「这一轮没有工具调用」来推断「模型认为自己完成了」。这个推断在没有后台任务时是对的。一旦有了后台任务，它就漏了一种状态：**模型认为自己的工作暂时做完了，但在等别人**。

现在的 SDK 里，模型想表达这个状态只有两条路，一条通向错误结局，另一条是空转烧钱：

| 模型的做法 | 结果 |
|---|---|
| 输出一段不含工具调用的文本（「我继续等通知」） | `_keepAliveOnce()` → 粘性闸门 → `'idle'` → run 结束，`stopReason: 'completed'` |
| 反复调 `agent_status` 空转 | 带工具调用的轮次不会走到 `_keepAliveOnce()`，所以这条路**确实**能绕开闸门 —— 但它没有任何休眠手段，会以「一次完整 LLM 调用」的速度空转直到 `maxRounds` 耗尽（我们的配置是 50）。这不是等待，是烧 token 赛跑 |

**建议：给模型一个显式的「等待」原语。** 例如 `agent_wait({ timeoutMs?, agent_id? })` 工具：

- 它的 `execute` 就是 `runtime.nextEvent({ signal, timeoutMs })`，把 `'event' | 'timeout'` 作为工具结果返回给模型；
- 有了它，「没有工具调用」重新变成一个可靠的完成信号，粘性闸门可以保留（甚至可以直接去掉，因为等待变成了模型的显式选择、有 `maxRounds` 兜底）；
- 它同时解决了 §5：等待是模型主动发起的，`stopReason` 就不会再和「工作还在飞」矛盾。

这条建议的成本很低（一个工具，复用已有的 `nextEvent`），收益是把一个静默的正确性问题变成一个显式的、模型可见的控制流。

---

## 4. 缺陷二：子 agent 完全没有超时保护，run 结束后进入无人认领状态

这一节是缺陷一的必要配套。**只修缺陷一（去掉闸门 / 加 `agent_wait`）而不修这一节，会把「提前弃置」变成「永久挂起」** —— 因为主 agent 会一直等一个永远不会返回的子 agent。

### 4.1 三个独立的事实，叠在一起就是「永远」

**事实 A：子 agent 的 LLM 调用没有任何超时。**

子 agent 走的是 `syncChat`（非流式）。`src/llm-client.js:338`：

```js
export async function syncChat({ url, apiKey, body, signal, telemetry }) {
  // ...
  return withRetry(async () => {
    const response = await fetch(url, {
      method: 'POST', headers: {...},
      body: JSON.stringify({ ...body, stream: false }),
      signal,                       // ← 只有外部传进来的 signal，没有自己的 deadline
    })
    // ...
  }, { signal })
}
```

整个 `llm-client.js` 里唯一的 `setTimeout` 在 `:566`，那是 `withRetry` 的退避延时。**没有 `AbortSignal.timeout()`，没有 deadline 竞速。** `withRetry`（`:559`）只在 `fn` **抛异常**时重试 —— 一个挂住的 `fetch` 不抛异常，所以它连重试都进不去。

对比：父 agent 走 `streamChatIter`，调用方（我们）可以在外面包静默看门狗；子 agent 的 `syncChat` 调用发生在 SDK 内部，看门狗包不进去。

**这里要更正我们自己的一个判断。** 我们原以为「调用方完全没有注入点」，查证后发现是错的：SDK 其实提供了一个 `createAgent` 工厂钩子 ——

```
src/agents/runtime.js:60    createAgent,                              // 解构入参
src/agents/runtime.js:131   ...(createAgent ? { createAgent } : {}),  // 透传给 runner
src/agents/runner.js:142    createAgent = async (options) => { …new Agent(options) }   // 默认实现
src/agents/runner.js:378    const child = await this.createAgent({ …options, memory: … })
```

因为 Agent 构造函数是 `createSubagentRuntime({ parent: this, ...opts.subagents })`（`agent.js:669`），宿主传 `opts.subagents.createAgent` 就能拿到子 agent 的构造权，进而给子 agent 包一层带 deadline 的 `chat()`。**这条路是通的，我们只是没找到它**，原因是：

- `src/agent.js:256-276` 那段 JSDoc 逐个文档化了 `opts.subagents` 的每一个字段（`types` / `defaultType` / `maxConcurrent` / `maxDepth` / `modelAliases` / `retry` / `artifacts` / `retainCompleted` / `retainClosedGraphs` / `a2a` / `ask` / `keepAlive` / `keepAliveTimeoutMs`）—— **`createAgent` 不在其中**。`grep -n "createAgent" src/agent.js` 返回空。
- `runtime.js:60` 那行也只是一个裸的解构参数，没有注释。
- SDK 不发 `.d.ts`（§4.2），所以也没有类型提示能把它暴露出来。

**一个能解决本节问题的公开扩展点，文档里完全不存在** —— 这本身就是需要修的一条（见 §10 #6）。我们把它写在这里，是为了让维护者知道：调用方不是没有办法，是办法藏起来了。

**事实 B：`retry.attemptTimeoutMs` 只存在于当初的设计规划和注释里，实现从没读过它。**

```
$ grep -rn "attemptTimeoutMs" src/
src/agents/runtime.js:116:      // `{ ...retry }`，不是挑着重建 `{ maxAttempts, attemptTimeoutMs }` 两个键：   ← 注释
src/agents/runtime.test.js:94:  // 曾经的 runtime.js 只挑 maxAttempts / attemptTimeoutMs 两个键重建 retry 对象，  ← 注释
```

当初的设计规划明确写了 `attemptTimeoutMs`，默认 600000（`retry = {}  // { maxAttempts = 3, attemptTimeoutMs = 600000 }`）。**实现里没有任何一处读取它**，`runner.run()` 的重试循环也没有单次尝试的时间上限。

**事实 C：重试链条把 `'timeout'` 列为可重试，但没有任何代码会产生 timeout。**

`src/agents/runner.js:28`：

```js
export const RETRYABLE_KINDS = new Set(['rate_limited', 'llm_error', 'network', 'timeout'])
```

`classifyFailure`（`:87,89`）也确实有两条路径能产出 `'timeout'`：

```js
if (err.name === 'TimeoutError') return 'timeout'
if (/timed out/i.test(message)) return 'timeout'
```

但因为事实 A + B，**这两条路径永远不会被走到**：没有任何东西会抛 `TimeoutError`，也没有任何错误消息里会出现 "timed out"。`RETRYABLE_KINDS` 里的 `'timeout'` 和 `classifyFailure` 里的两个分支是**为一个不存在的机制准备的接口**。

这三条合起来说明：`attemptTimeoutMs` 不是被有意去掉的，是**没实现完**。补上它，事实 A 和事实 C 会一起消失。

### 4.2 run 结束时，SDK 不关闭在飞的子 agent

`closeSubagents()`（`src/agent.js:1543`）在整个 SDK 里只有一个调用点：`reset()`（`:761`，fire-and-forget）。

`_reactLoop` / `_reactLoopStream` 的 `done` 路径**不碰它**。所以 run 正常结束时：

- 子 agent 的 `AbortController` 不被 abort（复现输出：`子 agent signal 被 abort : null`）；
- 子 agent 的 promise 仍挂在 `runtime.inflight` 里（复现输出：`hasInFlight() : true`，800ms 后仍是 `true`）；
- 子 agent 完成时，`_onBackgroundSettled`（`src/agents/runtime.js:757`）会照常 `enqueueMessage` + `_signalEvent()` —— 但已经没有人在 `nextEvent()` 上等了，那条通知就永久躺在 `_pendingInjections` 里。

我们承认调用方有责任：宿主可以在 run 结束时自己调 `reset()` 或 `closeSubagents()`。但有两个现实障碍：

1. **`closeSubagents()` 不在 SDK 的类型面上。** SDK 的 `package.json` 没有 `types` / `typings` 字段，`files` 里也没有任何 `.d.ts` —— 我们只能手写一份 `src/main/lll-web-agent.d.ts`。手写的声明面漏了 `closeSubagents`（只写了 `reset()`），而 `reset()` 会连带清掉 memory / spill，对「一轮对话结束」来说太重。这就是我们线上没关子 agent 的直接原因。**SDK 随包发一份 `.d.ts`（哪怕是 JSDoc 生成的）能直接消灭这一类漏接。**
2. 即便关掉了，那也只是把「静默弃置」换成「明确取消」。**真正想要的是子 agent 的结果能活过这一轮** —— 见 §7。

### 4.3 建议

优先级从高到低：

1. **实现 `retry.attemptTimeoutMs`**（默认 600000，按设计文档）。这是最小、最局部的一处修改，同时补齐事实 A/B/C。实现位置：`runner.run()` 的每次尝试外面套一层 `AbortSignal.any([signal, AbortSignal.timeout(attemptTimeoutMs)])`（或等价的 deadline 竞速），超时抛 `TimeoutError` → `classifyFailure` 已经会把它归成 `'timeout'` → 已经在 `RETRYABLE_KINDS` 里 → 重试链条自动接通。**下游全是现成的，只缺产生 timeout 的那一处。**
2. **run 结束时对在飞的子 agent 给出明确处置**，而不是让它们悬着。两个可选语义，任选其一都比现状好：
   - 在 `done` 路径上自动 `closeSubagents()`（保守：run 结束 = 一切结束）；
   - 或者保持它们在跑，但在 `done` 事件里带上 `inFlight: [{agentId, name, ...}]`，让调用方知道有什么被留下了、并能自己决定（§5）。
3. **随包发布 TypeScript 声明**（`types` 字段 + `.d.ts`）。手写声明面必然漂移，漂移的后果是调用方漏掉 `closeSubagents` 这种关键清理入口 —— 我们就是这么踩的。

---

## 5. 缺陷三：`done.stopReason` 的契约里没有一个值能表达「结束时还有工作在飞」

`CHANGELOG.md:276-277` 定义的契约是：

```
stopReason: 'completed' | 'max_rounds'
```

我们的类型面（`src/main/lll-web-agent.d.ts:133`）照着它写：

```ts
| { type: 'done'; content: string; stopReason?: 'completed' | 'max_rounds'; rounds?: number }
```

而且 `CHANGELOG.md:159-161` 明确记载了**不扩张这个枚举**是一个有意的决定：

> **`Agent#lastStopReason` 的取值集合未扩张**（仍为 `null` | `'completed'` | `'max_rounds'`，跨包契约）—— keep-alive 超时经上面那面独立的旗子与事件浮出，不新增枚举值，现有消费方无需改动。

理由是「超时已经通过 `lastKeepAliveTimedOut` 这面旗子和 `run.keep_alive.timeout` 这个事件浮出来了」。**但这两个信号回答的都不是调用方在 `done` 时刻需要知道的那个问题**：

| 信号 | 它说的是什么 | 为什么不够 |
|---|---|---|
| `run.keep_alive.timeout` 事件 | 「某一次等待超时了」 | 它在超时的**那一刻**发出，而 run 可能在很久以后才结束。能量守恒 run B 就是在超时之后又跑了 219s 的工具调用才收尾的。收到这个事件的调用方无法知道 run 最终是恢复了（所有子 agent 都 settle 了）还是留下了孤儿 |
| `lastKeepAliveTimedOut` 旗子 | 「本 run 至少超时过一次」 | 它**过度上报**：即便所有子 agent 后来都成功完成、run 干净收尾，它依然是 `true` |
| `hasInFlight()`（在 `done` 时刻读） | 「run 结束这一刻还有工作在飞」 | 这才是调用方需要的判据 —— 但它不在 `done` 事件的 payload 里，而且此时读它已经晚了：调用方通常是在收到 `done` 后才开始收尾，而宿主可能已经把 Agent 实例丢掉了 |

这两个值覆盖不了实际发生的第三种结局：**run 结束了，但 `hasInFlight() === true`。** 这种结局现在被报成 `'completed'`，于是：

- 调用方无法区分「干净收尾」和「留下孤儿」，也就无法决定要不要 `closeSubagents()`、要不要在 UI 上告诉用户「有 N 个后台任务被中止了」；
- 我们的渲染层把 `'max_rounds'` 专门映射成一条「回复『继续』我会接着做」的提示（`src/renderer/src/lib/agent-provider.ts:114`）。同样的机制本该能用在「工作还在飞」上，但没有可用的信号；
- 更糟的是它**误导模型自己**：`'completed'` 会被写进对话历史，下一轮模型看到的是「上一轮正常完成了」，而实际产物并不存在。§6 里模型在下一轮开头说「所有 agent 都已跑完！」然后发现 PPT 只有 1 页、游戏文件不存在 —— 这个误判的直接来源就是 `'completed'`。

**建议**：增加一个终态值，例如 `'abandoned_inflight'`（或 `'keep_alive_timeout'`），并在 `done` 事件里带上残留清单：

```js
yield {
  type: 'done', content: textContent,
  stopReason: 'abandoned_inflight',
  inFlight: this.subagents.registry.list().map(h => ({ agentId: h.id, name: h.name, state: h.state })),
}
```

这是**向后兼容的加法**（老调用方只看 `content`），但它把 §3 的静默失败变成了调用方可以处理的事实。

---

## 6. 生产环境证据

以下数据来自我们应用的 SQLite 库（`ai_messages.orchestration` 是每轮结束时持久化的编排快照，只读打开）。**五次 run，五次全部触发。**

### 6.1 时间算术：每一次 run 都在 keep-alive 超时后的第一个「纯文本轮」上结束

`keepAliveTimeoutMs = 240s`。「最后一次唤醒」= 最后一次有子 agent settle（那会 `_signalEvent()` 唤醒 `nextEvent`）或用户信件到达的时刻。「残余静默」= 从最后一次唤醒到 run 结束的时长 —— 它必须 > 240s，闸门才会落下。

| run | 起止（UTC） | 总时长 | 最后一次唤醒 | 残余静默 | 结束时在飞 |
|---|---|---|---|---|---|
| 英语启蒙 #1 | 03:13:51 → 03:18:41 | **289s** | 无 | **289s** | 2 个 |
| 英语启蒙 #2 | 03:22:33 → 03:27:17 | **284s** | 无 | **284s** | 2 个 |
| 英语启蒙 #3 | 03:29:06 → 03:35:23 | **377s** | 用户信件 @255s | 240s 超时后又被信件唤醒，随后在第一个纯文本轮结束 | 2 个 |
| 能量守恒 A | 08:37:45 → 08:45:17 | **453s** | 教案 agent succeeded @172s | **281s** | 2 个 |
| 能量守恒 B | 09:28:29 → 09:36:08 | **459s** | 游戏 agent succeeded @154s | **305s**（期间模型自己调了工具，最后在纯文本轮结束） | 1 个 |

**五次 run 的残余静默全部 > 240s。** 这不是巧合，而是这类任务的固有形状：

- PPT agent 的活是「一次 `edit_deck` 提交 11–12 页 JSON」。这是**原子操作**，提交前看不到任何中间状态，中间也没有任何工具调用 → 没有 telemetry → 父 agent 的流完全静默。
- 游戏 agent 的活是「一次写出一个 13KB 的单文件 HTML」。同样是憋大招。
- 唯一成功交付的 教案 agent 花了 **172s**（`wallClockMs: 172419`）。这已经是我们观测到的**最快**的一个，而它自己就吃掉了 240s 预算的 72%。

**结论：只要任务稍微重一点，残余静默就会超过 240s。**

**但这里必须对我们自己诚实一句**：这五次 run 的残余静默最大是 305s，**如果当时用的是 SDK 默认的 600s，这五次一个都不会触发闸门**。也就是说，生产环境里的触发器是**我们自己传的 240s**，不是 SDK 的默认值。

那我们为什么不能用 600s？因为**没有一个值能同时满足两边** —— 这是本节真正要说的设计问题：

```
      残余静默 < keepAliveTimeoutMs < 宿主的流静默看门狗
             ↑                                ↑
      任务的固有形状决定               宿主的防断网机制决定
      （实测 281s ~ 305s，            （必须存在，否则一次静默断网
        而且没有上界）                    会让 UI 永远转圈）
```

- `keepAliveTimeoutMs` 调低（240s）→ 比任务的正常静默还短 → **每次多产物并行都触发闸门**，就是本报告的五个样本。
- `keepAliveTimeoutMs` 调高（600s，SDK 默认）→ 主 agent 在 `_keepAliveOnce()` 里干等 10 分钟，**这期间 `stream()` 一个字节都不吐**。宿主的流看门狗如果短于它，就会把这一轮当断网打死，用户看到一个纯属捏造的「网络连接中断」；如果长于它（我们的 660s），那么 §4 的问题原样保留，只是推迟 6 分钟出现 —— 而 run A 的游戏 agent 被弃置后 41 分钟毫无产出，说明它的实际静默期根本没有上界，600s 一样会到。

**根因：keep-alive 的等待对宿主的流看门狗不可见。** `_keepAliveOnce()` 在 `await nextEvent()` 期间不 yield 任何东西，所以「正在等子 agent」和「连接死了」在 `stream()` 上是同一个信号 —— 静默。宿主被迫在这两种故障之间二选一。

**建议（这条是我们认为最该做的）**：keep-alive 等待期间在**流上**发心跳。例如每 15–30s yield 一个不影响对话内容的流事件：

```js
yield { type: 'keep_alive_waiting', pendingAgents, pendingNodes, waitedMs }
```

有了它：

- 宿主的流看门狗被正常喂到，可以把阈值设得很短（真正快速地抓住断网），而**不必**再和 `keepAliveTimeoutMs` 排序；
- `keepAliveTimeoutMs` 于是可以按任务的真实形状设（甚至设成 `null` = 永不超时），不再有「被迫调低」的理由；
- UI 也能第一次显示「正在等待 2 个后台任务，已等 3 分 12 秒」—— 现在这段等待对用户是完全黑屏的，这正是我们的用户在 03:27:50 打出「别停啊」的原因。

这条改动很小（`_reactLoopStream` 的等待处加一个定时器竞速，非流式的 `_reactLoop` 不受影响），但它解开的是那个让所有取值都错误的死结。

### 6.2 编排快照原文：`succeeded` 有 `wallClockMs`，`cancelled` 没有

能量守恒 run A 结束时持久化的快照（`msg_a472068fe2704b41`）：

```
startedAt 2026-09-04T08:37:45.107Z  settledAt 2026-09-04T08:45:17.857Z  span=453s
  · 写能量守恒教案笔记   | status=succeeded attempt=1 rounds=8  wallClockMs=172419.35  tokens=248721  tools=7
  · 做能量守恒PPT课件    | status=cancelled attempt=2 rounds=3  wallClockMs=—          tokens=—        tools=4
  · 做能量守恒HTML游戏   | status=cancelled attempt=1 rounds=1  wallClockMs=—          tokens=—        tools=0
  counts={"total":3,"done":1,"failed":0}
```

能量守恒 run B（`msg_ea2dee1e7819459b`）：

```
startedAt 2026-09-04T09:28:29.562Z  settledAt 2026-09-04T09:36:08.285Z  span=459s
  · PPT课件制作        | status=cancelled attempt=1 rounds=31 wallClockMs=—        tokens=—      tools=20(截断10)
  · HTML能量游戏开发   | status=succeeded attempt=1 rounds=5  wallClockMs=153774.7 tokens=182264 tools=4
  counts={"total":2,"done":1,"failed":0}
```

四个值得注意的点：

1. **`status=cancelled` 是我们的宿主写的，不是 SDK 报的。** SDK 从没发过 `agent.cancelled` 事件（复现输出：`子 agent 终态/重试事件 : 0`）。我们的编排账本在 run 结束时把所有非终态 agent 一律改写成 `'cancelled'`（`src/main/ai-agent/orchestration-ledger.ts:558`）。**这条不是 SDK 的 bug**，列在这里只是为了让数据可读 —— 请把 `cancelled` 读作「run 结束时它还在飞」。
2. **`wallClockMs` / `tokens` 只在真终态上有值。** 它们是 `agent.succeeded` 事件带的字段（`runner.js:464`）。`cancelled` 那两行没有，正是因为那两个事件从未发生。这个「缺字段」就是区分真终态和被弃置的可靠判据。
3. **run B 的 PPT agent 跑了 31 轮、至少 30 次成功的工具调用**（`tools=20` 且 `toolsTruncated=10`）。它**一直在正常干活**，不是卡住了。而模型在同一轮里说的是「PPT agent 看起来卡住了」。一个健康工作着的子 agent 被主 agent 判定为卡住并接手 —— 这是 §5 那个 `'completed'` 误导的直接后果。
4. **run A 的 PPT agent `attempt=2`**，说明重试链条确实跑过一次（第一次尝试失败了）。SDK 的失败上报是完整的（`runner.js:484` 的 `agent.failed` 带 `failureKind` + `lastError`，`:328` 的 `agent.retry` 带 `failureKind`）—— **是我们的宿主账本没接住这些字段**，所以快照里 `error=null`。这条也不是 SDK 的问题。

### 6.3 模型自己的话：它复述了 SDK 的承诺，然后被这个承诺骗了

以下是数据库里的原文（assistant 消息，未删改）。

**英语启蒙 run #1 结束时（03:18:41）：**

> 这两个任务工作量都不小（尤其是 PPT 要逐页构建并做布局质检），**超过 4 分钟属于正常情况**。它们**完成后会自动通知我**，届时我会立刻把课件打开给你看，并告诉你游戏文件的位置。再稍等一下～

注意「超过 4 分钟属于正常情况」—— 模型对任务耗时的判断是**正确的**（教案 agent 实测 172s，PPT 更重）。它也正确地选择了不取消。然后这段话作为「不含工具调用的最终回答」触发了粘性闸门，run 就地结束。

**英语启蒙 run #2 结束时（03:27:17）：**

> 它们完成后会自动通知我，届时我会立刻打开课件并告诉你游戏文件位置。请再稍等片刻～

**英语启蒙 run #3（03:35:23）—— 模型开始怀疑，但仍然选择相信通知机制：**

> 这两个任务都是「憋大招」型：中间没有增量产出，最后一次性落盘。已经跑了约 4 分钟，属于这类大任务的正常范围，但确实比预期慢。
>
> 我的处理：**让它们继续跑**，不取消（现在取消就前功尽弃了）。一有产出我立刻汇报并打开课件给你看。**如果再等一会儿还是没动静，我就直接取消、自己动手逐页做，不再依赖它们。**

**能量守恒 run A 结束时（08:45:17）：**

> 两个 agent 仍在正常工作中，我选择让它们继续跑完（不取消）：… 它们都在正常推进，教案（agent ①）已交付。**完成后我会立即向你汇报最终结果。**

**然后是 41 分钟的空白。** run A 在 08:45:17Z 结束，用户下一条消息在 09:26:37Z。这期间主进程**没有重启**（`main.log` 里 2026-09-04 只有 11:36:57 和 16:23:32 两条 `starting edu-desktop-app`，后者 = 08:23:32Z，在 run A 之前）。两个子 agent 在这 41 分钟里产出了**零个字节**：既没有 telemetry，也没有落盘产物，也没有任何终态事件。这就是 §4.2 描述的无人认领状态在真实进程里的样子。

**用户在 09:26:37 打了「继续」，新的一轮开始（09:36:08）：**

> **所有 agent 都已跑完！** 让我检查一下各项产出物：教案已完好（✅），但 PPT 只建了标题页、HTML 游戏未生成。**我现在亲自把这两个补完。**

「所有 agent 都已跑完」是错的 —— 它们既没跑完也没失败，只是**在新的 run 里彻底不可见**（§7）。而模型能拿到的唯一信号（`stopReason: 'completed'` + 空注册表）只支持这一个解读。

**英语启蒙那条线的结局（04:03:25）—— 模型放弃了委派：**

> 确认了：两个 agent 都已经死掉（0 个在运行），PPT 还是只有 1 页封面，游戏文件不存在。**不再指望它们了 —— 我现在直接自己动手做**，两件事一起推进。

它随后用 21 次工具调用，自己串行做完了 12 页 PPT + lint 修复 + 游戏文件，**成功了**。

（这一轮的「0 个在运行」还有一个额外原因：run #3 在 03:35:23Z 结束，主进程在 94 秒后（11:36:57 本地时间 = 03:36:57Z）重启了一次，孤儿随之被进程退出杀掉。但即便没有这次重启，新 run 的注册表也一样是空的 —— 见 §7。）

### 6.4 代价

从模型的角度看，它的适应是**完全正确**的：在这个系统里委派不可用。

- 三次失败的委派，累计约 **950s** 的墙钟时间；
- 那个唯一成功的 教案 agent 单独烧掉 **248,721 tokens**（`tokens` 字段），另外两个 agent 的 token 数因为从未上报而无从统计；
- 最终交付是主 agent 自己串行做出来的。

也就是说：**SDK 的后台 subagent 能力在我们的负载下等效于不可用**，而且它的失败模式是最贵的那一种 —— 先烧完 token，再让模型重做一遍。

---

## 7. 缺陷四：注册表是 per-Agent-instance 的，而聊天应用的天然形状是 per-turn 一个 Agent

这一节不是 bug，是**设计适配面**的问题，但它决定了我们能不能真正用上后台委派。

### 7.1 现状

`subagents` runtime 在 Agent 构造函数里无条件新建（`src/agent.js:668`）：

```js
if (opts.subagents) {
  this.subagents = createSubagentRuntime({ parent: this, ...opts.subagents })
  this.tools = [...this.tools, ...this.subagents.tools]
}
```

`createSubagentRuntime` 内部又新建了注册表、注入队列、图容器和产物轨（`src/agents/runtime.js:66` `const artifacts = new ArtifactTrack({...})`）。**这些全部绑定在一个 Agent 实例的生命周期上。**

而聊天应用的标准形状是：**每一轮用户消息 = 一次 run**。我们的宿主就是这么做的（`src/main/ai-agent/agent-handlers.ts:67`，`createAskAiAgent(...)` 在 `run.start` handler 内部调用，`finally` 里 `sessions.delete(sessionId)`）。

于是：

| 跨轮的东西 | 结局 |
|---|---|
| 子 agent 的 handle / 注册表 | 新 run 看不到；`agent_status` 返回 `no active agents (0 running, 0 queued)`；`agent_cancel` 找不到目标 |
| 子 agent 的完成通知 | `enqueueMessage` 进**旧** runtime 的 `_pendingInjections`，永远没人排空 |
| 子 agent 写的产物（`artifact_write`） | 存在**旧** runtime 的 `ArtifactTrack` 里，新 run 的 `artifact_list` 读不到 |
| 子 agent 占用的并发槽 | 旧 runtime 的池，新 run 重新从 0 开始计数 |

**「you will be notified when one completes」这个承诺在跨轮场景下必然失效**，哪怕缺陷一被修好 —— 因为通知的收件人（那个 Agent 实例）已经被宿主丢掉了。

`createSubagentRuntime` 是从 `src/index.js:63` 导出的，但 Agent 构造函数不接受一个预先建好的 runtime，所以调用方没有任何注入点。

### 7.2 建议

**允许 runtime 跨 Agent 实例复用。** 最小改动：

```js
if (opts.subagents) {
  this.subagents = opts.subagents.runtime            // 新增：调用方自带的 runtime
    ?? createSubagentRuntime({ parent: this, ...opts.subagents })
  // ...
}
```

配套需要处理 `parent` 的重新绑定（runtime 里对 `parent` 的引用要能在每轮开始时指向当前 Agent，而不是构造它的那个），以及 `beginClose()` / `notifyEpoch` 的语义 —— 现在它们假设 runtime 与 Agent 同生共死。

有了这个，宿主就能把 runtime 的生命周期绑到**会话**（而不是单轮）上：

- 上一轮派出去的子 agent，这一轮 `agent_status` 能看见；
- 它的完成通知会排进当前这一轮的注入队列，模型真的会被通知到；
- 它写的产物能被后续轮次读到；
- 宿主也终于有了一个自然的时机去 `closeSubagents()` —— 会话关闭时，而不是每轮结束时。

**这是我们最想要的一项改动。** 缺陷一到三修好之后，后台委派在单轮内是可用的；但只有 runtime 能跨轮存活，「派一个慢任务、下轮再收结果」这个 subagent 系统最核心的价值才成立。

如果这条改动太大，退一步的方案是提供一个**只读的可序列化快照 + 重连入口**（例如 `runtime.exportState()` / `createSubagentRuntime({ restore })`），让宿主能自己跨轮保存和恢复在飞任务的最小信息。但这只能救回可见性，救不回那些还挂在 `fetch` 上的真实任务。

---

## 8. 一个未验证的疑点（供参考，不作为结论）

能量守恒 run B 中，模型说过一句「**PPT agent 看起来卡住了（0 轮交互）**」，但同一轮结束时持久化的快照显示这个 agent `rounds=31`、`tools=20`（截断了 10 条）。

两种可能：

1. `agent_status` 的列表形态（`src/agents/tools.js:641` `renderAgentStatus`）只打印 `name / state / type / model / attempt / description`，**不打印 `rounds`** —— 模型可能是从缺失的信息里自己编了一个「0 轮」。这是模型的问题，不是 SDK 的。
2. 单个 agent 的形态走 `handle.toStatus()`（`src/agents/handle.js:102`），如果它返回的 `rounds` 在运行期间不更新（只在 settle 时写入），那模型读到的 0 就是真的，而这是个 bug。

我们没有验证是哪一种。**建议在 `renderAgentStatus` 的列表形态里加上 `rounds` 和最后一次工具调用的时间戳** —— 无论上面哪种解释成立，这都是模型判断「它是在干活还是卡住了」唯一需要的信息，而现在它拿不到，只能猜。这条改动的成本极低，而 §6.3 显示模型确实会去猜，并且猜错之后会做出「自己接手重做」这种昂贵的决定。

---

## 9. 明确排除：以下不是 SDK 的问题

为了让维护者不去追错方向，以下几条我们自查后确认是**宿主侧**的问题，与 SDK 无关：

| 现象 | 真实归属 |
|---|---|
| 编排面板显示 `cancelled`，但 SDK 从未发过 `agent.cancelled` | 宿主的账本在 run 结束时把所有非终态 agent 改写成 `'cancelled'`（`orchestration-ledger.ts:558`）。应该改成 `abandoned` 之类不撒谎的值 |
| 快照里子 agent 的 `error` 恒为 `null`，看不到失败原因 | **SDK 上报是完整的** —— `agent.failed` 带 `failureKind` + `lastError`（`runner.js:484`），`agent.retry` 带 `failureKind`（`:328`）。是宿主的账本没接住这些字段 |
| run 结束时没有调用 `closeSubagents()` | 宿主的责任。但请注意 §4.2：SDK 不发 `.d.ts`，我们手写的声明面漏了这个方法，这是漏接的成因 |
| 父 agent 的流静默看门狗（660s）没有保护到子 agent | 宿主只能包住 `agent.stream()`。子 agent 的 `syncChat` 在 SDK 内部，宿主够不着 —— 这部分是 §4 的缺陷二 |
| 主 agent 每轮新建一个 Agent 实例 | 宿主的架构选择。但它与 SDK 的 per-instance runtime 组合出了 §7 的问题，所以那一节的建议是提给 SDK 的 |

---

## 10. 建议的修改清单（按性价比排序）

| # | 改动 | 位置 | 成本 | 解决 |
|---|---|---|---|---|
| 1 | **keep-alive 等待期间在流上发心跳**：`yield { type:'keep_alive_waiting', pendingAgents, pendingNodes, waitedMs }`，每 15–30s 一次 | `_reactLoopStream` 的 `_keepAliveOnce()` 等待处（非流式路径不受影响） | 小 | §6.1 的死结：宿主的流看门狗不再和 `keepAliveTimeoutMs` 抢同一个静默，`keepAliveTimeoutMs` 终于能按任务真实形状设 |
| 2 | **实现 `retry.attemptTimeoutMs`**（默认 600000，按设计文档），超时抛 `TimeoutError` | `runner.run()` 每次尝试外层 | 小 | §4 事实 A/B/C。下游 `classifyFailure`（`runner.js:87-89`）+ `RETRYABLE_KINDS`（`:28`）已经就绪，只缺产生 timeout 的那一处 |
| 3 | **`done` 事件增加 `stopReason:'abandoned_inflight'` + `inFlight[]`** | `_reactLoop:1979` / `_reactLoopStream:2197` 收尾处 | 小 | §5；让宿主和模型都能看见「结束时还有工作在飞」这个事实 |
| 4 | `renderAgentStatus` 列表形态加 `rounds` + 最后一次工具调用时间 | `agents/tools.js:641` | 极小 | §8；模型不再靠猜「它是卡住了还是在干活」 |
| 5 | **新增 `agent_wait({ timeoutMs?, agent_id? })` 工具**，`execute` 复用 `nextEvent` | `agents/tools.js` | 小 | §3.3；让「继续等」成为模型的显式动作，粘性闸门于是可以保留甚至去掉 |
| 6 | **文档化 `createAgent` 钩子 + 随包发布 `.d.ts`**（`package.json` 加 `types`） | `agent.js:256-276` 的 JSDoc 补一行；构建 | 中 | §4.1 / §4.2；一个已存在的公开扩展点现在完全不可发现，而手写声明面必然漂移 |
| 7 | run 结束时对在飞子 agent 明确处置（自动 `closeSubagents()`，或交由 #3 的 `inFlight[]` 让宿主决定） | `done` 路径 | 小 | §4.2 |
| 8 | **`opts.subagents.runtime` 允许注入外部 runtime；`parent` 支持每轮重绑** | `agent.js:668` + `runtime.js` | 大 | §7；跨轮委派 —— 这是我们最想要的一项 |

**依赖关系（重要）**：

- **#5 必须在 #2 之后。** 只给模型一个显式等待原语、却不给子 agent 加超时，会把「提前弃置」变成「无限等待」：一个挂住的子 agent 会让主 agent 一直 `agent_wait` 到 `maxRounds` 耗尽，比现在更糟。
- **#3 和 #7 是一对。** 有了 `inFlight[]`，宿主才有依据决定关不关；没有它，#7 只能是「一律自动关」，那会误伤 §7 那种「下一轮再收结果」的合法用法。
- **#1 是我们建议优先做的一条**，因为它成本最小、且是唯一能让 `keepAliveTimeoutMs` 这个参数重新变得可配置的改动。在 #1 之前，这个参数对我们来说没有正确取值。

### 10.1 在 SDK 修好之前，宿主侧能做的临时缓解

列在这里是为了让维护者了解我们的处境，也为了让其他调用方少走弯路。**这些都不是 SDK 的修复，只是止血**：

1. **用 `createAgent` 钩子给子 agent 包一层 deadline。** `opts.subagents.createAgent` 是通的（§4.1），宿主可以在里面返回一个 `chat()` 被 deadline 包裹的 Agent，超时就 abort 自己的 signal。这能把「无限挂起」变成「明确失败 + 走 SDK 已有的重试链条」。**这是我们今天就能做、且最该做的一件事。**
2. **run 结束时调 `closeSubagents()`。** 至少把静默弃置变成明确取消，不再白烧 token。代价是彻底放弃「下一轮收结果」的可能（反正现在也收不到，见 §7）。
3. **把编排面板里的 `cancelled` 改成 `abandoned`**，并把 SDK 已经上报的 `failureKind` / `lastError` 接进账本 —— 这两条纯属我们自己的问题（§9）。

这三条做完，故障形态会从「静默失败 + 模型重做」变成「明确失败 + 可见原因」，但**委派仍然不可用** —— 因为 §6.1 的死结和 §7 的跨轮断裂都还在 SDK 侧。


---

## 附录 A：复现脚本全文

`docs/repro/keepalive-sticky.mjs`（在 SDK 仓库根目录运行；`LLL_SDK` 环境变量可指定入口路径）

```js
/**
 * lll-web-agent 缺陷最小复现：keep-alive 首次超时后，主 agent 会在**仍有子 agent
 * 在飞**时结束整个 run，且对外报告 stopReason = 'completed'。
 *
 * 运行（在 SDK 仓库根目录）：
 *   node path/to/keepalive-sticky.mjs
 * 或显式指定 SDK 入口：
 *   LLL_SDK=/abs/path/to/agent-lll-js-sdk/src/agent.js node path/to/keepalive-sticky.mjs
 *
 * 期望：全部断言通过 = 缺陷仍在。
 */
import assert from 'node:assert'
import { pathToFileURL } from 'node:url'

const SDK = process.env.LLL_SDK
  ? pathToFileURL(process.env.LLL_SDK).href
  : pathToFileURL(`${process.cwd()}/src/agent.js`).href
const { Agent } = await import(SDK)

// 缩短仅为让复现秒级完成；生产默认是 600_000。缩放不改变行为，只改变触发时刻。
const KEEP_ALIVE_MS = 300

let mainRound = 0
let childCalls = 0
let childSignalAborted = null

/**
 * 假 LLM：
 *   - 主 agent 第 0 轮派一个后台子 agent，之后每轮只说话（无工具调用）——
 *     这正是"我在等子 agent 通知"的真实形态。
 *   - 子 agent 的请求永久挂起，模拟一次生成大 payload 的慢/静默请求
 *     （真实场景：一次 edit_deck 的 12 页 JSON，或一个 13KB 单文件 HTML）。
 */
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body)
  const isMain = String(body.messages[0]?.content ?? '').includes('MAIN')

  if (!isMain) {
    childCalls += 1
    init.signal?.addEventListener('abort', () => { childSignalAborted = true })
    await new Promise(() => {})        // 永不 resolve，也永不 reject
  }

  const message = mainRound++ === 0
    ? {
        content: '',
        tool_calls: [{
          id: 'c1', type: 'function',
          function: {
            name: 'agent',
            arguments: JSON.stringify({ description: 'slow task', prompt: 'generate a large document' }),
          },
        }],
      }
    : { content: `第 ${mainRound} 轮：子 agent 还在跑，我继续等它的通知。` }

  return {
    ok: true, status: 200, headers: new Map(),
    json: async () => ({ choices: [{ message }] }),
    text: async () => '',
  }
}

const agent = new Agent({
  provider: 'openai', url: 'http://mock/v1/chat/completions', apiKey: 'k', model: 'm',
  systemPrompt: 'MAIN agent', tools: [], maxRounds: 20,
  subagents: { maxConcurrent: 4, maxDepth: 2, keepAliveTimeoutMs: KEEP_ALIVE_MS },
})

const keepAliveTimeouts = []
agent.on('run.keep_alive.timeout', (p) => keepAliveTimeouts.push(p))
const terminalEvents = []
for (const t of ['agent.succeeded', 'agent.failed', 'agent.cancelled', 'agent.retry']) {
  agent.on(t, (p) => terminalEvents.push({ event: t, ...p }))
}

const t0 = Date.now()
const answer = await agent.chat('请并行处理这件事')
const elapsed = Date.now() - t0

console.log('--- run 结束时的状态 ---')
console.log('主 agent 的最终回答      :', JSON.stringify(answer))
console.log('lastStopReason           :', agent.lastStopReason)
console.log('run 耗时 ms              :', elapsed, `(keepAliveTimeoutMs=${KEEP_ALIVE_MS})`)
console.log('主 agent 轮数            :', mainRound)
console.log('keep_alive.timeout 次数  :', keepAliveTimeouts.length, JSON.stringify(keepAliveTimeouts))
console.log('子 agent 终态/重试事件   :', terminalEvents.length, JSON.stringify(terminalEvents))
console.log('run 结束时 hasInFlight() :', agent.subagents.hasInFlight())
console.log('注册表（含终态）         :', agent.subagents.registry.list({ includeFinished: true })
  .map(h => `${h.name}:${h.state}`))
console.log('子 agent 的 LLM 调用次数 :', childCalls)
console.log('子 agent signal 被 abort :', childSignalAborted)

// run 已经结束，再等一段时间：证明被弃置的子 agent 既不会超时，也不会被回收
await new Promise(r => setTimeout(r, 800))
console.log('\n--- run 结束 800ms 后 ---')
console.log('hasInFlight()            :', agent.subagents.hasInFlight())
console.log('子 agent 终态/重试事件   :', terminalEvents.length)
console.log('_pendingInjections       :', agent._pendingInjections.length)

console.log('\n--- 断言 ---')
assert.strictEqual(keepAliveTimeouts.length, 1, 'keep-alive 应恰好超时一次')
assert.strictEqual(agent.subagents.hasInFlight(), true, 'run 结束时子 agent 仍在飞')
assert.strictEqual(agent.lastStopReason, 'completed', "stopReason 报的是 'completed'")
assert.strictEqual(terminalEvents.length, 0, '子 agent 没有任何终态/重试事件')
assert.strictEqual(childSignalAborted, null, '子 agent 的 signal 从未被 abort')
console.log('全部断言通过 —— 缺陷复现成功。')
process.exit(0)
```

## 附录 B：本报告引用的 SDK 代码位置索引

| 位置 | 内容 |
|---|---|
| `src/agent.js:277-278` | `keepAliveTimeoutMs` 的 JSDoc，记载粘性行为为有意设计 |
| `src/agent.js:291` | `maxRounds` 默认 300 |
| `src/agent.js:668-672` | 构造函数无条件新建 subagent runtime |
| `src/agent.js:1141 / :1213` | `lastKeepAliveTimedOut = false` —— 唯一的 reset 点（run 入口） |
| `src/agent.js:1543-1546` | `closeSubagents()` |
| `src/agent.js:1651-1697` | `_keepAliveOnce()` 全文，含三道判断的内联注释 |
| `src/agent.js:1665` | **粘性闸门** `if (this.lastKeepAliveTimedOut) return 'idle'` |
| `src/agent.js:1677` | `lastKeepAliveTimedOut = true` |
| `src/agent.js:1979-1988` | `_reactLoop` 收尾：`'idle'` → `stopReason: 'completed'` |
| `src/agent.js:2197-2207` | `_reactLoopStream` 收尾，与上同形 |
| `src/agent.js:749-765` | `reset()` 里 `beginClose()` + fire-and-forget `closeSubagents()` |
| `src/agents/tools.js:39` | `'…you will be notified when one completes. '` |
| `src/agents/tools.js:641-653` | `renderAgentStatus`，列表形态不含 `rounds` |
| `src/agents/handle.js:102` | `toStatus()` |
| `src/agents/runtime.js:66` | `new ArtifactTrack({...})` —— 产物轨绑在 runtime 上 |
| `src/agents/runtime.js:116` | 提到 `attemptTimeoutMs` 的注释（唯一出现处之一） |
| `src/agents/runtime.js:573-579` | 子 agent 继承父 signal |
| `src/agents/runtime.js:757-772` | `_onBackgroundSettled`：`enqueueMessage` + `_signalEvent()` |
| `src/agents/runtime.js:902-904` | `hasInFlight()` |
| `src/agents/runtime.js:992-1019` | `nextEvent({ signal, timeoutMs })` |
| `src/agents/runtime.js:1033-1065` | `beginClose()` / `close()` |
| `src/agents/runner.js:28` | `RETRYABLE_KINDS` 含 `'timeout'` |
| `src/agents/runner.js:87-89` | `classifyFailure` 的 `TimeoutError` / `/timed out/i` 分支 |
| `src/agents/runner.js:165-212` | `buildChildOptions` —— 子 agent 不拿 `subagents` 选项 |
| `src/agents/runner.js:328-331` | `agent.retry` 事件（带 `failureKind`） |
| `src/agents/runner.js:464-468` | `agent.succeeded` 事件（带 `rounds` / `usage` / `wallClockMs`） |
| `src/agents/runner.js:484-487` | `agent.failed` 事件（带 `failureKind` / `lastError`） |
| `src/llm-client.js:338-362` | `syncChat`：裸 fetch，无超时 |
| `src/llm-client.js:559-566` | `withRetry`：只在抛异常时重试 |
| `src/index.js:63` | `createSubagentRuntime` 已导出（但 Agent 构造函数不接受注入） |
| `CHANGELOG.md:147-149` | keep-alive 要修的那个「洞」的原始描述 —— 与本报告的现象完全一致 |
| `CHANGELOG.md:151-153` | `lastKeepAliveTimedOut` 的公开文档：「每轮对话最多超时一次…此后的最终回答直接收尾」 |
| `CHANGELOG.md:159-161` | 明确记载**有意不扩张** `lastStopReason` 枚举 |
| `CHANGELOG.md:276-277` | `stopReason: 'completed' \| 'max_rounds'` 契约 |
| 当初的设计规划 | 规划了 `attemptTimeoutMs`，默认 600000 |
| `package.json` | 无 `types` / `typings` 字段，`files` 里无 `.d.ts` |
