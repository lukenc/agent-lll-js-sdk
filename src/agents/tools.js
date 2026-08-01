/**
 * subagent 系统的元工具。全部遵循本仓库的**软失败**风格：入参非法、类型未注册、
 * 目标不存在等情况返回说明字符串让模型自行纠正，不 throw。
 */
import {
  AGENT_TOOL_DESCRIPTION, AGENT_GRAPH_DESCRIPTION,
  GRAPH_CLOSE_DESCRIPTION, GRAPH_REACTIVATE_DESCRIPTION,
} from './contract.js'
import { modelEnum } from './models.js'
import { searchHistory, getHistoryEvent } from './history-search.js'
import { cancelHandle } from './runner.js'

export const SUBAGENT_TOOL_NAMES = [
  'agent', 'agent_status', 'agent_cancel',
  'agent_graph', 'graph_start', 'graph_close', 'graph_reactivate',
  'send_message',
  'artifact_write', 'artifact_list',
  'history_search', 'history_get',
]

export function createSubagentTools(runtime) {
  return [
    {
      name: 'agent',
      description: AGENT_TOOL_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'A short (3-8 word) description of the task' },
          prompt: { type: 'string', description: 'The task for the agent to perform' },
          subagent_type: { type: 'string', description: 'The type of specialized agent to use for this task' },
          model: {
            type: 'string',
            enum: modelEnum(runtime.aliases),
            description: 'Optional model override. If omitted, uses the agent type\'s model, or inherits from the parent.',
          },
          run_in_background: {
            type: 'boolean',
            description: 'Agents run in the background by default; you will be notified when one completes. '
              + 'Set to false to run this agent synchronously when you need the result before continuing.',
          },
          isolation: {
            type: 'string',
            enum: ['worktree', 'remote'],
            description: 'Isolation mode. "worktree" gives the agent its own git worktree and branch, so '
              + 'agents working in parallel cannot overwrite each other\'s files; a worktree left clean is '
              + 'removed when the agent finishes, one with changes is kept and reported back to you. '
              + 'Requires a git repository whose worktree base directory is gitignored — you get a plain '
              + 'error back if that is not the case. Note that the working directory is communicated to '
              + 'the agent and to its tools, but honouring it is up to the host\'s tool implementations. '
              + '"remote" is not implemented.',
          },
        },
        required: ['description', 'prompt'],
        additionalProperties: false,
      },
      execute: async (params = {}, ctx = {}) => {
        const { description, prompt, subagent_type: subagentType, model, run_in_background: bg, isolation } = params
        if (typeof description !== 'string' || description.trim() === '') {
          return 'Error: `description` is required — a 3-8 word label for this task (not the task itself).'
        }
        if (typeof prompt !== 'string' || prompt.trim() === '') {
          return 'Error: `prompt` is required — it carries the entire task contract in natural language.'
        }
        if (isolation === 'remote') {
          return 'Error: isolation "remote" is not available (no non-local A2A transport is registered). '
            + 'Retry without the isolation parameter, or with isolation "worktree".'
        }
        return runtime.spawn({
          description,
          prompt,
          subagentType,
          model,
          isolation: isolation === 'worktree' ? { mode: 'worktree' } : null,
          background: bg !== false,
          depth: (ctx.depth ?? 0) + 1,
          parentAgentId: ctx.agentId ?? 'main',
          signal: ctx.signal,
        })
      },
    },

    {
      name: 'agent_status',
      description: 'List spawned agents and their current state. Use this to check on background agents '
        + 'before assuming anything about their results.',
      parameters: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'Inspect one agent by id or name' },
          include_finished: { type: 'boolean', description: 'Include agents that already finished' },
          include_graph: {
            type: 'boolean',
            description: 'Also print the dependency graph: every node, its state, and why it is blocked',
          },
          graph_id: {
            type: 'string',
            description: 'Which graph to print. Defaults to the one you are working in; pass "all" to list '
              + 'every graph you have, including closed ones. Implies include_graph.',
          },
        },
      },
      execute: async ({
        agent_id: agentId, include_finished: includeFinished = false, include_graph: includeGraph = false,
        graph_id: graphId,
      } = {}) => {
        const base = renderAgentStatus(runtime, { agentId, includeFinished })
        // 给了 graph_id 却什么图都不打印是个静默空操作 —— 它本身就是"我要看图"。
        if (!includeGraph && graphId == null) return base
        return `${base}\n\n--- graph ---\n${runtime.statusTable({ graphId })}`
      },
    },

    {
      name: 'agent_cancel',
      description: 'Cancel a running agent, or give up on a graph node. The agent stops at its next '
        + 'checkpoint and reports as cancelled. Cancelling a node also cancels whatever agent is running '
        + 'for it, and everything downstream of it then blocks (or is skipped, per its on_upstream_failure).',
      parameters: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'Agent id or name' },
          node_id: { type: 'string', description: 'Graph node id — give either this or agent_id' },
          graph_id: {
            type: 'string',
            description: 'Which graph the node_id belongs to. Defaults to the one you are working in.',
          },
          reason: { type: 'string', description: 'Why it is being cancelled' },
        },
      },
      execute: async ({
        agent_id: agentId, node_id: nodeId, graph_id: graphId, reason = 'cancelled by orchestrator',
      } = {}) => {
        if (!agentId && !nodeId) return 'Error: give either agent_id or node_id.'
        if (nodeId) {
          // 节点路径统一走 `_cancelNode`：它负责把节点上在跑的 agent 也
          // cancelHandle 掉（光改图状态的话那个 agent 还在烧 token）。
          const cancelled = runtime._cancelNode(nodeId, reason, { graphId })
          if (!cancelled.ok) return `Error: ${cancelled.reason}`
          return `node ${nodeId} cancelled (${reason}).`
        }
        const handle = runtime.registry.get(agentId)
        if (!handle) return `Error: agent "${agentId}" not found.`
        if (handle.isTerminal()) return `agent ${handle.name} already finished (${handle.state}); nothing to cancel.`
        // 立刻把 handle 转到 cancelled，而不是只 abort 底层 controller：否则 abort
        // 传导进子 agent 变成一次异常，被 runner 的重试循环当成普通失败分类，
        // 这个工具自己的 description 说"reports as cancelled"就成了假话
        // （state 最终落在 failed）。cancelHandle 同时也是 runtime.close() 用的
        // 同一条路径，两者对 abort() 的用法不再分叉。
        cancelHandle(handle, {
          reason,
          emit: (type, payload) => runtime.parent.emit(type, payload),
          // 它若正阻塞在 ask_user 上，光 abort 是叫不停的 —— 见 cancelHandle。
          ask: runtime.ask,
        })
        return `agent ${handle.name} cancellation requested (${reason}).`
      },
    },

    {
      name: 'agent_graph',
      description: AGENT_GRAPH_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          nodes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                node_id: { type: 'string' },
                depends_on: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Node ids this one waits for. They must already exist or be in this same call.',
                },
                description: { type: 'string', description: 'A short (3-8 word) label' },
                prompt: { type: 'string', description: 'Required only for on_ready "auto"' },
                subagent_type: { type: 'string' },
                model: { type: 'string', enum: modelEnum(runtime.aliases) },
                on_ready: {
                  type: 'string',
                  enum: ['confirm', 'auto'],
                  description: 'Default "confirm": you get the upstream results and write the prompt then. '
                    + '"auto" launches with the prompt declared here.',
                },
                on_upstream_failure: {
                  type: 'string',
                  enum: ['block', 'skip'],
                  description: 'Default "block": the node waits for you to decide. "skip" abandons it.',
                },
              },
              required: ['node_id', 'description'],
            },
          },
          max_concurrent: { type: 'number' },
          graph_id: {
            type: 'string',
            description: 'Add these nodes to an existing graph. Omit to use the graph you are currently '
              + 'working in (one is started for you if you have none).',
          },
          label: {
            type: 'string',
            description: 'A name for the task this graph tracks. Declaring with a label you have used before '
              + 'adds to that same graph; a new label starts a separate one, so unrelated tasks keep '
              + 'independent node_id namespaces and separate status listings.',
          },
        },
        required: ['nodes'],
      },
      execute: async ({
        nodes, max_concurrent: maxConcurrent, graph_id: graphId, label,
      } = {}) => {
        const resolved = resolveDeclareTarget(runtime, { graphId, label })
        if (!resolved.ok) return `Error: ${resolved.reason}`
        const { entry } = resolved
        try {
          const { accepted } = entry.graph.declare(nodes, { maxConcurrent })
          // 声明成功才切活跃图：一批被拒的声明不该顺手换掉工作现场。（新开的图是
          // 例外 —— `newGraph` 自己就置活跃，那张空图留着给模型重试。）
          runtime.activeGraphId = entry.graphId
          return `declared ${accepted.length} node(s) in graph ${entry.graphId}: ${accepted.join(', ')}\n`
            + runtime.statusTable({ graphId: entry.graphId })
        } catch (err) {
          // 整批被拒（环、未知依赖、重名、缺 description……）。返回可纠正的说明，
          // 图上不会留下半个声明。
          return `Error: ${err.message}`
        }
      },
    },

    {
      name: 'graph_start',
      description: 'Start a graph node that is ready, giving it its final task contract. This is where you '
        + 'write the prompt — after seeing what upstream produced, not before.',
      parameters: {
        type: 'object',
        properties: {
          node_id: { type: 'string' },
          graph_id: {
            type: 'string',
            description: 'Which graph the node belongs to. Defaults to the one you are working in.',
          },
          prompt: { type: 'string', description: 'The full task contract for this node' },
          subagent_type: { type: 'string' },
          model: { type: 'string', enum: modelEnum(runtime.aliases) },
          run_in_background: { type: 'boolean' },
        },
        required: ['node_id', 'prompt'],
      },
      execute: async ({
        node_id: nodeId, graph_id: graphId, prompt, subagent_type: subagentType, model,
        run_in_background: bg,
      } = {}, ctx = {}) => {
        if (typeof nodeId !== 'string' || nodeId.trim() === '') {
          return 'Error: `node_id` is required — the id of the node you declared with agent_graph.'
        }
        // prompt 可以省（省了就用声明时带的那份），但给了就必须是一段真话 ——
        // 放行一个非字符串会让它被 String() 塞进契约正文。
        if (prompt != null && (typeof prompt !== 'string' || prompt.trim() === '')) {
          return 'Error: `prompt` must be this node\'s full task contract in natural language.'
        }
        // 只查不建：`graph_start` 打的是一个已经声明过的节点，凭它凭空造出一张
        // 空图毫无意义。
        const resolved = runtime._lookupGraph(graphId)
        if (!resolved.ok) return `Error: ${resolved.reason}`
        const { entry } = resolved
        // 多图之后 node_id 可以跨图重名，所以"不在这张图里"要点名到底哪张图有它
        // —— `graph.start` 自己只会说 not found，模型没法据此纠正。
        if (!entry.graph.nodes.has(nodeId)) {
          return `Error: ${runtime._nodeNotHereReason(nodeId, entry)}`
        }
        const started = entry.graph.start(nodeId, { prompt, subagent_type: subagentType, model })
        if (!started.ok) return `Error: ${started.reason}`
        return runtime._startNode(started.node, {
          graphId: entry.graphId, background: bg !== false, signal: ctx.signal,
        })
      },
    },

    {
      name: 'graph_close',
      description: GRAPH_CLOSE_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          graph_id: {
            type: 'string',
            description: 'Which graph to close. Defaults to the one you are working in.',
          },
          disposition: {
            type: 'string',
            enum: ['cancel_outstanding', 'keep_running'],
            description: 'What to do with nodes that have not finished. If any node is still '
              + 'outstanding, ask the user which of these two to use before you call this.',
          },
          reason: { type: 'string', description: 'Why the task is being closed out' },
        },
        required: ['disposition'],
      },
      execute: async ({ graph_id: graphId, disposition, reason } = {}) => {
        // `disposition ?? null`，不是原样透传：`closeGraph` 的入参默认值是
        // `keep_running`（宿主直接调 `closeGraph(id)` 时"只标记"是对的），而
        // `undefined` 会命中那个默认值 —— 模型漏填这个必填项就会静默关掉一张图，
        // 连它有没有未完成节点都没被摆到它面前。传 `null` 绕开默认值，让
        // `closeGraph` 那一条校验（列出两个可选值）成为唯一的出处。
        const closed = runtime.closeGraph(graphId ?? null, {
          reason: reason ?? null, disposition: disposition ?? null,
        })
        if (!closed.ok) return `Error: ${closed.reason}`
        const { entry, cancelled, stoppedAgents, outstanding } = closed
        const label = entry.label ? ` ${JSON.stringify(entry.label)}` : ''
        const lines = [`graph ${entry.graphId}${label} closed (${disposition}${reason ? `: ${reason}` : ''}).`]
        if (disposition === 'cancel_outstanding') {
          // 节点数不当 agent 数报：blocked / awaiting_confirm 的节点压根没起 agent，
          // 说"agent 都停了"会让模型向用户转述一件没发生的事。
          lines.push(cancelled.length > 0
            ? `Cancelled ${cancelled.length} unfinished node(s): ${cancelled.join(', ')}`
              + `${stoppedAgents > 0 ? ` — ${stoppedAgents} running agent(s) stopped.` : '; none of them had an agent running.'}`
            : 'Nothing was outstanding — no node had to be cancelled.')
        } else if (outstanding.length > 0) {
          lines.push(`${outstanding.length} node(s) left running: ${outstanding.join(', ')}. `
            + 'You will still be notified as they finish, and they still count as work in flight.')
        }
        lines.push('You have no active graph now: your next agent_graph call without a graph_id '
          + 'starts a fresh one.')
        // `closeGraph` 末尾会跑一次 FIFO 淘汰，超出 `retainClosedGraphs` 时这张图可能
        // 当场就被整张淘汰了 —— 那时候告诉模型"还查得到"就是假话。
        if (runtime.graphs.has(entry.graphId)) {
          lines.push('This graph can still be inspected with agent_status graph_id "all", and its '
            + 'nodes can still be reactivated.')
        } else {
          lines.push('This graph has been dropped from the status listing (only the most recent '
            + `closed graphs are kept), so ${entry.graphId} can no longer be inspected or reactivated.`)
        }
        return lines.join('\n')
      },
    },

    {
      name: 'graph_reactivate',
      description: GRAPH_REACTIVATE_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          graph_id: {
            type: 'string',
            description: 'Which graph the nodes belong to. Defaults to the one you are working in; '
              + 'a closed graph reopens when you reactivate a node in it.',
          },
          node_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Every node whose finished work is now out of date — not only the one the '
              + 'user pointed at. Nodes not listed here keep their old results.',
          },
          reason: { type: 'string', description: 'What changed, and why this work is now stale' },
        },
        required: ['node_ids'],
      },
      execute: async ({ graph_id: graphId, node_ids: nodeIds, reason } = {}) => {
        const out = runtime.reactivateNodes({ graphId, nodeIds, reason: reason ?? null })
        if (!out.ok) return `Error: ${out.reason}`
        if (out.reactivated.length === 0) {
          return `Error: nothing was reactivated.\n${renderSkipped(out.skipped)}`
        }
        return renderReactivation(out)
      },
    },

    {
      name: 'send_message',
      description: 'Send a message to another agent. The message does not interrupt what that agent is '
        + 'doing — it lands in its context at its next round boundary. Sending to an agent that already '
        + 'finished resumes it with its context intact. Use "parent" for whoever spawned you, or "main" '
        + 'for the orchestrator.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Target agent id or name, or "parent" / "main"' },
          message: { type: 'string' },
          summary: { type: 'string', description: 'Optional 5-10 word preview for the UI' },
        },
        required: ['to', 'message'],
      },
      execute: async ({ to, message, summary } = {}, ctx = {}) =>
        runtime.sendMessage({
          to, body: message, summary,
          from: { agentId: ctx.agentId ?? 'main', name: ctx.agentName ?? 'main' },
        }),
    },

    {
      name: 'artifact_write',
      description: 'Record an artifact you produced on the shared artifact track, so other agents can see '
        + 'who produced what. Recording is bookkeeping — it does not write the file for you.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Stable identifier, usually the file path' },
          kind: { type: 'string', enum: ['file', 'text', 'json', 'patch', 'url'] },
          summary: { type: 'string', description: 'One line: what this artifact is' },
          path: { type: 'string' },
          content: { type: 'string', description: 'Content, when the artifact is not a file on disk' },
          supersedes: { type: 'string', description: 'artifactId this replaces, when deliberately overwriting' },
        },
        required: ['key', 'summary'],
      },
      execute: async (params = {}, ctx = {}) => {
        const { ok, record, conflict } = runtime.artifacts.write({
          ...params,
          kind: params.kind ?? 'text',
          agentId: ctx.agentId ?? 'main',
          agentName: ctx.agentName ?? 'main',
          nodeId: ctx.nodeId ?? null,
          attempt: ctx.attempt ?? 1,
        })
        if (!ok) {
          runtime.parent.emit('artifact.conflict', { key: params.key, owner: conflict.ownerAgentName, policy: 'deny' })
          return `Refused: artifact key "${params.key}" is owned by ${conflict.ownerAgentName} `
            + `(sha:${conflict.ownerSha}). Coordinate with them, or use a different key.`
        }
        runtime.parent.emit('artifact.write', {
          artifactId: record.artifactId, key: record.key, sha: record.sha, bytes: record.bytes,
          agentId: record.agentId, agentName: record.agentName,
        })
        if (conflict) {
          runtime.parent.emit('artifact.conflict', { key: record.key, owner: conflict.ownerAgentName, policy: 'warn' })
          return `recorded ${record.key} (sha:${record.sha}) — warning: the previous version belonged to `
            + `${conflict.ownerAgentName} (sha:${conflict.ownerSha}). If this was not a deliberate overwrite, coordinate first.`
        }
        return `recorded ${record.key} (sha:${record.sha}, id:${record.artifactId})`
      },
    },

    {
      name: 'artifact_list',
      description: 'List artifacts on the shared track, with who produced each one.',
      parameters: {
        type: 'object',
        properties: {
          agent_id: { type: 'string' },
          key: { type: 'string' },
          limit: { type: 'number' },
        },
      },
      execute: async ({ agent_id: agentId, key, limit } = {}) => {
        const rows = runtime.artifacts.list({ agentId, key, limit })
        if (rows.length === 0) return 'no artifacts recorded yet'
        return rows.map(r =>
          `${r.key} (sha:${r.sha}) by ${r.agentName}${r.attempt > 1 ? ` attempt=${r.attempt}` : ''} — ${r.summary}`,
        ).join('\n')
      },
    },

    {
      name: 'history_search',
      description: 'Search the full session history — every message from every agent, including content that '
        + 'has since been compacted out of the active context. Use this to recover project context instead of '
        + 'guessing, or when you were told something earlier that you no longer have.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Substring (default) or regular expression source' },
          regex: { type: 'boolean' },
          agent_id: { type: 'string', description: 'Restrict to one agent\'s messages' },
          role: { type: 'string', enum: ['user', 'assistant', 'tool', 'system'] },
          since: { type: 'number', description: 'Epoch ms lower bound' },
          until: { type: 'number', description: 'Epoch ms upper bound' },
          limit: { type: 'number', description: 'Max hits (default 20)' },
        },
        required: ['query'],
      },
      execute: async ({ query, regex, agent_id: agentId, role, since, until, limit } = {}) => {
        if (!runtime.sharedHistory) {
          return 'history search unavailable: this agent\'s memory implementation does not expose a RuntimeHistory.'
        }
        const hits = searchHistory(runtime.sharedHistory, { query, regex, agentId, role, since, until, limit })
        if (hits.length === 0) return `no match for ${JSON.stringify(query)}`
        return hits.map(h =>
          `[${h.eventId}] ${new Date(h.ts).toISOString()} ${h.agentId ?? 'main'}/${h.role}: ${h.snippet}`,
        ).join('\n')
      },
    },

    {
      name: 'history_get',
      description: 'Expand one history event found via history_search, with surrounding messages.',
      parameters: {
        type: 'object',
        properties: {
          event_id: { type: 'string' },
          before: { type: 'number', description: 'How many preceding events (max 10)' },
          after: { type: 'number', description: 'How many following events (max 10)' },
        },
        required: ['event_id'],
      },
      execute: async ({ event_id: eventId, before, after } = {}) => {
        if (!runtime.sharedHistory) return 'history unavailable for this memory implementation.'
        const got = getHistoryEvent(runtime.sharedHistory, { eventId, before, after })
        if (!got) return `Error: event "${eventId}" not found.`
        const render = (e) => {
          const body = e.type === 'summary' ? e.content : (e.message?.content ?? '')
          const role = e.type === 'summary' ? 'summary' : (e.message?.role ?? '?')
          return `[${e.id}] ${role}: ${body}`
        }
        return [...got.before.map(render), `>>> ${render(got.target)}`, ...got.after.map(render)].join('\n')
      },
    },
  ]
}

