# `content/` — 多模态（图片）输入

> 父文档：[设计说明索引](README.md) · 回到 [AGENTS.md](../../AGENTS.md)
>
> **状态：已实现**（2026-09-25）。真实供应商验收（OpenAI / 小米 MiMo）待完成，完成后在 §8 末尾补"验收记录"。

让 Agent 能**看图**：用户消息里带图，以及工具（含 MCP）返回的图回灌给模型。
历史保留策略移植自 deepseek-harness 的 `dsh-llm/content.ts` 与 `dsh-llm-deepseek/serialize.ts`
（MIT），但**存储形态不同**：dsh 把字节放进独立的 attachment store、消息里只存引用；
我们把图**内联**在消息里（见 §9 的取舍）。

---

## 0. 范围

| 在范围内 | 不在范围内（本版） |
|---|---|
| 用户消息带图（`chat` / `stream`） | 音频、PDF 等其他模态 |
| 工具返回图（自定义工具 + MCP `image` 部件） | 模型**输出**图片（生图应当做成一个工具，与消息模型无关） |
| 历史保留 + 超限按量子卸载 | `plan_and_execute` 下带图（入口直接拒绝，§5） |
| 图片 token 计价 | Agent 之间传图（`enqueueMessage` / `send_message` 仍只收文本） |
| 视觉能力开关 + 发送前报错 | 父 Agent 的图转交子 Agent（子 Agent 的 prompt 是模型生成的字符串） |
| OpenAI、小米 MiMo 两家实测 | 图片缩放/重编码（零运行时依赖；Node 侧无法做，宿主自行预处理） |
|  | `reasoning_content` 回传（improvements.md **D-2**，独立问题，见 §10） |

目标供应商：OpenAI、小米 MiMo（`https://api.xiaomimimo.com/v1`，OpenAI 兼容）。
两者都用 chat completions 的 `image_url` 部件，支持公网 URL 与 `data:` base64。

---

## 1. 消息形状

**新增的唯一形状不变量：无图 ⇒ `content` 是字符串。**

```js
// 带图：OpenAI 标准 content parts
{ role: 'user', content: [
  { type: 'text', text: '这张图里有什么？' },
  { type: 'image_url', image_url: { url: 'data:image/png;base64,…', detail: 'auto' } },
]}

// 无图：与今天逐字节相同
{ role: 'user', content: '你好' }
```

- 入口规范化时，**只含文本部件的数组折叠成字符串**。于是"`content` 是数组 ⇔ 至少一张图"，
  纯文本会话对 memory、`getHistory()`、宿主 UI、自定义 memory 零变化
  （dsh 的 DeepSeek 序列化器同样"text-only requests retain string user content"）。
- 允许的部件类型：`text`、`image_url`。`image_url.url` 只允许 `data:` 与 `http(s):`；
  `detail`（`'low' | 'high' | 'auto'`）原样透传。
- data URL 媒体类型白名单：`image/png`、`image/jpeg`、`image/webp`、`image/gif` ——
  OpenAI 与 MiMo 支持集合的交集（MiMo 另支持 BMP，OpenAI 不支持）。
- **图片元信息不存进消息。** 媒体类型、宽高、字节数、短摘要都由 `image-meta.js` 从 URL
  按需纯函数推导。消息里因此**没有任何私有字段**，也就不存在"出站忘了剥字段 → 供应商 400"。
- `tool` 消息的 `content` 在 memory 里**也可以**是 parts 数组（内部形状）。
  拆成线上形状只发生在出站投影（§3.B），memory 里的 tool-call 配对不变量
  （`adjustCutPointForToolPairs` / `sliceWithoutOrphanTools`）因此不受影响。

### 1.1 元信息推导（`image-meta.js`）

