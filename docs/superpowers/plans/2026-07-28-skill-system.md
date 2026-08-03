# Skill System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Claude Code-style skill system to lll-web-agent — named instruction packages (SKILL.md + scripts/references) loaded from local folders or HTTP, injected into the system prompt, with an LLM filter for large skill sets.

**Architecture:** A self-contained `src/skills/` subsystem mirroring `src/mcp/`. Providers (local/http) are dumb pipes returning bytes; the registry parses/validates/materializes into `Skill_Def[]`; the agent injects a Level 1 listing into the system prompt and a `skill` meta-tool for Level 2 body injection. A separate `SkillFilter` sidecar ranks skills when the count exceeds a threshold.

**Tech Stack:** Pure ESM JavaScript, Node >=18 (browser degraded), `node:test` + `node:assert`, `fast-check` (devDep, already present). Zero new runtime dependencies.

## Global Constraints

- Pure ESM (`import`/`export`, `"type": "module"`) — no `require`, no TypeScript.
- Node >=18 built-ins only (`fs`, `path`, `os`, `fetch`). Zero new runtime dependencies.
- Tests use `node:test` + `node:assert`, co-located as `src/**/*.test.js`. All HTTP mocked; no real API keys.
- Error constructors accept only whitelist scalar fields — never raw options objects (prevents secret leakage).
- `name` regex: `^[a-z0-9-]{1,64}$`. `description`: non-empty, ≤1024 chars.
- Follow existing `src/mcp/` patterns for module layout, error classes, and transport-style registry.
- No linter/formatter configured — match surrounding code style (2-space indent, no semicolons at statement ends per existing files).

---

### Task 1: Error classes

**Files:**
- Create: `src/skills/errors.js`
- Test: `src/skills/errors.test.js`

**Interfaces:**
- Consumes: nothing (leaf module)
- Produces: `SkillLoadError`, `SkillParseError`, `SkillMaterializeError`, `SkillProviderError` — each extends `Error`, sets `this.name`, accepts only whitelist scalar fields `{ skillName?, providerName?, cause? }` as a second options arg.

- [ ] **Step 1: Write the failing test**

```js
// src/skills/errors.test.js
import { test } from 'node:test'
import assert from 'node:assert'
import {
  SkillLoadError, SkillParseError, SkillMaterializeError, SkillProviderError,
} from './errors.js'

test('SkillParseError carries skillName and message, no raw options leak', () => {
  const err = new SkillParseError('missing description', { skillName: 'pdf' })
  assert.strictEqual(err.name, 'SkillParseError')
  assert.strictEqual(err.skillName, 'pdf')
  assert.match(err.message, /missing description/)
  assert.ok(err instanceof Error)
})

test('SkillProviderError carries providerName and cause', () => {
  const cause = new Error('network down')
  const err = new SkillProviderError('listSkills failed', { providerName: 'http', cause })
  assert.strictEqual(err.name, 'SkillProviderError')
  assert.strictEqual(err.providerName, 'http')
  assert.strictEqual(err.cause, cause)
})

test('errors never store a whole options object', () => {
  const err = new SkillLoadError('boom', { skillName: 'x', apiKey: 'SECRET' })
  assert.strictEqual(err.apiKey, undefined)
  assert.ok(!JSON.stringify({ ...err }).includes('SECRET'))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/skills/errors.test.js`
Expected: FAIL — `Cannot find module './errors.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// src/skills/errors.js
/**
 * Skill 子系统错误类。构造函数只接收白名单标量字段
 * (skillName / providerName / cause),绝不接收原始 options 对象,
 * 防止 API key、headers 等敏感值泄漏进 err.message 或 err 自身属性。
 * 与 src/mcp/errors.js 同款设计。
 */

export class SkillLoadError extends Error {
  constructor(message, { skillName, providerName, cause } = {}) {
    super(message)
    this.name = 'SkillLoadError'
    if (skillName !== undefined) this.skillName = skillName
    if (providerName !== undefined) this.providerName = providerName
    if (cause !== undefined) this.cause = cause
  }
}

export class SkillParseError extends Error {
  constructor(message, { skillName, cause } = {}) {
    super(message)
    this.name = 'SkillParseError'
    if (skillName !== undefined) this.skillName = skillName
    if (cause !== undefined) this.cause = cause
  }
}

export class SkillMaterializeError extends Error {
  constructor(message, { skillName, cause } = {}) {
    super(message)
    this.name = 'SkillMaterializeError'
    if (skillName !== undefined) this.skillName = skillName
    if (cause !== undefined) this.cause = cause
  }
}

export class SkillProviderError extends Error {
  constructor(message, { providerName, cause } = {}) {
    super(message)
    this.name = 'SkillProviderError'
    if (providerName !== undefined) this.providerName = providerName
    if (cause !== undefined) this.cause = cause
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/skills/errors.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/skills/errors.js src/skills/errors.test.js
git commit -m "feat(skills): add skill subsystem error classes"
```

---

### Task 2: SKILL.md frontmatter parser + Skill_Def

**Files:**
- Create: `src/skills/model.js`
- Test: `src/skills/model.test.js`

**Interfaces:**
- Consumes: `SkillParseError` from `./errors.js`
- Produces:
  - `parseFrontmatter(text) → { frontmatter: object, body: string }` — splits leading `---\n...\n---\n` block; returns `{ frontmatter: {}, body: text }` when no frontmatter present.
  - `parseSkillMd(text, { dirName, source, files, baseDir }) → Skill_Def` — full parse + validation. Throws `SkillParseError` on missing/invalid required fields. `Skill_Def` shape per spec §1.
  - `NAME_RE` = `/^[a-z0-9-]{1,64}$/`, `MAX_DESCRIPTION = 1024`.

- [ ] **Step 1: Write the failing test**

```js
// src/skills/model.test.js
import { test } from 'node:test'
import assert from 'node:assert'
import { parseFrontmatter, parseSkillMd } from './model.js'
import { SkillParseError } from './errors.js'

test('parseFrontmatter splits block and body', () => {
  const text = '---\nname: pdf\ndescription: Process PDFs\n---\nBody line one\nBody line two'
  const { frontmatter, body } = parseFrontmatter(text)
  assert.strictEqual(frontmatter.name, 'pdf')
  assert.strictEqual(frontmatter.description, 'Process PDFs')
  assert.strictEqual(body, 'Body line one\nBody line two')
})

test('parseFrontmatter with no frontmatter returns empty map + full body', () => {
  const { frontmatter, body } = parseFrontmatter('just text')
  assert.deepStrictEqual(frontmatter, {})
  assert.strictEqual(body, 'just text')
})

test('parseFrontmatter parses string list (block + inline)', () => {
  const block = '---\nallowed-tools:\n  - read_file\n  - shell_exec\n---\nx'
  assert.deepStrictEqual(parseFrontmatter(block).frontmatter['allowed-tools'], ['read_file', 'shell_exec'])
  const inline = '---\nallowed-tools: read_file, shell_exec\n---\nx'
  assert.deepStrictEqual(parseFrontmatter(inline).frontmatter['allowed-tools'], ['read_file', 'shell_exec'])
})

test('parseSkillMd builds a valid Skill_Def', () => {
  const text = '---\nname: pdf-processing\ndescription: Process PDFs\nversion: 1.0.0\n---\nInstructions here'
  const def = parseSkillMd(text, {
    dirName: 'pdf-processing',
    source: { provider: 'local', origin: '/skills' },
    files: ['scripts/fill.py'],
    baseDir: '/skills/pdf-processing',
  })
  assert.strictEqual(def.name, 'pdf-processing')
  assert.strictEqual(def.description, 'Process PDFs')
  assert.strictEqual(def.version, '1.0.0')
  assert.strictEqual(def.body, 'Instructions here')
  assert.deepStrictEqual(def.files, ['scripts/fill.py'])
  assert.strictEqual(def.baseDir, '/skills/pdf-processing')
  assert.strictEqual(def.disableModelInvocation, false)
})

test('parseSkillMd uses dirName over frontmatter name on mismatch', () => {
  const text = '---\nname: wrong-name\ndescription: d\n---\nb'
  const def = parseSkillMd(text, { dirName: 'real-name', source: {}, files: [], baseDir: null })
  assert.strictEqual(def.name, 'real-name')
})

test('parseSkillMd throws on missing description', () => {
  const text = '---\nname: pdf\n---\nb'
  assert.throws(
    () => parseSkillMd(text, { dirName: 'pdf', source: {}, files: [], baseDir: null }),
    SkillParseError,
  )
})

test('parseSkillMd truncates over-long description to 1024', () => {
  const long = 'x'.repeat(2000)
  const text = `---\nname: pdf\ndescription: ${long}\n---\nb`
  const def = parseSkillMd(text, { dirName: 'pdf', source: {}, files: [], baseDir: null })
  assert.strictEqual(def.description.length, 1024)
})

test('parseSkillMd preserves unknown fields in metadata.extra', () => {
  const text = '---\nname: pdf\ndescription: d\ncustom-field: hello\n---\nb'
  const def = parseSkillMd(text, { dirName: 'pdf', source: {}, files: [], baseDir: null })
  assert.strictEqual(def.metadata.extra['custom-field'], 'hello')
})

test('parseSkillMd parses disable-model-invocation true', () => {
  const text = '---\nname: pdf\ndescription: d\ndisable-model-invocation: true\n---\nb'
  const def = parseSkillMd(text, { dirName: 'pdf', source: {}, files: [], baseDir: null })
  assert.strictEqual(def.disableModelInvocation, true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/skills/model.test.js`
