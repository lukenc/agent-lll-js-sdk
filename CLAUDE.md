# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**lll-web-agent** — an LLM Agent SDK for JavaScript (Node >=18, browser). Provides a complete runtime pipeline: intent recognition → tool filtering → context/token management → ReAct loop execution. Supports multiple LLM providers (OpenAI, DeepSeek, Qwen, Moonshot, Zhipu, X-Grok).

## Commands

- **Build**: `npm run build` (IIFE bundle) / `npm run build:min` (minified)
- **Test**: `npm test` (uses native Node.js test runner: `node --test src/**/*.test.js`)
- **Run single test**: `node --test src/memory.test.js`
- **Run example**: `npm run example` or `node examples/basic.js`

## Architecture

The runtime pipeline flows through these modules in order:

1. **`agent.js` — `Agent`**: Main orchestrator. Coordinates the full pipeline and manages the ReAct loop (LLM call → tool execution → observation → repeat).
2. **`intent-recognizer.js`**: Optional sidecar LLM call that analyzes user message complexity and recommends strategy/tools.
3. **`tool-filter.js`**: Filters tools based on intent; always retains `BASE_TOOLS` (keyword_search, read_file, write_file, shell_exec, project_tree).
4. **`context-manager.js`**: Assembles the prompt (system + knowledge + history + tools) and enforces token budgets. Trimming priority: TOOLS → HISTORY → KNOWLEDGE.
5. **Execution strategies**:
   - **ReAct** (default): Simple loop in `agent.js` — suitable for most tasks.
   - **PlanAndExecute** (`plan-and-execute.js`): Three-phase approach (planning → step execution with internal ReAct → synthesis) for complex multi-step tasks.

