/**
 * 把子 agent 的消息**单向镜像**进父 agent 的 RuntimeHistory，让
 * `history_search` 能检索整个会话（含所有 subagent 的轨迹），而子 agent 自己
 * 仍持有独立的 memory（不继承父上下文）。
 *
 * `memory.js` 零改动 —— 这里用代理对象包一层。
 */

export function agentTrackName(agentId) {
  return `agent:${agentId}`
}

function isSummaryMessage(message) {
  return message?.role === 'system' && message._isSummary === true
}

/**
 * @param {object} inner 真正的 memory 实例
 * @param {{ sharedHistory: object|null, agentId: string }} opts
 * @returns {object} 与 `inner` 接口一致的代理
 */
export function wrapMemoryForMirror(inner, { sharedHistory, agentId }) {
  if (!sharedHistory) return inner

  const tracks = ['all', 'internal', agentTrackName(agentId)]

  const mirror = (message) => {
    try {
      if (isSummaryMessage(message)) {
        // 必须显式走 appendSummary：appendMessage 的摘要分支不透传 meta.tracks，
        // tracks 会落回默认值 ['all','model','internal'] —— 子 agent 的摘要就
        // 泄进 model 轨了。当前它只是靠 projectMessages 的 topicId 过滤侥幸不
        // 出事，那是隐式依赖，不能指望。
        sharedHistory.appendSummary({
          content: String(message.content ?? '').replace(/^\[Previous conversation summary\]:\s*/, ''),
          sourceEventIds: [],
          topicId: agentId,
          tracks,
        })
        return
      }
      sharedHistory.appendMessage(message, { topicId: agentId, tracks })
    } catch (err) {
      // 镜像是可观测性设施，不是子 agent 的关键路径。写不进去就算了，
      // 绝不能让它把子 agent 的 memory.add 打断。
      console.warn(`[agents] history mirror failed for ${agentId}:`, err?.message || err)
    }
  }

  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'add') {
        return (message) => {
          const out = target.add(message)
          mirror(message)
          return out
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
