import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'
import {
  DEFAULT_IMAGE_LIMITS, normalizeImageLimits, offloadedPrefixCount,
  projectHistoryImages, toWireMessages, TOOL_IMAGE_LABEL,
} from './projection.js'
import { UnsupportedContentError } from './errors.js'

function pngUrl(w, h) {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20)
  return `data:image/png;base64,${b.toString('base64')}`
}
const img = url => ({ type: 'image_url', image_url: { url } })
const userImg = (text, ...urls) => ({ role: 'user', content: [{ type: 'text', text }, ...urls.map(img)] })
const MiB = 1024 * 1024

describe('offloadedPrefixCount (dsh parity)', () => {
  it('dsh doc example: 129×1 MiB under 128 MiB with a 64 MiB quantum removes 65', () => {
    const limits = { maxBytes: 128 * MiB, byteQuantum: 64 * MiB }
    assert.equal(offloadedPrefixCount(Array(129).fill(MiB), limits), 65)
    assert.equal(offloadedPrefixCount(Array(192).fill(MiB), limits), 65)
    assert.equal(offloadedPrefixCount(Array(193).fill(MiB), limits), 129)
  })
  it('nothing removed under both limits', () => {
    assert.equal(offloadedPrefixCount([1, 2, 3], { maxImages: 3, maxBytes: 6 }), 0)
  })

  const limitsArb = fc.record({
    maxImages: fc.integer({ min: 1, max: 30 }),
    maxBytes: fc.integer({ min: 1, max: 5000 }),
  }).chain(l => fc.record({
    maxImages: fc.constant(l.maxImages),
    maxBytes: fc.constant(l.maxBytes),
    countQuantum: fc.integer({ min: 1, max: l.maxImages }),
    byteQuantum: fc.integer({ min: 1, max: l.maxBytes }),
  }))
  const lengthsArb = fc.array(fc.integer({ min: 0, max: 800 }), { maxLength: 80 })

  it('property: the removed prefix never shrinks as history grows (cache stability)', () => {
    fc.assert(fc.property(limitsArb, lengthsArb, lengthsArb, (limits, base, extra) => {
      assert.ok(offloadedPrefixCount([...base, ...extra], limits) >= offloadedPrefixCount(base, limits))
    }))
  })
  it('property: what remains fits both limits', () => {
    fc.assert(fc.property(limitsArb, lengthsArb, (limits, lengths) => {
      const p = offloadedPrefixCount(lengths, limits)
      const rest = lengths.slice(p)
      assert.ok(rest.length <= limits.maxImages)
      assert.ok(rest.reduce((s, b) => s + b, 0) <= limits.maxBytes)
    }))
  })
  it('property: count-only removal happens in whole quanta', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 20 }), fc.integer({ min: 0, max: 100 }), (maxImages, n) => {
      fc.pre(n >= 0)
      const countQuantum = Math.max(1, Math.floor(maxImages / 2))
      const p = offloadedPrefixCount(Array(n).fill(0), { maxImages, countQuantum })
      assert.equal(p % countQuantum, 0)
      assert.ok(n - p <= maxImages)
    }))
  })
})

describe('normalizeImageLimits', () => {
  it('defaults', () => {
    assert.deepEqual({ ...normalizeImageLimits() }, { maxImages: 20, maxBytes: 20 * MiB, countQuantum: 5, byteQuantum: 10 * MiB })
    assert.equal(normalizeImageLimits(), DEFAULT_IMAGE_LIMITS)
  })
  it('overriding only a maximum derives a fitting quantum', () => {
    const l = normalizeImageLimits({ maxImages: 2 })
    assert.equal(l.countQuantum, 2)
    assert.equal(normalizeImageLimits({ maxBytes: 1000 }).byteQuantum, 1000)
  })
  it('rejects invalid values at construction time', () => {
    for (const bad of [{ maxImages: 0 }, { maxBytes: -1 }, { countQuantum: 1.5 }, { maxImages: 2, countQuantum: 3 }, 'x']) {
      assert.throws(() => normalizeImageLimits(bad), TypeError)
    }
  })
})

describe('projectHistoryImages', () => {
  const a = pngUrl(10, 10)
  const b = pngUrl(20, 20)
  const c = pngUrl(30, 30)

  it('returns the same reference when there is nothing to do', () => {
    const msgs = [{ role: 'user', content: 'hi' }]
    assert.equal(projectHistoryImages(msgs, { vision: true }), msgs)
    const withImg = [userImg('x', a)]
    assert.equal(projectHistoryImages(withImg, { vision: true }), withImg)
  })
  it('vision off: every image becomes a text-only placeholder and the message folds to a string', () => {
    const msgs = [userImg('look', a)]
    const out = projectHistoryImages(msgs, { vision: false })
    assert.match(out[0].content, /^look\n\[image omitted: model accepts text only; png 10×10 #[0-9a-f]{8}\]$/)
  })
  it('offloads the oldest images past the limit, including images inside tool messages', () => {
    const msgs = [
      userImg('one', a),
      { role: 'assistant', content: null, tool_calls: [{ id: 't', type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 't', content: [{ type: 'text', text: 'r' }, img(b)] },
      userImg('three', c),
    ]
    const snapshot = JSON.stringify(msgs)
    const out = projectHistoryImages(msgs, { vision: true, imageLimits: normalizeImageLimits({ maxImages: 2, countQuantum: 1 }) })
    assert.match(out[0].content, /^one\n\[image omitted to fit request image limits; png 10×10 #/)
    assert.equal(out[2], msgs[2])
    assert.equal(out[3], msgs[3])
    assert.equal(JSON.stringify(msgs), snapshot, 'input is never mutated')
  })
})

describe('toWireMessages', () => {
  const a = pngUrl(10, 10)
  const call = id => ({ id, type: 'function', function: { name: 'f', arguments: '{}' } })

  it('returns the same reference when no message carries an image', () => {
    const msgs = [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }]
    assert.equal(toWireMessages(msgs), msgs)
  })
  it('consecutive tool results keep string content and share one following user image message', () => {
    const msgs = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: null, tool_calls: [call('1'), call('2')] },
      { role: 'tool', tool_call_id: '1', content: [{ type: 'text', text: 'first' }, img(a)] },
      { role: 'tool', tool_call_id: '2', content: [img(a)] },
      { role: 'assistant', content: 'done' },
    ]
    const out = toWireMessages(msgs)
    assert.deepEqual(out.map(m => m.role), ['user', 'assistant', 'tool', 'tool', 'user', 'assistant'])
    assert.equal(out[2].content, 'first')
    assert.equal(out[3].content, '(no output)')
    assert.deepEqual(out[4].content, [{ type: 'text', text: TOOL_IMAGE_LABEL }, img(a), img(a)])
  })
  it('flushes pending tool images at the end of the list (the usual next-round request)', () => {
    const out = toWireMessages([
      { role: 'assistant', content: null, tool_calls: [call('1')] },
      { role: 'tool', tool_call_id: '1', content: [{ type: 'text', text: 'r' }, img(a)] },
    ])
    assert.equal(out.at(-1).role, 'user')
    assert.equal(out.at(-1).content[0].text, TOOL_IMAGE_LABEL)
  })
  it('user image messages pass through unchanged', () => {
    const u = userImg('x', a)
    assert.equal(toWireMessages([u])[0], u)
  })
  it('images in assistant/system messages fail loud', () => {
    assert.throws(() => toWireMessages([{ role: 'assistant', content: [img(a)] }]),
      e => e instanceof UnsupportedContentError && e.code === 'image_in_role' && e.role === 'assistant')
  })
})
