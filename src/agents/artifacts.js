/**
 * 产物轨 —— 每个 agent 把自己的产出登记到共享的 RuntimeHistory `artifacts` 轨，
 * 记清楚谁产出了什么、什么时候、内容指纹是多少。
 *
 * **这是记账约定，不是强制隔离**：绕过 artifact_write、直接用 shell_exec 改
 * 文件的行为框架检测不到。
 *
 * **但它是跨 agent 安全的主方案，不是退路。** 目标环境包含浏览器，那里既没有
 * git worktree 也没有 shell_exec —— 归属记录加同 key 跨 agent 的 warn/deny 是
 * 唯一在 Node 与浏览器都成立、每个 agent 都能用的护栏。`isolation: 'worktree'`
 * （`isolation.js`）是 Node-only 的可选加强，已搁置为实验特性，不是"需要硬保证
 * 时的正解" —— 它在一半的目标环境里根本不存在。这一层的强度就是这套系统跨
 * agent 安全的实际上限。
 */
import { utf8ByteLength } from '../telemetry.js'
import { SubagentError } from './errors.js'

/**
 * FNV-1a 32 位哈希，输出 8 位十六进制。
 *
 * **用途是变更/冲突检测，不是加密**：抗碰撞性不足以做完整性校验，选它是因为
 * 零依赖且 Node 与浏览器同实现（node:crypto 浏览器没有，SubtleCrypto 是异步的）。
 * @param {string} str
 * @returns {string}
 */
export function fnv1a32(str) {
  let hash = 0x811c9dc5
  const s = String(str)
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

let SEQ = 0

export class ArtifactTrack {
  /**
   * @param {{ sharedHistory: object, policy?: 'warn'|'deny', now?: () => number }} opts
   * @throws {SubagentError} `policy` 不是 'warn' / 'deny' 时
   */
  constructor({ sharedHistory, policy = 'warn', now = () => Date.now() }) {
    // 非法值**抛**，不静默读成 'warn'。这条轨是跨 agent 安全的主方案（浏览器里既
    // 没有 worktree 也没有 shell_exec），把 `'DENY'` 或一个拼错的值降级成 warn，
    // 等于在调用方以为自己开了硬拦截的时候把唯一那道护栏关掉。与 `types.js` 对
    // 非法枚举的处理一致 —— 那是配置错误，不是可软失败的运行时输入。
    if (policy !== 'warn' && policy !== 'deny') {
      throw new SubagentError(
        `ArtifactTrack: policy must be "warn" or "deny" (got ${JSON.stringify(policy) ?? typeof policy})`,
      )
    }
    this.sharedHistory = sharedHistory
    this.policy = policy
    this._now = now
    /** @type {Map<string, object>} key → 最新记录 */
    this._latest = new Map()
    /** @type {object[]} 追加序 */
    this._records = []
  }

  latest(key) {
    return this._latest.get(key) ?? null
  }

  /**
   * @returns {{ ok: boolean, record: object|null,
   *             conflict: { ownerAgentId, ownerAgentName, ownerSha, ownerTs }|null }}
   */
  write({
    key, kind = 'text', summary = '', path = null, content = null, supersedes = null,
    agentId, agentName, nodeId = null, attempt = 1,
  }) {
    const previous = this._latest.get(key) ?? null
    const conflictingOwner = previous
      && previous.agentId !== agentId
      && supersedes !== previous.artifactId
    const conflict = conflictingOwner
      ? {
          ownerAgentId: previous.agentId,
          ownerAgentName: previous.agentName,
          ownerSha: previous.sha,
          ownerTs: previous.ts,
        }
      : null

    if (conflict && this.policy === 'deny') {
      return { ok: false, record: null, conflict }
    }

    SEQ = (SEQ + 1) >>> 0
    const record = {
      artifactId: `art_${SEQ.toString(16).padStart(6, '0')}`,
      key,
      agentId,
      agentName,
      nodeId,
      attempt,
      kind,
      path,
      sha: content != null ? fnv1a32(content) : fnv1a32(`path:${path ?? key}`),
      bytes: content != null ? utf8ByteLength(content) : null,
      summary,
      supersedes: supersedes ?? (previous ? previous.artifactId : null),
      ts: this._now(),
    }

    this._records.push(record)
    this._latest.set(key, record)
    try {
      this.sharedHistory?.appendArtifact?.(record)
    } catch (err) {
      console.warn('[agents] artifact track append failed:', err?.message || err)
    }
    return { ok: true, record, conflict }
  }

  list({ agentId, key, since, limit = 50 } = {}) {
    let out = this._records
    if (agentId != null) out = out.filter(r => r.agentId === agentId)
    if (key != null) out = out.filter(r => r.key === key)
    if (since != null) out = out.filter(r => r.ts >= since)
    return out.slice(0, limit).map(r => ({ ...r }))
  }
}
