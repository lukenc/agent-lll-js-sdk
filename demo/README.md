# lll-web-agent Demo 使用指南

这个目录是一个**可交互的完整应用**，用来演示 `lll-web-agent` SDK 跑起来是什么效果。
它和 `examples/`（纯命令行的 API 教程脚本）不同：demo 是一个带网页 UI、遥测面板、
MCP 配置面板的小产品。

> 想看「怎么调 API」？去 `examples/`。
> 想看「跑起来什么样」？就在这里。

---

## 目录结构

| 文件 / 目录 | 作用 |
|---|---|
| `server.js` | Node HTTP 服务器：提供 `/chat`(SSE 流式)、策略切换、MCP 挂载、遥测指标等接口 |
| `index.html` | **服务端 Agent** 前端：Agent 跑在 server 上，浏览器只做展示，API Key 留在服务端（安全） |
| `browser.html` | **浏览器端 Agent** 前端：Agent 直接跑在浏览器里，API Key 填在页面上（仅开发测试） |
| `mcp-servers/web-search.js` | 内置搜索 MCP server，搜狗搜索 + 网页抓取，零依赖、免 API Key |
| `mcp-servers/searxng-search.js` | SearXNG MCP server，对接本地 Docker 起的多引擎聚合搜索 |
| `searxng/` | SearXNG 的 Docker 配置（`settings.yml` + 启动说明），见 `searxng/README.md` |

---

## 前置条件

- Node.js >= 18（用到内置 `fetch`）
- 一个 LLM 的 API Key（OpenAI / DeepSeek / 通义千问等任选其一）
- 浏览器端 demo（`/browser`）需要先构建一次 bundle：在仓库根目录运行 `npm run build`

---

## 🚀 全功能启动（一次打开所有能力）

想把 demo 的所有功能（服务端 Agent + 浏览器端 Agent + 动态 MCP + 所有 MCP 预设）
一次性跑起来，在**仓库根目录**按下面三步：

```bash
# 1. 构建浏览器 bundle —— 让 /browser 页面可用（只需一次，改了源码才要重建）
npm run build

# 2. （可选）起 SearXNG，解锁质量最好的「🌐 SearXNG 搜索」预设
docker run -d --name searxng-demo -p 8888:8080 \
  -v "$(pwd)/demo/searxng:/etc/searxng" \
  -e "INSTANCE_NAME=lll-demo" searxng/searxng:latest

# 3. 带上动态 MCP 开关 + API Key 启动 server
DYNAMIC_MCP=1 OPENAI_API_KEY=sk-xxx node demo/server.js
```

启动后访问：

- **http://localhost:3000** — 服务端 Agent（流式对话 + 遥测面板 + 策略切换）
- **http://localhost:3000/browser** — 浏览器端 Agent（10 个本地工具 + MCP 面板）

这一条命令打开的能力：

- ✅ 服务端 Agent 对话（ReAct / Plan & Execute 两种策略可切换）
- ✅ 浏览器端 Agent（前提：第 1 步已 `npm run build`）
- ✅ 遥测面板：实时事件流 + Run/Session 聚合指标
- ✅ RuntimeHistory 上下文轨道快照：`all` / `visible` / `model` / `artifacts`
- ✅ MCP 面板一键挂载（内置搜索、SearXNG、mock 等预设），并保留 `title` / `icons` / `outputSchema` / `execution.taskSupport` / `annotations`
- ✅ `DYNAMIC_MCP=1` 动态 MCP：LLM 可在对话中自主调用 `load_mcp_server` 加载工具

> 用 DeepSeek：把第 3 步换成 `DYNAMIC_MCP=1 DEEPSEEK_API_KEY=sk-xxx node demo/server.js`。
> 第 2 步可选——不起 SearXNG 也能用「⭐ 内置搜索」预设（零依赖）。

下面是按单项能力拆开的详细说明。

---

## 用法一：服务端 Agent（推荐，API Key 不暴露）

Agent 跑在 Node 服务端，浏览器通过 SSE 接收流式回复。这是接近生产的形态。

```bash
# 在仓库根目录运行
OPENAI_API_KEY=sk-xxx node demo/server.js
```

然后打开 **http://localhost:3000**

你能体验到：

- 流式对话（边生成边显示）
- 内置两个工具：`get_current_time`（查时间）、`calculate`（算数学）
- 右上角切换执行策略：**ReAct**（边想边做，默认）/ **Plan & Execute**（先规划再执行）
- 右侧**遥测面板**实时展示 `llm.call` / `tool.call` / `round.*` / `session.*` 事件，
  以及当前 Run 和 Session 的聚合指标（tokens / 耗时 / 调用次数）

