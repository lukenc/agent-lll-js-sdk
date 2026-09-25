/**
 * 图片元信息 —— 全部从 URL 纯函数推导,不存进消息。
 *
 * 消息里因此没有任何私有字段,也就不存在"出站忘了剥字段 → 供应商 400"。
 * 零依赖、不 import Node 内置模块(浏览器包要干净):base64 用全局 atob。
 */

export const SUPPORTED_IMAGE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** JPEG 的 SOF 可能被很大的 EXIF 推远;扫描上限之外记为尺寸未知(按兜底值计价,不影响发送)。 */
export const JPEG_SCAN_LIMIT = 256 * 1024

const HEADER_BYTES = 64
const DATA_URL_RE = /^data:([^;,]*)((?:;[^;,]*)*),/i
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

export function parseDataUrl(url) {
  if (typeof url !== 'string') return null
  const m = DATA_URL_RE.exec(url.slice(0, 256))
  if (!m) return null
  if (!m[2].toLowerCase().split(';').includes('base64')) return null
  return { mediaType: m[1].toLowerCase(), base64: url.slice(m[0].length) }
}

export function base64ByteLength(b64) {
  if (!b64) return 0
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.floor(b64.length * 3 / 4) - pad
}

/** 只解码开头 `maxBytes` 字节。非法 base64 返回空数组,永不抛。 */
export function decodeBase64Prefix(b64, maxBytes) {
  const chars = Math.min(b64.length, Math.ceil(maxBytes / 3) * 4)
  let bin
  try {
    bin = atob(b64.slice(0, chars - (chars % 4)))
  } catch {
    return new Uint8Array(0)
  }
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function ascii(b, off, n) {
  let s = ''
  for (let i = off; i < off + n && i < b.length; i++) s += String.fromCharCode(b[i])
  return s
}

export function sniffMediaType(b) {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 6 && ascii(b, 0, 4) === 'GIF8') return 'image/gif'
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'image/webp'
  return null
}

function u32be(b, o) {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
}

function webpDimensions(b) {
  if (b.length < 30) return null
  const kind = ascii(b, 12, 4)
  if (kind === 'VP8X') {
    return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) }
  }
  if (kind === 'VP8L') {
    return {
      width: 1 + (((b[22] & 0x3f) << 8) | b[21]),
      height: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)),
    }
  }
  if (kind === 'VP8 ') {
    return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff }
  }
  return null
}

function jpegDimensions(b) {
  let i = 2
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null
    const marker = b[i + 1]
    if (marker === 0xff) { i += 1; continue }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
    if (SOF_MARKERS.has(marker)) {
      if (i + 8 >= b.length) return null
      return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] }
    }
    i += 2 + ((b[i + 2] << 8) | b[i + 3])
  }
  return null
}

export function readDimensions(bytes, mediaType) {
  switch (mediaType) {
    case 'image/png': return bytes.length >= 24 ? { width: u32be(bytes, 16), height: u32be(bytes, 20) } : null
    case 'image/gif': return bytes.length >= 10 ? { width: bytes[6] | (bytes[7] << 8), height: bytes[8] | (bytes[9] << 8) } : null
    case 'image/webp': return webpDimensions(bytes)
    case 'image/jpeg': return jpegDimensions(bytes)
    default: return null
  }
}

/**
 * FNV-1a 短摘要 —— 只为占位文本的确定性服务(同一张图每次渲染出同一段占位,
 * prompt cache 前缀才稳定),不承担安全语义。大 URL 只取「长度 + 头尾各 4 KB」。
 * 不用 WebCrypto:Node 18 不保证全局 crypto,且 SHA-256 是异步的。
 */
export function shortDigest(url) {
  const s = url.length > 8192 ? `${url.length}:${url.slice(0, 4096)}${url.slice(-4096)}` : `${url.length}:${url}`
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0')
}

const EMPTY = Object.freeze({ mediaType: null, width: null, height: null, bytes: null, digest: '00000000', inline: false })
const CACHE_MAX = 256
const cache = new Map()

function computeMeta(url, digest) {
  const parsed = parseDataUrl(url)
  if (!parsed) return Object.freeze({ mediaType: null, width: null, height: null, bytes: null, digest, inline: false })
  const head = decodeBase64Prefix(parsed.base64, HEADER_BYTES)
  const mediaType = sniffMediaType(head) ?? parsed.mediaType
  const probe = mediaType === 'image/jpeg' ? decodeBase64Prefix(parsed.base64, JPEG_SCAN_LIMIT) : head
  const dims = readDimensions(probe, mediaType)
  return Object.freeze({
    mediaType,
    width: dims?.width || null,
    height: dims?.height || null,
    bytes: base64ByteLength(parsed.base64),
    digest,
    inline: true,
  })
}

/** 永不抛。一次请求里同一张图会被计价、投影、渲染多次,所以按 `长度:摘要` 缓存。 */
export function imageMeta(url) {
  if (typeof url !== 'string' || url.length === 0) return EMPTY
  const digest = shortDigest(url)
  const key = `${url.length}:${digest}`
  const hit = cache.get(key)
  if (hit) return hit
  const meta = computeMeta(url, digest)
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value)
  cache.set(key, meta)
  return meta
}

export function describeImage(meta) {
  if (!meta.inline) return `url #${meta.digest}`
  const kind = meta.mediaType?.startsWith('image/') ? meta.mediaType.slice(6) : 'image'
  const size = meta.width && meta.height ? `${meta.width}×${meta.height}` : '?×?'
  return `${kind} ${size} #${meta.digest}`
}
