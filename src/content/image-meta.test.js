import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  imageMeta, describeImage, parseDataUrl, base64ByteLength, sniffMediaType,
  shortDigest, JPEG_SCAN_LIMIT, SUPPORTED_IMAGE_TYPES,
} from './image-meta.js'
import { UnsupportedContentError, InvalidContentError } from './errors.js'

const b64 = bytes => Buffer.from(bytes).toString('base64')
const dataUrl = (type, bytes) => `data:${type};base64,${b64(bytes)}`

function pngHeader(w, h) {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  b[24] = 8
  b[25] = 2
  return b
}
function gifHeader(w, h) {
  const b = Buffer.alloc(13)
  b.write('GIF89a', 0, 'ascii')
  b.writeUInt16LE(w, 6)
  b.writeUInt16LE(h, 8)
  return b
}
function webpHeader(kind, w, h) {
  const b = Buffer.alloc(30)
  b.write('RIFF', 0, 'ascii')
  b.writeUInt32LE(22, 4)
  b.write('WEBP', 8, 'ascii')
  b.write(kind, 12, 'ascii')
  if (kind === 'VP8X') {
    b.writeUIntLE(w - 1, 24, 3)
    b.writeUIntLE(h - 1, 27, 3)
  } else if (kind === 'VP8L') {
    b[20] = 0x2f
    b.writeUInt32LE(((w - 1) | ((h - 1) << 14)) >>> 0, 21)
  } else {
    b[23] = 0x9d; b[24] = 0x01; b[25] = 0x2a
    b.writeUInt16LE(w, 26)
    b.writeUInt16LE(h, 28)
  }
  return b
}
function jpeg(w, h, { app1Bytes = 0 } = {}) {
  const parts = [Buffer.from([0xff, 0xd8])]
  // APP1 单段上限 65533 字节负载,串多段把 SOF 推远(模拟大 EXIF)
  for (let left = app1Bytes; left > 0;) {
    const n = Math.min(left, 65533)
    const seg = Buffer.alloc(4 + n)
    seg[0] = 0xff; seg[1] = 0xe1
    seg.writeUInt16BE(n + 2, 2)
    parts.push(seg)
    left -= n
  }
  const sof = Buffer.alloc(19)
  sof[0] = 0xff; sof[1] = 0xc0
  sof.writeUInt16BE(17, 2)
  sof[4] = 8
  sof.writeUInt16BE(h, 5)
  sof.writeUInt16BE(w, 7)
  parts.push(sof, Buffer.from([0xff, 0xd9]))
  return Buffer.concat(parts)
}