Expected: FAIL — `Cannot find module './model.js'`

- [ ] **Step 3: Write minimal implementation**

See Task 2 code block below (kept separate because it exceeds one screen). Create `src/skills/model.js` with the full contents of the "Task 2 implementation" section.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/skills/model.test.js`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/skills/model.js src/skills/model.test.js
git commit -m "feat(skills): add SKILL.md frontmatter parser and Skill_Def model"
```

#### Task 2 implementation (`src/skills/model.js`)

```js
/**
 * Skill 模型 + SKILL.md frontmatter 解析。
 * 零依赖手写 YAML 子集解析器:仅支持 frontmatter 实际用到的形态 ——
 * 标量、单层 map、字符串列表(block `- item` 与 inline `a, b`)。
 * 与 src/mcp/ 的"零新运行时依赖"铁律一致。
 */

import { SkillParseError } from './errors.js'

export const NAME_RE = /^[a-z0-9-]{1,64}$/
export const MAX_DESCRIPTION = 1024

const KNOWN_KEYS = new Set([
  'name', 'description', 'version', 'license', 'allowed-tools',
  'disable-model-invocation', 'metadata',
])

/** 解析标量:去引号、识别 true/false。 */
function parseScalar(raw) {
  let v = raw.trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1)
  }
  if (v === 'true') return true
  if (v === 'false') return false
  return v
}

/** 把 inline 列表 "a, b, c" 拆成数组;单元素也返回数组。 */
function parseInlineList(raw) {
  return raw.split(/[,\s]+/).map(s => s.trim()).filter(s => s.length > 0)
}

/**
 * 切分 frontmatter。文本以 `---\n` 开头且存在闭合 `---` 时,解析中间块;
 * 否则返回 { frontmatter: {}, body: 原文 }。
 * @param {string} text
 * @returns {{ frontmatter: object, body: string }}
 */
export function parseFrontmatter(text) {
  const src = String(text ?? '')
  if (!src.startsWith('---')) return { frontmatter: {}, body: src }

  // 找到第一行 --- 之后的闭合 ---(独占一行)
  const lines = src.split('\n')
  if (lines[0].trim() !== '---') return { frontmatter: {}, body: src }
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break }
  }
  if (end === -1) return { frontmatter: {}, body: src }

  const fmLines = lines.slice(1, end)
  const body = lines.slice(end + 1).join('\n')
  const frontmatter = {}

  let i = 0
  while (i < fmLines.length) {
    const line = fmLines[i]
    if (line.trim() === '' || line.trim().startsWith('#')) { i++; continue }
    const m = line.match(/^([A-Za-z0-9_-]+):(.*)$/)
    if (!m) { i++; continue }
    const key = m[1]
    const rest = m[2]
    if (rest.trim() === '') {
      // 可能是 block 列表或 block map:向下看缩进行
      const items = []
      let j = i + 1
      while (j < fmLines.length && /^\s+-\s+/.test(fmLines[j])) {
        items.push(parseScalar(fmLines[j].replace(/^\s+-\s+/, '')))
        j++
      }
      if (items.length > 0) {
        frontmatter[key] = items
        i = j
        continue
      }
      frontmatter[key] = ''
      i++
    } else {
      frontmatter[key] = parseScalar(rest)
      i++
    }
  }

  return { frontmatter, body }
}

/** 归一 allowed-tools 为 string[] | null。 */
function normalizeAllowedTools(v) {
  if (Array.isArray(v)) return v.map(String)
  if (typeof v === 'string' && v.trim().length > 0) return parseInlineList(v)
  return null
}

/**
 * 解析并校验一个 SKILL.md,产出 Skill_Def。
 * @param {string} text SKILL.md 全文
 * @param {object} ctx
 * @param {string} ctx.dirName 目录名(权威 name 来源)
 * @param {object} ctx.source 溯源 { provider, origin }
 * @param {string[]} ctx.files 捆绑资源相对路径清单
 * @param {string|null} ctx.baseDir 物化后绝对路径(浏览器为 null)
 * @returns {Skill_Def}
 * @throws {SkillParseError} 缺少必填字段或 name 非法
 */
export function parseSkillMd(text, { dirName, source, files, baseDir }) {
  const { frontmatter, body } = parseFrontmatter(text)

  // name:目录名权威;与 frontmatter 不一致时 warn 并采用目录名。
  let name = dirName
  if (frontmatter.name && frontmatter.name !== dirName) {
    console.warn(`[skills] name "${frontmatter.name}" in SKILL.md != dir "${dirName}"; using dir name`)
  }
  if (!NAME_RE.test(name)) {
    throw new SkillParseError(`invalid skill name "${name}" (must match ${NAME_RE})`, { skillName: name })
  }

  let description = frontmatter.description
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new SkillParseError('SKILL.md missing required non-empty description', { skillName: name })
  }
  if (description.length > MAX_DESCRIPTION) {
    console.warn(`[skills] description of "${name}" exceeds ${MAX_DESCRIPTION} chars; truncating`)
    description = description.slice(0, MAX_DESCRIPTION)
  }

  const extra = {}
  for (const k of Object.keys(frontmatter)) {
    if (!KNOWN_KEYS.has(k)) extra[k] = frontmatter[k]
  }

  const metadata = (frontmatter.metadata && typeof frontmatter.metadata === 'object')
    ? { ...frontmatter.metadata, extra }
    : { extra }

  return {
    name,
    description,
    version: frontmatter.version ?? null,
    license: frontmatter.license ?? null,
    allowedTools: normalizeAllowedTools(frontmatter['allowed-tools']),
    disableModelInvocation: frontmatter['disable-model-invocation'] === true,
    metadata,
    body,
    files: Array.isArray(files) ? files : [],
    baseDir: baseDir ?? null,
    source: source ?? {},
  }
}
```

---

### Task 3: Provider registry + contract

**Files:**
- Create: `src/skills/provider.js`
- Test: `src/skills/provider.test.js`

**Interfaces:**
- Consumes: `SkillProviderError` from `./errors.js`
- Produces:
  - `registerSkillProvider(type, factory)` — registers a factory; throws `SkillProviderError` if `type` is reserved (`local`, `http`) or already registered.
  - `resolveProvider(config)` — given a config object `{ type, ...opts }` OR a duck-typed instance (has `listSkills` + `fetchSkill`), returns a provider instance. Throws `SkillProviderError` on unknown type.
  - `_setBuiltinProvider(type, factory)` — internal; lets `local`/`http` self-register on module load without tripping the reserved-name guard.
  - `RESERVED_PROVIDER_TYPES` = `['local', 'http']`.

- [ ] **Step 1: Write the failing test**

```js
// src/skills/provider.test.js
import { test } from 'node:test'
import assert from 'node:assert'
import {
  registerSkillProvider, resolveProvider, _setBuiltinProvider,
} from './provider.js'
import { SkillProviderError } from './errors.js'

test('resolveProvider passes through a duck-typed instance', () => {
  const inst = { name: 'custom', listSkills: async () => [], fetchSkill: async () => ({}) }
  assert.strictEqual(resolveProvider(inst), inst)
})

test('resolveProvider builds from a registered type', () => {
  _setBuiltinProvider('local', (opts) => ({ name: 'local', dir: opts.dir, listSkills: async () => [], fetchSkill: async () => ({}) }))
  const p = resolveProvider({ type: 'local', dir: '/x' })
  assert.strictEqual(p.dir, '/x')
})

test('resolveProvider throws on unknown type', () => {
  assert.throws(() => resolveProvider({ type: 'nope' }), SkillProviderError)
})

test('registerSkillProvider rejects reserved names', () => {
  assert.throws(() => registerSkillProvider('local', () => ({})), SkillProviderError)
  assert.throws(() => registerSkillProvider('http', () => ({})), SkillProviderError)
})

test('registerSkillProvider allows a new custom type then resolves it', () => {
  registerSkillProvider('memory', (opts) => ({ name: 'memory', tag: opts.tag, listSkills: async () => [], fetchSkill: async () => ({}) }))
  const p = resolveProvider({ type: 'memory', tag: 't1' })
  assert.strictEqual(p.tag, 't1')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/skills/provider.test.js`
Expected: FAIL — `Cannot find module './provider.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// src/skills/provider.js
/**
 * SkillProvider 契约 + provider 工厂注册表。
 * 仿 src/mcp/transports/index.js:内置 local/http 经 _setBuiltinProvider 自注册,
 * 用户经 registerSkillProvider 注册自定义类型,保留名不可覆盖。
 */

import { SkillProviderError } from './errors.js'

export const RESERVED_PROVIDER_TYPES = ['local', 'http']

const registry = new Map()

/** 内置 provider 自注册入口(绕过保留名守卫)。 */
export function _setBuiltinProvider(type, factory) {
  registry.set(type, factory)
}

/**
 * 注册自定义 provider 工厂。
 * @param {string} type 非保留、未占用的类型名
 * @param {(opts: object) => object} factory
 * @throws {SkillProviderError}
 */
export function registerSkillProvider(type, factory) {
  if (RESERVED_PROVIDER_TYPES.includes(type)) {
    throw new SkillProviderError(`provider type "${type}" is reserved`, { providerName: type })
  }
  if (registry.has(type)) {
    throw new SkillProviderError(`provider type "${type}" already registered`, { providerName: type })
  }
  if (typeof factory !== 'function') {
    throw new SkillProviderError(`provider factory for "${type}" must be a function`, { providerName: type })
  }
  registry.set(type, factory)
}

/** duck-type 检查:有 listSkills + fetchSkill 即视为 provider 实例。 */
function isProviderInstance(x) {
  return x && typeof x.listSkills === 'function' && typeof x.fetchSkill === 'function'
}

/**
 * 解析配置为 provider 实例。接受实例(原样返回)或 { type, ...opts } 配置。
 * @param {object} config
 * @returns {object} provider 实例
 * @throws {SkillProviderError}
 */
export function resolveProvider(config) {
  if (isProviderInstance(config)) return config
  if (!config || typeof config.type !== 'string') {
    throw new SkillProviderError('skill provider config must have a string `type` or be a provider instance', {})
  }
  const factory = registry.get(config.type)
  if (!factory) {
    throw new SkillProviderError(`unknown skill provider type "${config.type}"`, { providerName: config.type })
  }
  return factory(config)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/skills/provider.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/skills/provider.js src/skills/provider.test.js
git commit -m "feat(skills): add provider contract and registry"
```