| 项 | 方法 |
|---|---|
| 媒体类型 | data URL 头；与魔数不符时以魔数为准（入口据此重写规范头，§2.3） |
| 宽高 | PNG：IHDR；GIF：逻辑屏幕描述符；WebP：`VP8 ` / `VP8L` / `VP8X`；只需解码前几十字节。JPEG：扫描到 SOFn 标记为止，**扫描上限 256 KB**，超出记为尺寸未知 |
| 字节数 | base64 长度反推（公网 URL：未知） |
| 短摘要 | FNV-1a(`长度 + 头 4 KB + 尾 4 KB`) 的 8 位十六进制 |

短摘要**只为占位文本的确定性**服务（同一张图每次渲染出同一段占位，prompt cache 前缀才稳定），
不承担任何安全语义；碰撞只影响显示。不用 WebCrypto：Node 18 下 `globalThis.crypto` 不保证可用，
且 SHA-256 是异步的，会把整条出站路径拖成异步。

---

## 2. 入口

### 2.1 公开 API

| 符号 | 说明 |
|---|---|
| `agent.chat(message)` / `agent.stream(message)` | `message: string \| ContentPart[]` |
| `imagePart(source, { mediaType?, detail? })` | 同步、零依赖、Node/浏览器通用。`source`：data URL、http(s) URL、裸 base64（需 `mediaType`）、`Uint8Array` / `ArrayBuffer`（魔数嗅探类型） |
| `contentResult(parts)` | 工具返回图片的**显式**包装，见 §2.3 |
| `isContentResult(value)` | 识别 contentResult；宿主处理 `tool_end.result` 或经 JSON 往返后重新包装时用 |
| `contentText(content)` | 文本投影，见 §4.2；宿主渲染历史也可用 |
| `UnsupportedContentError` / `InvalidContentError` | 见 §6 |

浏览器的 `File` / `Blob` 由宿主用 `FileReader.readAsDataURL` 转成 data URL（demo 示范），
SDK 不提供异步 Blob 读取。

### 2.2 Agent 配置

| 选项 | 默认 | 说明 |
|---|---|---|
| `vision` | `false` | 主模型是否接受图片。对齐 dsh `inputModalities ?? ['text']` —— 默认拒绝。给了就必须是布尔值，否则**构造时抛** `TypeError`（`'true'` 不会被当成真） |
| `simpleVision` | 未配置简单模型时同 `vision`，否则 `false` | 只影响子 Agent 的 `fast` 别名（没配简单模型时 `fast` 就是主模型，所以继承 `vision`）；sidecar 一律走文本投影（§4.2）。类型校验同 `vision` |
| `imageLimits` | `{ maxImages: 20, maxBytes: 20 MiB, countQuantum: 5, byteQuantum: 10 MiB }` | 出站卸载的上限与量子（§3.A）。非法值**构造时抛** |
| `maxImageBytes` | `20 MiB` | 入口单张上限 |
| `imageTokenEstimator` | 按 url 推断：OpenAI → `'openai'`，其余 → `'mimo'` | `'openai' \| 'mimo' \| (w, h, detail) => number` |
| `unknownImageTokens` | `1024` | 宽高未知时的兜底计价 |

两个字节上限口径不同：`maxImageBytes` 按**解码后**字节计，`imageLimits.maxBytes` 按 **data URL 字符数**
（≈ 解码字节 × 4/3）计。入口两道都要过（§2.3 第 1、4 步），所以默认配置下单张图的实际上限约为
**15 MiB**（data URL 要装进 20 MiB），而不是 `maxImageBytes` 字面上的 20 MiB。

### 2.3 入口校验 —— 在 `memory.add` **之前**

校验失败时本轮**什么都不写**。顺序：

1. 部件合法性（类型、URL 协议、声明的媒体类型在白名单、base64 可解、**魔数**是白名单图片格式、
   单张 ≤ `maxImageBytes`）→ 否则 `InvalidContentError`。魔数嗅探只解码前 64 字节：非图字节挂在
   `image/png` 头下 → `unsupported_media_type`；头与魔数不符（JPEG 字节声明成 PNG）→ 收下，
   规范头**按魔数**重写（§1.1）。