describe('image-meta: dimensions', () => {
  it('PNG', () => {
    const m = imageMeta(dataUrl('image/png', pngHeader(640, 480)))
    assert.deepEqual([m.mediaType, m.width, m.height, m.inline], ['image/png', 640, 480, true])
  })
  it('GIF', () => {
    const m = imageMeta(dataUrl('image/gif', gifHeader(320, 200)))
    assert.deepEqual([m.mediaType, m.width, m.height], ['image/gif', 320, 200])
  })
  for (const kind of ['VP8X', 'VP8L', 'VP8 ']) {
    it(`WebP ${kind.trim()}`, () => {
      const m = imageMeta(dataUrl('image/webp', webpHeader(kind, 1000, 750)))
      assert.deepEqual([m.mediaType, m.width, m.height], ['image/webp', 1000, 750])
    })
  }
  it('JPEG (SOF after an APP1 segment)', () => {
    const m = imageMeta(dataUrl('image/jpeg', jpeg(1024, 768, { app1Bytes: 5000 })))
    assert.deepEqual([m.mediaType, m.width, m.height], ['image/jpeg', 1024, 768])
  })
  it('JPEG whose SOF lies beyond the scan limit → dimensions unknown, never throws', () => {
    const m = imageMeta(dataUrl('image/jpeg', jpeg(1024, 768, { app1Bytes: JPEG_SCAN_LIMIT + 1000 })))
    assert.equal(m.mediaType, 'image/jpeg')
    assert.equal(m.width, null)
    assert.equal(m.height, null)
    assert.match(describeImage(m), /^jpeg \?×\? #[0-9a-f]{8}$/)
  })
  it('magic bytes win over the declared media type', () => {
    assert.equal(imageMeta(dataUrl('image/jpeg', pngHeader(2, 3))).mediaType, 'image/png')
  })
})

describe('image-meta: other fields', () => {
  it('http(s) URLs are not inline and have no dimensions', () => {
    const m = imageMeta('https://example.com/a.png')
    assert.deepEqual([m.inline, m.mediaType, m.width, m.bytes], [false, null, null, null])
    assert.match(describeImage(m), /^url #[0-9a-f]{8}$/)
  })
  it('garbage input never throws', () => {
    for (const v of [undefined, null, 42, '', 'data:,hello', 'data:image/png;base64,@@@']) {
      assert.doesNotThrow(() => imageMeta(v))
    }
  })
  it('byte length from base64', () => {
    assert.equal(base64ByteLength('QQ=='), 1)
    assert.equal(base64ByteLength('QUI='), 2)
    assert.equal(base64ByteLength('QUJD'), 3)
    assert.equal(imageMeta(dataUrl('image/png', pngHeader(1, 1))).bytes, 33)
  })
  it('digest is stable per URL and differs across images', () => {
    const a = dataUrl('image/png', pngHeader(10, 10))
    const b = dataUrl('image/png', pngHeader(10, 11))
    assert.equal(shortDigest(a), shortDigest(a))
    assert.notEqual(shortDigest(a), shortDigest(b))
    assert.match(shortDigest(a), /^[0-9a-f]{8}$/)
  })
  it('describeImage renders kind, size and digest', () => {
    const m = imageMeta(dataUrl('image/png', pngHeader(640, 480)))
    assert.equal(describeImage(m), `png 640×480 #${m.digest}`)
  })
  it('parseDataUrl lowercases the media type and rejects non-base64 data URLs', () => {
    assert.deepEqual(parseDataUrl('data:image/PNG;base64,AAAA'), { mediaType: 'image/png', base64: 'AAAA' })
    assert.equal(parseDataUrl('data:text/plain,hello'), null)
    assert.equal(parseDataUrl('https://x/y.png'), null)
  })
  it('sniffMediaType knows the four supported formats', () => {
    assert.equal(sniffMediaType(pngHeader(1, 1)), 'image/png')
    assert.equal(sniffMediaType(gifHeader(1, 1)), 'image/gif')
    assert.equal(sniffMediaType(webpHeader('VP8X', 1, 1)), 'image/webp')
    assert.equal(sniffMediaType(jpeg(1, 1)), 'image/jpeg')
    assert.equal(sniffMediaType(Buffer.from('hello world')), null)
    assert.deepEqual([...SUPPORTED_IMAGE_TYPES], ['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
  })
})

describe('content errors: whitelisted scalar fields only', () => {
  it('UnsupportedContentError codes', () => {
    const e = new UnsupportedContentError({ code: 'vision_disabled' })
    assert.ok(e instanceof Error)
    assert.equal(e.name, 'UnsupportedContentError')
    assert.equal(e.code, 'vision_disabled')
    assert.match(e.message, /vision: true/)
    assert.equal(new UnsupportedContentError({ code: 'image_in_role', role: 'assistant' }).role, 'assistant')
    assert.equal(new UnsupportedContentError({ code: 'image_in_role', role: 'data:image/png;base64,AAAA' }).role, undefined)
    assert.equal(new UnsupportedContentError({ code: 'nope' }).code, 'unsupported')
  })
  it('InvalidContentError never echoes URLs or payloads', () => {
    const e = new InvalidContentError({ code: 'image_too_large', partIndex: 1, bytes: 30, maxBytes: 20 })
    assert.equal(e.name, 'InvalidContentError')
    assert.deepEqual([e.code, e.partIndex, e.bytes, e.maxBytes], ['image_too_large', 1, 30, 20])
    assert.match(e.message, /30 bytes.*20-byte/)
    const evil = new InvalidContentError({ code: 'unsupported_media_type', partIndex: 0, mediaType: 'data:image/png;base64,SECRETSECRET' })
    assert.equal(evil.mediaType, undefined)
    assert.ok(!evil.message.includes('SECRET'))
    assert.equal(new InvalidContentError({ code: 'unsupported_media_type', partIndex: 0, mediaType: 'image/svg+xml' }).mediaType, 'image/svg+xml')
  })
})
