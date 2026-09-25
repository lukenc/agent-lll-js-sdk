import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'
import { encodePng, squaresPng, barChartPng, BAR_COLORS } from './png.js'
import { imagePart } from '../../src/index.js'
import { imageMeta } from '../../src/content/image-meta.js'

describe('demo/lib/png', () => {
  it('writes a valid signature, IHDR dimensions and a correct CRC', () => {
    const png = encodePng(3, 2, () => [255, 0, 0])
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    assert.equal(png.readUInt32BE(16), 3)
    assert.equal(png.readUInt32BE(20), 2)
    // IEND 的 CRC 是固定值 0xAE426082 —— 用它校验 crc32 实现
    assert.equal(png.readUInt32BE(png.length - 4), 0xae426082)
    const idatLen = png.readUInt32BE(33)
    const raw = inflateSync(png.subarray(41, 41 + idatLen))
    assert.equal(raw.length, (3 * 3 + 1) * 2)
  })
  it('squaresPng / barChartPng dimensions are readable by the SDK', () => {
    const m = imageMeta(imagePart(squaresPng(5)).image_url.url)
    assert.deepEqual([m.mediaType, m.width, m.height], ['image/png', 440, 240])
    const c = imageMeta(imagePart(barChartPng([90, 210, 150])).image_url.url)
    assert.deepEqual([c.width, c.height], [360, 260])
    assert.deepEqual(BAR_COLORS, ['red', 'blue', 'green'])
  })
})