---

### Task 4: Local provider

**Files:**
- Create: `src/skills/providers/local.js`
- Test: `src/skills/providers/local.test.js`

**Interfaces:**
- Consumes: `SkillProviderError` from `../errors.js`; `parseFrontmatter` from `../model.js`; Node `fs/promises`, `path`.
- Produces: `createLocalSkillProvider({ dir }) → provider` with `name: 'local'`, `origin: dir`, `listSkills()`, `fetchSkill(name) → { baseDir }`, and `readResource(name, relPath) → string`.
- Self-registers: `_setBuiltinProvider('local', createLocalSkillProvider)` at module load.

- [ ] **Step 1: Write the failing test**

Uses a real temp dir (`node:os` tmpdir + `fs`), no mocks. Creates two skill dirs, one without SKILL.md (must be ignored).

```js
// src/skills/providers/local.test.js
import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalSkillProvider } from './local.js'

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'skills-local-'))
  await mkdir(join(root, 'pdf'), { recursive: true })
  await writeFile(join(root, 'pdf', 'SKILL.md'), '---\nname: pdf\ndescription: Process PDFs\n---\nBody')
  await mkdir(join(root, 'pdf', 'scripts'), { recursive: true })
  await writeFile(join(root, 'pdf', 'scripts', 'run.py'), 'print(1)')
  await mkdir(join(root, 'not-a-skill'), { recursive: true }) // no SKILL.md
  return root
}

test('listSkills returns only dirs with SKILL.md, reading frontmatter', async () => {
  const root = await setup()
  try {
    const p = createLocalSkillProvider({ dir: root })
    const list = await p.listSkills()
    assert.strictEqual(list.length, 1)
    assert.strictEqual(list[0].name, 'pdf')
    assert.strictEqual(list[0].description, 'Process PDFs')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('fetchSkill returns baseDir and file list', async () => {
  const root = await setup()
  try {
    const p = createLocalSkillProvider({ dir: root })
    const bundle = await p.fetchSkill('pdf')
    assert.strictEqual(bundle.baseDir, join(root, 'pdf'))
    assert.ok(bundle.files.includes('SKILL.md'))
    assert.ok(bundle.files.includes('scripts/run.py'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('readResource reads a bundled file', async () => {
  const root = await setup()
  try {
    const p = createLocalSkillProvider({ dir: root })
    const content = await p.readResource('pdf', 'scripts/run.py')
    assert.strictEqual(content, 'print(1)')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('readResource rejects path traversal', async () => {
  const root = await setup()
  try {
    const p = createLocalSkillProvider({ dir: root })
    await assert.rejects(() => p.readResource('pdf', '../not-a-skill/x'))
  } finally { await rm(root, { recursive: true, force: true }) }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/skills/providers/local.test.js`
Expected: FAIL — `Cannot find module './local.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// src/skills/providers/local.js
/**
 * 本地文件夹 SkillProvider。扫描 dir 下每个含 SKILL.md 的子目录;
 * fetchSkill 返回 { baseDir }(零拷贝,注册表跳过物化)。
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { parseFrontmatter } from '../model.js'
import { _setBuiltinProvider } from '../provider.js'
import { SkillProviderError } from '../errors.js'

/** 递归列出目录下所有文件的相对路径(POSIX 风格分隔)。 */
async function listFilesRecursive(baseDir) {
  const out = []
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) await walk(full)
      else out.push(relative(baseDir, full).split(sep).join('/'))
    }
  }
  await walk(baseDir)
  return out
}

export function createLocalSkillProvider({ dir }) {
  if (typeof dir !== 'string' || dir.length === 0) {
    throw new SkillProviderError('local skill provider requires a `dir` string', { providerName: 'local' })
  }

  async function listSkills() {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (cause) {
      throw new SkillProviderError(`cannot read skills dir "${dir}"`, { providerName: 'local', cause })
    }
    const result = []
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const skillMd = join(dir, e.name, 'SKILL.md')
      try {
        const text = await readFile(skillMd, 'utf8')
        const { frontmatter } = parseFrontmatter(text)
        result.push({
          name: e.name,
          description: typeof frontmatter.description === 'string' ? frontmatter.description : '',
          version: frontmatter.version ?? null,
        })
      } catch {
        // 无 SKILL.md 的目录跳过
      }
    }
    return result
  }

  async function fetchSkill(name) {
    const baseDir = join(dir, name)
    let files
    try {
      files = await listFilesRecursive(baseDir)
    } catch (cause) {
      throw new SkillProviderError(`cannot read skill dir for "${name}"`, { providerName: 'local', cause })
    }
    return { baseDir, files }
  }

  async function readResource(name, relPath) {
    const baseDir = resolve(dir, name)
    const target = resolve(baseDir, relPath)
    if (target !== baseDir && !target.startsWith(baseDir + sep)) {
      throw new SkillProviderError(`resource path escapes skill dir: "${relPath}"`, { providerName: 'local' })
    }
    return readFile(target, 'utf8')
  }

  return { name: 'local', origin: dir, listSkills, fetchSkill, readResource }
}

_setBuiltinProvider('local', createLocalSkillProvider)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/skills/providers/local.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/skills/providers/local.js src/skills/providers/local.test.js
git commit -m "feat(skills): add local folder provider"
```

---

### Task 5: HTTP provider

**Files:**
- Create: `src/skills/providers/http.js`
- Test: `src/skills/providers/http.test.js`

**Interfaces:**
- Consumes: `SkillProviderError` from `../errors.js`; `_setBuiltinProvider` from `../provider.js`.
- Produces: `createHttpSkillProvider({ baseUrl, headers?, fetchImpl? }) → provider` with `name: 'http'`, `origin: baseUrl`, `listSkills()`, `fetchSkill(name) → { files: [{ path, content }] }`, `readResource(name, relPath) → string`.
- Wire protocol: `GET {baseUrl}/manifest.json` → `{ skills: [{ name, description, version, hash, files }] }`; `GET {baseUrl}/skills/{name}/{relPath}` → file content.
- `fetchImpl` defaults to `globalThis.fetch`; tests inject a mock.
- Self-registers: `_setBuiltinProvider('http', createHttpSkillProvider)`.

- [ ] **Step 1: Write the failing test**

```js
// src/skills/providers/http.test.js
import { test } from 'node:test'
import assert from 'node:assert'
import { createHttpSkillProvider } from './http.js'

function mockFetch(routes) {
  return async (url) => {
    const key = String(url)
    if (!(key in routes)) return { ok: false, status: 404, text: async () => 'not found' }
    const body = routes[key]
    return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) }
  }
}

const MANIFEST = JSON.stringify({
  skills: [{ name: 'pdf', description: 'Process PDFs', version: '1.0.0', hash: 'abc', files: ['SKILL.md', 'scripts/run.py'] }],
})

test('listSkills reads manifest.json', async () => {
  const fetchImpl = mockFetch({ 'https://x/manifest.json': MANIFEST })
  const p = createHttpSkillProvider({ baseUrl: 'https://x', fetchImpl })
  const list = await p.listSkills()
  assert.strictEqual(list[0].name, 'pdf')
  assert.strictEqual(list[0].hash, 'abc')
})

test('fetchSkill pulls every file in the manifest entry', async () => {
  const fetchImpl = mockFetch({
    'https://x/manifest.json': MANIFEST,
    'https://x/skills/pdf/SKILL.md': '---\nname: pdf\ndescription: d\n---\nb',
    'https://x/skills/pdf/scripts/run.py': 'print(1)',
  })
  const p = createHttpSkillProvider({ baseUrl: 'https://x', fetchImpl })
  const bundle = await p.fetchSkill('pdf')
  const paths = bundle.files.map(f => f.path).sort()
  assert.deepStrictEqual(paths, ['SKILL.md', 'scripts/run.py'])
  const skillMd = bundle.files.find(f => f.path === 'SKILL.md')
  assert.match(skillMd.content, /description: d/)
})

test('fetchSkill throws SkillProviderError for unknown skill', async () => {
  const fetchImpl = mockFetch({ 'https://x/manifest.json': MANIFEST })
  const p = createHttpSkillProvider({ baseUrl: 'https://x', fetchImpl })
  await assert.rejects(() => p.fetchSkill('nope'), /nope/)
})

test('readResource does a single-file GET', async () => {
  const fetchImpl = mockFetch({ 'https://x/skills/pdf/scripts/run.py': 'print(1)' })
  const p = createHttpSkillProvider({ baseUrl: 'https://x', fetchImpl })
  assert.strictEqual(await p.readResource('pdf', 'scripts/run.py'), 'print(1)')
})

test('trailing slash in baseUrl is normalized', async () => {
  const fetchImpl = mockFetch({ 'https://x/manifest.json': MANIFEST })
  const p = createHttpSkillProvider({ baseUrl: 'https://x/', fetchImpl })
  const list = await p.listSkills()
  assert.strictEqual(list[0].name, 'pdf')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/skills/providers/http.test.js`