2. 带图且 `vision !== true` → `UnsupportedContentError { code: 'vision_disabled' }`。
3. 带图且 `strategy === 'plan_and_execute'` → `UnsupportedContentError { code: 'plan_and_execute' }`。
4. 带图且这条消息**自己**的图就超出 `imageLimits`（张数 > `maxImages`，或 data URL 字符数之和
   > `maxBytes`；公网 URL 计 0 字节）→ `InvalidContentError { code: 'exceeds_image_limits' }`。
   收下它毫无意义：出站投影只会在携带它的那次请求里就把它换成卸载占位。

公网 http(s) URL 无法在入口校验（SDK 不替供应商抓图），风险见 §10。

**为什么必须先于 `memory.add`：** 若先写后抛，这条带图消息留在历史里，此后每一轮组装都会再撞上它，
会话被永久毒化。入口是唯一能"拒绝而不留痕"的位置。

`_mergePendingIntoUserMessage` 对数组消息：在最前面插一个 `{ type: 'text', text: notice }`，
**仍然不追加第二条 `user` 消息**（不变量 18）；字符串消息的行为逐字节不变。
交给 `_runPipeline` 的仍是原始 `message`（intent / skill filter 取其 `contentText`）。

### 2.4 工具返回图片

今天工具返回数组会被 `JSON.stringify` —— 很多工具**就是**返回 JSON 数组，
所以"返回数组即 parts"会破坏既有工具。改为显式包装：

```js
execute: async () => contentResult([
  { type: 'text', text: '渲染完成' },
  imagePart(pngBytes),
])
```

`contentResult` 用 `Symbol.for('lll.contentResult')` 打标，识别只看标记。
其 parts 与用户消息走**同一套**部件校验（§2.3 第 1 步，含魔数与单张 `maxImageBytes`；
视觉开启时还有第 4 步的 `imageLimits` 检查）。
`formatToolResult(callId, name, result)` 签名不变（`tool.js` 是稳定契约）：
遇到 `contentResult` 时 `content` 取规范化后的 parts（无图则折叠为字符串）。

**不支持视觉时：工具级报错。** 在 ReAct 的同步与流式两条工具循环里（`agent.js` 的
`tool.execute` 之后、`afterToolCall` 之前），若结果是含图的 `contentResult` 且 `vision !== true`：

- `result` 替换为错误文本：`Error: Tool "<name>" returned image content, but the model does not accept image input (vision is disabled).`
- `errorKind = 'unsupported_content'`，`tool.call` 事件 `ok: false`；
- `onError(new UnsupportedContentError({ code: 'vision_disabled' }), { round, toolName })`；
- run **继续**，模型看到错误结果并自行应对。

与仓库既有约定一致：工具失败永不打断 run（`tool-error-resilience.test.js`）。
**不能**整轮抛出 —— 此时 `assistant(tool_calls)` 已写入 memory，直接抛会留下悬空的
`tool_calls`，下一轮请求被供应商以 400 拒绝。`contentResult` 部件不合法、或（视觉开启时）
它自己的图就超出 `imageLimits` 时同理：`result` 为 `Error: Tool "<name>" returned invalid content: <InvalidContentError 消息>`，
`errorKind = 'invalid_content'`，`onError` 收到该 `InvalidContentError`。

`plan_and_execute` 的步骤内工具循环（`plan-and-execute.js:544`）对含图 `contentResult`
一律按 `unsupported_content` 处理（本版该策略不支持图）。

**MCP：** `mcp/normalize.js` 遇到 `image` 部件时产出 `contentResult`：
`text` 部件原文保留，`image` 部件转为 `image_url`（`data:<mimeType>;base64,<data>`），
`audio` / `resource_link` / `resource` 仍是既有的 `[mcp:<type> …]` 占位。
不含 `image` 部件的 MCP 结果，归一化输出**逐字节不变**。
只有白名单格式（png/jpeg/webp/gif）的 `image` 部件转成 `image_url`；其余格式（如 svg）保持既有的
`[mcp:image mimeType=…]` 占位，结果仍是字符串。`isError` 的结果永远是字符串。