试试这些输入：

```
现在几点了？
帮我算一下 (123 + 456) * 789
先告诉我现在时间，再算 2 的 20 次方
```

### 用别的供应商

```bash
# DeepSeek（设了 DEEPSEEK_API_KEY 会自动切到 deepseek-chat）
DEEPSEEK_API_KEY=sk-xxx node demo/server.js

# 显式指定供应商和模型
PROVIDER=openai MODEL=gpt-4o-mini OPENAI_API_KEY=sk-xxx node demo/server.js

# 换端口（默认 3000，被占用时会自动 +1 重试）
PORT=8080 OPENAI_API_KEY=sk-xxx node demo/server.js
```

---

## 用法二：浏览器端 Agent（Agent 直接跑在前端，完整支持）

Agent 完全跑在浏览器里，演示 SDK 的浏览器打包产物（`dist/lll-web-agent.js`）。

### ⚠️ 关键：必须经 demo server 访问，不能直接双击打开

`browser.html` 里有 `<script src="../dist/lll-web-agent.js">`，并且代码会检测
`location.protocol`。**直接双击用 `file://` 打开**会有两个问题：

1. 找不到 bundle（路径对不上）→ 页面 `LllWebAgent` 未定义，连不上
2. 页面检测到 `file://` 会**禁用 MCP 挂载按钮**，提示你改用 demo server

所以要「完整支持」，必须：先 `npm run build`，再启动 demo server，然后用
**http://localhost:3000/browser** 访问。server 会把 bundle 路径改写成 `/bundle.js`
并提供 `/mcp-*` 代理接口，浏览器端的 MCP 工具就是靠这套代理工作的。

```bash
# 1. 构建浏览器 bundle（只需一次，改了 src/ 才要重建）
npm run build

# 2. 启动 demo server —— 浏览器端的 MCP 工具、bundle 都靠它提供
#    注意：browser 模式的对话 Key 在网页里填，所以这里启动 server 可以不带 LLM Key
node demo/server.js

# 3. 浏览器打开（务必走 http，不要用 file://）
#    http://localhost:3000/browser
```

### 在页面里完整配置 Agent

点开页面顶部配置栏，逐项填好后点「连接」：

1. **主任务模型（思考模型）**：供应商（默认通义千问）、模型名、**API Key**、执行策略（ReAct / Plan & Execute）
2. **简单任务模型（可选，sidecar）**：单独给意图识别 / 工具筛选 / 记忆摘要用的小模型；留空则复用主模型
3. **启用意图识别**：开启后每轮对话前先用简单模型判断复杂度/清晰度并筛工具，遥测面板会出 `agent.intent` 事件
4. **注入 ask_user 工具**：开启后 LLM 信息不足时会弹真人对话框向你追问（如「查天气」不说城市）
5. 点「连接」生成 Agent 并订阅遥测

### 浏览器端完整能力清单

- 10 个本地工具：时间、计算、天气、单位换算、随机生成、文本处理、改页面外观、记事本（localStorage）、弹窗、倒计时
- MCP 工具：通过「🔌 MCP Server」面板挂载（走服务端代理，见用法三方式 A），挂完热更新到 Agent，不丢对话
- 意图识别 + 工具筛选（sidecar 小模型）
- `ask_user` 交互式追问（真人弹框回答）
- ReAct / Plan & Execute 策略切换
- 遥测面板：实时事件流（含 `reasoning` 思考流）+ Run/Session 聚合指标

试试这些（页面连接后会有完整提示）：

```
北京天气怎么样          # 工具调用
查天气                  # 不说城市 → 触发 ask_user 追问
帮我做点啥              # AMBIGUOUS 意图
先算 100×50，再用这个值生成等长密码，最后存为笔记   # COMPLEX，多步
```

> ⚠️ 浏览器端会把 API Key 暴露在前端，**仅用于开发测试**。
> 生产环境请用「用法一」的服务端代理形态（Key 留在服务端）。

---

## 用法三：挂载 MCP Server（给 Agent 加真实工具）

demo 支持把外部 MCP server 的工具挂到 Agent 上。有三种挂法。

### 方式 A：浏览器面板一键挂载（最简单）

启动 server 后，在网页的「🔌 MCP Server」面板选一个预设点「挂载」。
内置预设：

