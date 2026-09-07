# `mcp/` — MCP 客户端集成

> 父文档：[设计说明索引](README.md) · 回到 [CLAUDE.md](../../CLAUDE.md)

入口是 `mcp/index.js`，导出 `createMCPClient(options): Promise<MCP_Client>`。

**零新增运行时依赖** —— 只用 Node 18+ 内置能力（`child_process`、`fetch`、`http`、`stream`）。

---

## 内部布局

| 文件 | 职责 |
|---|---|
| `mcp/client.js` | `MCP_Client` 类 |
| `mcp/codec.js` | JSON-RPC 2.0 encode / decodeLine |
| `mcp/namespace.js` | 工具名命名空间化 |
| `mcp/normalize.js` | MCP `content` 数组归一化为单个字符串 |
| `mcp/errors.js` | 四个错误类 |
| `mcp/transports/index.js` | 传输层注册表 |
| `mcp/transports/stdio.js` | 子进程 stdio |
| `mcp/transports/http.js` | Streamable HTTP |
| `mcp/transports/sse.js` | 传统 SSE |
| `mcp/transports/sse-parser.js` | 共享 SSE 线格式解析器 |
| `mcp/__fixtures__/*.js` | **仅测试用** fixture |

### `mcp/client.js`

`MCP_Client` 类：

- 状态机 `connecting → ready → closing → closed`；
- JSON-RPC 请求/响应多路复用器（`_pending` Map，以 id 为键）；
- initialize 握手；
- `listTools()` 带分页 + 缓存，`refreshTools()`；
- `_executeTool(rawName, args, ctx)` 把每个 Mcp_Tool_Def 的 `execute` 接回 `tools/call`；
- 通知派发（`notifications/tools/list_changed` + `notifications/cancelled`）。

### `mcp/codec.js`

JSON-RPC 2.0 encode / decodeLine，带形状校验；畸形输入抛
`MCPProtocolError({ kind: 'malformed_frame' })`。

### `mcp/namespace.js`

`sanitizeSegment`、`buildNamespacedName`、`assignUniqueNames`（冲突去重，加 `_2`/`_3` 后缀）、
`unprefixToolName`。输出**始终**匹配 `^[a-zA-Z0-9_-]{1,64}$`。

### `mcp/normalize.js`

`normalizeCallToolResult(result, rawName)` 把 MCP 的 `content` 数组摊平成单个字符串：

- `text` 用 `\n` 拼接；
- `image` / `audio` / `resource_link` / `resource` 替换为 `[mcp:<type> ...]` 占位符；
- 处理 `isError: true` 前缀，并有 `structuredContent` 回退。

### `mcp/errors.js`

`UnsupportedTransportError` / `MCPClosedError` / `MCPRequestError` / `MCPProtocolError`。

构造函数**只接受白名单标量字段**（绝不接受原始 options 对象），
所以 API key / 环境变量值不可能泄漏进 `err.message`。

### `mcp/transports/index.js`

传输注册表。导出 `registerTransport(name, factory)`，以及内部的 `_setBuiltinTransport` +
`resolveTransport`。**保留名**（`stdio`、`http`、`streamable-http`、`sse`）不可被用户代码覆盖。
内置传输在模块加载时自注册；`createMCPClient` 按需 lazy-import 它要用的那一个。

### `mcp/transports/stdio.js`

`child_process.spawn` 子进程，行缓冲 stdio，stderr 透传到 `options.onStderr`。

### `mcp/transports/http.js`

Streamable HTTP（`POST`，按 `Content-Type: application/json | text/event-stream` 分支处理响应）。
使用 Node 18+ 内置 `fetch`。同时注册在 `'http'` 和 `'streamable-http'` 两个名字下。

### `mcp/transports/sse.js`

传统 SSE（长连接 `GET /sse` + `POST /messages`）。端点 URL 通过 `event: endpoint` 帧协商，
失败时回退到 `<url>/messages`。

### `mcp/transports/sse-parser.js`

共享的 SSE 线格式解析器（处理 `\n`/`\r\n`/`\r`、多行 `data:`、注释行、跨 chunk 边界）。
`http.js`（SSE 响应）与 `sse.js`（流消费）都用它。

### `mcp/__fixtures__/*.js`

仅测试用 fixture（mock MCP server + 内存 mock-transport + fast-check arbitrary）。
**不**从 `mcp/index.js` 或 `src/index.js` 再导出。

---

## 与既有框架的接触面

极小且纯增量：

1. `src/index.js` 追加 MCP 导出（`createMCPClient`、`registerTransport`、四个错误类、`MCP_Client`）。
2. `src/tool-filter.js` 为 `BASE_TOOLS` 增加运行时 CRUD（`registerBaseTool` / `unregisterBaseTool` /
   `setBaseTools` / `clearBaseTools` / `resetBaseTools` / `isBaseTool` / `getBaseTools` /
   `INITIAL_BASE_TOOLS`）—— 全部**就地修改**既有的 `BASE_TOOLS` Set（引用身份保持不变）。
3. `src/context-manager.js` 把它的局部 `const BASE_TOOLS` 改为
   `import { BASE_TOOLS } from './tool-filter.js'`（修掉一个既有的 5-vs-6 不一致，
   **并且**确保 CRUD 的修改对 `trimTools` 立即可见）。

`agent.js`、`tool.js` 及其他任何既有模块**都没有改动**。
`defineTool` 签名与 Tool_Def 形状契约保持不变。

## 来源

- `CLAUDE.md` Supporting modules 的 `mcp/` 条目（2026-09-07 精简前的版本）
