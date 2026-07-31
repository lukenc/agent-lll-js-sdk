/**
 * SubagentRuntime —— 组装 subagent 系统的全部部件，并暴露给 `Agent` 的
 * 单一入口。`Agent` 只认这一个对象，不直接碰 registry / runner / graph。
 */
import { AgentRegistry } from './registry.js'
import { ArtifactTrack } from './artifacts.js'
import { SubagentRunner } from './runner.js'
import { resolveModelAliases, resolveModel } from './models.js'
import { getAgentType, listAgentTypes, registerAgentType } from './types.js'
import { createSubagentTools } from './tools.js'

export function createSubagentRuntime({
  parent,
  types = [],
  defaultType = 'general-purpose',
  maxConcurrent = 4,
  maxDepth = 2,
  modelAliases,
  retry = {},
  artifacts: artifactOpts = {},
  retainCompleted = 20,
  createAgent,
} = {}) {
  for (const type of types) registerAgentType(type)

  const sharedHistory = parent?.memory?.runtimeHistory ?? null
  const registry = new AgentRegistry({ maxConcurrent, retainCompleted })
  const artifacts = new ArtifactTrack({
    sharedHistory,
    policy: artifactOpts.policy ?? 'warn',
  })
  const aliases = resolveModelAliases(parent, modelAliases)
  const emit = (type, payload) => parent.emit(type, payload)

  const runner = new SubagentRunner({
    parent, registry, artifacts, sharedHistory, aliases,
    opts: { retry: { maxAttempts: retry.maxAttempts ?? 3, attemptTimeoutMs: retry.attemptTimeoutMs ?? 600000 }, maxDepth },
    emit,
    ...(createAgent ? { createAgent } : {}),
  })

  /** @type {Set<Promise<unknown>>} 在跑的后台任务 */
  const inflight = new Set()

  const runtime = {
    parent, registry, artifacts, runner, sharedHistory, aliases, defaultType, maxDepth,
    /** 供 `Agent` 注入的工具集 */
    tools: [],

    /** Level 1 清单：注入 system 消息，让模型知道 subagent_type 能填什么。 */
    typesNote() {
      const lines = listAgentTypes().map((t) => {
        const tools = t.tools === '*' ? 'all' : t.tools.join(', ')
        return `- ${t.name}: ${t.description} (model: ${t.model ?? 'inherited'}, tools: ${tools})`
      })
      return `Available agent types for the \`agent\` tool:\n${lines.join('\n')}`
    },

    /**
     * 起一个 subagent。`background: true` 时立即返回 started 行，结果稍后经
     * 轮边界注入（Task 10 接上）。
     */
    async spawn({
      description, prompt, subagentType, model, background = true, isolation = null,
      nodeId = null, inputs = [], depth = 1, parentAgentId = 'main', signal, onHandle,
    }) {
      const typeName = subagentType ?? defaultType
      const type = getAgentType(typeName)
      if (!type) {
        return `Error: unknown subagent_type "${typeName}". Available types: `
          + `${listAgentTypes().map(t => t.name).join(', ')}. Pick one of these and retry.`
      }
      let resolved
      try {
        resolved = resolveModel({ requested: model, type, aliases, parent })
      } catch (err) {
        return `Error: ${err.message}`
      }

      const handle = registry.create({
        type: typeName, description, parentAgentId, depth, nodeId,
        model: resolved, isolation,
      })
      // 图调度用它把 agentId 回填到节点。Task 16 会在这之后插入 worktree 创建。
      onHandle?.(handle)

      // 每个 agent 一个 AbortController，agent_cancel 就是 abort 它。父的 signal
      // 一旦 abort，子也跟着停。
      const controller = new AbortController()
      handle._abort = controller
      if (signal) {
        if (signal.aborted) controller.abort(signal.reason)
        else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
      }
      const childSignal = controller.signal

      const task = (async () => {
        const release = await registry.acquireSlot(depth, { signal: childSignal })
        try {
          return await runner.run(handle, { prompt, inputs, signal: childSignal })
        } finally {
          release()
        }
      })()

      if (!background) return task

      const tracked = task.then(
        (result) => { runtime._onBackgroundSettled(handle, result); return result },
        (err) => { runtime._onBackgroundSettled(handle, `[agent:${handle.name} failed] ${err?.message ?? err}`) },
      ).finally(() => inflight.delete(tracked))
      inflight.add(tracked)

      return `[agent:${handle.name} started] background; 完成后会通知你。用 agent_status 查看进度。`
    },

    /** Task 10 用注入替换掉这个默认实现。 */
    _onBackgroundSettled() {},

    hasPending() {
      return inflight.size > 0 || registry.list().length > 0
    },

    /** 等全部后台任务 settle。测试与 closeSubagents 用。 */
    async drain() {
      while (inflight.size > 0) await Promise.allSettled([...inflight])
    },

    async close() {
      for (const handle of registry.list()) {
        if (!handle.isTerminal()) {
          // 先 abort 再打标记：只 transition('cancelled') 不 abort 的话，在跑的
          // 后台 subagent 会继续跑到自然结束（drain 也就一直等着），而它结束时
          // 的 transition('succeeded') 从终态出发是非法迁移，被重试循环捕获后
          // 又被翻译成一次失败 —— handle 最终 state=cancelled 而
          // result.status=failed，自相矛盾。abort 不带 reason，好让子 agent 侧
          // 抛出的是标准 AbortError（failureKind 因此归类为 aborted）；取消原因
          // 走下面的事件 payload。
          handle._abort?.abort()
          handle.transition('cancelled')
          emit('agent.cancelled', {
            agentId: handle.agentId, agentName: handle.name,
            parentAgentId: handle.parentAgentId, reason: 'runtime closed',
          })
        }
      }
      await runtime.drain()
    },
  }

  runtime.tools = createSubagentTools(runtime)
  return runtime
}
