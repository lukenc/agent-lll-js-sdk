/**
 * 图片 token 估算。估算偏差的影响面有限：锚点是真实用量（不变量 6），一张图只在
 * **首次被发送的那一轮**处于"估算增量"里，之后就进入锚点。
 */

import { imageMeta } from './image-meta.js'

export const DEFAULT_UNKNOWN_IMAGE_TOKENS = 1024

/**
 * OpenAI tile 公式（gpt-4o 系列）：low → 85；否则缩放进 2048×2048，再把短边缩到 768，
 * 按 512 切 tile，85 + 170·tiles。mini / 新型号公式可能不同 —— 宿主可覆盖估算器。
 */
export function openaiImageTokens(width, height, detail) {
  if (detail === 'low') return 85
  let w = width
  let h = height
  const fit = Math.min(1, 2048 / Math.max(w, h))
  w *= fit
  h *= fit
  const shortSide = Math.min(1, 768 / Math.min(w, h))
  w *= shortSide
  h *= shortSide
  return 85 + 170 * Math.ceil(w / 512) * Math.ceil(h / 512)
}

const MIMO_FACTOR = 32
const MIMO_MIN_PIXELS = 8192
const MIMO_MAX_PIXELS = 8388608

/** 小米 MiMo 官方估算：宽高取整到 32 的倍数，总像素夹在 [8192, 8388608]，token = (w/32)·(h/32)。 */
export function mimoImageTokens(width, height) {
  let h = Math.max(MIMO_FACTOR, Math.round(height / MIMO_FACTOR) * MIMO_FACTOR)
  let w = Math.max(MIMO_FACTOR, Math.round(width / MIMO_FACTOR) * MIMO_FACTOR)
  if (h * w > MIMO_MAX_PIXELS) {
    const beta = Math.sqrt((height * width) / MIMO_MAX_PIXELS)
    h = Math.max(MIMO_FACTOR, Math.floor(height / beta / MIMO_FACTOR) * MIMO_FACTOR)
    w = Math.max(MIMO_FACTOR, Math.floor(width / beta / MIMO_FACTOR) * MIMO_FACTOR)
  } else if (h * w < MIMO_MIN_PIXELS) {
    const beta = Math.sqrt(MIMO_MIN_PIXELS / (height * width))
    h = Math.ceil(height * beta / MIMO_FACTOR) * MIMO_FACTOR
    w = Math.ceil(width * beta / MIMO_FACTOR) * MIMO_FACTOR
  }
  return (h / MIMO_FACTOR) * (w / MIMO_FACTOR)
}

const ESTIMATORS = { openai: openaiImageTokens, mimo: mimoImageTokens }

export function estimatorForUrl(url) {
  return typeof url === 'string' && url.toLowerCase().includes('api.openai.com') ? 'openai' : 'mimo'
}

/**
 * @param {{ estimator?: 'openai'|'mimo'|((w:number,h:number,detail?:string)=>number), unknownTokens?: number }} [opts]
 * @returns {{ imageTokens(part: object): number }}
 */
export function createImagePricing({ estimator = 'mimo', unknownTokens = DEFAULT_UNKNOWN_IMAGE_TOKENS } = {}) {
  const fn = typeof estimator === 'function' ? estimator : ESTIMATORS[estimator]
  if (typeof fn !== 'function') throw new TypeError('imageTokenEstimator must be "openai", "mimo" or a function')
  if (!Number.isFinite(unknownTokens) || unknownTokens < 0) {
    throw new TypeError('unknownImageTokens must be a non-negative finite number')
  }
  return {
    imageTokens(part) {
      const meta = imageMeta(part?.image_url?.url)
      if (!meta.width || !meta.height) return unknownTokens
      // 宿主估算器抛错不能冒泡进 assemblePrompt 把整轮打断 —— 计价只是估算，兜底值即可。
      let n
      try {
        n = fn(meta.width, meta.height, part.image_url.detail)
      } catch {
        return unknownTokens
      }
      return Number.isFinite(n) && n >= 0 ? Math.ceil(n) : unknownTokens
    },
  }
}

export const DEFAULT_IMAGE_PRICING = createImagePricing()
