/**
 * 多模态内容模块出口。`src/index.js` 只再导出其中的公开子集；其余 helper 供
 * agent.js / tool.js / mcp / plan-and-execute 等内部模块使用。
 */
export { UnsupportedContentError, InvalidContentError } from './errors.js'
export { SUPPORTED_IMAGE_TYPES, imageMeta, describeImage } from './image-meta.js'
export {
  CONTENT_RESULT, DEFAULT_MAX_IMAGE_BYTES, normalizeMaxImageBytes, normalizeContent, hasImage,
  contentText, partsText, imageParts, imagePart, contentResult, isContentResult, toolResultText,
} from './parts.js'
export {
  openaiImageTokens, mimoImageTokens, createImagePricing, DEFAULT_IMAGE_PRICING,
  DEFAULT_UNKNOWN_IMAGE_TOKENS, estimatorForUrl,
} from './image-tokens.js'
export {
  DEFAULT_IMAGE_LIMITS, normalizeImageLimits, offloadedPrefixCount,
  projectHistoryImages, toWireMessages, TOOL_IMAGE_LABEL,
} from './projection.js'
