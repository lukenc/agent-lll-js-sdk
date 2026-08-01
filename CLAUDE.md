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
- **`agents/` — Subagent System**: Entry point is `agents/index.js`, exporting `createSubagentRuntime`, the Agent_Type registry (`registerAgentType` / `getAgentType` / `listAgentTypes` / `unregisterAgentType` / `resetAgentTypes` / `AGENT_TYPE_NAME_RE` / `INITIAL_AGENT_TYPES`), `registerA2ATransport` / `RESERVED_A2A_TRANSPORTS`, `SUBAGENT_TOOL_NAMES`, and the five error classes. Everything else (`handle.js` / `registry.js` / `runner.js` / `graph.js` / `mailbox.js` / `ask.js` / `isolation.js` / `mirror.js` / `contract.js` / `models.js` / `artifacts.js` / `history-search.js` / `a2a/local.js`) is internal — assembled and held by the runtime, not exported. `agents/index.test.js` is the contract test for that boundary: it names each internal that must stay unexported, and fails on any unregistered export. Internal layout:
  - `agents/errors.js` — `SubagentError` / `AgentTypeError` / `AgentGraphError` / `A2AError` / `WorktreeIsolationError`. Constructors accept only whitelist scalar fields, same pattern as `mcp/errors.js` (so an apiKey can never reach `err.message`).
  - `agents/types.js` — Agent_Type registry. `name` matches `AGENT_TYPE_NAME_RE = /^[a-z0-9-]{1,64}$/`; built-in `general-purpose` is reserved and cannot be overridden or unregistered (same policy as reserved MCP transports / skill provider types). A type carries `description` (goes into the system-prompt listing), `systemPrompt`, `model` (alias), `tools` (`'*'` or a name list), `maxRounds` (60), `maxAttempts` (3), `temperature` (0.6), `canSpawn` (false), `enableIntentRecognition` (false). **The registry is process-global**, like `BASE_TOOLS` — `resetAgentTypes()` wipes host registrations back to built-ins.
  - `agents/contract.js` — `AGENT_TOOL_DESCRIPTION` / `AGENT_GRAPH_DESCRIPTION` (the `Tool_Def.description` constants that are the model's only source of guidance on how to write a task contract and when an edge is mandatory) + `renderContract({ description, prompt, inputs, cwd })`, which renders a subagent's first user message deterministically.
  - `agents/models.js` — model alias table. Defaults: `fast` → the parent's `simpleModel`/`simpleApiKey`/`simpleUrl` triple, `main` → the parent's `model`/`apiKey`/`url`. `modelEnum` generates the `model` parameter's enum at tool-injection time (never a hardcoded model list — this SDK is multi-provider), so a fast alias may live on a different provider. Resolution order: call argument → `Agent_Type.model` → inherit parent.
  - `agents/handle.js` — `AgentHandle`: identity, metrics, and a validated state machine (`pending → queued → running → succeeded|failed|cancelled`, with `running ⇄ waiting_input` while a question is outstanding). An illegal transition throws (it is a programming error, not a soft failure). `toStatus()` returns a function-free, apiKey-free snapshot.
  - `agents/registry.js` — agentId/name allocation (`agt_` + counter; duplicate names get `_2`/`_3`, lookups by name resolve to the newest), **per-depth concurrency slot pools**, and LRU retention of finished agents (`retainCompleted`, default 20) so `send_message` can resume one. The slots are per-depth for a structural reason: one shared pool deadlocks as soon as `maxConcurrent` parents each synchronously spawn a child.
  - `agents/runner.js` — builds each subagent as a plain `new Agent({...})` (composition, not a forked ReAct loop), retries by `failureKind`, renders the terminal state into an `Agent_Result` string, and forwards telemetry with attribution fields. `run()` never throws — every failure comes back as a structured result for the parent to act on. Also exports `cancelHandle`, the single cancellation path shared by the `agent_cancel` tool and `runtime.close()`: it transitions the handle to `cancelled` *before* aborting, so a cancellation is never reclassified as a failure. A retry is a **brand-new subagent instance on the same contract** — the failed instance's memory is deliberately not reused.
  - `agents/graph.js` — pure logic (state machine, Kahn cycle detection, ready-set computation), no I/O. **Declaring is not creating**: `blocked` / `ready` / `awaiting_confirm` nodes hold no handle, no `Agent`, no concurrency slot. On the default path a ready node does *not* auto-start — the upstream results go back to the orchestrator, which then writes the node's final contract via `graph_start`. `on_ready: 'auto'` is the escape hatch for work fully determined in advance.
  - `agents/mailbox.js` — one inbox per agent. Messages **never interrupt a running tool**; they are drained at the target's ReAct round boundary and injected as `role: 'user'` with an `<agent-message>` wrapper (not `assistant` — forging an assistant turn makes the model believe it said that itself). More than `INJECTION_MERGE_THRESHOLD` (5) pending injections merge into a single message, since several consecutive `user` messages trip some providers' validation.
  - `agents/ask.js` — `AskRegistry`: multiplexed question routing. Every question (the main agent's included) gets an `askId` with attribution, so a host can answer out of order. Two answer channels **race, first wins, the late one is a silent no-op** — both existing simultaneously is a legal host setup, so throwing at the loser would let a normal race crash the host, and letting the loser overwrite would hand the waiter someone else's answer.
  - `agents/artifacts.js` — ownership records on the shared RuntimeHistory `artifacts` track + same-key cross-agent conflict detection (`policy: 'warn'` default / `'deny'`), and `fnv1a32` (8 hex chars, zero-dependency, identical in Node and the browser; **change/conflict detection, not cryptography**).
  - `agents/history-search.js` — substring/regex search over the shared track's **raw events**, so content already compacted away by `SummarizingMemory` is still recoverable (a summary only affects projection, it does not delete events). This is what lets a subagent skip inheriting the parent context. Snippets are ±120 chars, capped at 400, `limit` default 20.
  - `agents/mirror.js` — `wrapMemoryForMirror(inner, { sharedHistory, agentId })` one-way mirrors subagent messages into the parent's `RuntimeHistory` on the `all` / `internal` / `agent:<id>` tracks — **never the `model` track**, so the parent's conversation projection stays clean. `memory.js` is unchanged. Summary messages are routed through `appendSummary` explicitly, because `appendMessage`'s `_isSummary` branch does not forward `meta.tracks` and would land them on the `model` track.
  - `agents/a2a/index.js` — Envelope codec (JSON-RPC 2.0 shape) + transport registry. Reserved names `local` / `http` / `grpc` cannot be overridden by user code. `agents/a2a/local.js` is the in-process transport and **runs encode/decode even though nothing needs serializing**, so a malformed envelope fails locally rather than on the day someone wires up a remote transport.
  - `agents/isolation.js` — worktree isolation (Node-only, dynamic `import('node:child_process')`). **Parked — see the note below.**
  - `agents/tools.js` — `SUBAGENT_TOOL_NAMES` plus the 10 meta-tool definitions: `agent`, `agent_status`, `agent_cancel`, `agent_graph`, `graph_start`, `send_message`, `artifact_write`, `artifact_list`, `history_search`, `history_get`. All soft-fail (an unregistered type, an unknown target, a node in the wrong state come back as a correctable sentence, never a throw). What a subagent actually receives is decided by `Agent_Type.tools` in `runner.buildChildOptions`: `'*'` inherits the parent's **entire** tool set minus `agent` / `agent_graph` / `graph_start` (kept when `canSpawn: true`), while an explicit array keeps only the names it lists — so a narrow type must name `artifact_write` / `history_search` etc. itself. (Design spec §5 describes a fixed six-tool default for subagents; the implementation is the `tools`-driven rule above.)
  - `agents/runtime.js` — `createSubagentRuntime({ parent, ...opts })` assembles and owns all of the above, and is the only object `agent.js` talks to.

  **Zero new runtime dependencies** — Node 18+ built-ins only, and `node:child_process` is dynamically imported by `isolation.js` alone, so browser builds never pull it in. `fast-check` (devDependency) is used by `graph.property.test.js`.

  **Agent touchpoints** (`agent.js`), all additive:
  1. **Constructor** — `opts.subagents` (`types`, `defaultType`, `maxConcurrent` 4, `maxDepth` 2, `modelAliases`, `retry`, `keepAlive` true, `keepAliveTimeoutMs` 600000, `artifacts.policy`, `ask.timeoutMs`, `isolation`, `retainCompleted` 20, `a2a.transport`) creates `this.subagents`, appends the 10 meta-tools, and calls `registerBaseTool(name)` for each. Registering them as base tools is mandatory for the same reason `skill` needed it (commit `20617d8`): with `enableIntentRecognition` on, `ToolFilter` would prune the meta-tools while the system prompt still advertises the agent-type listing.
  2. **`enqueueMessage(message)` + `_pendingInjections`** — FIFO queue drained at the ReAct **round boundary** (before `_buildSimpleBody()` / `_runPipeline()`), where the previous round's `assistant(tool_calls)` and all its `tool` results are already paired on disk, so inserting a `user` message cannot break the pairing invariant `memory-policy.js` relies on. Three producers share it: background-agent completion notices, graph node-ready notices, and `send_message` delivery.
  3. **`ask_user` upgrade** — injected when `hooks.onAskUser || opts.subagents`; hook signature widened to `onAskUser(question, meta)` (old single-argument hooks keep working); new `pendingQuestions()` / `answerQuestion(askId, answer)` / `cancelQuestion(askId, reason)`.
  4. **`_withSubagentTypesNote(messages)`** — merges the agent-type listing into the system message each round (recomputed every round, since types can be registered at runtime). ReAct only.
  5. **Tool execution context** — `tool.execute(args, ctx)` gets `{ signal, cwd, agentId, agentName, depth }` by spreading `this._toolContextExtra`. The main agent's `cwd` is `null`. Existing tools are unaffected by the extra fields.
  6. **keep-alive** — at the "no tool calls → return" branch, `_keepAliveOnce()` decides whether to hold the turn open. The order of its three checks is the whole point: pending injections are drained *before* any in-flight check (a finished background agent has nothing in flight but its completion notice is still queued); then at most one timeout per turn (`lastKeepAliveTimedOut`, event `run.keep_alive.timeout`); then `subagents.hasInFlight()` — deliberately not `hasPending()`, because `blocked` / `awaiting_confirm` graph nodes are waiting on the orchestrator's own next move, generate no events, and would burn a full timeout every round. Bounded by `maxRounds` throughout.
  7. **Lifecycle** — `getArtifacts({ agentId })` gains an optional filter (no-arg behaviour unchanged); new `closeSubagents()` cancels running agents, rejects pending questions, and cleans up unmodified worktrees; `reset()` calls it.

  **Security caveat**: there is no sandbox. Subagents execute commands through host-provided tools, exactly like the skill system — hosts must gate them via tool provisioning and `hooks.beforeToolCall`. Note that `hooks.beforeToolCall` / `afterToolCall` / `onError` are forwarded to every subagent; that forwarding is a security boundary, not a convenience.

  **The artifact track is the primary cross-agent guard.** Ownership records plus same-key cross-agent warn/deny is the only mechanism that holds in *both* target environments — the browser has neither git worktree nor `shell_exec`. Its strength is therefore the actual ceiling on cross-agent safety here.

  **`isolation: 'worktree'` is parked** — Node-only, experimental, fully implemented and tested, code retained, but **not a recommended path**. It does not exist in half the target environments, and it conflicts with DAG semantics: a DAG node is one subtask run by one subagent, so per-node worktrees would show a downstream node the repository as it stood *before* its upstream did any work, producing edits that silently conflict. `agent_graph` / `graph_start` therefore **deliberately omit** an `isolation` parameter — graph nodes share one working directory by design. The consequence, which `AGENT_GRAPH_DESCRIPTION` states to the model: **two nodes with no `depends_on` path between them will run concurrently in the same directory with nothing isolating them**, so a missing edge is a correctness bug, not a scheduling imperfection.

  **Known limitations**:
  1. **ReAct only** — the agent-type listing, round-boundary injection (`_pendingInjections`), keep-alive, and `_toolContextExtra` all live in `_reactLoop` / `_reactLoopStream`. Under `strategy: 'plan_and_execute'` none of them apply: the `agent` tool is still callable, but the model sees no type listing, and a background agent's completion notice sits in the queue until the next `react` call (or is only visible to the host via telemetry). Same shape as the documented skill-listing limitation.
  2. **No sandbox** — see above.
  3. **The artifact track is a bookkeeping convention** — a subagent that skips `artifact_write` and edits files directly is undetectable to the framework.
  4. **`ctx.cwd` is advisory** — whether a host tool honours it is the host's decision. The framework deliberately does not rewrite tool arguments: silently rewriting paths would produce something that looks isolated without being isolated, which is worse than no isolation, because the host would trust it.
  5. **`isolation: 'remote'` is unimplemented** — the protocol and transport registry are in place, but no non-local A2A transport ships, so the `agent` tool soft-fails on it.
  6. **Kept worktrees leave `.git/worktrees/<name>` admin entries** that accumulate across runs. Hosts should run `git worktree prune`; the framework deliberately does not, because pruning is repo-wide and would reach beyond this SDK's own worktrees.
  7. **`retry.attemptTimeoutMs` is dead configuration** — documented in `agent.js`, defaulted in `runtime.js`, and read by nothing. **No per-attempt timeout is enforced.** A subagent stuck on a hanging tool call is bounded only by `maxRounds` and the caller's `signal`. Needs its own follow-up: either implement the timeout or delete the option.
  8. **`Agent_Type.maxAttempts` is unreachable** — `runner.js` reads `this.opts.retry?.maxAttempts ?? type.maxAttempts ?? 3`, but `runtime.js` always populates `opts.retry.maxAttempts` (defaulting it to 3), so the per-type value is never consulted. A type declaring `maxAttempts: 5` is silently ignored; only `subagents.retry.maxAttempts` has any effect. Same follow-up bucket as (7).
  9. **History search degrades when the parent memory has no `runtimeHistory`** — the runtime falls back to a private `RuntimeHistory`, and `history_search` says so in its result rather than pretending to have searched the parent's history.


## Testing

Tests use **native Node.js test runner** with `node:test` and `node:assert`. Property-based tests use `fast-check`. Test files are co-located with source (`src/*.test.js`).

Key test files and what they cover:
- `agent.test.js` — Agent + memory integration
- `memory.test.js` — Memory strategy edge cases, token counting
- `context-manager.test.js` — Prompt assembly, token trimming, tool-call group preservation
- `p0-2.test.js`, `p0-4-5.test.js`, `review-r1-r4.test.js` — Regression tests for fixed bugs
- `agents/index.test.js` — Subagent public-export contract (every public name exported from both `agents/index.js` and `src/index.js`; every internal name absent from both)
- `agents/*.test.js` — Subagent units: `types` / `contract` / `handle` / `registry` / `runner` / `graph` (+ `graph.property.test.js` under fast-check) / `graph-tools` / `mailbox` / `a2a` / `ask` / `artifacts` / `history-search` / `mirror` / `isolation` / `tools` / `errors` / `models`
- `agent-subagents.test.js`, `agent-injection.test.js`, `agent-keepalive.test.js`, `agent-ask-routing.test.js` — Agent-side wiring: meta-tool + base-tool registration, type-listing injection, round-boundary drain without breaking tool-call pairing, keep-alive branches, multiplexed question routing, `closeSubagents()`

All tests mock HTTP calls; no real API keys needed to run tests.

## Key Conventions

- Pure ESM (`"type": "module"` in package.json) — use `import`/`export`, not `require`.
- No TypeScript, no transpilation — plain JavaScript with esbuild for bundling only.
- No linter or formatter configured.
- `todo.md` tracks known bugs by severity (P0–P3) and regression fixes (R-1 to R-4). Consult it before working on bug fixes.