---

## 3. 出站投影（`projection.js`）

打主模型的请求只在 `agent.js` 的三处组装：`_runPipeline` 的 ContextManager 路径与 simple 路径、
后续轮的 `_buildSimpleBody`。三处统一改为 **A → 组装 → B** 两步；
两步都是纯函数，**只作用于本次请求的副本，不改 memory**。

子 Agent 就是 `Agent`，走同一套 A/B，无需单独接线。

### A. `projectHistoryImages(history, { vision, imageLimits })` —— 计价/裁剪**之前**

1. **兜底文本投影。** `vision` 为假而历史里仍有图（自定义 memory 注入、宿主中途关掉 vision）→
   全部替换为 `[image omitted: model accepts text only; png 1024×768 #a1b2c3d4]`。
   正常流程被 §2.3 与 §2.4 两道闸挡住，走不到这里；兜底选**投影而非抛错**，
   否则一张旧图就能让会话永久不可用（这与 dsh `LlmRuntime` 的 `projectImagesForTextModel` 同位）。
2. **超限按量子卸载最老的图**（移植 dsh `offloadRequestImagesWithPolicy`）。
   - 按请求顺序收集所有图（含 `tool` 消息内的）。长度 = data URL 字符数（即 base64 表示）；
     公网 URL 计张数、字节计 0。
   - 超出 `maxImages` 或 `maxBytes` 时，待移除量**向上取整到量子倍数**，从最老处连续替换为
     `[image omitted to fit request image limits; png 1024×768 #a1b2c3d4]`。
   - **本轮受保护。** 最后一条"最终" `assistant`（无 `tool_calls` 或为空数组）**之后**的图 ——
     用户刚发的图、本轮工具回灌的图 —— 绝不在携带它的那次请求里被卸载。量子仍按**全部**图计算
     （与 dsh 一致，前缀稳定性不变），再封顶到边界及之前的旧图张数：
     `count = min(offloadedPrefixCount(全部), 旧图张数)`；没有这样的 `assistant` 时旧图张数为 0。
     图按顺序排列，封顶后的前缀碰不到本轮。代价：单条用户消息 / 单个工具结果自己超限已在入口
     （§2.3 第 4 步 / §2.4）被拒，但本轮的图**合计**超限（用户图加上几次工具回灌）时不卸载，
     原样发出，由供应商裁决。
   - **量子的意义是缓存稳定。** 每轮只挤掉一张，会让前缀每轮都变、prompt cache 每轮失效；
     按量子成批移除，被移除的前缀在历史再增长一个量子之前保持不变。
     dsh 的注释给过一个例子：129 张 1 MB 图、上限 128 MiB、量子 64 MiB → 一次移除最老的 65 张，
     剩 64 MiB；此后直到总量超过 192 MiB 前，这个前缀不动。
   - 默认 20 MiB 取自 dsh 的内联 base64 默认值（`DEFAULT_MAX_INLINE_REQUEST_IMAGE_BYTES`），
     低于 OpenAI 单请求总载荷上限（50 MB，以官方文档为准）。

**A 必须先于计价。** 计价看到的必须就是实际发出的东西：若 100 张图中 80 张已被卸载却仍按图计价，
预算会误判超限，把本不该裁的文本历史裁掉。卸载按量子跳变，带符号 delta 会随之出现负跳变 ——
不变量 7 本就允许负 delta。

### B. `toWireMessages(messages)` —— 组装完成、写入 body 之前的最后一步

1. **tool 图拆分。** `tool` 消息的 parts：文本部件拼接为该 `tool` 消息的字符串 `content`
   （为空则 `(no output)`），图片暂存；在下一条非 `tool` 消息之前（或数组末尾）插入一条

   ```js
   { role: 'user', content: [{ type: 'text', text: 'Attached image(s) from tool result:' }, ...images] }
   ```

   连续多个 tool 结果**共享**这一条，所以 `assistant(tool_calls)` 之后仍紧跟**全部** `tool` 消息，
   满足 OpenAI / Qwen / MiMo 的配对要求。OpenAI chat completions 的 `tool` 消息只收文本，
   dsh 的 `serializeMessagesWithImages` 用的是同一个布局。
