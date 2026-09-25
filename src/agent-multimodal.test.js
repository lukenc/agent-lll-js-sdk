/**
 * 多模态（图片输入）—— Agent 集成。HTTP 全部 mock；记录每次请求体用于断言。
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { Agent } from './agent.js'
import { SlidingWindowMemory } from './memory.js'
import { defaultTokenBudget } from './context-manager.js'
import { imagePart, UnsupportedContentError, InvalidContentError } from './content/index.js'

const ORIGINAL_FETCH = globalThis.fetch
let requests = []
let queue = []

function installJsonFetch() {
  requests = []
  queue = []
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body))
    const next = queue.shift()
    if (!next) throw new Error('mock fetch: response queue empty')
    return {
      ok: true, status: 200, headers: new Headers(),
      async json() { return next },
      async text() { return JSON.stringify(next) },
    }
  }
}
const reply = content => queue.push({ choices: [{ message: { content }, finish_reason: 'stop' }] })

function sseBody(lines) {
  return new ReadableStream({ start(c) { for (const l of lines) c.enqueue(new TextEncoder().encode(l + '\n')); c.close() } })
}
function installSseFetch(rounds) {
  requests = []
  let i = 0
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body))
    if (i >= rounds.length) throw new Error('sse stub exhausted')
    return new Response(sseBody(rounds[i++]), { status: 200 })
  }
}
const SSE_TEXT = [
  'data: {"choices":[{"delta":{"content":"ok"}}]}',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
  'data: [DONE]',
]

function pngBytes(w, h) {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20)
  return b
}
const PNG = imagePart(pngBytes(64, 48))
const PNG2 = imagePart(pngBytes(80, 60))
const withImage = (text, part = PNG) => [{ type: 'text', text }, part]

function makeAgent(extra = {}) {
  return new Agent({
    provider: 'openai', apiKey: 'sk-fake', model: 'gpt-4o-mini',
    memory: new SlidingWindowMemory(50), maxRounds: 4, ...extra,
  })
}
const nonSystem = async agent => (await agent._getHistory()).filter(m => m.role !== 'system')

describe('Agent multimodal: entry', () => {
  beforeEach(installJsonFetch)
  afterEach(() => { globalThis.fetch = ORIGINAL_FETCH })

  it('vision:false rejects an image before memory.add and before any request', async () => {
    const agent = makeAgent()
    await assert.rejects(agent.chat(withImage('look')), e => e instanceof UnsupportedContentError && e.code === 'vision_disabled')
    assert.equal(requests.length, 0)
    assert.equal((await nonSystem(agent)).length, 0)
  })

  it('plan_and_execute rejects images even with vision:true', async () => {
    const agent = makeAgent({ vision: true, strategy: 'plan_and_execute' })
    await assert.rejects(agent.chat(withImage('look')), e => e.code === 'plan_and_execute')
    assert.equal(requests.length, 0)
  })

  it('invalid parts are rejected with InvalidContentError and leave memory untouched', async () => {
    const agent = makeAgent({ vision: true })
    await assert.rejects(agent.chat([{ type: 'image_url', image_url: { url: 'ftp://x/y.png' } }]),
      e => e instanceof InvalidContentError && e.code === 'bad_url_scheme')
    assert.equal((await nonSystem(agent)).length, 0)
  })

  it('maxImageBytes is enforced at the entry', async () => {
    const agent = makeAgent({ vision: true, maxImageBytes: 10 })
    await assert.rejects(agent.chat(withImage('big')), e => e.code === 'image_too_large')
  })

  it('vision:true (simple path) sends the image and stores the array in memory', async () => {
    const agent = makeAgent({ vision: true })
    reply('a dog')
    assert.equal(await agent.chat(withImage('what is this?')), 'a dog')
    const last = requests[0].messages.at(-1)
    assert.equal(last.role, 'user')
    assert.deepEqual(last.content, [{ type: 'text', text: 'what is this?' }, PNG])
    assert.deepEqual((await nonSystem(agent))[0].content, [{ type: 'text', text: 'what is this?' }, PNG])
  })

  it('vision:true (ContextManager path) sends the image and prices it', async () => {
    const agent = makeAgent({ vision: true, tokenBudget: defaultTokenBudget() })
    const assembled = []
    agent.on('context.assembled', p => assembled.push(p))
    reply('ok')
    await agent.chat(withImage('what is this?'))
    assert.deepEqual(requests[0].messages.at(-1).content[1], PNG)
    // openai 估算器：64×48 → 1 tile → 255
    assert.ok(assembled[0].historyTokens >= 255, `historyTokens=${assembled[0].historyTokens}`)
  })

  it('a text-only parts array folds to a string and needs no vision', async () => {
    const agent = makeAgent()
    reply('ok')
    await agent.chat([{ type: 'text', text: 'hi' }])
    assert.equal(requests[0].messages.at(-1).content, 'hi')
  })

  it('[Review Focus 1] text-only chat is byte-identical on the wire', async () => {
    const agent = makeAgent()
    reply('ok')
    await agent.chat('hi')
    assert.deepEqual(requests[0].messages, [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'hi' },
    ])
  })

  it('[Review Focus 5] a pending notice merges into the image message as its first text part', async () => {
    const agent = makeAgent({ vision: true })
    agent._pendingInjections.push({ role: 'user', content: '<agent-message>bg done</agent-message>' })
    reply('ok')
    await agent.chat(withImage('and look at this'))
    const users = requests[0].messages.filter(m => m.role === 'user')
    assert.equal(users.length, 1)
    assert.deepEqual(users[0].content, [
      { type: 'text', text: '<agent-message>bg done</agent-message>' },
      { type: 'text', text: 'and look at this' },
      PNG,
    ])
  })

  it('intent recognition receives only the text projection', async () => {
    const agent = makeAgent({ vision: true, enableIntentRecognition: true })
    queue.push({ choices: [{ message: { content: '{"complexity":"SIMPLE"}' }, finish_reason: 'stop' }] })
    reply('ok')
    await agent.chat(withImage('what is this?'))
    const intentBody = requests[0]
    assert.ok(!JSON.stringify(intentBody).includes('image_url'))
    assert.match(intentBody.messages.at(-1).content, /^what is this\?\n\[image png 64×48 #[0-9a-f]{8}\]$/)
    assert.ok(JSON.stringify(requests[1]).includes('image_url'))
  })

  it('backstop: vision:false with an image already in memory projects to text instead of throwing', async () => {
    const agent = makeAgent()
    agent.memory.add({ role: 'user', content: withImage('old') })
    agent.memory.add({ role: 'assistant', content: 'seen' })
    reply('ok')
    await agent.chat('next')
    const body = JSON.stringify(requests[0])
    assert.ok(!body.includes('image_url'))
    assert.ok(body.includes('model accepts text only'))
  })

  it('imageLimits offloads the oldest image on the next request', async () => {
    const agent = makeAgent({ vision: true, imageLimits: { maxImages: 1 } })
    reply('first')
    await agent.chat(withImage('one'))
    reply('second')
    await agent.chat(withImage('two', PNG2))
    const body = JSON.stringify(requests[1])
    assert.ok(body.includes('image omitted to fit request image limits'))
    assert.equal((body.match(/data:image\/png/g) || []).length, 1)
  })

  it('invalid multimodal options throw at construction', () => {
    assert.throws(() => makeAgent({ imageLimits: { maxImages: 0 } }), TypeError)
    assert.throws(() => makeAgent({ maxImageBytes: -1 }), TypeError)
    assert.throws(() => makeAgent({ imageTokenEstimator: 'nope' }), TypeError)
  })

  it('simpleVision defaults to vision when no simple model is configured, else false', () => {
    assert.equal(makeAgent({ vision: true }).simpleVision, true)
    assert.equal(makeAgent({ vision: true, simpleModel: 'cheap' }).simpleVision, false)
    assert.equal(makeAgent({ vision: true, simpleModel: 'cheap', simpleVision: true }).simpleVision, true)
  })
})

describe('Agent multimodal: stream() parity [Review Focus 3]', () => {
  afterEach(() => { globalThis.fetch = ORIGINAL_FETCH })

  it('stream rejects images when vision is off, before any request', async () => {
    installSseFetch([SSE_TEXT])
    const agent = makeAgent()
    await assert.rejects(async () => { for await (const _ of agent.stream(withImage('x'))) { /* drain */ } },
      e => e instanceof UnsupportedContentError)
    assert.equal(requests.length, 0)
  })

  it('stream sends the image when vision is on', async () => {
    installSseFetch([SSE_TEXT])
    const agent = makeAgent({ vision: true })
    for await (const _ of agent.stream(withImage('x'))) { /* drain */ }
    assert.deepEqual(requests[0].messages.at(-1).content[1], PNG)
  })
})