/** 被拒的节点逐条给理由 —— 模型只能靠这些话自我纠正。 */
function renderSkipped(skipped) {
  return skipped.map(s => `- ${s.reason}`).join('\n')
}

/**
 * 一次激活的返回值。**这段渲染本身是机制**：失效范围由模型决定，而模型手工挑节点
 * 会漏（它得靠记忆推断"谁消费过这份产物"，而它的上下文可能已被压缩过）。所以这里
 * 必须把它漏掉的摆出来，而且要让"没列进来"读起来是一个待确认的选择，不是一句可以
 * skim 过去的提示 —— 漏一个下游，那个下游就拿着过期认知继续跑，而且不报任何错。
 */
function renderReactivation({ entry, reactivated, skipped, reopened, staleKeys, downstream }) {
  const names = reactivated.map(r => `${r.nodeId} (generation ${r.generation})`).join(', ')
  const lines = [`reactivated ${reactivated.length} node(s) in graph ${entry.graphId}: ${names}.`]
  if (reopened) lines.push('That graph was closed; it is open again.')
  lines.push(`Graph ${entry.graphId} is now the one you are working in. Each reactivated node is back `
    + 'to waiting on its dependencies — give it a new contract with graph_start once it is ready.')
  if (skipped.length > 0) lines.push('', 'Not reactivated (unchanged):', renderSkipped(skipped))

  lines.push('', staleKeys.length > 0
    ? `Artifacts you just declared stale: ${staleKeys.join(', ')}.`
    : 'The reactivated nodes recorded no artifacts, so consumption cannot be checked key by key — '
      + 'treat every node below as a possible consumer.')

  if (downstream.length === 0) {
    lines.push('Nothing downstream: no other node depends on what you reactivated, so the '
      + 'invalidation stops here.')
    return lines.join('\n')
  }

  lines.push('', `Downstream of your selection — ${downstream.length} node(s):`)
  for (const row of downstream) {
    const what = row.consumedKeys.length > 0
      ? `read ${row.consumedKeys.join(', ')}`
      : (row.direct ? 'depends on a reactivated node' : `further downstream (via ${row.via.join(', ')})`)
    lines.push(`- ${row.nodeId} [${row.state}] ${what} — `
      + (row.reactivated ? 'reactivated in this call' : 'NOT reactivated'))
  }

  const left = downstream.filter(row => !row.reactivated).map(row => row.nodeId)
  if (left.length === 0) {
    lines.push('', 'Every downstream node is in this call, so nothing is left holding a stale result.')
    return lines.join('\n')
  }
  lines.push('', `Still to decide — not reactivated: ${left.join(', ')}. `
    + 'Each of those still holds a result produced from what you just declared out of date. '
    + 'Leaving one out is a decision that its work still holds despite the change; if that is not '
    + 'what you mean, call graph_reactivate again with those node_ids. Nothing else will raise this.')
  return lines.join('\n')
}