2. **`assistant` / `system` 带图 → 抛** `UnsupportedContentError { code: 'image_in_role', role }`。
   代码不会产生这种消息，出现即 bug，fail loud（dsh `assertSupportedImageRoles` 同理）。
3. **无图请求原样返回同一个数组引用**，不复制 —— 纯文本会话零开销、零行为变化。

`_withUnavailableToolsNote`、skill 清单注入、子 Agent 类型清单注入不动：它们只改写
`system` 消息的字符串 `content`。

### 子 Agent 的视觉能力

模型别名（`agents/models.js`）增加可选 `vision` 字段：

| 情形 | `vision` |
|---|---|
| 不指定别名（继承父模型） | 父级 `vision` |
| 默认别名 `main` | 父级 `vision` |
| 默认别名 `fast` | 父级 `simpleVision` |
| 宿主配置的别名 | `spec.vision ?? (spec.model 未指定 ? 父级 vision : false)` |

---

## 4. Token 计价与文本投影

### 4.1 计价（`memory-policy.js` 的 `estimateMessageTokens`）

- `content` 为字符串：**算法逐字节不变**。校准锚点 `{role:'user', content:'abcd'}` === 9
  （不变量 5）保持。
- `content` 为数组：逐部件累加 ——
  文本 `ceil(len / 4) + BLOCK_OVERHEAD`；图片 `estimateImageTokens(part) + BLOCK_OVERHEAD`。
  **base64 永不按文本计价**（今天 `String(content).length` 对数组得出 `"[object Object]"`，
  而若改成按 data URL 字符数计，1 MB 图 ≈ 33 万 token，两个方向都错）。
- `TokenAwareMemory` 与 `ContextManager` 共用此函数，没有第二套算法。
  `headerFingerprint` 只看工具，不受影响。

**估算器（`image-tokens.js`）**

| 名称 | 公式 |
|---|---|
| `mimo` | MiMo 官方：宽高各取整到 32 的倍数，总像素夹在 [8192, 8388608]（超出按比例缩放），token = (w/32)·(h/32) |
| `openai` | tile 公式：`detail:'low'` → 85；否则先缩放进 2048×2048，再把短边缩到 768，按 512 切 tile，token = 85 + 170·tiles |

`openai` 公式对应 gpt-4o 系列；mini / 新型号的公式可能不同，所以估算器可由宿主覆盖。
宿主估算器抛错或返回非有限 / 负数时按 `unknownImageTokens` 计价 —— 计价只是估算，不能把整轮打断。
`estimateMessageTokens(msg, pricing)` 的 `pricing` 缺省或为 `null` 时用默认（`mimo`）计价。
估算偏差的影响面有限：锚点是真实用量（不变量 6），一张图只在**首次被发送的那一轮**
处于"估算增量"里，之后就进入锚点。

### 4.2 文本投影 `contentText(content)`

字符串原样返回；数组 → 文本部件以 `\n` 拼接，图片渲染为 `[image png 1024×768 #a1b2c3d4]`。

| 调用方 | 今天的问题 | 改法 |
|---|---|---|
| 摘要（`memory-policy.js` `plan()`） | `[object Object]` | `contentText`。被摘要的图只剩占位 —— 接受这个信息损失；摘要走简单模型，本就只收文本 |
| `intent-recognizer.js` `sanitizeHistory` | 带图消息被 `typeof === 'string'` **直接丢弃** | 保留消息，内容取 `contentText`；`analyze` 入参与末尾去重都按 `contentText` 比较 |
| `skills/filter.js` | — | 入参取 `contentText(userMessage)` |
| `plan-and-execute.js` `sanitizeHistory` | 同 intent | 同样修 |
| `agents/history-search.js` | `String()` → `[object Object]` | `contentText`；顺带避免对几 MB base64 做全文检索 |
| `agents/tools.js` 的 `history_get` | 数组被原样拼进字符串 | `contentText`（`mirror.js` 只处理摘要文本，恒为字符串，无需改） |