Expected: FAIL — `Cannot find module './http.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// src/skills/providers/http.js
/**
 * HTTP SkillProvider。wire 协议:
 *   GET {baseUrl}/manifest.json → { skills: [{ name, description, version, hash, files }] }
 *   GET {baseUrl}/skills/{name}/{relPath} → 文件内容
 * fetchSkill 返回内存包 { files: [{ path, content }] },由注册表在 Node 下物化。
 */

import { _setBuiltinProvider } from '../provider.js'
import { SkillProviderError } from '../errors.js'

export function createHttpSkillProvider({ baseUrl, headers = {}, fetchImpl } = {}) {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    throw new SkillProviderError('http skill provider requires a `baseUrl` string', { providerName: 'http' })
  }
  const base = baseUrl.replace(/\/+$/, '')
  const doFetch = fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') {
    throw new SkillProviderError('no fetch implementation available', { providerName: 'http' })
  }

  async function getText(url) {
    let resp
    try {
      resp = await doFetch(url, { headers })
    } catch (cause) {
      throw new SkillProviderError(`fetch failed for ${url}`, { providerName: 'http', cause })
    }
    if (!resp.ok) {
      throw new SkillProviderError(`HTTP ${resp.status} for ${url}`, { providerName: 'http' })
    }
    return resp.text()
  }

  async function getManifest() {
    const text = await getText(`${base}/manifest.json`)
    let obj
    try {
      obj = JSON.parse(text)
    } catch (cause) {
      throw new SkillProviderError('manifest.json is not valid JSON', { providerName: 'http', cause })
    }
    const skills = Array.isArray(obj?.skills) ? obj.skills : []
    return skills
  }

  async function listSkills() {
    return (await getManifest()).map(s => ({
      name: s.name,
      description: typeof s.description === 'string' ? s.description : '',
      version: s.version ?? null,
      hash: s.hash ?? null,
    }))
  }

  async function fetchSkill(name) {
    const entry = (await getManifest()).find(s => s.name === name)
    if (!entry) {
      throw new SkillProviderError(`skill "${name}" not in manifest`, { providerName: 'http' })
    }
    const relPaths = Array.isArray(entry.files) ? entry.files : ['SKILL.md']
    const files = []
    for (const rel of relPaths) {
      const content = await getText(`${base}/skills/${name}/${rel}`)
      files.push({ path: rel, content })
    }
    return { files }
  }

  async function readResource(name, relPath) {
    return getText(`${base}/skills/${name}/${relPath}`)
  }

  return { name: 'http', origin: base, listSkills, fetchSkill, readResource }
}

_setBuiltinProvider('http', createHttpSkillProvider)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/skills/providers/http.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/skills/providers/http.js src/skills/providers/http.test.js
git commit -m "feat(skills): add HTTP provider with manifest wire protocol"
```

---

### Task 6: Materializer (Node-only)

**Files:**
- Create: `src/skills/materializer.js`
- Test: `src/skills/materializer.test.js`

**Interfaces:**
- Consumes: `SkillMaterializeError` from `./errors.js`; Node `fs/promises`, `path`, `os`.
- Produces:
  - `defaultCacheDir() → string` — `path.join(os.homedir(), '.lll-agent', 'skills-cache')`.
  - `materializeBundle(name, bundle, { cacheDir }) → { baseDir, files }` — writes an in-memory `{ files: [{ path, content }] }` bundle to `cacheDir/<name>/` via a temp dir + atomic rename. Returns absolute `baseDir` and the relative file-path list. Throws `SkillMaterializeError` on write failure.

- [ ] **Step 1: Write the failing test**

```js
// src/skills/materializer.test.js
import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { materializeBundle, defaultCacheDir } from './materializer.js'

test('defaultCacheDir points under home/.lll-agent', () => {
  assert.match(defaultCacheDir(), /\.lll-agent[\/\\]skills-cache$/)
})

test('materializeBundle writes files and returns baseDir', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'skills-cache-'))
  try {
    const bundle = { files: [
      { path: 'SKILL.md', content: '---\nname: pdf\ndescription: d\n---\nb' },
      { path: 'scripts/run.py', content: 'print(1)' },
    ] }
    const { baseDir, files } = await materializeBundle('pdf', bundle, { cacheDir })
    assert.strictEqual(baseDir, join(cacheDir, 'pdf'))
    assert.ok(files.includes('SKILL.md'))
    assert.ok(files.includes('scripts/run.py'))
    assert.strictEqual(await readFile(join(baseDir, 'scripts', 'run.py'), 'utf8'), 'print(1)')
  } finally { await rm(cacheDir, { recursive: true, force: true }) }
})

test('materializeBundle overwrites an existing skill dir cleanly', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'skills-cache-'))
  try {
    await materializeBundle('pdf', { files: [{ path: 'old.txt', content: 'old' }] }, { cacheDir })
    const { baseDir } = await materializeBundle('pdf', { files: [{ path: 'SKILL.md', content: 'new' }] }, { cacheDir })
    await assert.rejects(() => readFile(join(baseDir, 'old.txt'), 'utf8'))
    assert.strictEqual(await readFile(join(baseDir, 'SKILL.md'), 'utf8'), 'new')
  } finally { await rm(cacheDir, { recursive: true, force: true }) }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/skills/materializer.test.js`
Expected: FAIL — `Cannot find module './materializer.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// src/skills/materializer.js
/**
 * 内存包物化(仅 Node)。写入 cacheDir/<name>/,采用先写临时目录再原子 rename,
 * 避免半包状态。旧目录先删除再替换,确保覆盖干净。
 */

import { mkdir, writeFile, rm, rename } from 'node:fs/promises'
import { join, dirname, sep } from 'node:path'
import { homedir } from 'node:os'
import { SkillMaterializeError } from './errors.js'

export function defaultCacheDir() {
  return join(homedir(), '.lll-agent', 'skills-cache')
}

/**
 * @param {string} name skill 名
 * @param {{ files: Array<{ path: string, content: string|Uint8Array }> }} bundle
 * @param {{ cacheDir: string }} opts
 * @returns {Promise<{ baseDir: string, files: string[] }>}
 */
export async function materializeBundle(name, bundle, { cacheDir }) {
  const baseDir = join(cacheDir, name)
  const tmpDir = join(cacheDir, `.tmp-${name}-${process.pid}`)
  const files = Array.isArray(bundle?.files) ? bundle.files : []
  try {
    await rm(tmpDir, { recursive: true, force: true })
    await mkdir(tmpDir, { recursive: true })
    for (const f of files) {
      const rel = String(f.path).split('/').join(sep)
      const target = join(tmpDir, rel)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, f.content)
    }
    await rm(baseDir, { recursive: true, force: true })
    await mkdir(dirname(baseDir), { recursive: true })
    await rename(tmpDir, baseDir)
  } catch (cause) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    throw new SkillMaterializeError(`failed to materialize skill "${name}"`, { skillName: name, cause })
  }
  return { baseDir, files: files.map(f => f.path) }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/skills/materializer.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/skills/materializer.js src/skills/materializer.test.js
git commit -m "feat(skills): add Node materializer with atomic rename"
```

---

### Task 7: SkillRegistry (eager load, first-wins, refresh)

**Files:**
- Create: `src/skills/registry.js`
- Test: `src/skills/registry.test.js`

**Interfaces:**
- Consumes: `resolveProvider` from `./provider.js`; `parseSkillMd` from `./model.js`; `materializeBundle`, `defaultCacheDir` from `./materializer.js` (dynamic import — Node only); `SkillLoadError` from `./errors.js`.
- Produces: `createSkillRegistry({ providers, cacheDir?, runtime? }) → SkillRegistry` with:
  - `runtime` resolved: `'auto'` (default) → `'node'` if `process.versions?.node` else `'browser'`.
  - `async load()` — eager full load per spec §3. Idempotent guard not required (caller memoizes).
  - `async refresh()` — re-list; entries whose `hash` is non-null and unchanged keep their cached `Skill_Def`; others re-fetch. Removed skills disappear.
  - `list() → Skill_Def[]` (snapshot copy), `get(name) → Skill_Def | null`.
  - `async readResource(name, relPath)` — delegates to the owning provider's `readResource`; rejects `..` traversal before delegating.
  - `generation` — integer, incremented on every `load()`/`refresh()` completion (agent uses it to rebuild the system-prompt block).

**Load algorithm (implement exactly):**
1. For each provider in order: `listSkills()`; on throw → `console.warn` + skip provider.
2. For each listed entry in provider order: if name already taken → `console.warn` first-wins + skip. Else `fetchSkill(name)`.
3. Bundle with `baseDir` → read `SKILL.md` from disk (`node:fs/promises`, dynamic import), `files` from bundle. Bundle with in-memory `files` → find `path === 'SKILL.md'` entry for text; if `runtime === 'node'`, materialize via `materializeBundle` to get `baseDir`; if `'browser'`, `baseDir = null`.
4. `parseSkillMd(text, { dirName: name, source: { provider: provider.name, origin: provider.origin }, files, baseDir })`.
5. Any per-skill throw → `console.warn` + skip that skill (name slot is released so a later provider may claim it).
6. Store `{ def, providerRef, hash }` in an internal `Map`; bump `generation`.

