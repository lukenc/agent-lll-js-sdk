/**
 * 多模态内容的错误类。构造函数只接收白名单标量字段(code / role / partIndex /
 * mediaType / bytes / maxBytes),绝不接收原始 part 或 URL —— data URL 动辄几 MB,
 * 又是用户数据,不能进 err.message。与 src/mcp/errors.js、src/skills/errors.js 同款设计。
 */

import { SUPPORTED_IMAGE_TYPES } from './image-meta.js'

const MEDIA_TYPE_RE = /^[a-z0-9.+-]{1,40}\/[a-z0-9.+-]{1,60}$/i
const ROLES = new Set(['system', 'user', 'assistant', 'tool'])

function safeMediaType(v) {
  return typeof v === 'string' && MEDIA_TYPE_RE.test(v) ? v.toLowerCase() : undefined
}

function safeInt(v) {
  return Number.isSafeInteger(v) && v >= 0 ? v : undefined
}

const UNSUPPORTED_MESSAGES = {
  vision_disabled: () => 'Image input is not supported: this agent was created without `vision: true`.',
  plan_and_execute: () => 'Image input is not supported by the "plan_and_execute" strategy; use the default ReAct strategy.',
  image_in_role: ({ role }) => `Images are only allowed in user and tool messages; found one in a ${role ?? 'non-user'} message.`,
}

export class UnsupportedContentError extends Error {
  constructor({ code, role } = {}) {
    const render = UNSUPPORTED_MESSAGES[code]
    const safeRole = ROLES.has(role) ? role : undefined
    super(render ? render({ role: safeRole }) : 'Unsupported content.')
    this.name = 'UnsupportedContentError'
    this.code = render ? code : 'unsupported'
    if (safeRole !== undefined) this.role = safeRole
  }
}

const at = i => `#${i ?? '?'}`

const INVALID_MESSAGES = {
  bad_part_type: ({ partIndex }) => `Content part ${at(partIndex)} has an unsupported type; expected "text" or "image_url".`,
  bad_url_scheme: ({ partIndex }) => `Image part ${at(partIndex)} must use a data: or http(s): URL.`,
  unsupported_media_type: ({ partIndex, mediaType }) =>
    `Image part ${at(partIndex)} has media type ${mediaType ?? '(unknown)'}; supported: ${SUPPORTED_IMAGE_TYPES.join(', ')}.`,
  image_too_large: ({ partIndex, bytes, maxBytes }) =>
    `Image part ${at(partIndex)} is ${bytes ?? '?'} bytes, above the ${maxBytes ?? '?'}-byte limit.`,
  bad_base64: ({ partIndex }) => `Image part ${at(partIndex)} is not valid base64.`,
}

export class InvalidContentError extends Error {
  constructor({ code, partIndex, mediaType, bytes, maxBytes } = {}) {
    const fields = {
      partIndex: safeInt(partIndex),
      mediaType: safeMediaType(mediaType),
      bytes: safeInt(bytes),
      maxBytes: safeInt(maxBytes),
    }
    const render = INVALID_MESSAGES[code]
    super(render ? render(fields) : 'Invalid content.')
    this.name = 'InvalidContentError'
    this.code = render ? code : 'invalid'
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) this[key] = value
    }
  }
}