### 4.3 Spill 与遥测

- `_applySpill` 遇到 `contentResult`：只对拼接后的文本部件限界，图片原样保留（由 §3.A 的
  张数/字节上限约束）。"永不抛"（不变量 28）保持。
- `tool.call` 事件：`bytes` = 文本部分的 UTF-8 字节数；新增可选字段 `imageCount`（纯增量）。

---

## 5. `plan_and_execute`

本版不支持带图：入口拒绝用户图（§2.3），步骤内工具图按 `unsupported_content` 处理（§2.4）。

理由：步骤执行是独立的 ReAct，只拿到 planner 写好的步骤描述，看不到用户原消息；
把图塞进每一步要么按步数重复计费，要么仍然看不见。与不变量 3（若干机制只在 ReAct 路径生效）同类，
写进 AGENTS.md。

---

## 6. 错误

遵守仓库约定：**构造函数只接受白名单标量字段**（同 `mcp/errors.js`、`skills/errors.js`、`agents/errors.js`）。
**错误消息永远不含 URL 或 base64** —— 既可能有几 MB，又是用户数据；测试断言这一点。

| 类 | 字段 | `code` |
|---|---|---|
| `UnsupportedContentError` | `code`, `role?` | `'vision_disabled'` · `'plan_and_execute'` · `'image_in_role'` |
| `InvalidContentError` | `code`, `partIndex?`, `mediaType?`, `bytes?`, `maxBytes?`, `images?`, `maxImages?` | `'bad_part_type'` · `'bad_url_scheme'` · `'unsupported_media_type'` · `'image_too_large'` · `'bad_base64'` · `'exceeds_image_limits'` |

`exceeds_image_limits` 的 `images` / `bytes` 是这条内容的图张数与 data URL 字符数，`maxImages` / `maxBytes`
取自 `imageLimits`；消息形如 `Images in this content (3 images, 900 bytes as data URLs) exceed the per-request image limits (2 images, 800 bytes); lower maxImageBytes or raise imageLimits.`
（`images` / `maxImages` 与其余数值字段一样只收非负安全整数。）

---

## 7. 模块划分

| 文件 | 职责 |
|---|---|
| `src/content/parts.js` | 入口规范化（文本数组折叠）、`imagePart`、`contentResult`、`isContentResult`、`contentText`、`hasImage`、`toolResultText`、`normalizeMaxImageBytes` |
| `src/content/image-meta.js` | data URL 解析、四种格式的宽高嗅探、短摘要 |
| `src/content/image-tokens.js` | `mimo` / `openai` 估算器 |
| `src/content/projection.js` | `projectHistoryImages`、`toWireMessages`、`imagesExceedLimits`（入口与工具闸的单条内容上限检查） |
| `src/content/errors.js` | 两个错误类 |
| `src/content/index.js` | 模块出口 |

`src/index.js` 追加导出：`imagePart`、`contentResult`、`isContentResult`、`contentText`、
`UnsupportedContentError`、`InvalidContentError`（`src/index.test.js` 同步登记）。
`providers.js` 与 `llm-client.js` 的 `_providerFromUrl` 增加 `xiaomi`
（`https://api.xiaomimimo.com/v1/chat/completions`）。

全部代码零运行时依赖、不 import 任何 Node-only 内置模块，浏览器构建直接可用。

---

## 8. 验证

### 8.1 单元测试（全部 mock HTTP）

- **content**：四种格式宽高解析（字节在测试内生成）、短摘要稳定、文本数组折叠、
  错误消息不含数据。
- **projection**：fast-check 属性 ——"被卸载前缀在历史增长一个量子之前不变"；
  连续 tool 结果共享一条图片 `user` 消息且 `tool_calls` 后紧跟全部 `tool`；
  无图返回**同一引用**。