Supporting modules:
- **`memory.js`**: Three strategies — `SlidingWindowMemory`, `SummarizingMemory`, `TokenAwareMemory`. SummarizingMemory makes LLM calls to compress history.
- **`llm-client.js`**: HTTP client supporting both streaming (`streamChat`) and sync (`syncChat`) modes. Custom `LlmApiError` for API failures. Accepts an optional `telemetry: { ctx, onLlmSpanStart? }` opt — when `ctx` is a `TelemetryContext`, each call emits an OTel GenAI-shaped `llm.call` event on the owning `Agent`'s bus.
- **`tool.js`**: Tool definition (`defineTool`), OpenAI format conversion, and response parsing.
- **`knowledge-base.js`**: Injects project knowledge entries into the context.
- **`providers.js`**: Registry mapping provider names to API URLs. Extensible via `registerProvider`.
- **`telemetry.js`**: Portable event bus (`TelemetryBus`), W3C-style `newTraceId` / `newSpanId`, `childContext` for threading `TelemetryContext` through the call chain, `extractUsage` for OpenAI/DeepSeek/Qwen usage normalization, `utf8ByteLength` for Node+browser UTF-8 sizing. No runtime dependencies; field names align with OpenTelemetry GenAI semantic conventions but no OTel SDK is bundled.
- **`mcp/` — MCP Client Integration**: Entry point is `mcp/index.js` exporting `createMCPClient(options): Promise<MCP_Client>`. Internal layout:
  - `mcp/client.js` — `MCP_Client` class: state machine (`connecting → ready → closing → closed`), JSON-RPC request/response demultiplexer (`_pending` Map keyed by id), initialize handshake, `listTools()` with pagination + caching, `refreshTools()`, `_executeTool(rawName, args, ctx)` wiring each Mcp_Tool_Def's `execute` back through `tools/call`, and notification dispatch (`notifications/tools/list_changed` + `notifications/cancelled`).
  - `mcp/codec.js` — JSON-RPC 2.0 encode/decodeLine with shape validation; malformed input throws `MCPProtocolError({ kind: 'malformed_frame' })`.
  - `mcp/namespace.js` — `sanitizeSegment`, `buildNamespacedName`, `assignUniqueNames` (collision dedupe with `_2/_3` suffix), `unprefixToolName`. Output always matches `^[a-zA-Z0-9_-]{1,64}$`.
  - `mcp/normalize.js` — `normalizeCallToolResult(result, rawName)` flattens MCP `content` array (`text` concat with `\n`; `image`/`audio`/`resource_link`/`resource` replaced with `[mcp:<type> ...]` placeholders) to a single string; handles `isError: true` prefix and `structuredContent` fallback.
  - `mcp/errors.js` — `UnsupportedTransportError` / `MCPClosedError` / `MCPRequestError` / `MCPProtocolError`. Constructors accept only whitelist scalar fields (never raw options) so API keys / env values cannot leak into `err.message`.
  - `mcp/transports/index.js` — Transport registry. Exports `registerTransport(name, factory)` and internal `_setBuiltinTransport` + `resolveTransport`. Reserved names (`stdio`, `http`, `streamable-http`, `sse`) cannot be overridden by user code. Built-in transports self-register on module load; `createMCPClient` lazy-imports the one it needs.
  - `mcp/transports/stdio.js` — `child_process.spawn` subprocess, line-buffered stdio, stderr passthrough to `options.onStderr`.
  - `mcp/transports/http.js` — Streamable HTTP (`POST` with `Content-Type: application/json | text/event-stream` response branching). Uses Node 18+ built-in `fetch`. Registered under both `'http'` and `'streamable-http'`.
  - `mcp/transports/sse.js` — Legacy SSE (`GET /sse` long-lived + `POST /messages`). Endpoint URL negotiated via `event: endpoint` frame with fallback to `<url>/messages`.
  - `mcp/transports/sse-parser.js` — Shared SSE wire format parser (handles `\n`/`\r\n`/`\r`, multi-line `data:`, comment lines, cross-chunk boundaries). Used by both `http.js` (SSE response) and `sse.js` (stream consumer).
  - `mcp/__fixtures__/*.js` — Test-only fixtures (mock MCP servers + in-memory mock-transport + fast-check arbitraries). Not re-exported from `mcp/index.js` or `src/index.js`.

  **Zero new runtime dependencies** — implementation uses only Node 18+ built-ins (`child_process`, `fetch`, `http`, `stream`). `fast-check` is a devDependency used only by the property tests.

  **Touchpoint with existing framework** — minimal and additive:
  1. `src/index.js` appends MCP exports (`createMCPClient`, `registerTransport`, four error classes, `MCP_Client`).
  2. `src/tool-filter.js` adds runtime CRUD for `BASE_TOOLS` (`registerBaseTool` / `unregisterBaseTool` / `setBaseTools` / `clearBaseTools` / `resetBaseTools` / `isBaseTool` / `getBaseTools` / `INITIAL_BASE_TOOLS`) — all mutate the existing `BASE_TOOLS` Set in place (reference identity preserved).
  3. `src/context-manager.js` changes its local `const BASE_TOOLS` to `import { BASE_TOOLS } from './tool-filter.js'` (fixes a pre-existing 5-vs-6 inconsistency AND ensures CRUD mutations are immediately visible to `trimTools`).
  No change to `agent.js`, `tool.js`, or any other existing module. `defineTool` signature and Tool_Def shape contract are unchanged.
