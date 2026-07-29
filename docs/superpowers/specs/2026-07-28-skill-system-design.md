# Skill System Design

**Date:** 2026-07-28
**Status:** Approved

## Overview

A skill system for lll-web-agent that mirrors the Claude Code skill model: a skill is a named, versioned instruction package (SKILL.md + optional scripts/references/assets) that the agent loads at startup and injects into context on demand. Supports local-folder and HTTP providers, browser degradation, and an LLM-powered filter for large skill sets.

---

## 1. Skill Model & Contract (`skills/model.js`)

### Directory layout

```
<skill-name>/
  SKILL.md          # required
  scripts/          # optional — executable scripts
  references/       # optional — reference documents
  assets/           # optional — templates, static files
```

### SKILL.md frontmatter

Zero-dependency hand-written YAML parser (scalar, single-level map, string list only — same approach as mcp/). Unknown fields are preserved in `metadata.extra` without error.

| Field | Required | Rule |
|---|---|---|
| `name` | yes | `^[a-z0-9-]{1,64}$`; mismatch with dir name → use dir name + warn |
| `description` | yes | non-empty, ≤1024 chars; truncate + warn if exceeded |
| `version` | no | preserved as-is |
| `license` | no | preserved as-is |
| `allowed-tools` | no | parsed to `string[]`; v1 parsed but not enforced (host uses `beforeToolCall`) |
| `disable-model-invocation` | no | `true` → skill excluded from `skill` tool listing |
| `metadata` | no | arbitrary key-value, preserved |

### `Skill_Def` runtime object

```js
{
  name: 'pdf-processing',
  description: '...',                    // Level 1 — always in context
  version: '1.0.0' | null,
  license: null,
  allowedTools: ['read_file'] | null,
  disableModelInvocation: false,
  metadata: {},
  body: '...',                           // Level 2 — injected on skill(name) call
  files: ['scripts/fill.py', 'references/api.md'],  // Level 3 — relative paths
  baseDir: '/abs/path/to/skill' | null,  // null in browser
  source: { provider: 'local', origin: '/path/to/skills' },
}
```

### Progressive disclosure (three levels)

1. **Level 1** — `name` + `description` always present in `skill` tool description.
2. **Level 2** — `body` (SKILL.md without frontmatter) returned as tool result when model calls `skill(name)`.
3. **Level 3** — `baseDir` + `files` list appended to tool result; model accesses files via `read_file`/`shell_exec` (Node) or `skill_resource` tool (browser).

### Cross-provider name collision

First-registered provider wins; later duplicate is skipped with a warn. This matches Claude Code's personal > project > plugin priority semantics.

---

## 2. Provider Protocol & Registry (`skills/provider.js`, `skills/providers/`)

### SkillProvider contract (duck-typed)

```js
{
  name: 'local',

  // Returns metadata only — no body/files fetched yet
  async listSkills() → [{ name, description, version?, hash? }]

  // Returns one of:
  //   { baseDir: '/abs/path' }                          — already on disk (local)
  //   { files: [{ path, content: string|Uint8Array }] } — in-memory bundle (HTTP)
  async fetchSkill(name) → SkillBundle

  // Optional — browser Level 3 resource access
  async readResource(name, relPath) → string | Uint8Array
}
```

Parsing and validation are done entirely in the registry; providers are dumb pipes.

### Built-in providers

**`createLocalSkillProvider({ dir })`**
- Scans `dir` for subdirectories containing `SKILL.md`.
- `listSkills` reads only frontmatter.
- `fetchSkill` returns `{ baseDir }` — zero-copy, no materialization needed.
- Multiple directories → multiple provider instances; registration order = priority.

**`createHttpSkillProvider({ baseUrl, headers?, fetchImpl? })`**

Wire protocol (server implementation spec):
- `GET {baseUrl}/manifest.json` → `{ skills: [{ name, description, version, hash, files: ['SKILL.md', ...] }] }`
- `GET {baseUrl}/skills/{name}/{relPath}` → file content

`fetchSkill` fetches all files listed in the manifest entry. `readResource` does a single-file GET (browser Level 3).

### Provider registry

`registerSkillProvider(type, factory)` — reserved names `local` and `http` cannot be overridden.