- [ ] **Step 1: Write the failing test**

```js
// src/skills/registry.test.js
import { test } from 'node:test'
import assert from 'node:assert'
import { createSkillRegistry } from './registry.js'

const SKILL_MD = (name, desc) => `---\nname: ${name}\ndescription: ${desc}\n---\nBody of ${name}`

function memProvider(name, skills, { hash = null } = {}) {
  // skills: { skillName: description }
  return {
    name,
    origin: `mem:${name}`,
    calls: { fetch: [] },
    async listSkills() {
      return Object.keys(skills).map(n => ({ name: n, description: skills[n], hash }))
    },
    async fetchSkill(n) {
      this.calls.fetch.push(n)
      if (!(n in skills)) throw new Error(`no skill ${n}`)
      return { files: [{ path: 'SKILL.md', content: SKILL_MD(n, skills[n]) }, { path: 'references/doc.md', content: 'ref' }] }
    },
    async readResource(n, rel) {
      if (rel === 'references/doc.md') return 'ref'
      throw new Error('not found')
    },
  }
}

test('load builds Skill_Def list from in-memory bundles (browser runtime)', async () => {
  const reg = createSkillRegistry({ providers: [memProvider('p1', { alpha: 'A skill' })], runtime: 'browser' })
  await reg.load()
  const defs = reg.list()
  assert.strictEqual(defs.length, 1)
  assert.strictEqual(defs[0].name, 'alpha')
  assert.strictEqual(defs[0].body, 'Body of alpha')
  assert.strictEqual(defs[0].baseDir, null)
  assert.deepStrictEqual(defs[0].files, ['SKILL.md', 'references/doc.md'])
  assert.strictEqual(defs[0].source.provider, 'p1')
})

test('cross-provider duplicate: first provider wins', async () => {
  const p1 = memProvider('p1', { alpha: 'from p1' })
  const p2 = memProvider('p2', { alpha: 'from p2', beta: 'B' })
  const reg = createSkillRegistry({ providers: [p1, p2], runtime: 'browser' })
  await reg.load()
  assert.strictEqual(reg.get('alpha').source.provider, 'p1')
  assert.ok(reg.get('beta'))
})

test('single skill failure does not abort load', async () => {
  const p = memProvider('p1', { good: 'G' })
  const broken = {
    name: 'p2', origin: 'mem:p2',
    async listSkills() { return [{ name: 'bad', description: 'B' }] },
    async fetchSkill() { throw new Error('boom') },
  }
  const reg = createSkillRegistry({ providers: [broken, p], runtime: 'browser' })
  await reg.load()
  assert.strictEqual(reg.get('bad'), null)
  assert.ok(reg.get('good'))
})

test('provider listSkills failure skips that provider only', async () => {
  const dead = { name: 'dead', origin: 'x', async listSkills() { throw new Error('net') }, async fetchSkill() {} }
  const reg = createSkillRegistry({ providers: [dead, memProvider('p1', { ok: 'O' })], runtime: 'browser' })
  await reg.load()
  assert.ok(reg.get('ok'))
})

test('refresh skips unchanged hashes, refetches changed', async () => {
  const p = memProvider('p1', { alpha: 'A' }, { hash: 'h1' })
  const reg = createSkillRegistry({ providers: [p], runtime: 'browser' })
  await reg.load()
  assert.strictEqual(p.calls.fetch.length, 1)
  await reg.refresh()
  assert.strictEqual(p.calls.fetch.length, 1) // hash unchanged → no refetch
  const gen1 = reg.generation
  assert.ok(gen1 >= 2)
})

test('readResource delegates to owning provider and blocks traversal', async () => {
  const reg = createSkillRegistry({ providers: [memProvider('p1', { alpha: 'A' })], runtime: 'browser' })
  await reg.load()
  assert.strictEqual(await reg.readResource('alpha', 'references/doc.md'), 'ref')
  await assert.rejects(() => reg.readResource('alpha', '../escape'))
  await assert.rejects(() => reg.readResource('nope', 'x'))
})

test('node runtime materializes in-memory bundles to cacheDir', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const cacheDir = await mkdtemp(join(tmpdir(), 'skills-reg-'))
  try {
    const reg = createSkillRegistry({ providers: [memProvider('p1', { alpha: 'A' })], runtime: 'node', cacheDir })
    await reg.load()
    assert.strictEqual(reg.get('alpha').baseDir, join(cacheDir, 'alpha'))
  } finally { await rm(cacheDir, { recursive: true, force: true }) }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/skills/registry.test.js`
Expected: FAIL — `Cannot find module './registry.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// src/skills/registry.js
/**
 * SkillRegistry — 聚合多 Provider,全量急切加载为内存 Skill_Def[]。
 * 重名 first-wins;单 skill / 单 provider 失败隔离(warn + skip);
 * refresh 按 hash 差异跳过未变更 skill。浏览器运行时不物化(baseDir=null)。
 */

import { resolveProvider } from './provider.js'
import { parseSkillMd } from './model.js'

function detectRuntime(runtime) {
  if (runtime === 'node' || runtime === 'browser') return runtime
  return (typeof process !== 'undefined' && process.versions?.node) ? 'node' : 'browser'
}

export function createSkillRegistry({ providers = [], cacheDir, runtime = 'auto' } = {}) {
  const resolved = providers.map(resolveProvider)
  const mode = detectRuntime(runtime)
  // name → { def, provider, hash }
  const entries = new Map()

  async function buildDef(provider, name, hash) {
    const bundle = await provider.fetchSkill(name)
    let text, files, baseDir
    if (bundle && typeof bundle.baseDir === 'string') {
      // 已在磁盘(local provider):零拷贝
      const { readFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      text = await readFile(join(bundle.baseDir, 'SKILL.md'), 'utf8')
      files = Array.isArray(bundle.files) ? bundle.files : []
      baseDir = bundle.baseDir
    } else {
      // 内存包
      const memFiles = Array.isArray(bundle?.files) ? bundle.files : []
      const skillMd = memFiles.find(f => f.path === 'SKILL.md')
      if (!skillMd) throw new Error(`bundle for "${name}" has no SKILL.md`)
      text = typeof skillMd.content === 'string' ? skillMd.content : new TextDecoder().decode(skillMd.content)
      files = memFiles.map(f => f.path)
      if (mode === 'node') {
        const { materializeBundle, defaultCacheDir } = await import('./materializer.js')
        const out = await materializeBundle(name, bundle, { cacheDir: cacheDir ?? defaultCacheDir() })
        baseDir = out.baseDir
      } else {
        baseDir = null
      }
    }
    const def = parseSkillMd(text, {
      dirName: name,
      source: { provider: provider.name, origin: provider.origin },
      files,
      baseDir,
    })
    return { def, provider, hash: hash ?? null }
  }

  async function loadInto(target) {
    for (const provider of resolved) {
      let listed
      try {
        listed = await provider.listSkills()
      } catch (e) {
        console.warn(`[skills] provider "${provider.name}" listSkills failed, skipping:`, e.message)
        continue
      }
      for (const item of listed) {
        const name = item?.name
        if (typeof name !== 'string' || name.length === 0) continue
        if (target.has(name)) {
          console.warn(`[skills] duplicate skill "${name}" from provider "${provider.name}" skipped (first wins)`)
          continue
        }
        // refresh 优化:hash 非空且与旧条目一致 → 复用旧 Skill_Def
        const prev = entries.get(name)
        if (prev && prev.hash !== null && item.hash === prev.hash && prev.provider === provider) {
          target.set(name, prev)
          continue
        }
        try {
          target.set(name, await buildDef(provider, name, item.hash))
        } catch (e) {
          console.warn(`[skills] failed to load skill "${name}":`, e.message)
        }
      }
    }
  }

  const registry = {
    generation: 0,

    async load() {
      const next = new Map()
      await loadInto(next)
      entries.clear()
      for (const [k, v] of next) entries.set(k, v)
      registry.generation++
    },

    async refresh() {
      return registry.load()
    },

    list() {
      return [...entries.values()].map(e => e.def)
    },

    get(name) {
      return entries.get(name)?.def ?? null
    },

    async readResource(name, relPath) {
      const entry = entries.get(name)
      if (!entry) throw new Error(`unknown skill "${name}"`)
      const rel = String(relPath)
      if (rel.split('/').includes('..') || rel.startsWith('/')) {
        throw new Error(`invalid resource path "${relPath}"`)
      }
      if (typeof entry.provider.readResource !== 'function') {
        throw new Error(`provider "${entry.provider.name}" does not support readResource`)
      }
      return entry.provider.readResource(name, rel)
    },
  }

  return registry
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/skills/registry.test.js`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/skills/registry.js src/skills/registry.test.js
git commit -m "feat(skills): add SkillRegistry with eager load, first-wins, hash refresh"
```

---

### Task 8: SkillFilter (sidecar LLM Top-K)

**Files:**
- Create: `src/skills/filter.js`
- Test: `src/skills/filter.test.js`

**Interfaces:**
- Consumes: `syncChat` from `../llm-client.js`; `childContext` from `../telemetry.js`.
- Produces: `class SkillFilter { constructor({ url, apiKey, model }); async filter(userMessage, skills, { topK = 20, signal, telemetry } = {}) → Skill_Def[] }`.
- Fail-open: any throw or unparsable response → return `skills` unchanged + `console.warn` (same policy as `IntentRecognizer.analyze`).
- Telemetry: `childContext(telemetry, 'agent.skill_filter')` passed to `syncChat` (same pattern as `intent-recognizer.js:137`).
- Testing seam: tests mock via dependency injection — constructor accepts internal `_syncChat` override (same style as `Agent._createMCPClient`).

- [ ] **Step 1: Write the failing test**

```js
// src/skills/filter.test.js
import { test } from 'node:test'
import assert from 'node:assert'
import { SkillFilter } from './filter.js'

