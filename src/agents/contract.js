/**
 * Task Contract 的两件事：
 *
 * 1. `AGENT_TOOL_DESCRIPTION` —— `agent` 工具自身的 `Tool_Def.description`
 *    （模型在工具列表里读到的那段文字）。这是**唯一**引导主 agent 把完整契约
 *    写进入参 `prompt` 的地方，措辞直接决定契约质量。
 * 2. `AGENT_GRAPH_DESCRIPTION` —— `agent_graph` 工具的 `Tool_Def.description`。
 *    图节点共享同一个工作目录、没有 per-node 隔离兜底（worktree 已搁置，见
 *    spec §11），所以两个之间没有依赖路径的节点必然并行跑在同一个目录里。
 *    `depends_on` 因此不是调度提示，是安全边界——这段文字是模型唯一能读到的
 *    约束来源，必须把这一点讲透（spec §5.4「依赖声明是安全边界，不是调度提示」）。
 * 3. `renderContract` —— 把入参渲染成子 agent 的首条 user 消息。
 *
 * 术语（全文严格区分）：
 *   入参 `description` = 3-8 词短标签，只用于列表显示 / 命名 / 日志，不含任务内容。
 *   入参 `prompt`      = Task Contract 的唯一所在，自然语言。
 */

export const AGENT_TOOL_DESCRIPTION = `Launch a new agent to handle a complex, multi-step task. Each agent type has specific capabilities and tools available to it.

Available agent types are listed in the system prompt. Pass one via subagent_type; if omitted, the general-purpose agent is used.

## When to use

Reach for this when the task matches an available agent type, when you have independent work to run in parallel, or when answering would mean reading across several files — delegate it and you keep the conclusion, not the file dumps. For a single-fact lookup where you already know the file, symbol, or value, search directly. Once you've delegated a search, don't also run it yourself — wait for the result.

## The two text fields are NOT interchangeable

- \`description\`: a 3-8 word label, e.g. "Audit auth flow". It is used for status listings, the agent's name, and logs. It carries NO task content.
- \`prompt\`: the entire task contract, in natural language. This is the only thing the subagent gets.

The subagent does not inherit your conversation history. It starts with its type's system prompt, your \`prompt\`, and its tools — nothing else. A vague prompt produces a subagent that guesses. Write the contract so that a competent stranger could execute it with no further questions:

1. **One single objective.** If you find yourself writing "and then also", split it into two agents instead.
2. **The background it needs.** Names, paths, prior decisions, constraints you already know. Do not make it rediscover what you already have.
3. **The deliverable.** What to produce and where it goes: "return a markdown list of findings" / "write the migration to db/migrations/, then report the file path".
4. **Acceptance criteria.** How it knows it is done and correct.
5. **Constraints and prohibitions.** What it must not touch, change, or assume.

If the subagent needs project context you cannot easily paste, tell it to use \`history_search\` to retrieve it from the session history (including content your own context has since compacted away), or to read the project's docs itself.

## Model choice

Pick with \`model\`. Use the fast tier for mechanical, enumerable work whose result is easy to verify (grep-and-list, mass renames, reading a known file). Use the main tier for design judgement, cross-file reasoning, or anything whose output you will adopt directly. If omitted, the agent type's model is used; if the type declares none, the parent's model is inherited.

## Notes

- The subagent's final report is not shown to the user — relay what matters.
- Subagents run in the background by default; you will be notified when one completes. Pass run_in_background: false for a synchronous run when you need the result before continuing.
- Use send_message with the agent's name or id to continue a previously spawned agent with its context intact; a new agent call starts fresh.
- Never fabricate or predict a pending agent's result. If it has not reported yet, say it is still running.`

export const AGENT_GRAPH_DESCRIPTION = `Declare a dependency graph (DAG) of tasks. Declaring does NOT create agents — a node is instantiated only once its dependencies have all succeeded. By default a ready node hands its upstream results back to you and waits: you then call graph_start with the final prompt, having seen what upstream actually produced. Use on_ready "auto" only when the downstream task is fully determined in advance and cannot be affected by upstream results.

## depends_on is a safety boundary, not a scheduling hint

Graph nodes share one working directory. There is no per-node isolation under it. This means two nodes with no depends_on path between them WILL run concurrently in that same directory. A missing edge is not a scheduling imperfection — it is two subagents editing the same files at the same time, neither aware of the other, and the conflict surfaces silently, if at all, only after the fact.

1. **One node is one single, bounded subtask.** If stating its goal needs "and then also", that is two nodes, not one.
2. **Declare depends_on whenever a node reads or writes anything an earlier node produced or touched.** File overlap is itself a dependency, even when the two tasks look unrelated at the business-logic level.
3. **When unsure, add the edge.** A needless edge only costs parallelism — wall-clock time. A missing edge costs correctness and does not error. These costs are not symmetric, so default to serial.
4. **But do not invent ordering that isn't real.** The test is whether a genuine read/write overlap exists between two nodes, not whether an ordering feels tidier. Chain everything and the DAG degenerates into sequential execution, which defeats the reason to use one.
5. **depends_on can only name nodes already declared** — in this call or an earlier one. A node cannot depend on one declared later; declare producers before their consumers.`

/**
 * 渲染子 agent 的首条 user 消息。确定性：同样入参恒得同样文本。
 *
 * @param {object} args
 * @param {string} args.description 3-8 词标签（进标题行，便于子 agent 自我定位）
 * @param {string} args.prompt Task Contract 原文
 * @param {Array<{ key: string, agentName?: string, summary?: string, sha?: string }>} [args.inputs]
 *        上游产物引用（图节点场景）
 * @param {string|null} [args.cwd] worktree 隔离时的工作目录
 * @returns {string}
 */
export function renderContract({ description, prompt, inputs, cwd } = {}) {
  const parts = [`# Task: ${description}`, '', String(prompt ?? '')]

  if (Array.isArray(inputs) && inputs.length > 0) {
    parts.push('', '## Upstream artifacts', '',
      'These were produced by earlier agents in this workflow. Read them before starting.', '')
    for (const input of inputs) {
      const bits = [`- \`${input.key}\``]
      if (input.agentName) bits.push(`by ${input.agentName}`)
      if (input.sha) bits.push(`(sha:${input.sha})`)
      if (input.summary) bits.push(`— ${input.summary}`)
      parts.push(bits.join(' '))
    }
  }

  if (cwd) {
    parts.push('', '## Working directory', '',
      `Your working directory is \`${cwd}\` — an isolated copy of the repository, on its own git `
      + 'branch. Changes you make there do not affect other agents. Prefer absolute paths under it: '
      + 'the tools you call may resolve relative paths against the parent process\'s directory instead.')
  }

  return parts.join('\n')
}