| 预设 | 说明 | 依赖 |
|---|---|---|
| ⭐ 内置搜索 | 搜狗搜索 + 网页抓取，零依赖、秒启、国内直连 | 无 |
| 🌐 SearXNG | 本地 Docker 多引擎聚合搜索，质量最好 | 需先起 SearXNG（见 `searxng/README.md`） |
| 🔍 open-websearch | 社区多引擎搜索 | 需 `npx` 下载，可能需 Playwright |
| 🧠 sequential-thinking | Anthropic 官方思维链工具 | 需 `npx` |
| 🌐 fetch-mcp | 通用网页抓取 | 需 `npx` |
| 🧪 mock | 仓库自带的 echo / add 测试 server | 无 |

挂载后工具名会自动加命名空间前缀 `mcp__<name>__<tool>`，Agent 立即可用，不丢对话。
demo 会把 MCP 官方工具 metadata 一并透传到服务端 Agent 和浏览器端 Agent：UI 可读到
`title` / `icons`，大模型可在工具 description 与系统提示里看到 `outputSchema` 和
`execution.taskSupport` 摘要。

### 方式 B：启动时用环境变量挂载

```bash
# 挂仓库自带的 mock server
MCP_SERVER_CMD="node" \
MCP_SERVER_ARGS="src/mcp/__fixtures__/mock-mcp-server.js" \
MCP_SERVER_NAME="mock" \
OPENAI_API_KEY=sk-xxx node demo/server.js

# 挂社区 filesystem server
MCP_SERVER_CMD="npx" \
MCP_SERVER_ARGS="-y @modelcontextprotocol/server-filesystem /tmp" \
OPENAI_API_KEY=sk-xxx node demo/server.js
```

### 方式 C：让 LLM 在对话中自主加载（动态 MCP）

设 `DYNAMIC_MCP=1`，Agent 工具集会多一个 `load_mcp_server` 元工具，
LLM 能在对话过程中自己决定加载哪个 MCP server。

```bash
DYNAMIC_MCP=1 OPENAI_API_KEY=sk-xxx node demo/server.js
```

然后在对话里说「联网搜一下 MCP 是什么」——LLM 会自己调用 `load_mcp_server`
加载内置搜索 server，再用搜索结果回答。

---

## 服务端接口速查（给想二次开发的人）

### RuntimeHistory 与上下文轨道

demo 会在每轮对话结束后展示当前 Agent 的 RuntimeHistory 轨道快照，帮助你区分：

| 轨道 | demo 中的用途 |
|---|---|
| `all` | 完整事件事实源，包含 system / user / assistant / tool / artifact |
| `visible` | 适合展示给用户看的消息投影 |
| `model` | 下一轮会进入模型上下文的消息投影 |
| `artifacts` | Plan & Execute 的计划、步骤结果、最终产物 |

服务端 demo 也提供 `GET /context`，返回同一份快照：

```json
{
  "counts": { "all": 6, "visible": 2, "model": 4, "artifacts": 0 },
  "tracks": { "all": [], "visible": [], "model": [], "artifacts": [] }
}
```

浏览器端 demo 不经过 server 读取上下文，而是直接调用本地 `agent.getHistory('all')`、`agent.getHistory('visible')`、`agent.getHistory('model')` 和 `agent.getArtifacts()`。

