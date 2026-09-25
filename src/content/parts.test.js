import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeContent, hasImage, contentText, partsText, imageParts, imagePart,
  contentResult, isContentResult, toolResultText, normalizeMaxImageBytes, DEFAULT_MAX_IMAGE_BYTES,
} from './parts.js'
import { InvalidContentError } from './errors.js'

function pngHeader(w, h) {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20)
  return b
}
const PNG_B64 = pngHeader(2, 3).toString('base64')
const PNG_URL = `data:image/png;base64,${PNG_B64}`
const img = (url, extra = {}) => ({ type: 'image_url', image_url: { url, ...extra } })

describe('normalizeContent', () => {
  it('passes strings and other non-arrays through untouched', () => {
    assert.equal(normalizeContent('hi'), 'hi')
    assert.equal(normalizeContent(null), null)
    assert.equal(normalizeContent(42), 42)
  })
  it('folds text-only arrays into a string (no image ⇒ string)', () => {
    assert.equal(normalizeContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb')
    assert.equal(normalizeContent([]), '')
  })
  it('keeps image arrays, strips unknown fields, keeps a valid detail', () => {
    const out = normalizeContent([{ type: 'text', text: 'look', foo: 1 }, img(PNG_URL, { detail: 'low', bar: 2 })])
    assert.deepEqual(out, [{ type: 'text', text: 'look' }, img(PNG_URL, { detail: 'low' })])
    assert.deepEqual(normalizeContent([img(PNG_URL, { detail: 'ultra' })]), [img(PNG_URL)])
  })
  it('canonicalizes an uppercase data URL header', () => {
    const [part] = normalizeContent([img(`data:image/PNG;base64,${PNG_B64}`)])
    assert.equal(part.image_url.url, PNG_URL)
  })
  it('accepts http(s) URLs as-is', () => {
    assert.deepEqual(normalizeContent([img('https://example.com/a.png')]), [img('https://example.com/a.png')])
  })
  const bad = [
    ['bad_part_type', [{ type: 'audio' }]],
    ['bad_part_type', [{ type: 'text', text: 1 }]],
    ['bad_url_scheme', [img('ftp://x/y.png')]],
    ['bad_url_scheme', [img('file:///etc/passwd')]],
    ['bad_url_scheme', [img(42)]],
    ['unsupported_media_type', [img(`data:image/svg+xml;base64,${PNG_B64}`)]],
    ['bad_base64', [img('data:image/png;base64,@@@@')]],
    ['bad_base64', [img('data:image/png;base64,')]],
  ]
  for (const [code, content] of bad) {
    it(`rejects ${code}: ${JSON.stringify(content).slice(0, 60)}`, () => {
      assert.throws(() => normalizeContent(content), e => e instanceof InvalidContentError && e.code === code && e.partIndex === 0)
    })
  }
  it('rejects non-image bytes under an image header (magic bytes are checked, not just the header)', () => {
    const notImage = Buffer.from('hello world!').toString('base64')
    assert.throws(
      () => normalizeContent([{ type: 'text', text: 'x' }, img(`data:image/png;base64,${notImage}`)]),
      e => e instanceof InvalidContentError && e.code === 'unsupported_media_type' && e.partIndex === 1
        && e.mediaType === 'image/png' && !e.message.includes(notImage),
    )
  })
  it('magic bytes win over the declared type: JPEG bytes declared as image/png get a jpeg header', () => {
    const jpegB64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]).toString('base64')
    const [part] = normalizeContent([img(`data:image/png;base64,${jpegB64}`, { detail: 'low' })])
    assert.deepEqual(part, img(`data:image/jpeg;base64,${jpegB64}`, { detail: 'low' }))
  })
  it('enforces maxImageBytes and reports the offending index without echoing data', () => {
    assert.throws(
      () => normalizeContent([{ type: 'text', text: 'x' }, img(PNG_URL)], { maxImageBytes: 10 }),
      e => e.code === 'image_too_large' && e.partIndex === 1 && e.bytes === 33 && e.maxBytes === 10 && !e.message.includes(PNG_B64),
    )
  })
})