Agent `skills.providers` accepts three forms:
```js
providers: [
  { type: 'local', dir: './skills' },
  { type: 'http', baseUrl: 'https://...' },
  myCustomProviderInstance,   // duck-typed: has listSkills + fetchSkill
]
```

### Materializer (`skills/materializer.js`, Node only)

HTTP bundles are written to `cacheDir/<skill-name>/` (default `~/.lll-agent/skills-cache/`, configurable). Write strategy: temp dir → atomic rename to avoid partial state. Browser runtime skips materialization; `baseDir` remains `null`.

**Security note (documented):** Scripts under `baseDir` are executed via the host-provided `shell_exec` tool — equivalent to arbitrary code execution. v1 provides no sandbox. Hosts control exposure via whether `shell_exec` is provided and via `beforeToolCall` hooks.

---

## 3. SkillRegistry (`skills/registry.js`)

### Load model — eager, full

`registry.load()` is a full eager load:
1. Calls all providers' `listSkills()` and `fetchSkill(name)` concurrently.
2. Parses and validates every SKILL.md.
3. Node + in-memory bundle → materializes to `cacheDir`.
4. On completion: `registry.skills: Skill_Def[]` is fully populated.
5. Single-skill failure → warn + skip (does not abort load).
6. Provider `listSkills` failure → warn + skip that provider.

`registry.refresh()` re-runs the full load; uses `hash`/`version` to skip unchanged skills.

### API

```js
registry.load()              → Promise<void>
registry.refresh()           → Promise<void>
registry.list()              → Skill_Def[]   // snapshot
registry.get(name)           → Skill_Def | null  // O(1) Map lookup
```

---

## 4. Agent Integration

### Configuration

```js
new Agent({
  skills: {
    providers: [...],
    runtime: 'auto',          // 'node' | 'browser' | 'auto' (detects process.versions.node)
    cacheDir: undefined,      // default: ~/.lll-agent/skills-cache
    filter: {
      threshold: 50,          // enable filter when skill count exceeds this
      topK: 20,               // skills to retain after filtering
    },
  },
})
```

### Lifecycle

- `registry.load()` runs automatically before the first `chat()`/`stream()` (memoized promise).
- `agent.loadSkills()` — explicit preload.
- `agent.refreshSkills()` — triggers `registry.refresh()`.
- `agent.skills` — direct registry access.

### System prompt injection (Level 1)

After `load()` (and after each `refresh()`), the agent appends a skill listing block to the effective system prompt sent to the LLM. Format matches Claude Code exactly:

```
The following skills are available for use with the Skill tool:

- aggregate-module-docs
- skill-creator: Create new skills, modify and improve existing skills, and measure skill performance. Use when users want to create a skill from scratch, edit, or optimize an existing skill, run evals to test a skill, benchmark skill performance with variance analysis, or optimize a skill's description for better triggering accuracy.
```

Rules:
- Skills with no description emit only `- <name>` (no trailing colon).
- Skills with `disable-model-invocation: true` are omitted from the block.
- When SkillFilter is active (threshold exceeded), only the filtered Top-K subset is listed for that round.
- The block is appended after the user-supplied `systemPrompt`; the rest of the prompt is unchanged.
- Block change (load / refresh / filter result differs) → `_toolsGeneration` incremented → existing round-boundary tool-set re-derivation picks it up automatically.

### `skill` meta-tool (injected like `ask_user` / `load_mcp_server`)

Injected into `this.tools` when `skills.providers` is configured. Its description is static and minimal:

```
Invoke a skill by name to load its full instructions into context.
```

The listing lives in the system prompt (above), not in the tool description.

**Tool result** (Node):
```
<SKILL.md body>
---
Skill base directory: /Users/x/.lll-agent/skills-cache/pdf-processing
Bundled files: scripts/fill.py, references/api.md
Access files with read_file / shell_exec using paths under the base directory.
```

**Tool result** (browser):
```
<SKILL.md body>
---
Bundled files: scripts/fill.py, references/api.md
Use the skill_resource tool to read bundled files.
```

Unknown skill name → soft failure (error text + valid name list); no exception thrown.

Skills with `disable-model-invocation: true` are excluded from the listing but remain accessible via `agent.skills.get()`.

