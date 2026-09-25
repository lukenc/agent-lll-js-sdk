import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  openaiImageTokens, mimoImageTokens, createImagePricing, DEFAULT_IMAGE_PRICING, estimatorForUrl,
} from './image-tokens.js'
import { estimateMessageTokens } from '../memory-policy.js'
import { ContextManager } from '../context-manager.js'

function pngUrl(w, h, padBytes = 0) {
  const b = Buffer.alloc(33 + padBytes)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20)
  return `data:image/png;base64,${b.toString('base64')}`
}
const img = (url, detail) => ({ type: 'image_url', image_url: { url, ...(detail ? { detail } : {}) } })

describe('image token formulas (values pinned to our implementation)', () => {
  it('openai tile formula', () => {
    assert.equal(openaiImageTokens(1024, 1024), 765)
    assert.equal(openaiImageTokens(2048, 4096), 1105)
    assert.equal(openaiImageTokens(512, 512), 255)
    assert.equal(openaiImageTokens(640, 480), 425)
    assert.equal(openaiImageTokens(4000, 3000, 'low'), 85)
  })
  it('mimo 32px-block formula', () => {
    assert.equal(mimoImageTokens(1024, 768), 768)
    assert.equal(mimoImageTokens(640, 480), 300)
    assert.equal(mimoImageTokens(10, 10), 9)
    assert.equal(mimoImageTokens(4000, 3000), 8112)
  })
})

describe('createImagePricing', () => {
  it('prices by decoded dimensions', () => {
    assert.equal(DEFAULT_IMAGE_PRICING.imageTokens(img(pngUrl(640, 480))), 300)
    assert.equal(createImagePricing({ estimator: 'openai' }).imageTokens(img(pngUrl(640, 480), 'low')), 85)
  })
  it('unknown dimensions (URL images, unreadable JPEG) fall back to unknownTokens', () => {
    assert.equal(DEFAULT_IMAGE_PRICING.imageTokens(img('https://x/y.png')), 1024)
    assert.equal(createImagePricing({ unknownTokens: 7 }).imageTokens(img('https://x/y.png')), 7)
  })
  it('custom estimator function; non-finite results fall back', () => {
    assert.equal(createImagePricing({ estimator: (w, h) => w + h }).imageTokens(img(pngUrl(3, 4))), 7)
    assert.equal(createImagePricing({ estimator: () => NaN, unknownTokens: 5 }).imageTokens(img(pngUrl(3, 4))), 5)
  })
  it('a throwing host estimator falls back to unknownTokens instead of aborting the run', () => {
    const pricing = createImagePricing({ estimator: () => { throw new Error('boom') }, unknownTokens: 6 })
    assert.equal(pricing.imageTokens(img(pngUrl(3, 4))), 6)
  })
  it('rejects bad configuration at construction', () => {
    assert.throws(() => createImagePricing({ estimator: 'nope' }), TypeError)
    assert.throws(() => createImagePricing({ unknownTokens: -1 }), TypeError)
  })
  it('estimatorForUrl', () => {
    assert.equal(estimatorForUrl('https://api.openai.com/v1/chat/completions'), 'openai')
    assert.equal(estimatorForUrl('https://api.xiaomimimo.com/v1/chat/completions'), 'mimo')
    assert.equal(estimatorForUrl(undefined), 'mimo')
  })
})

describe('estimateMessageTokens with content parts', () => {
  it('string content: calibration anchor unchanged (invariant 5)', () => {
    assert.equal(estimateMessageTokens({ role: 'user', content: 'abcd' }), 9)
  })
  it('array content: per-part blocks + role/message framing', () => {
    const msg = { role: 'user', content: [{ type: 'text', text: 'abcd' }, img(pngUrl(10, 10))] }
    // text 1+4, image 100+4, message 4+4
    assert.equal(estimateMessageTokens(msg, { imageTokens: () => 100 }), 117)
  })
  it('null pricing falls back to the default pricing', () => {
    const msg = { role: 'user', content: [img(pngUrl(640, 480))] }
    assert.equal(estimateMessageTokens(msg, null), estimateMessageTokens(msg))
  })
  it('base64 is never priced as text: a ~1 MB image costs its formula price', () => {
    const msg = { role: 'user', content: [img(pngUrl(640, 480, 1_000_000))] }
    assert.equal(estimateMessageTokens(msg), 300 + 4 + 8)
  })
})

describe('ContextManager.assemblePrompt forwards imagePricing', () => {
  it('historyTokens uses the supplied pricing', () => {
    const cm = new ContextManager()
    const history = [{ role: 'user', content: [img(pngUrl(10, 10))] }]
    const out = cm.assemblePrompt({ systemPrompt: 's', history, imagePricing: { imageTokens: () => 500 } })
    assert.equal(out.historyTokens, 500 + 4 + 8)
  })
})
