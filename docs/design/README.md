# 设计说明（Design Notes）

按模块拆分的实现说明与"为什么这样设计"的论证。

这些内容原先全部堆在项目规范的 Architecture 一节（约 60 KB / 15K+ tokens），
每次会话都要全量吞下。现在规范文件（真源是根目录的 `AGENTS.md`；`CLAUDE.md` 是一行
`@AGENTS.md` 导入的指针）只保留**模块一览**与
**不可回退的不变量**，机制细节与设计论证移到这里，按需阅读。

| 文件 | 覆盖 |
|---|---|
| [context-manager.md](context-manager.md) | token 结构化计价、usage 锚定、信封指纹、最小消息下限 |
| [mcp.md](mcp.md) | MCP 客户端：状态机、JSON-RPC 多路复用、三种传输、命名空间、结果归一化、错误白名单 |
| [skills.md](skills.md) | Skill 系统：frontmatter 解析、provider（local/http）、materializer、registry、filter、三级注入 |
| [subagents.md](subagents.md) | 子 Agent 系统内部：type 注册表、handle 状态机、并发/深度、DAG 多图容器、邮箱、artifact track、A2A |
| [subagents-wiring.md](subagents-wiring.md) | `agent.js` 侧接线：注入队列与 idle 投递、keep-alive 唤醒预算、`ask_user` 包装、生命周期；含 demo 侧两个易踩点 |
| [spill.md](spill.md) | 工具输出限界：`TextRetainer`/`ItemRetainer`、三种 `SpillStore`、spill policy、`spill_read`/`spill_search` |
| [multimodal.md](multimodal.md) | 图片输入：content parts 形状、入口校验、出站投影（量子卸载 + tool 图拆分）、图片计价、文本投影 |

相关但独立的文档：

- `src/token-accounting.test.js` / `src/spill/policy.test.js` / `src/output-retention.test.js` —
  token 计价与 spill policy 的行为契约以这些测试为准（各设计文件末尾的"相关测试"列出了完整清单）。
- [`../../improvements.md`](../../improvements.md) — 项目唯一有效的待改进列表
  （由原 `framework-review.md` + `todo.md` + `todo-audit.md` 合并而来）。

## 关于文中的实测数字

各文件里出现的 token 数、字节数、调用次数（如 `tools=5407 of total=5508`、
`18 → 28 → 28`、`spill_read` 烧掉 7 次）都是**某一次真实运行的快照**，用来说明问题的量级，
**不是回归阈值**。代码改动后它们不会自动更新；读到时请理解为"当时测到的量级"，
需要当前值就自己跑 `examples/` 里的对应用例（`token-accounting.js` / `spill.js` / `subagents.js`）。

同理，文中引用的 commit 号、`lll-web-agent-sdk-issue-report.md` 的章节号（§3/§4/§5/§10）
都是**写作时的定位信息**，不作为契约；契约由各文件末尾"相关测试"里列出的测试钉住。