### `skill_resource` tool (browser only)

Injected only when `runtime === 'browser'`. Parameters: `{ skill, path }`. Calls `provider.readResource(skill, path)`. Path validation rejects `../` traversal.

---

## 5. SkillFilter (`skills/filter.js`)

### Trigger

Only when `registry.skills.length > filter.threshold` (default 50). Below threshold: all skills injected, no LLM call.

### Sidecar LLM call

Uses `simpleModel` config (falls back to main model if not configured). Runs once per user message in `_runPipeline` (the user message doesn't change between rounds), with the result cached and reused for all ReAct rounds of that turn.

```
System: You are a skill selector. Given a user message and a list of skills,
        return the names of the top ${topK} most relevant skills as a JSON array.
        Respond with ONLY a JSON array of skill names.
        Available skills:
        ${skills.map(s => `- ${s.name}: ${s.description}`).join('\n')}

User:   ${userMessage}
```

Returns parsed `string[]`, truncated to `topK`. Fail-open on parse error or LLM failure: returns full `Skill_Def[]` + warn (consistent with IntentRecognizer failure policy).

### API

```js
class SkillFilter {
  constructor({ url, apiKey, model })
  async filter(userMessage, skills, { topK, signal, telemetry }) → Skill_Def[]
}
```

Independent of `IntentRecognizer` — separate sidecar call, separate class, separate test file.

---

## 6. Error Handling (`skills/errors.js`)

Constructors accept only whitelist scalar fields (`name`, `message`, `skillName`, `providerName`, `cause`) — no raw options objects, preventing API key / env value leakage into `err.message` (same pattern as `mcp/errors.js`).

| Class | Trigger |
|---|---|
| `SkillLoadError` | Provider fetch failure, SKILL.md missing |
| `SkillParseError` | Frontmatter parse failure, required field missing/invalid |
| `SkillMaterializeError` | Write-to-disk failure (Node) |
| `SkillProviderError` | Reserved name override attempt, `listSkills` network error |

### Failure isolation

| Failure | Behavior |
|---|---|
| Single skill parse/materialize | warn + skip; load continues |
| Provider `listSkills` failure | warn + skip provider; others continue |
| SkillFilter LLM failure | fail-open: return full `Skill_Def[]` |
| `skill` tool called with unknown name | soft failure: error text + valid name list |

---

## 7. File Layout

```
src/skills/
  index.js          # exports: createSkillRegistry, registerSkillProvider, error classes
  model.js          # Skill_Def, SKILL.md frontmatter parser
  provider.js       # SkillProvider contract + provider registry
  providers/
    local.js        # createLocalSkillProvider
    http.js         # createHttpSkillProvider
  materializer.js   # Node-only: in-memory bundle → cacheDir
  registry.js       # SkillRegistry
  filter.js         # SkillFilter
  errors.js         # SkillLoadError, SkillParseError, SkillMaterializeError, SkillProviderError
```

`src/index.js` additions (same additive pattern as MCP):
- `createSkillRegistry`, `registerSkillProvider`, four error classes

`src/agent.js` additions:
- `opts.skills` config block
- `loadSkills()` / `refreshSkills()` public methods
- `skill` meta-tool injection
- `skill_resource` tool injection (browser)
- SkillFilter call once per user message in `_runPipeline` (when threshold exceeded), cached for all ReAct rounds of that turn

Zero new runtime dependencies.

---

## 8. Testing

All tests use `node:test` + `node:assert`. HTTP calls mocked via `globalThis.fetch` replacement.

| File | Coverage |
|---|---|
| `skills/model.test.js` | Frontmatter parsing: valid, missing required fields, description truncation, unknown fields preserved |
| `skills/provider.test.js` | LocalProvider dir scan; HttpProvider with mock fetch; manifest protocol |
| `skills/registry.test.js` | Full eager load, first-wins collision, refresh cache invalidation, single-skill failure isolation |
| `skills/filter.test.js` | Threshold trigger/no-trigger, fail-open, Top-K truncation |
| `agent-skills.test.js` | `skill` tool injection, tool result body+files, `disable-model-invocation`, browser `skill_resource` injection, SkillFilter integration |
