/**
 * 出站投影 —— 只作用于本次请求的副本，永不修改 memory。
 *
 *   A. projectHistoryImages：计价/裁剪**之前**。文本投影兜底 + 超限按量子卸载最老的图。
 *      必须先于计价：计价看到的必须就是实际发出的东西。
 *   B. toWireMessages：组装完成、写进 body 之前。tool 消息里的图拆成随后的一条 user 消息
 *      （OpenAI chat completions 的 tool 消息只收文本）。
 *
 * 移植自 deepseek-harness `dsh-llm/content.ts`（offloadRequestImagesWithPolicy）与
 * `dsh-llm-deepseek/serialize.ts`（serializeMessagesWithImages），MIT。
 */

import { UnsupportedContentError } from './errors.js'
import { imageMeta, describeImage } from './image-meta.js'
import { hasImage, imageParts, partsText } from './parts.js'

const MiB = 1024 * 1024

/** 20 MiB 取自 dsh 的内联 base64 默认值（DEFAULT_MAX_INLINE_REQUEST_IMAGE_BYTES）。 */
export const DEFAULT_IMAGE_LIMITS = Object.freeze({ maxImages: 20, maxBytes: 20 * MiB, countQuantum: 5, byteQuantum: 10 * MiB })

export const TOOL_IMAGE_LABEL = 'Attached image(s) from tool result:'

function positiveInt(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`imageLimits.${name} must be a positive integer`)
  return value
}

export function normalizeImageLimits(limits) {
  if (limits == null) return DEFAULT_IMAGE_LIMITS
  if (typeof limits !== 'object') throw new TypeError('imageLimits must be an object')
  const maxImages = positiveInt(limits.maxImages ?? DEFAULT_IMAGE_LIMITS.maxImages, 'maxImages')
  const maxBytes = positiveInt(limits.maxBytes ?? DEFAULT_IMAGE_LIMITS.maxBytes, 'maxBytes')
  const countQuantum = positiveInt(limits.countQuantum ?? Math.min(DEFAULT_IMAGE_LIMITS.countQuantum, maxImages), 'countQuantum')
  const byteQuantum = positiveInt(limits.byteQuantum ?? Math.min(DEFAULT_IMAGE_LIMITS.byteQuantum, maxBytes), 'byteQuantum')
  if (countQuantum > maxImages) throw new TypeError('imageLimits.countQuantum must not exceed maxImages')
  if (byteQuantum > maxBytes) throw new TypeError('imageLimits.byteQuantum must not exceed maxBytes')
  return Object.freeze({ maxImages, maxBytes, countQuantum, byteQuantum })
}

/**
 * 需要卸载的最老图片数。待移除量向上取整到量子倍数 —— 每轮只挤掉一张会让前缀
 * 每轮都变、prompt cache 每轮失效；按量子成批移除，被移除的前缀在历史再增长一个
 * 量子之前保持不变。逐行对齐 dsh `offloadedImagePrefixCount`（含 `>` 的边界约定）。
 */
export function offloadedPrefixCount(lengths, { maxImages, maxBytes, countQuantum = 1, byteQuantum = 1 } = {}) {
  const total = lengths.reduce((sum, bytes) => sum + bytes, 0)
  const excessCount = maxImages == null ? 0 : Math.max(0, lengths.length - maxImages)
  const excessBytes = maxBytes == null ? 0 : Math.max(0, total - maxBytes)
  if (excessCount === 0 && excessBytes === 0) return 0
  const removeCount = excessCount === 0 ? 0 : Math.ceil(excessCount / countQuantum) * countQuantum
  const removeBytes = excessBytes === 0 ? 0 : Math.ceil(excessBytes / byteQuantum) * byteQuantum
  let count = 0
  let removedBytes = 0
  for (const bytes of lengths) {
    const byteTargetMet = removeBytes === 0
      || (byteQuantum === 1 ? removedBytes >= removeBytes : removedBytes > removeBytes)
    if (count >= removeCount && byteTargetMet) break
    removedBytes += bytes
    count += 1
  }
  return count
}

function inlineLength(part) {
  const url = part.image_url?.url
  return typeof url === 'string' && url.startsWith('data:') ? url.length : 0
}

function replaceOldestImages(messages, count, placeholder) {
  let remaining = count
  return messages.map((m) => {
    if (remaining <= 0 || !hasImage(m?.content)) return m
    let changed = false
    const parts = m.content.map((p) => {
      if (p?.type !== 'image_url' || remaining <= 0) return p
      remaining -= 1
      changed = true
      return { type: 'text', text: placeholder(imageMeta(p.image_url?.url)) }
    })
    if (!changed) return m
    return { ...m, content: parts.some(p => p.type === 'image_url') ? parts : partsText(parts) }
  })
}

/**
 * @param {object[]} messages
 * @param {{ vision?: boolean, imageLimits?: object }} opts
 * @returns {object[]} 无变化时为同一引用
 */
export function projectHistoryImages(messages, { vision, imageLimits = DEFAULT_IMAGE_LIMITS } = {}) {
  if (!Array.isArray(messages) || !messages.some(m => hasImage(m?.content))) return messages
  // 兜底：正常流程被入口与工具两道闸挡住走不到这里。选投影而非抛错 —— 否则一张旧图
  // 就能让会话永久不可用（与 dsh LlmRuntime 的 projectImagesForTextModel 同位）。
  if (vision !== true) {
    return replaceOldestImages(messages, Infinity, meta => `[image omitted: model accepts text only; ${describeImage(meta)}]`)
  }
  const lengths = []
  for (const m of messages) for (const p of imageParts(m?.content)) lengths.push(inlineLength(p))
  const count = offloadedPrefixCount(lengths, imageLimits)
  if (count === 0) return messages
  return replaceOldestImages(messages, count, meta => `[image omitted to fit request image limits; ${describeImage(meta)}]`)
}

/**
 * @param {object[]} messages 组装完成的请求消息
 * @returns {object[]} 无图时为同一引用
 */
export function toWireMessages(messages) {
  if (!Array.isArray(messages) || !messages.some(m => hasImage(m?.content))) return messages
  const out = []
  let pending = []
  const flush = () => {
    if (pending.length === 0) return
    out.push({ role: 'user', content: [{ type: 'text', text: TOOL_IMAGE_LABEL }, ...pending] })
    pending = []
  }
  for (const m of messages) {
    if (m?.role === 'tool') {
      if (Array.isArray(m.content)) {
        out.push({ ...m, content: partsText(m.content) || '(no output)' })
        pending.push(...imageParts(m.content))
      } else {
        out.push(m)
      }
      continue
    }
    flush()
    if ((m?.role === 'assistant' || m?.role === 'system') && hasImage(m.content)) {
      throw new UnsupportedContentError({ code: 'image_in_role', role: m.role })
    }
    out.push(m)
  }
  flush()
  return out
}
