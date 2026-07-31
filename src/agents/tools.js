/**
 * subagent 系统的元工具。全部遵循本仓库的**软失败**风格：入参非法、类型未注册、
 * 目标不存在等情况返回说明字符串让模型自行纠正，不 throw。
 */
import { AGENT_TOOL_DESCRIPTION } from './contract.js'
import { modelEnum } from './models.js'
import { searchHistory, getHistoryEvent } from './history-search.js'

export const SUBAGENT_TOOL_NAMES = [
  'agent', 'agent_status', 'agent_cancel',
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
            description: 'Isolation mode. "worktree" gives the agent its own git worktree.',
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
        },
      },
      execute: async ({ agent_id: agentId, include_finished: includeFinished = false } = {}) => {
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
      },
    },

    {
      name: 'agent_cancel',
      description: 'Cancel a running agent. The agent stops at its next checkpoint and reports as cancelled.',
      parameters: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'Agent id or name' },
          reason: { type: 'string', description: 'Why it is being cancelled' },
        },
        required: ['agent_id'],
      },
      execute: async ({ agent_id: agentId, reason = 'cancelled by orchestrator' } = {}) => {
        const handle = runtime.registry.get(agentId)
        if (!handle) return `Error: agent "${agentId}" not found.`
        if (handle.isTerminal()) return `agent ${handle.name} already finished (${handle.state}); nothing to cancel.`
        handle._abort?.abort(reason)
        return `agent ${handle.name} cancellation requested (${reason}).`
      },
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