/**
 * `agent_graph` 的目标图选择。三条路，从最显式到最省事：
 *
 *   1. 给了 `graph_id` —— 就用它。**closed 的拒掉**：closed 图随时会被 FIFO
 *      淘汰，往里声明的节点会连带消失，那是个静默的丢活。（只在这里拦；查状态
 *      与取消一张 closed 图里的节点都必须照旧可行。）
 *   2. 给了 `label` —— label 就是任务名，"同一任务同一张可变图"：找一张同名的
 *      open 图接着往里加，没有就新开一张。
 *   3. 都没给 —— 活跃图，没有活跃图就新开一张。
 *
 * @returns {{ ok: true, entry: object } | { ok: false, reason: string }}
 */
function resolveDeclareTarget(runtime, { graphId, label }) {
  if (graphId != null) {
    const resolved = runtime._resolveGraph(graphId)
    if (!resolved.ok) return resolved
    if (resolved.entry.state === 'closed') {
      return {
        ok: false,
        reason: `graph "${graphId}" is closed and no longer takes new nodes. `
          + 'Omit graph_id to declare into a fresh graph, or pass a label to name it.',
      }
    }
    return resolved
  }
  if (typeof label === 'string' && label.trim() !== '') {
    const match = [...runtime.graphs.values()].find(e => e.state === 'open' && e.label === label)
    return { ok: true, entry: match ?? runtime.newGraph({ label }) }
  }
  return runtime._resolveGraph(null)
}

/**
 * `agent_status` 的 agent 部分。独立成函数是因为 `include_graph` 必须能追加到
 * **每一条**返回路径后面（单个 agent 的 JSON、空列表、列表），内联写会漏掉早返回。
 */
function renderAgentStatus(runtime, { agentId, includeFinished }) {
  if (agentId) {
    const handle = runtime.registry.get(agentId)
    if (!handle) return `Error: agent "${agentId}" not found.`
    return JSON.stringify(handle.toStatus(), null, 2)
  }
  const handles = runtime.registry.list({ includeFinished })
  if (handles.length === 0) return 'no active agents (0 running, 0 queued)'
  const lines = handles.map(h =>
    `${h.name} [${h.state}] type=${h.type} model=${h.model?.alias ?? 'inherited'} `
    + `attempt=${h.attempt} — ${h.description}`)
  return `${handles.length} agent(s):\n${lines.join('\n')}`
}
