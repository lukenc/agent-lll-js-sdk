# `skills/` — Skill 系统

> 父文档：[设计说明索引](README.md) · 回到 [CLAUDE.md](../../CLAUDE.md)

入口是 `skills/index.js`，再导出下面各部件以及
`SkillLoadError` / `SkillParseError` / `SkillMaterializeError` / `SkillProviderError`。

**零新增运行时依赖** —— 纯 Node 18+ 内置（`node:fs/promises`、`node:path`、`node:os`）加 `fetch`。
local provider **动态** import `node:fs/promises`，所以 `skills/` 仍能安全打进浏览器构建。

---

## 内部布局

### `skills/model.js`

- `parseFrontmatter` —— 零依赖的手写 YAML 子集解析器（标量、单层 map、字符串列表）。
- `parseSkillMd(text, ctx): Skill_Def` —— **目录名是权威 `name`**；
  frontmatter 里的 `name` 不一致时只 warn 并被覆盖；要求 `description` 非空，
  超过 `MAX_DESCRIPTION`（1024 字符）时截断并 warn；`argument-hint` → `argumentHint`。
- `applySkillArgs(body, args): { text, applied }` —— 单趟展开 `$ARGUMENTS` / `$1`..`$9`，
  使用函数式 replacer，所以 args 里形如 `$&` 的文本不会被二次解释。
- `NAME_RE = /^[a-z0-9-]{1,64}$/`。

### `skills/provider.js`

`SkillProvider` 契约（`listSkills()` + `fetchSkill(name)`，可选 `readResource(name, relPath)`）
与工厂注册表：`registerSkillProvider(type, factory)` 用于自定义类型，
`resolveProvider(config)` 接受一个 provider 实例或一个 `{ type, ...opts }` 配置。
**保留类型 `local` / `http` 不可被覆盖。**

### `skills/providers/local.js`

扫描目录，找出含 `SKILL.md` 的子目录；`fetchSkill` 返回 `{ baseDir }`
（**零拷贝** —— registry 因此跳过物化）。`readResource` 解析目标路径，
并**拒绝任何逃出 skill 目录**的访问。

### `skills/providers/http.js`

线协议：

- `GET {baseUrl}/manifest.json` → `{ skills: [{ name, description, version, hash, files }] }`
- `GET {baseUrl}/skills/{name}/{relPath}` → 文件内容

用 `NAME_RE` 校验 skill 名，并在构造资源 URL **之前**拒绝/百分号编码路径段
（`..`、空段直接 throw）。

### `skills/materializer.js`（仅 Node）

`materializeBundle(name, bundle, { cacheDir })` 把内存文件束写到
`~/.lll-agent/skills-cache/<name>/`，走 **临时目录 → 原子 `rename`** 交换
（先移除旧目录以得到干净的替换）。

### `skills/registry.js`

`createSkillRegistry({ providers, cacheDir, runtime })`：

- 对所有 provider 做**急切全量加载**，进一张内存 map；
- 跨 provider 的同名 skill **先到先得**（后面的 warn + skip）；
- `refresh()` 对 provider 报告的 `hash` 未变的条目**复用缓存的 `Skill_Def`**；
- 浏览器 runtime **永不物化**（`baseDir: null`）；
- `readResource(name, relPath)` 拒绝 `..` 与绝对路径。

### `skills/filter.js`

`SkillFilter`：一次 sidecar LLM 调用（`syncChat`），按与用户消息的相关度给 skill 排序，
以 JSON 返回 top-K 名字；**fail-open**（任何解析/LLM 错误都返回完整 skill 列表），
与 `IntentRecognizer` 的失败策略一致。

### `skills/errors.js`

`SkillLoadError` / `SkillParseError` / `SkillMaterializeError` / `SkillProviderError`。
构造函数只接受白名单标量字段（`skillName` / `providerName` / `cause`），
与 `mcp/errors.js` 同一套模式。

---

## Agent 侧接线（`agent.js`）

`opts.skills`（`providers`、`runtime`、`cacheDir`、`filter.threshold` 默认 50、
`filter.topK` 默认 20）创建 `this.skills`（一个 `SkillRegistry`）。

- `loadSkills()` / `refreshSkills()` 触发急切加载 / 刷新。
- sidecar `SkillFilter` 在 `_runPipeline` 内**每条用户消息只跑一次**
  （不是每 ReAct 轮 —— 用户消息在轮与轮之间不变），结果被缓存并在该轮的每一轮复用。
- `_withSkillListingNote` 每轮把 **Level 1** skill 清单注入 system 消息
  （`- name: description`，当 skill 声明了 `argument-hint` 时再加 ` (args: <hint>)`）。
- `skill` 元工具的参数形状是 `{ skill, args? }`（`name` 作为宽松别名被接受），
  调用时注入某个 skill 的完整正文（**Level 2**），把 `args` 展开进正文的占位符 ——
  正文没有占位符时则追加 `Arguments: <args>`，**所以 args 绝不会被静默丢弃**。
- 一个**仅浏览器**的 `skill_resource` 工具暴露 **Level 3** 的束内资源读取
  （Node 侧依赖既有的 `read_file` / `shell_exec` 基础工具）。

`skill` 必须 `registerBaseTool`（commit `20617d8` 的先例）：系统提示里已经列出 skill 清单，
若 `enableIntentRecognition` 开着而 `ToolFilter` 把 `skill` 裁掉，
那份清单就成了工具集兑现不了的承诺。

---

## 安全告诫

**v1 没有沙箱。** 网络来源的 skill 脚本通过宿主提供的 `shell_exec` 工具运行。
消费远程（HTTP）skill provider 的宿主**必须自己把关执行**，
手段是 tool provisioning 与 `hooks.beforeToolCall`。

---

## 已知限制

**skill 清单注入目前只作用于 ReAct 策略** —— 在 `strategy: 'plan_and_execute'` 下，
`PlanAndExecuteStrategy` 自己构造 step 的 system prompt，收不到 skill 清单
（`skill` 工具在那里**仍可调用**，只是看不见清单）。
子 Agent 的注入与 `_applySpill` 是同一形状的限制。

## 来源

- `CLAUDE.md` Supporting modules 的 `skills/` 条目（2026-09-07 精简前的版本）