const SKILLS = Array.from({ length: 5 }, (_, i) => ({
  name: `skill-${i}`, description: `Does thing ${i}`,
}))

function respond(content) {
  return async () => ({ choices: [{ message: { content } }] })
}

test('filter returns Skill_Defs matching LLM-ranked names, in order', async () => {
  const f = new SkillFilter({ url: 'u', apiKey: 'k', model: 'm' })
  f._syncChat = respond('["skill-3","skill-1"]')
  const out = await f.filter('do thing three', SKILLS, { topK: 20 })
  assert.deepStrictEqual(out.map(s => s.name), ['skill-3', 'skill-1'])
})

test('filter truncates to topK', async () => {
  const f = new SkillFilter({ url: 'u', apiKey: 'k', model: 'm' })
  f._syncChat = respond('["skill-0","skill-1","skill-2","skill-3"]')
  const out = await f.filter('x', SKILLS, { topK: 2 })
  assert.strictEqual(out.length, 2)
})

test('filter ignores unknown names from the LLM', async () => {
  const f = new SkillFilter({ url: 'u', apiKey: 'k', model: 'm' })
  f._syncChat = respond('["skill-1","hallucinated"]')
  const out = await f.filter('x', SKILLS, { topK: 20 })
  assert.deepStrictEqual(out.map(s => s.name), ['skill-1'])
})

test('filter extracts JSON array embedded in prose', async () => {
  const f = new SkillFilter({ url: 'u', apiKey: 'k', model: 'm' })
  f._syncChat = respond('Sure! Here you go: ["skill-2"] hope that helps')
  const out = await f.filter('x', SKILLS, { topK: 20 })
  assert.deepStrictEqual(out.map(s => s.name), ['skill-2'])
})

test('filter fails open on LLM error', async () => {
  const f = new SkillFilter({ url: 'u', apiKey: 'k', model: 'm' })
  f._syncChat = async () => { throw new Error('503') }
  const out = await f.filter('x', SKILLS, { topK: 2 })
  assert.strictEqual(out.length, SKILLS.length)
})