- **`skills/` — Skill System**: Entry point is `skills/index.js`, re-exporting the pieces below plus `SkillLoadError`/`SkillParseError`/`SkillMaterializeError`/`SkillProviderError`. Internal layout:
  - `skills/model.js` — `parseFrontmatter` (zero-dependency handwritten YAML-subset parser: scalars, single-level maps, string lists) and `parseSkillMd(text, ctx): Skill_Def` (dir name is the authoritative `name`; a mismatched frontmatter `name` warns and is overridden; requires non-empty `description`, truncated at `MAX_DESCRIPTION` (1024 chars) with a warn). `NAME_RE = /^[a-z0-9-]{1,64}$/`.
  - `skills/provider.js` — `SkillProvider` contract (`listSkills()` + `fetchSkill(name)`, optional `readResource(name, relPath)`) and factory registry: `registerSkillProvider(type, factory)` for custom types, `resolveProvider(config)` accepting either a provider instance or a `{ type, ...opts }` config. Reserved types `local`/`http` cannot be overridden.
  - `skills/providers/local.js` — scans a directory for subdirectories containing `SKILL.md`; `fetchSkill` returns `{ baseDir }` (zero-copy — registry skips materialization). `readResource` resolves the target path and rejects anything that escapes the skill directory.
  - `skills/providers/http.js` — wire protocol: `GET {baseUrl}/manifest.json` → `{ skills: [{ name, description, version, hash, files }] }`; `GET {baseUrl}/skills/{name}/{relPath}` → file content. Validates skill names against `NAME_RE` and rejects/percent-encodes path segments (`..`/empty segments throw) before building resource URLs.
  - `skills/materializer.js` (Node-only) — `materializeBundle(name, bundle, { cacheDir })` writes an in-memory file bundle to `~/.lll-agent/skills-cache/<name>/` via a temp-dir-then-atomic-`rename` swap (old dir removed first for a clean replace).
  - `skills/registry.js` — `createSkillRegistry({ providers, cacheDir, runtime })`: eager full load of all providers into an in-memory map; same-name skills across providers are first-wins (later providers warn+skip); `refresh()` reuses the cached `Skill_Def` for entries whose provider-reported `hash` is unchanged. Browser runtime never materializes (`baseDir: null`). `readResource(name, relPath)` rejects `..`/absolute paths.
  - `skills/filter.js` — `SkillFilter`: sidecar LLM call (`syncChat`) that ranks skills by relevance to the user message and returns the top-K names as JSON; fail-open (returns the full skill list) on any parse/LLM error, matching `IntentRecognizer`'s failure policy.
  - `skills/errors.js` — `SkillLoadError` / `SkillParseError` / `SkillMaterializeError` / `SkillProviderError`. Constructors accept only whitelist scalar fields (`skillName` / `providerName` / `cause`), same pattern as `mcp/errors.js`.

  **Zero new runtime dependencies** — pure Node 18+ builtins (`node:fs/promises`, `node:path`, `node:os`) plus `fetch`. The local provider imports `node:fs/promises` dynamically so `skills/` still bundles safely for browser builds.

  **Agent touchpoints** (`agent.js`): `opts.skills` (`providers`, `runtime`, `cacheDir`, `filter.threshold` default 50, `filter.topK` default 20) creates `this.skills` (a `SkillRegistry`); `loadSkills()`/`refreshSkills()` trigger eager load/refresh; the sidecar `SkillFilter` runs once per user message inside `_runPipeline` (not per ReAct round — the user message doesn't change between rounds), with the result cached and reused for every round of that turn; `_withSkillListingNote` injects the Level 1 skill listing into the system message each round; the `skill` meta-tool injects a skill's full body (Level 2) on invocation; a browser-only `skill_resource` tool exposes Level 3 bundled-resource reads (Node relies on the existing `read_file`/`shell_exec` base tools instead).

  **Security caveat**: network-sourced skill scripts run via the host-provided `shell_exec` tool — there is no sandbox in v1. Hosts consuming remote (HTTP) skill providers must gate execution themselves via tool provisioning and `hooks.beforeToolCall`.

  **Known limitation**: skill listing injection currently applies to the ReAct strategy only — under `strategy: 'plan_and_execute'`, `PlanAndExecuteStrategy` builds its own step system prompts and does not receive the skill listing (the `skill` tool remains callable there without listing visibility).

## Testing

Tests use **native Node.js test runner** with `node:test` and `node:assert`. Property-based tests use `fast-check`. Test files are co-located with source (`src/*.test.js`).

Key test files and what they cover:
- `agent.test.js` — Agent + memory integration
- `memory.test.js` — Memory strategy edge cases, token counting
- `context-manager.test.js` — Prompt assembly, token trimming, tool-call group preservation
- `p0-2.test.js`, `p0-4-5.test.js`, `review-r1-r4.test.js` — Regression tests for fixed bugs

All tests mock HTTP calls; no real API keys needed to run tests.

## Key Conventions

- Pure ESM (`"type": "module"` in package.json) — use `import`/`export`, not `require`.
- No TypeScript, no transpilation — plain JavaScript with esbuild for bundling only.
- No linter or formatter configured.
- `todo.md` tracks known bugs by severity (P0–P3) and regression fixes (R-1 to R-4). Consult it before working on bug fixes.