- **计价**：9-token 锚点不变；base64 不按文本计价；两个公式在已知宽高上的数值。
- **Agent 集成**：
  - `vision:false` 发图 → 抛，memory 零写入、零 HTTP；
  - `vision:true` → 请求 body 含 `image_url`；
  - 工具图 + `vision:false` → `errorKind:'unsupported_content'`、`onError` 触发、run 正常结束；
  - intent 历史保留带图轮次；摘要输入是占位不是 base64；`history_search` 搜不到 base64；
  - MCP `image` 部件 → `contentResult`；子 Agent 别名的 `vision` 继承。
- **回归**：`npm test` 全绿；`p0-*`、`review-r1-r4`、`token-accounting`、`spill/policy`、
  `agents/index` 等契约守卫不改。

### 8.2 `examples/multimodal.js` —— 综合用例（DoD 第 3 条）

测试图由 `demo/lib/png.js`（Node 内置 `zlib`）现场生成 PNG（颜色、数量确定的色块），不依赖图片文件。
断言**发生了什么**，不断言措辞；任何失败非零退出。依次对 **OpenAI** 与 **MiMo** 各跑一遍。

| 幕 | 内容 | 断言 |
|---|---|---|
| 1 | 用户发一张含 N 个色块的图，要求调 `report_count({count})` | 工具被调用且 `count === N`（同时覆盖既有工具调用） |
| 2 | 工具 `render_chart` 返回 `contentResult`（三根不同颜色的柱） | 模型调 `submit_answer({color})` 答出最高柱的颜色 |
| 3 | `demo/mcp-servers/image-chart.js`（最小 stdio MCP 服务器，与 demo 共用）返回 `image` 部件 | 模型拿到图并完成同样判断 |
| 4 | 追问"刚才第一张图里有几个色块"；再把 `imageLimits` 调小 | 历史保留生效；调小后请求里出现卸载占位 |
| 5 | 同场：SummarizingMemory（小阈值触发摘要）、意图识别 + 工具过滤、`tokenBudget` | 摘要里是占位而非 base64；`context.assembled` 可见图片 token |
| 6 | `vision:false` 的 Agent：发图；再调一个返回图的工具 | 前者抛 `UnsupportedContentError` 且 memory 不变；后者工具级错误、run 正常结束 |

### 8.3 demo

- `demo/server.js`：`message` 接受字符串或 parts；provider 解析加 `xiaomi`；`VISION=1` 开关；
  新增一个返回图表图片的 demo 工具。
- `demo/index.html` / `demo/browser.html`：附件按钮 + 粘贴图片、发送前缩略图预览；
  聊天记录渲染带图消息（`content` 可能是数组）；设置区 vision 开关；供应商列表加小米。
- 先 `npm run build`，再用浏览器自动化在页面上**真实完成**"上传图片 → 对话 → 工具返回图"，
  服务端 Agent（`/`）与浏览器端 Agent（`/browser`）各一次。

验收需要 `OPENAI_API_KEY` 与 `MIMO_API_KEY`，以及两边的视觉模型名（MiMo 官方列出的可收图模型：
`mimo-v2.6-flash`、`mimo-v2.6-pro`、`mimo-v2.6-pro-ultraspeed`、`mimo-v2.5`；
**`mimo-v2.5-pro` 不收图**）。

---

## 9. 取舍记录

**内联而非 attachment store。** dsh 把字节放进内容寻址的 store、消息只存引用，好处是
memory / 事件日志 / 子 Agent 镜像不被 base64 撑大，占位还能给出模型可读的路径。
我们选择内联：实现面小、`getHistory()` 直接是 OpenAI 形状、不引入第二个存储生命周期。
代价是 base64 常驻内存、`cloneMessage` 会深拷贝大字符串、卸载占位无法指向可恢复的路径。
若日后出现内存压力，§1 的"元信息按需推导、消息无私有字段"让迁移到引用形态只需改
`parts.js` 与 `projection.js` 两处。