describe('text projection', () => {
  it('contentText', () => {
    assert.equal(contentText('plain'), 'plain')
    assert.equal(contentText(null), '')
    assert.equal(contentText(undefined), '')
    assert.match(contentText([{ type: 'text', text: 'look' }, img(PNG_URL)]), /^look\n\[image png 2×3 #[0-9a-f]{8}\]$/)
    assert.match(contentText([img('https://x/y.png')]), /^\[image url #[0-9a-f]{8}\]$/)
  })
  it('hasImage / partsText / imageParts', () => {
    assert.equal(hasImage('x'), false)
    assert.equal(hasImage([{ type: 'text', text: 'x' }]), false)
    assert.equal(hasImage([img(PNG_URL)]), true)
    assert.equal(partsText([{ type: 'text', text: 'a' }, img(PNG_URL), { type: 'text', text: 'b' }]), 'a\nb')
    assert.equal(imageParts([{ type: 'text', text: 'a' }, img(PNG_URL)]).length, 1)
    assert.deepEqual(imageParts('x'), [])
  })
})

describe('imagePart', () => {
  it('data and https URLs pass through', () => {
    assert.deepEqual(imagePart(PNG_URL), img(PNG_URL))
    assert.deepEqual(imagePart('https://x/y.png', { detail: 'high' }), img('https://x/y.png', { detail: 'high' }))
  })
  it('bare base64 with or without mediaType; whitespace stripped', () => {
    assert.equal(imagePart(PNG_B64, { mediaType: 'image/png' }).image_url.url, PNG_URL)
    assert.equal(imagePart(PNG_B64).image_url.url, PNG_URL)
    const wrapped = PNG_B64.replace(/(.{8})/g, '$1\n')
    assert.equal(imagePart(wrapped).image_url.url, PNG_URL)
  })
  it('Uint8Array / Buffer / ArrayBuffer', () => {
    const bytes = pngHeader(2, 3)
    assert.equal(imagePart(bytes).image_url.url, PNG_URL)
    assert.equal(imagePart(new Uint8Array(bytes)).image_url.url, PNG_URL)
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)
    assert.equal(imagePart(ab).image_url.url, PNG_URL)
  })
  it('unsniffable bytes without mediaType and unsupported sources throw InvalidContentError', () => {
    assert.throws(() => imagePart(Buffer.from('hello world')), e => e.code === 'unsupported_media_type')
    assert.throws(() => imagePart(42), e => e.code === 'bad_part_type')
  })
})

describe('contentResult', () => {
  it('brands the object; JSON keeps type/parts but drops the brand', () => {
    const r = contentResult([{ type: 'text', text: 'ok' }])
    assert.equal(isContentResult(r), true)
    assert.equal(r.type, 'content_result')
    const roundTripped = JSON.parse(JSON.stringify(r))
    assert.equal(isContentResult(roundTripped), false)
    assert.deepEqual(roundTripped, { type: 'content_result', parts: [{ type: 'text', text: 'ok' }] })
    assert.equal(isContentResult({ type: 'content_result', parts: [] }), false)
    assert.equal(isContentResult(null), false)
  })
  it('rejects non-array parts', () => {
    assert.throws(() => contentResult('x'), TypeError)
  })
  it('toolResultText counts only text parts; other values use String()', () => {
    assert.equal(toolResultText(contentResult([{ type: 'text', text: 'a' }, img(PNG_URL)])), 'a')
    assert.equal(toolResultText('s'), 's')
    assert.equal(toolResultText({ a: 1 }), '[object Object]')
  })
})

describe('normalizeMaxImageBytes', () => {
  it('defaults and validates', () => {
    assert.equal(normalizeMaxImageBytes(undefined), DEFAULT_MAX_IMAGE_BYTES)
    assert.equal(normalizeMaxImageBytes(1000), 1000)
    for (const v of [0, -1, 1.5, Infinity, '10']) assert.throws(() => normalizeMaxImageBytes(v), TypeError)
  })
})
