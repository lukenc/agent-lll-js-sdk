/**
 * streamChatIter 流完整性校验（对齐 openai-node 语义层检测）：
 * 正常完成的 OpenAI 兼容流，最后一个内容 chunk 必带非空 finish_reason，
 * 之后才是 data: [DONE]。连接被服务端/代理干净关闭时没有这两样——
 * 旧实现把这当正常结束，截断被静默当成功。
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { streamChatIter, LlmStreamIncompleteError } from './llm-client.js'

const ORIGINAL_FETCH = globalThis.fetch

/** 把 SSE 行数组变成一个流式 Response（模拟服务端）。 */
function sseResponse(lines, { status = 200, headers = {} } = {}) {
  const stream = new ReadableStream({
    start(controller) {
      for (const l of lines) controller.enqueue(new TextEncoder().encode(l + '\n'))
      controller.close()
    },
  })
  return new Response(stream, { status, headers })
}

function stubFetch(...responses) {
  let i = 0
  globalThis.fetch = async () => {
    if (i >= responses.length) throw new Error(`fetch stub exhausted (call #${i + 1})`)
    return responses[i++]
  }
}

async function collect(iter) {
  const events = []
  for await (const ev of iter) events.push(ev)
  return events
}

const DELTA = 'data: {"choices":[{"delta":{"content":"你好"}}]}'
const FINISH = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}'
const USAGE_TAIL = 'data: {"usage":{"prompt_tokens":1,"completion_tokens":2},"choices":[]}'
const DONE = 'data: [DONE]'

describe('streamChatIter completeness validation', () => {
  afterEach(() => { globalThis.fetch = ORIGINAL_FETCH })

  it('complete stream (finish_reason present) passes and yields done', async () => {
    stubFetch(sseResponse([DELTA, FINISH, USAGE_TAIL, DONE]))
    const events = await collect(streamChatIter({ url: 'http://x', apiKey: 'k', body: {} }))
    const done = events.find(e => e.type === 'done')
    assert.ok(done)
    assert.equal(done.response.choices[0].finish_reason, 'stop')
  })

  it('stream cut before finish_reason throws LlmStreamIncompleteError, deltas already yielded', async () => {
    stubFetch(sseResponse([DELTA]))  // 连接被干净关闭：无 finish、无 [DONE]
    const events = []
    await assert.rejects(
      async () => { for await (const ev of streamChatIter({ url: 'http://x', apiKey: 'k', body: {} })) events.push(ev) },
      (err) => {
        assert.ok(err instanceof LlmStreamIncompleteError)
        assert.equal(err.name, 'LlmStreamIncompleteError')
        assert.equal(err.chunkCount, 1)
        assert.equal(err.partialContentLength, '你好'.length)
        return true
      },
    )
    // 已收到的 delta 不回收（与 openai-node/Anthropic 一致）
    assert.deepEqual(events, [{ type: 'delta', content: '你好' }])
  })

  it('validateCompletion: false restores old tolerant behavior', async () => {
    stubFetch(sseResponse([DELTA]))
    const events = await collect(
      streamChatIter({ url: 'http://x', apiKey: 'k', body: {}, validateCompletion: false }),
    )
    const done = events.find(e => e.type === 'done')
    assert.ok(done, 'must complete without throwing')
    assert.equal(done.response.choices[0].finish_reason, null)
  })

  it('zero-chunk stream always throws, regardless of validateCompletion', async () => {
    stubFetch(sseResponse([]))
    await assert.rejects(
      collect(streamChatIter({ url: 'http://x', apiKey: 'k', body: {}, validateCompletion: false })),
      (err) => err instanceof LlmStreamIncompleteError && err.chunkCount === 0,
    )
  })

  it('usage tail frame (empty choices) does not trigger a false positive', async () => {
    stubFetch(sseResponse([DELTA, FINISH, USAGE_TAIL]))  // 无 [DONE] 也行：finish 已到
    const events = await collect(streamChatIter({ url: 'http://x', apiKey: 'k', body: {} }))
    assert.ok(events.find(e => e.type === 'done'))
  })
})
