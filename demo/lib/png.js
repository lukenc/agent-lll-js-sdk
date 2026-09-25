/**
 * 零依赖 PNG 编码（Node 内置 zlib）。examples/multimodal.js、demo/server.js 与
 * demo/mcp-servers/image-chart.js 共用：演示用的图由代码现场画出，答案（色块个数、
 * 最高柱颜色）才可断言。只画纯色矩形 —— 足够让视觉模型数数、比高低。
 */
import { deflateSync } from 'node:zlib'

export const BAR_COLORS = ['red', 'blue', 'green']

const RGB = {
  white: [255, 255, 255],
  red: [220, 38, 38],
  blue: [37, 99, 235],
  green: [22, 163, 74],
  gray: [148, 163, 184],
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed))
  return Buffer.concat([len, typed, crc])
}

/** @param {(x:number, y:number) => [number, number, number]} rgbAt */
export function encodePng(width, height, rgbAt) {
  const stride = width * 3 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0
    for (let x = 0; x < width; x++) {
      const [r, g, b] = rgbAt(x, y)
      const o = y * stride + 1 + x * 3
      raw[o] = r
      raw[o + 1] = g
      raw[o + 2] = b
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/** @param {{ x:number, y:number, w:number, h:number, color:string }[]} rects 后画的盖住先画的 */
export function drawRects(width, height, rects, background = 'white') {
  return encodePng(width, height, (x, y) => {
    for (let i = rects.length - 1; i >= 0; i--) {
      const r = rects[i]
      if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return RGB[r.color]
    }
    return RGB[background]
  })
}

/** `count` 个红色方块，一行最多 4 个，间距足够大，数得清。 */
export function squaresPng(count) {
  const size = 60
  const gap = 40
  const perRow = 4
  const rows = Math.max(1, Math.ceil(count / perRow))
  const width = perRow * (size + gap) + gap
  const height = rows * (size + gap) + gap
  const rects = Array.from({ length: count }, (_, i) => ({
    x: gap + (i % perRow) * (size + gap),
    y: gap + Math.floor(i / perRow) * (size + gap),
    w: size, h: size, color: 'red',
  }))
  return drawRects(width, height, rects)
}

/** 三根柱子，`heights` 与 BAR_COLORS（red, blue, green）一一对应；每个高度须在 1..220。 */
export function barChartPng(heights) {
  const width = 360
  const height = 260
  const base = 240
  const barW = 60
  const gap = 50
  const rects = [{ x: 20, y: base, w: width - 40, h: 2, color: 'gray' }]
  heights.forEach((h, i) => rects.push({ x: gap + i * (barW + gap), y: base - h, w: barW, h, color: BAR_COLORS[i] }))
  return drawRects(width, height, rects)
}
