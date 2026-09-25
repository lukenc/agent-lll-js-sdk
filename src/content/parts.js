/**
 * Content parts —— 内部消息沿用 OpenAI chat completions 的 content parts：
 *
 *   { role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url, detail? } }] }
 *
 * **唯一新增的形状不变量：无图 ⇒ `content` 是字符串。** 入口把纯文本数组折叠成
 * 字符串，于是"`content` 是数组 ⇔ 至少一张图"，纯文本会话与改动前逐字节相同。
 */

import { InvalidContentError } from './errors.js'
import {
  imageMeta, describeImage, parseDataUrl, base64ByteLength, decodeBase64Prefix,
  sniffMediaType, SUPPORTED_IMAGE_TYPES,
} from './image-meta.js'

export const CONTENT_RESULT = Symbol.for('lll.contentResult')
export const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/
const DETAILS = new Set(['low', 'high', 'auto'])

export function normalizeMaxImageBytes(value) {
  if (value === undefined) return DEFAULT_MAX_IMAGE_BYTES
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('maxImageBytes must be a positive integer (bytes)')
  return value
}

export function hasImage(content) {
  return Array.isArray(content) && content.some(p => p?.type === 'image_url')
}

export function partsText(parts) {
  if (!Array.isArray(parts)) return ''
  return parts.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n')
}

export function imageParts(parts) {
  return Array.isArray(parts) ? parts.filter(p => p?.type === 'image_url') : []
}

/**
 * 文本投影：给只收文本的调用方（摘要、意图识别、技能过滤、历史检索）用。
 * 字符串原样返回（纯文本会话逐字节不变）；非字符串非数组返回 ''。永不抛。
 */
export function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const out = []
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') {
      if (part.text) out.push(part.text)
    } else if (part?.type === 'image_url') {
      out.push(`[image ${describeImage(imageMeta(part.image_url?.url))}]`)
    }
  }
  return out.join('\n')
}

function imageUrlPart(url, detail) {
  return { type: 'image_url', image_url: { url, ...(DETAILS.has(detail) ? { detail } : {}) } }
}

function normalizePart(part, partIndex, maxImageBytes) {
  if (part?.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text }
  if (part?.type !== 'image_url') throw new InvalidContentError({ code: 'bad_part_type', partIndex })
  const url = part.image_url?.url
  const detail = part.image_url?.detail
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) return imageUrlPart(url, detail)
  const parsed = parseDataUrl(url)
  if (!parsed) throw new InvalidContentError({ code: 'bad_url_scheme', partIndex })
  if (!SUPPORTED_IMAGE_TYPES.includes(parsed.mediaType)) {
    throw new InvalidContentError({ code: 'unsupported_media_type', partIndex, mediaType: parsed.mediaType })
  }
  if (parsed.base64.length === 0 || parsed.base64.length % 4 !== 0 || !BASE64_RE.test(parsed.base64)) {
    throw new InvalidContentError({ code: 'bad_base64', partIndex })
  }
  const bytes = base64ByteLength(parsed.base64)
  if (bytes > maxImageBytes) {
    throw new InvalidContentError({ code: 'image_too_large', partIndex, bytes, maxBytes: maxImageBytes })
  }
  const canonical = `data:${parsed.mediaType};base64,`
  return imageUrlPart(url.startsWith(canonical) ? url : canonical + parsed.base64, detail)
}

/**
 * 校验并规范化消息内容。非数组原样返回（`chat('hi')` 的行为逐字节不变）。
 * 数组逐部件校验（抛 InvalidContentError），只保留已知字段；无图时折叠成字符串。
 */
export function normalizeContent(content, { maxImageBytes = Infinity } = {}) {
  if (!Array.isArray(content)) return content
  const parts = content.map((part, partIndex) => normalizePart(part, partIndex, maxImageBytes))
  return parts.some(p => p.type === 'image_url') ? parts : parts.map(p => p.text).join('\n')
}

function bytesToBase64(bytes) {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  }
  return btoa(bin)
}

function toDataUrl(base64, mediaType) {
  const type = mediaType ?? sniffMediaType(decodeBase64Prefix(base64, 64))
  if (!type) throw new InvalidContentError({ code: 'unsupported_media_type', partIndex: 0 })
  return `data:${String(type).toLowerCase()};base64,${base64}`
}

/**
 * 构造一个图片部件。同步、零依赖、Node/浏览器通用。
 * @param {string|Uint8Array|ArrayBuffer} source data URL、http(s) URL、裸 base64 或字节
 * @param {{ mediaType?: string, detail?: 'low'|'high'|'auto' }} [opts]
 */
export function imagePart(source, { mediaType, detail } = {}) {
  let url
  if (typeof source === 'string' && /^(data:|https?:\/\/)/i.test(source)) {
    url = source
  } else if (typeof source === 'string') {
    url = toDataUrl(source.replace(/\s+/g, ''), mediaType)
  } else if (source instanceof Uint8Array || source instanceof ArrayBuffer) {
    const bytes = source instanceof ArrayBuffer ? new Uint8Array(source) : source
    url = toDataUrl(bytesToBase64(bytes), mediaType)
  } else {
    throw new InvalidContentError({ code: 'bad_part_type', partIndex: 0 })
  }
  return imageUrlPart(url, detail)
}

/**
 * 工具返回图片的**显式**包装。今天工具返回数组会被 JSON.stringify —— 很多工具
 * 就是返回 JSON 数组 —— 所以"返回数组即 parts"会破坏既有工具。识别只看 Symbol
 * 标记；`type`/`parts` 两个普通字段让它经 JSON（SSE、HTTP 代理）往返后仍可被宿主
 * 用 `contentResult(obj.parts)` 重新包装。
 */
export function contentResult(parts) {
  if (!Array.isArray(parts)) throw new TypeError('contentResult(parts): parts must be an array of content parts')
  return { [CONTENT_RESULT]: true, type: 'content_result', parts }
}

export function isContentResult(value) {
  return value != null && typeof value === 'object' && value[CONTENT_RESULT] === true
}

/** 遥测的 `bytes` 口径：contentResult 只计文本部件；其余与改动前的 `String(result)` 相同。 */
export function toolResultText(result) {
  return isContentResult(result) ? partsText(result.parts) : String(result)
}
