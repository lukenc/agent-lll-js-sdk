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
| `skills/` | 内置示例技能（`math-report` 计算报告 + `ancient-poet` 古体诗，后者演示 Level 3 参考文件）；server 找到此目录即自动启用技能系统 |
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
5. **启用技能系统**：开启后从 server 的 `/skill-source` 经 HTTP provider 加载 `demo/skills`（默认勾选）
6. 点「连接」生成 Agent 并订阅遥测

### 浏览器端完整能力清单

- 10 个本地工具：时间、计算、天气、单位换算、随机生成、文本处理、改页面外观、记事本（localStorage）、弹窗、倒计时
- MCP 工具：通过「🔌 MCP Server」面板挂载（走服务端代理，见用法三方式 A），挂完热更新到 Agent，不丢对话
- 意图识别 + 工具筛选（sidecar 小模型）
- `ask_user` 交互式追问（真人弹框回答）
- 技能系统（HTTP provider ← `/skill-source`）：Level 1 清单自动注入、`skill` 加载正文、`skill_resource` 读附属文件
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

## 用法四：技能系统（Skills）

技能（Skill）是一份**命名的指令包**：一个 `SKILL.md`（带 name / description 的
frontmatter + 正文指令），可选带 `references/` `scripts/` `assets/` 等附属文件。
它让你把「怎么做某类任务」的知识沉淀成可复用的模块，通过**三级渐进披露**按需加载，
不会一次性塞满上下文：

- **Level 1（清单）**：SDK 每轮把 `name: description` 列表自动追加到系统提示末尾，
  只占几十 token，让 LLM 知道有哪些技能可用。
- **Level 2（正文）**：LLM 判断某技能匹配当前请求时，调用 `skill` 元工具，
  拿到该技能 `SKILL.md` 的完整正文指令。
- **Level 3（附属文件）**：正文里若指示读取 `references/xxx.md` 等文件，
  服务端 Agent 用 `read_file` 工具读，浏览器端 Agent 用自动注入的 `skill_resource` 工具读。

### 默认即开：找到 `demo/skills` 就启用

server 启动时如果发现 `demo/skills/` 目录存在，就会自动加载其中的技能，无需额外开关：

```bash
OPENAI_API_KEY=sk-xxx node demo/server.js
# 启动日志会打印：Skills: 已加载 2 个技能 (ancient-poet, math-report)
```

内置两个示例技能：

| 技能 | 触发示例 | 演示点 |
|---|---|---|
| `math-report` | 「帮我算一下 12*8 和 (5+3)^2，生成一份计算报告」 | Level 2：正文指导先用 `calculate` 工具再产出 Markdown 报告表 |
| `ancient-poet` | 「写一首关于秋天的七言绝句」 | Level 3：正文让模型先读 `references/formats.md` 格律再作诗 |

换一个技能目录：

```bash
SKILLS_DIR=/path/to/your/skills OPENAI_API_KEY=sk-xxx node demo/server.js
```

### 服务端 Agent（`/`）

技能在 server 端用 local provider（`{ type: 'local', dir: SKILLS_DIR }`）加载，
Level 3 走 server 注入的、限定在 `SKILLS_DIR` 内的 `read_file` 工具。页面左上角有
**Skill 徽章**显示已加载技能数与清单，连接后会推一条提示消息带触发示例。

### 浏览器端 Agent（`/browser`）

浏览器无法直接读服务端文件系统，所以走 **HTTP provider**：Agent 配置
`{ type: 'http', baseUrl: '/skill-source' }`，由 server 的 `/skill-source/*` 接口
按技能 provider 的 wire 协议提供技能清单与文件；Level 3 由 SDK 自动注入的
`skill_resource` 工具再发一次 `GET /skill-source/skills/<name>/<path>` 读取。

页面配置栏有「**启用技能系统**」勾选框（默认勾选），顶部有 **Skill 徽章**。
勾选并「连接」后，说出匹配请求即可触发。注意 `file://` 直接打开时技能系统不可用
（依赖 server 的 `/skill-source`），必须经 `http://localhost:3000/browser` 访问。

> `disable-model-invocation: true` 的技能不会出现在 Level 1 清单里，也不能被 `skill`
> 工具加载，只能由代码 `agent.skills.get(name)` 主动取用——适合放不想让模型自发触发的内部流程。
> `examples/skills/` 里的 `internal-notes` 演示了这一点。

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
| GET | `/skills-status` | 技能系统状态：`{ enabled, dir, count, skills:[{name,description,version,files,hidden}] }` |
| GET | `/skill-source/manifest.json` | HTTP SkillProvider 清单（供浏览器端 Agent 加载技能） |
| GET | `/skill-source/skills/<name>/<relPath>` | 读取某技能的附属文件（Level 3，带路径穿越防护） |

---

## 常见问题

**打开 `/browser` 报「bundle 未构建」**
先在仓库根目录运行 `npm run build` 生成 `dist/lll-web-agent.js`。

**`/chat` 不工作 / 提示没有 API Key**
服务端 Agent 需要 `OPENAI_API_KEY` 或 `DEEPSEEK_API_KEY`。浏览器端 Agent
（`/browser`）不受影响，Key 在页面里填。

**端口 3000 被占用**
server 会自动尝试 3001、3002……最多试 10 次。也可以用 `PORT=8080` 指定。

**SearXNG 预设挂载失败**
需要先用 Docker 起 SearXNG 实例，详见 `searxng/README.md`。

**MCP server 是用 npx 的预设，第一次很慢**
`npx -y` 首次会下载包，可能 10–30 秒，属正常现象。