**方案 1（OpenAI parts）而非旁挂 `images` 字段。** 旁挂字段能让 57 处 `.content` 读者一行不改，
但形状非标准、图文穿插顺序丢失、将来接其他 provider adapter 要再转一次。
"无图 ⇒ 字符串"已经把回归面限定在带图会话里。

**模型不支持视觉时报错而非降级。** 用户的明确选择：静默降级让模型"假装看过"比报错更糟。
用户图在入口报错（整轮拒绝），工具图在工具级报错（run 继续）——位置不同是因为
工具图到达时 `assistant(tool_calls)` 已入 memory，整轮抛出会留下悬空 `tool_calls`。

---

## 10. 已知风险

- **MiMo 思考模式 + 工具调用。** MiMo 文档要求思考模式下调工具后，后续请求回传历史
  `reasoning_content`，否则 400。我们写 memory 时丢弃了它（improvements.md **D-2**）。
  这不是多模态问题、不并入本设计；若验收撞上，按 AGENTS.md DoD 第 4 条单独修复。
- **OpenAI 计价公式漂移。** 不同型号公式不同，估算器可覆盖；锚点兜住长期误差。
- **公网 URL 无法在入口校验。** http(s) 图片 URL 原样收下（SDK 不替供应商抓图）。若供应商抓不到
  （404、鉴权、内网地址），这条带图消息此后**每一轮**都会让请求失败，直到它被卸载（§3.A）、被摘要压掉，
  或宿主调用 `reset()`。需要确定性的宿主应先自行下载，再以 data URL 传入。
- **JPEG 尺寸扫描上限。** EXIF 缩略图很大的 JPEG 可能在 256 KB 内扫不到 SOF，
  此时按 `unknownImageTokens` 计价，不影响发送。
- **demo 载荷。** data URL 经 `/chat` 的 JSON 与 SSE 往返，大图会让单次请求变重；
  demo 前端在发送前提示图片大小。

---

## 相关测试

- `src/content/image-meta.test.js` —— 四种格式宽高、JPEG 扫描上限、魔数优先、错误类不泄露数据
- `src/content/parts.test.js` —— 规范化、折叠、魔数校验（非图字节拒绝、魔数改写头）、`imagePart`、`contentResult` 往返
- `src/content/image-tokens.test.js` —— 两个公式的钉住值、9-token 锚点、base64 不按文本计价
- `src/content/projection.test.js` —— dsh 量子算例、fast-check 属性（前缀单调、剩余在限内、整量子）、本轮受保护、`imagesExceedLimits`、tool 图拆分
- `src/agent-multimodal.test.js` —— 入口拒绝不留痕（含 `exceeds_image_limits`）、两条路径发图、ContextManager 路径先投影后计价、纯文本逐字节不变、积压合并、stream 对等、工具图（含超限）、spill、plan 模式、`vision` 类型校验
- `src/multimodal-consumers.test.js` —— 摘要、意图识别、技能过滤、历史检索的文本投影
- `src/mcp/image-result.test.js` —— normalize 的图片分支 + 真实 stdio 的 image-chart server
- `demo/lib/png.test.js` —— PNG 编码与 CRC

## 来源

- deepseek-harness：`packages/llm/llm/src/content.ts`（`offloadRequestImagesWithPolicy`、
  `projectImagesForTextModel`、`contentHasImage`）、`packages/llm/llm-deepseek/src/serialize.ts`
  （tool 图拆分、`assertSupportedImageRoles`）、`packages/llm/llm-deepseek/src/adapter.ts`
  （量子默认值、`UNSUPPORTED_CONTENT`）、`docs/subsystems/attachment.zh.md`。行号为写作时定位。
- [MiMo 图片理解](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/multimodal-understanding/image-understanding)
  · [MiMo OpenAI 兼容 API](https://mimo.mi.com/docs/zh-CN/api/chat/openai-api)
