/** 进程内 transport：按 agentId 路由到目标 mailbox。 */
import { _setBuiltinTransport, encodeEnvelope, decodeEnvelope } from './index.js'

export function createLocalTransport({ mailbox, registry }) {
  return {
    name: 'local',
    /**
     * 即使同进程也走 encode/decode —— 形状错误要在本地暴露。
     * @returns {{ ok: boolean, reason?: string }}
     */
    send(envelope) {
      const decoded = decodeEnvelope(encodeEnvelope(envelope))
      const targetId = decoded.params.to.agentId
      const handle = targetId === 'main' ? null : registry.get(targetId)
      if (targetId !== 'main' && !handle) return { ok: false, reason: 'unknown_target' }
      mailbox.deliver(decoded)
      return { ok: true }
    },
  }
}

_setBuiltinTransport('local', createLocalTransport)