`server.js` 暴露的 HTTP 接口：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/` | 服务端 Agent 页面（index.html） |
| GET | `/browser` | 浏览器端 Agent 页面（browser.html） |
| GET | `/bundle.js` | 浏览器端用的 SDK 打包产物 |
| POST | `/chat` | SSE 流式对话，body `{ message }` |
| POST | `/reset` | 重置会话历史 |
| GET/POST | `/strategy` | 查询 / 切换执行策略（react / plan_and_execute） |
| GET | `/metrics` | 当前 Run 和 Session 的聚合指标 |
| GET | `/context` | 当前 RuntimeHistory 轨道快照 |
| GET | `/mcp-status` | 已挂载的 MCP server 状态 + 可用预设清单 |
| POST | `/mcp-connect` | 挂载 MCP server，body `{ preset }` 或完整 spec |
| POST | `/mcp-disconnect` | 卸载 MCP server，body `{ name }`（不传则全卸） |
| GET | `/mcp-tools` | 列出所有已挂载 MCP 工具（含 title/icons/outputSchema/execution/annotations/modelDescription，供浏览器端代理调用） |
| POST | `/mcp-call` | 代理执行某个 MCP 工具，body `{ name, arguments }` |
| GET | `/agents` | Subagent 快照：agent 列表、每张图的节点、产物轨、待答提问 |
| GET | `/questions` | 只取待答提问（面板高频轮询用） |
| POST | `/answer` | 定向回答一个提问，body `{ askId, answer }` 或 `{ askId, cancel: true, reason }` |

---

## 用法四：Subagent（派活给子 agent / DAG 编排）

默认**开启**（`SUBAGENTS=0` 关闭）。开启后服务端 Agent 会带上 12 个元工具
（`agent` / `agent_status` / `agent_cancel` / `agent_graph` / `graph_start` /
`graph_close` / `graph_reactivate` / `send_message` / `artifact_write` /
`artifact_list` / `history_search` / `history_get`），以及两个演示用的
Agent_Type：

| 类型 | 能做什么 | 拿到的工具 |
|---|---|---|
| `explorer` | 只读检索：读项目笔记、汇报事实 | `read_note` + 基础设施 floor |
| `interviewer` | 替编排者向用户问一个具体问题 | 只有 floor（含 `ask_user`） |

> 窄类型不需要把 `artifact_write` / `history_search` / `ask_user` 写进 `tools` ——
> 它们是框架保证带上的 floor（与父 agent 实际拥有的工具取交集）。

右侧面板会实时显示每个 subagent 的状态、每张图的节点与依赖、以及产物轨。
subagent 通过 `ask_user` 提问时，页面底部会弹出黄色横幅，回答按 `askId` 定向送回
提问的那一个 agent（所以多个 agent 同时提问也不会串）。

服务端用的是**命令式提问通道**（`agent.pendingQuestions()` / `agent.answerQuestion()`），
不是 `hooks.onAskUser` —— HTTP 服务端不需要在某个请求上下文里 `await` 一个几分钟后
才有的回答。浏览器端 demo 相反，用的是 hook + 弹层（签名已扩展为
`onAskUser(question, meta)`，`meta.agentName` 会显示在弹层标题里）。

**「新会话」会重建 Agent**，而不是只 `reset()`：`AgentRegistry` 按 `retainCompleted`
保留已完成的 handle（设计如此，`send_message` 还能唤醒它们），只 reset 的话面板里会
挂着上一轮那批 agent。

### 事件带归属，攒成 UI 状态是主机的活

`runner._forwardTelemetry` 把每个 subagent 的 `llm.call` / `tool.call` /
`round.start` / `round.end` 转发到**父 agent 的同一条总线**上，并补上 `agentId`、
`agentName` 与 `parentAgentId`（后者是做深度感知的归属 UI 时需要的那个字段）。
主 agent 自己发的事件不带这些字段 —— 所以归属规则只有一条：

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

---

## 试试这些话术

启动后（`OPENAI_API_KEY=sk-xxx node demo/server.js`）在页面里输入：

| 说 | 会走到 |
|---|---|
| 现在几点 / 算一下 (17+25)*3 | 普通工具调用 |
| 用一个 explorer 在后台调研这个仓库的错误处理约定 | 后台 subagent + keep-alive + 轮边界注入 |
| 用 agent_graph 声明一张依赖图：并行统计模块清单和变更记录，第三个节点汇总 | DAG：两个 auto 上游 + 一个 confirm 闸门 → `graph_start` → `graph_close` |
| 用 artifact_list 把产物列出来 | 产物轨 |
| 派一个 interviewer 问我发布窗口定在什么时候 | 提问路由（服务端横幅 / 浏览器端弹层） |
| 北京天气怎么样、帮我记一条笔记… | `/browser` 那 10 个工具（既有能力） |

同一套集成也有一个纯命令行的版本：

```bash
OPENAI_API_KEY=sk-xxx node examples/subagents.js
```

7 幕跑完既有功能（工具 / Skill / MCP）与 subagent（后台派发 / DAG / 产物轨 / 提问路由），
末尾对若干关键事实做断言，任一条不成立以非 0 退出 —— 可以直接当回归脚本用。

---

## 常见问题

**打开 `/browser` 报「bundle 未构建」**
先在仓库根目录运行 `npm run build` 生成 `dist/lll-web-agent.js`。

**`/chat` 不工作 / 提示没有 API Key**
服务端 Agent 需要 `OPENAI_API_KEY` 或 `DEEPSEEK_API_KEY`。浏览器端 Agent
（`/browser`）不受影响，Key 在页面里填。用 OpenAI 兼容的代理/聚合服务时，
服务端设 `LLM_URL=https://.../v1/chat/completions`，浏览器端填页面上的「自定义 API URL」。

**端口 3000 被占用**
server 会自动尝试 3001、3002……最多试 10 次。也可以用 `PORT=8080` 指定。

**SearXNG 预设挂载失败**
需要先用 Docker 起 SearXNG 实例，详见 `searxng/README.md`。

**MCP server 是用 npx 的预设，第一次很慢**
`npx -y` 首次会下载包，可能 10–30 秒，属正常现象。