test('filter fails open on garbage response', async () => {
  const f = new SkillFilter({ url: 'u', apiKey: 'k', model: 'm' })
  f._syncChat = respond('no json here')
  const out = await f.filter('x', SKILLS, { topK: 2 })
  assert.strictEqual(out.length, SKILLS.length)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/skills/filter.test.js`
Expected: FAIL — `Cannot find module './filter.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// src/skills/filter.js
/**
 * SkillFilter — sidecar LLM 调用,按用户消息对 skill 做 Top-K 相关性排序。
 * 独立于 IntentRecognizer。失败 fail-open:返回全量 skills(与
 * IntentRecognizer 失败策略一致)。
 */

import { syncChat } from '../llm-client.js'
import { childContext } from '../telemetry.js'

const SYSTEM_PROMPT_TEMPLATE =
  'You are a skill selector. Given a user message and a list of skills, ' +
  'return the names of the top %TOPK% most relevant skills as a JSON array.\n' +
  'Respond with ONLY a JSON array of skill names, e.g. ["skill-a","skill-b"].\n' +
  'Available skills:\n%SKILLS%'

export class SkillFilter {
  /**
   * @param {object} opts
   * @param {string} opts.url LLM API endpoint
   * @param {string} opts.apiKey
   * @param {string} opts.model 建议使用 simpleModel;未配置时调用方回退主模型
   */
  constructor({ url, apiKey, model }) {
    this.url = url
    this.apiKey = apiKey
    this.model = model
    // 测试注入口(与 Agent._createMCPClient 同款):默认模块级 syncChat。
    this._syncChat = syncChat
  }

  /**
   * @param {string} userMessage
   * @param {import('./model.js').Skill_Def[]} skills
   * @param {{ topK?: number, signal?: AbortSignal, telemetry?: object }} [opts]
   * @returns {Promise<import('./model.js').Skill_Def[]>} 排序后的子集;失败时返回全量
   */
  async filter(userMessage, skills, { topK = 20, signal, telemetry = null } = {}) {
    try {
      const listing = skills.map(s => `- ${s.name}: ${s.description}`).join('\n')
      const systemPrompt = SYSTEM_PROMPT_TEMPLATE
        .replace('%TOPK%', String(topK))
        .replace('%SKILLS%', listing)

      const response = await this._syncChat({
        url: this.url,
        apiKey: this.apiKey,
        body: {
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
          temperature: 0,
        },
        signal,
        telemetry: { ctx: childContext(telemetry, 'agent.skill_filter') },
      })

      const text = response?.choices?.[0]?.message?.content ?? ''
      const start = text.indexOf('[')
      const end = text.lastIndexOf(']')
      if (start < 0 || end <= start) throw new Error('no JSON array in response')
      const names = JSON.parse(text.substring(start, end + 1))
      if (!Array.isArray(names)) throw new Error('response is not an array')

      const byName = new Map(skills.map(s => [s.name, s]))
      const picked = []
      for (const n of names) {
        if (picked.length >= topK) break
        const def = byName.get(n)
        if (def && !picked.includes(def)) picked.push(def)
      }
      if (picked.length === 0) throw new Error('no valid skill names in response')
      return picked
    } catch (e) {
      console.warn('[SkillFilter] Failed, returning all skills:', e.message)
      return skills
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/skills/filter.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/skills/filter.js src/skills/filter.test.js
git commit -m "feat(skills): add SkillFilter sidecar with fail-open Top-K ranking"
```

---

### Task 9: Barrel exports (`skills/index.js` + `src/index.js`)

**Files:**
- Create: `src/skills/index.js`
- Modify: `src/index.js` (append after the MCP export block, ~line 30-47)
- Test: `src/index.test.js` already exists — extend it; if extending is awkward, create `src/skills/index.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1-8.
- Produces: public API surface — `createSkillRegistry`, `registerSkillProvider`, `createLocalSkillProvider`, `createHttpSkillProvider`, `SkillFilter`, `SkillLoadError`, `SkillParseError`, `SkillMaterializeError`, `SkillProviderError`.
- IMPORTANT (browser-safety decision): `skills/index.js` statically imports BOTH providers so `{ type: 'local' }` / `{ type: 'http' }` configs resolve after a single `import`. To keep that import browser-safe, `local.js` must not import `node:fs/promises` / `node:path` at module top level — Step 1 below moves those into the async function bodies as `await import('node:fs/promises')` / `await import('node:path')` (this adjusts the Task 4 implementation). After that change, importing `skills/index.js` works in both runtimes; the fs modules are only touched when a local provider method actually runs (Node).

- [ ] **Step 1: Adjust `src/skills/providers/local.js`** — move `node:fs/promises` and `node:path` imports into function bodies as `const { readdir, readFile } = await import('node:fs/promises')` / `const { join, relative, resolve, sep } = await import('node:path')`. `listFilesRecursive` receives these as arguments or does its own dynamic import.

- [ ] **Step 2: Run existing provider tests to verify still green**

Run: `node --test src/skills/providers/local.test.js`
Expected: PASS (4 tests)

- [ ] **Step 3: Write the failing test**

```js
// src/skills/index.test.js
import { test } from 'node:test'
import assert from 'node:assert'

test('skills/index.js exports the full public surface', async () => {
  const m = await import('./index.js')
  for (const name of [
    'createSkillRegistry', 'registerSkillProvider',
    'createLocalSkillProvider', 'createHttpSkillProvider', 'SkillFilter',
    'SkillLoadError', 'SkillParseError', 'SkillMaterializeError', 'SkillProviderError',
  ]) {
    assert.strictEqual(typeof m[name], 'function', `missing export: ${name}`)
  }
})

test('src/index.js re-exports the skill surface', async () => {
  const m = await import('../index.js')
  assert.strictEqual(typeof m.createSkillRegistry, 'function')
  assert.strictEqual(typeof m.registerSkillProvider, 'function')
  assert.strictEqual(typeof m.SkillFilter, 'function')
  assert.strictEqual(typeof m.SkillLoadError, 'function')
})

test('built-in provider types resolve after importing index', async () => {
  await import('./index.js')
  const { resolveProvider } = await import('./provider.js')
  const p = resolveProvider({ type: 'http', baseUrl: 'https://x' })
  assert.strictEqual(p.name, 'http')
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `node --test src/skills/index.test.js`
Expected: FAIL — `Cannot find module './index.js'`

- [ ] **Step 5: Write minimal implementation**

```js
// src/skills/index.js
/**
 * Skill 子系统入口。导入 providers 触发内置 provider 自注册
 * (local 内部使用动态 import('node:fs/promises'),浏览器打包安全)。
 */

export { createSkillRegistry } from './registry.js'
export { registerSkillProvider, resolveProvider } from './provider.js'
export { createLocalSkillProvider } from './providers/local.js'
export { createHttpSkillProvider } from './providers/http.js'
export { SkillFilter } from './filter.js'
export { parseFrontmatter, parseSkillMd } from './model.js'
export {
  SkillLoadError, SkillParseError, SkillMaterializeError, SkillProviderError,
} from './errors.js'
```

Append to `src/index.js` (after the MCP export block):

```js
export {
  createSkillRegistry,
  registerSkillProvider,
  createLocalSkillProvider,
  createHttpSkillProvider,
  SkillFilter,
  SkillLoadError,
  SkillParseError,
  SkillMaterializeError,
  SkillProviderError,
} from './skills/index.js'
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test src/skills/index.test.js`
Expected: PASS (3 tests)

- [ ] **Step 7: Commit**

```bash
git add src/skills/index.js src/skills/index.test.js src/skills/providers/local.js src/index.js
git commit -m "feat(skills): add barrel exports and browser-safe local provider imports"
```

---

### Task 10: Agent integration

**Files:**
- Modify: `src/agent.js` — constructor (`opts.skills` block, after the `load_mcp_server` injection at ~line 379), `chat()` (~line 389), `stream()` (~line 406), `_runPipeline` (~line 918), `_buildSimpleBody` (~line 1850), plus three new methods.
- Test: `src/agent-skills.test.js`

**Interfaces:**
- Consumes: `createSkillRegistry` from `./skills/registry.js`; `SkillFilter` from `./skills/filter.js`.
- Produces (on `Agent`):
  - `opts.skills = { providers, runtime?, cacheDir?, filter?: { threshold?, topK? } }`
  - `agent.skills` — the registry instance (or `null` when not configured).
  - `async loadSkills()` — memoized eager load (`this._skillsLoadPromise ??= this.skills.load()`).
  - `async refreshSkills()` — `await this.skills.refresh()`, then `this._skillsGeneration = -1` to force listing rebuild, `this._toolsGeneration++`.
  - `_withSkillListingNote(messages)` — merges the Level 1 listing block into the outgoing system message (per-turn, never persisted to memory; same pattern as `_withUnavailableToolsNote` at `src/agent.js:1814`).
  - `_activeSkills()` — returns the skill subset for the current turn: `this._filteredSkills ?? all-non-disabled`.
- Filter timing note (spec §5 clarified): the sidecar filter runs **once per user message** in `_runPipeline` (not once per ReAct round — the user message doesn't change between rounds, so a per-round LLM call would be pure waste). The result is cached on `this._filteredSkills` and reused by every round's `_withSkillListingNote`. `_filteredSkills` is reset to `null` at the start of each `chat()`/`stream()`.

**Constructor additions (insert after the `load_mcp_server` block, before the closing brace):**

```js
    // ---- Skill 系统 ----
    // `opts.skills` 配置后创建 SkillRegistry(急切全量加载,首次 chat/stream 前
    // 自动 loadSkills)。Level 1 清单每轮合并进 system 消息(_withSkillListingNote),
    // Level 2 正文经 `skill` 元工具注入,Level 3 资源经 read_file/shell_exec(Node)
    // 或 skill_resource(浏览器)访问。
    this.skills = null
    this._skillsLoadPromise = null
    this._filteredSkills = null
    this._skillFilterOpts = { threshold: 50, topK: 20 }
    this._skillsRuntime = 'node'
    if (opts.skills && Array.isArray(opts.skills.providers) && opts.skills.providers.length > 0) {
      const runtime = opts.skills.runtime ?? 'auto'
      this._skillsRuntime = runtime === 'auto'
        ? ((typeof process !== 'undefined' && process.versions?.node) ? 'node' : 'browser')
        : runtime
      this.skills = createSkillRegistry({
        providers: opts.skills.providers,
        cacheDir: opts.skills.cacheDir,
        runtime: this._skillsRuntime,
      })
      this._skillFilterOpts = {
        threshold: opts.skills.filter?.threshold ?? 50,
        topK: opts.skills.filter?.topK ?? 20,
      }
      this._skillFilter = new SkillFilter({
        url: this.simpleUrl,
        apiKey: this.simpleApiKey,
        model: this.simpleModel,
      })

      // `skill` 元工具(与 ask_user / load_mcp_server 同一注入手法)。
      // description 保持静态最小;清单在 system prompt 里(Claude Code 形态)。
      this.tools = [
        ...this.tools,
        {
          name: 'skill',
          description: 'Invoke a skill by name to load its full instructions into context. Available skills are listed in the system prompt.',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'The skill name, exactly as listed in the system prompt' },
            },
            required: ['name'],
          },
          execute: async ({ name }) => this._invokeSkill(name),
        },
      ]

      // 浏览器运行时:注入 skill_resource 工具(Level 3 资源读取)。
      if (this._skillsRuntime === 'browser') {
        this.tools = [
          ...this.tools,
          {
            name: 'skill_resource',
            description: 'Read a bundled file from a previously invoked skill (browser runtime).',
            parameters: {
              type: 'object',
              properties: {
                skill: { type: 'string', description: 'The skill name' },
                path: { type: 'string', description: 'Relative path of the bundled file, e.g. references/api.md' },
              },
              required: ['skill', 'path'],
            },
            execute: async ({ skill, path }) => {
              try {
                return String(await this.skills.readResource(skill, path))
              } catch (e) {
                return `Error reading skill resource: ${e.message}`
              }
            },
          },
        ]
      }
    }
```

**New methods (add near `_withUnavailableToolsNote`):**

```js
  /** 首次调用触发急切全量加载;后续复用同一 promise。 */
  async loadSkills() {
    if (!this.skills) return
    this._skillsLoadPromise ??= this.skills.load()
    return this._skillsLoadPromise
  }

  /** 重新全量加载 skill(按 hash 跳过未变更项),并促使下一轮重建清单。 */
  async refreshSkills() {
    if (!this.skills) return
    await this.skills.refresh()
    this._toolsGeneration++
  }

  /** 当前轮参与清单的 skill 子集:过滤结果(若有)∩ 非 disable-model-invocation。 */
  _activeSkills() {
    if (!this.skills) return []
    const all = (this._filteredSkills ?? this.skills.list())
    return all.filter(s => !s.disableModelInvocation)
  }

  /**
   * 把 Level 1 skill 清单块合并进本轮 system 消息(不持久化,与
   * _withUnavailableToolsNote 同款每轮重算)。格式对齐 Claude Code:
   *   The following skills are available for use with the Skill tool:
   *   - name
   *   - name: description
   */
  _withSkillListingNote(messages) {
    const active = this._activeSkills()
    if (active.length === 0) return messages
    const lines = active.map(s => s.description ? `- ${s.name}: ${s.description}` : `- ${s.name}`)
    const block = `The following skills are available for use with the Skill tool:\n\n${lines.join('\n')}`
    const out = messages.slice()
    const sysIdx = out.findIndex((m) => m && m.role === 'system')
    if (sysIdx === -1) {
      out.unshift({ role: 'system', content: block })
    } else {
      const sys = out[sysIdx]
      const base = typeof sys.content === 'string' ? sys.content : ''
      out[sysIdx] = { ...sys, content: base ? `${base}\n\n${block}` : block }
    }
    return out
  }

  /** `skill` 元工具的 execute:返回正文 + Level 3 资源访问说明;未知名软失败。 */
  _invokeSkill(name) {
    const def = this.skills?.get(name)
    if (!def || def.disableModelInvocation) {
      const valid = this._activeSkills().map(s => s.name).join(', ') || '(none)'
      return `Error: unknown skill "${name}". Valid skills: ${valid}`
    }
    let out = def.body
    const fileList = def.files.filter(f => f !== 'SKILL.md')
    out += '\n---\n'
    if (def.baseDir) {
      out += `Skill base directory: ${def.baseDir}\n`
      if (fileList.length > 0) out += `Bundled files: ${fileList.join(', ')}\n`
      out += 'Access files with read_file / shell_exec using paths under the base directory.'
    } else {
      if (fileList.length > 0) out += `Bundled files: ${fileList.join(', ')}\n`
      out += 'Use the skill_resource tool to read bundled files.'
    }
    return out
  }
```

**Wiring changes:**

1. Top of `chat()` and `stream()` (before strategy dispatch): `this._filteredSkills = null; await this.loadSkills()` (in `stream()`, inside the generator before the first yield-producing call).
2. In `_runPipeline` after intent recognition (~line 930), add the filter step:

```js
    // 1.5 Skill 过滤(超阈值才触发 sidecar;fail-open)
    if (this.skills) {
      const allSkills = this.skills.list().filter(s => !s.disableModelInvocation)
      if (allSkills.length > this._skillFilterOpts.threshold) {
        this._filteredSkills = await this._skillFilter.filter(userMessage, allSkills, {
          topK: this._skillFilterOpts.topK,
          signal,
          telemetry: this._currentRun?.rootCtx ?? null,
        })
      }
    }
```

3. Chain the listing note into every outgoing-message site — wrap the existing `_withUnavailableToolsNote(...)` calls at `src/agent.js:950`, `:960`, and `:1851` as `this._withSkillListingNote(this._withUnavailableToolsNote(...))`.
4. Import at top of `agent.js`: `import { createSkillRegistry } from './skills/registry.js'` and `import { SkillFilter } from './skills/filter.js'`.

- [ ] **Step 1: Write the failing test** — create `src/agent-skills.test.js` with the test code below.

```js
// src/agent-skills.test.js
import { test } from 'node:test'
import assert from 'node:assert'
import { Agent } from './agent.js'

const SKILL_MD = (name, desc) => `---\nname: ${name}\ndescription: ${desc}\n---\nInstructions for ${name}`

function memProvider(skills, { disabled = [] } = {}) {
  return {
    name: 'mem', origin: 'mem:test',
    async listSkills() { return Object.keys(skills).map(n => ({ name: n, description: skills[n] })) },
    async fetchSkill(n) {
      const dmi = disabled.includes(n) ? 'disable-model-invocation: true\n' : ''
      return { files: [
        { path: 'SKILL.md', content: `---\nname: ${n}\ndescription: ${skills[n]}\n${dmi}---\nInstructions for ${n}` },
        { path: 'references/doc.md', content: 'ref content' },
      ] }
    },
    async readResource(n, rel) { return 'ref content' },
  }
}

function makeAgent(skillsOpts) {
  return new Agent({
    provider: 'openai', apiKey: 'test-key',
    skills: skillsOpts,
  })
}

test('skill meta-tool is injected when skills configured', () => {
  const agent = makeAgent({ providers: [memProvider({ alpha: 'A' })], runtime: 'browser' })
  assert.ok(agent.tools.find(t => t.name === 'skill'))
})

test('skill_resource tool injected only in browser runtime', () => {
  const browser = makeAgent({ providers: [memProvider({ a: 'A' })], runtime: 'browser' })
  assert.ok(browser.tools.find(t => t.name === 'skill_resource'))
  const node = makeAgent({ providers: [memProvider({ a: 'A' })], runtime: 'node' })
  assert.strictEqual(node.tools.find(t => t.name === 'skill_resource'), undefined)
})

test('no skill tools when skills not configured', () => {
  const agent = new Agent({ provider: 'openai', apiKey: 'k' })
  assert.strictEqual(agent.skills, null)
  assert.strictEqual(agent.tools.find(t => t.name === 'skill'), undefined)
})

test('_withSkillListingNote merges Claude Code style block into system message', async () => {
  const agent = makeAgent({ providers: [memProvider({ alpha: 'Does A', beta: '' })], runtime: 'browser' })
  await agent.loadSkills()
  const out = agent._withSkillListingNote([{ role: 'system', content: 'BASE' }])
  assert.match(out[0].content, /^BASE\n\nThe following skills are available for use with the Skill tool:/)
  assert.match(out[0].content, /- alpha: Does A/)
  assert.match(out[0].content, /- beta$/m) // no trailing colon when description empty
})

test('disable-model-invocation skills omitted from listing but accessible via get', async () => {
  const agent = makeAgent({ providers: [memProvider({ vis: 'V', hid: 'H' }, { disabled: ['hid'] })], runtime: 'browser' })
  await agent.loadSkills()
  const out = agent._withSkillListingNote([{ role: 'system', content: '' }])
  assert.ok(out[0].content.includes('- vis'))
  assert.ok(!out[0].content.includes('- hid'))
  assert.ok(agent.skills.get('hid'))
})

test('skill tool execute returns body + browser Level 3 note', async () => {
  const agent = makeAgent({ providers: [memProvider({ alpha: 'A' })], runtime: 'browser' })
  await agent.loadSkills()
  const result = await agent._invokeSkill('alpha')
  assert.match(result, /Instructions for alpha/)
  assert.match(result, /Bundled files: references\/doc\.md/)
  assert.match(result, /skill_resource tool/)
})

test('skill tool soft-fails on unknown name with valid list', async () => {
  const agent = makeAgent({ providers: [memProvider({ alpha: 'A' })], runtime: 'browser' })
  await agent.loadSkills()
  const result = await agent._invokeSkill('nope')
  assert.match(result, /unknown skill "nope"/)
  assert.match(result, /alpha/)
})

test('filter triggers only above threshold and narrows the listing', async () => {
  const many = {}
  for (let i = 0; i < 4; i++) many[`s-${i}`] = `Does ${i}`
  const agent = makeAgent({
    providers: [memProvider(many)], runtime: 'browser',
    filter: { threshold: 3, topK: 2 },
  })
  await agent.loadSkills()
  agent._skillFilter._syncChat = async () => ({ choices: [{ message: { content: '["s-2","s-0"]' } }] })
  // 模拟 _runPipeline 的过滤步骤
  const all = agent.skills.list().filter(s => !s.disableModelInvocation)
  assert.ok(all.length > 3)
  agent._filteredSkills = await agent._skillFilter.filter('msg', all, { topK: 2 })
  const out = agent._withSkillListingNote([{ role: 'system', content: '' }])
  assert.ok(out[0].content.includes('- s-2'))
  assert.ok(out[0].content.includes('- s-0'))
  assert.ok(!out[0].content.includes('- s-1'))
})

test('loadSkills is memoized (providers hit once)', async () => {
  let listCalls = 0
  const p = {
    name: 'mem', origin: 'x',
    async listSkills() { listCalls++; return [{ name: 'a', description: 'A' }] },
    async fetchSkill() { return { files: [{ path: 'SKILL.md', content: SKILL_MD('a', 'A') }] } },
  }
  const agent = makeAgent({ providers: [p], runtime: 'browser' })
  await Promise.all([agent.loadSkills(), agent.loadSkills()])
  await agent.loadSkills()
  assert.strictEqual(listCalls, 1)
})

test('refreshSkills bumps _toolsGeneration', async () => {
  const agent = makeAgent({ providers: [memProvider({ a: 'A' })], runtime: 'browser' })
  await agent.loadSkills()
  const gen = agent._toolsGeneration
  await agent.refreshSkills()
  assert.ok(agent._toolsGeneration > gen)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/agent-skills.test.js`
Expected: FAIL — `agent.tools.find(...)` returns undefined (no `skill` tool yet) etc.

- [ ] **Step 3: Implement** — apply the constructor additions, new methods, and wiring changes described above to `src/agent.js`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/agent-skills.test.js`
Expected: PASS (10 tests)

- [ ] **Step 5: Run the FULL suite to catch regressions**

Run: `npm test`
Expected: all existing tests still PASS (agent.test.js, context-manager.test.js, etc.)

- [ ] **Step 6: Commit**

```bash
git add src/agent.js src/agent-skills.test.js
git commit -m "feat(agent): integrate skill system — listing injection, skill tool, filter"
```

---

### Task 11: Documentation

**Files:**
- Modify: `CLAUDE.md` (add `skills/` module description alongside the `mcp/` block)
- Modify: `README.md` (add a "Skills" usage section)
- Modify: `CHANGELOG.md` (new entry under Unreleased/next version)

**Interfaces:**
- Consumes: final shapes from Tasks 1-10.
- Produces: docs only, no code.

- [ ] **Step 1: Add `skills/` section to CLAUDE.md**

Insert after the `mcp/` block in the Architecture section, following the same style — one bullet per module: `skills/index.js` (entry, exports), `skills/model.js` (frontmatter parser, Skill_Def), `skills/provider.js` (contract + registry, reserved names `local`/`http`), `skills/providers/local.js` + `http.js` (built-ins, HTTP wire protocol: `GET {baseUrl}/manifest.json` / `GET {baseUrl}/skills/{name}/{relPath}`), `skills/materializer.js` (Node-only atomic write to `~/.lll-agent/skills-cache/`), `skills/registry.js` (eager load, first-wins, hash-based refresh), `skills/filter.js` (SkillFilter sidecar, threshold 50 / topK 20, fail-open), `skills/errors.js` (whitelist-field errors). Note the Agent touchpoints: `opts.skills`, `loadSkills()`/`refreshSkills()`, system-prompt Level 1 listing, `skill` meta-tool, browser `skill_resource` tool. Note the security caveat: network-sourced skill scripts run via host-provided `shell_exec` — no sandbox in v1; hosts gate via tool provisioning + `beforeToolCall`.

- [ ] **Step 2: Add README "Skills" section**

Cover: what a skill is (SKILL.md + scripts/references, Claude Code-compatible layout), configuring `new Agent({ skills: { providers: [{ type: 'local', dir }, { type: 'http', baseUrl }], filter: { threshold, topK } } })`, the three disclosure levels, browser vs node runtime, the HTTP manifest protocol for server implementers, and the security note.

- [ ] **Step 3: Add CHANGELOG entry**

```markdown
## [0.9.0] - unreleased
### Added
- **Skill system** (`src/skills/`): Claude Code-style skill packages (SKILL.md + scripts/references) loadable from local folders or HTTP manifests. Level 1 listing injected into the system prompt, `skill` meta-tool for on-demand body injection, browser `skill_resource` tool, and an LLM-powered Top-K SkillFilter (fail-open) for skill sets above a threshold. Zero new runtime dependencies.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md CHANGELOG.md
git commit -m "docs: document the skill system"
```

---

## Execution Notes

- Task order is strict for 1→9 (each consumes the previous); Task 10 needs 1-9; Task 11 last.
- Every task's Step "run test" uses `node --test <file>`; the final gate is `npm test` in Task 10 Step 5.
- If `npm test` glob misses the new nested dir (`src/skills/providers/*.test.js`), check `package.json` — the script is `node --test src/**/*.test.js`; `**` covers nesting in Node 22, but verify and widen the glob if needed.
- All warns go through `console.warn` with a `[skills]` or `[SkillFilter]` prefix, matching `[IntentRecognizer]` style.

