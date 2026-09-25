/**
 * 多模态（图片输入）—— Agent 集成。HTTP 全部 mock；记录每次请求体用于断言。
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { Agent } from './agent.js'
import { SlidingWindowMemory } from './memory.js'
import { defaultTokenBudget } from './context-manager.js'
import { defineTool } from './tool.js'
import { MemorySpillStore } from './spill/index.js'
import { PlanAndExecuteStrategy, PlanStep } from './plan-and-execute.js'
import {
  imagePart, contentResult, isContentResult, UnsupportedContentError, InvalidContentError,
} from './content/index.js'

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

  it('a message whose own images can never fit imageLimits is rejected at the entry, before memory.add', async () => {
    const url = PNG.image_url.url
    const agent = makeAgent({ vision: true, imageLimits: { maxBytes: url.length - 1 } })
    await assert.rejects(agent.chat(withImage('too big for any request')), e => e instanceof InvalidContentError
      && e.code === 'exceeds_image_limits' && e.images === 1 && e.bytes === url.length && e.maxBytes === url.length - 1
      && e.maxImages === 20 && !e.message.includes(url.split(',')[1]))
    assert.equal(requests.length, 0)
    assert.equal((await nonSystem(agent)).length, 0)

    const twoImages = makeAgent({ vision: true, imageLimits: { maxImages: 1 } })
    await assert.rejects(twoImages.chat([{ type: 'text', text: 'two' }, PNG, PNG2]),
      e => e.code === 'exceeds_image_limits' && e.images === 2 && e.maxImages === 1)
    assert.equal((await nonSystem(twoImages)).length, 0)
  })

  it('[ContextManager path] an offloaded old image is priced as placeholder text, not as an image', async () => {
    const agent = makeAgent({
      vision: true, tokenBudget: defaultTokenBudget(), imageLimits: { maxImages: 1 }, imageTokenEstimator: () => 5000,
    })
    const assembled = []
    agent.on('context.assembled', p => assembled.push(p))
    reply('first')
    await agent.chat(withImage('one'))
    reply('second')
    await agent.chat(withImage('two', PNG2))
    assert.equal(assembled.length, 2)
    // 第二轮：第一张图已卸载 → 只剩 PNG2 按 5000 计价；若先计价后卸载，会 ≥ 10000
    const second = assembled[1].historyTokens
    assert.ok(second >= 5000 && second < 10000, `historyTokens=${second}`)
    assert.ok(JSON.stringify(requests[1]).includes('image omitted to fit request image limits'))
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

  it('vision / simpleVision must be booleans when given (undefined keeps the defaults)', () => {
    for (const bad of ['true', 1, null, {}]) {
      assert.throws(() => makeAgent({ vision: bad }), TypeError)
      assert.throws(() => makeAgent({ simpleVision: bad }), TypeError)
    }
    assert.equal(makeAgent({ vision: undefined }).vision, false)
    assert.equal(makeAgent({ vision: false, simpleVision: true }).simpleVision, true)
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

const toolRound = name => queue.push({ choices: [{ message: { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })
const chartTool = (result = contentResult([{ type: 'text', text: 'chart ready' }, PNG])) => defineTool({
  name: 'render', description: 'render a chart', parameters: { type: 'object', properties: {} },
  execute: async () => result,
})

describe('Agent multimodal: tool results', () => {
  beforeEach(installJsonFetch)
  afterEach(() => { globalThis.fetch = ORIGINAL_FETCH })

  it('vision:true — tool text stays in the tool message, the image follows as a user message', async () => {
    const agent = makeAgent({ vision: true, tools: [chartTool()] })
    toolRound('render'); reply('done')
    assert.equal(await agent.chat('draw'), 'done')
    const msgs = requests[1].messages
    const t = msgs.findIndex(m => m.role === 'tool')
    assert.equal(msgs[t].content, 'chart ready')
    assert.deepEqual(msgs[t + 1], { role: 'user', content: [{ type: 'text', text: 'Attached image(s) from tool result:' }, PNG] })
    const stored = (await nonSystem(agent)).find(m => m.role === 'tool')
    assert.deepEqual(stored.content, [{ type: 'text', text: 'chart ready' }, PNG])
  })

  it('vision:false — tool-level failure, onError fires, run completes, no image is sent', async () => {
    const errors = []
    const calls = []
    const agent = makeAgent({ tools: [chartTool()], hooks: { onError: e => errors.push(e) } })
    agent.on('tool.call', p => calls.push(p))
    toolRound('render'); reply('sorry')
    assert.equal(await agent.chat('draw'), 'sorry')
    assert.equal(calls[0].ok, false)
    assert.equal(calls[0].errorKind, 'unsupported_content')
    assert.ok(errors.some(e => e instanceof UnsupportedContentError))
    const tool = requests[1].messages.find(m => m.role === 'tool')
    assert.match(tool.content, /^Error: Tool "render" returned image content/)
    assert.ok(!JSON.stringify(requests[1]).includes('image_url'))
  })

  it('invalid contentResult parts → invalid_content', async () => {
    const calls = []
    const bad = contentResult([{ type: 'image_url', image_url: { url: 'data:image/svg+xml;base64,AAAA' } }])
    const agent = makeAgent({ vision: true, tools: [chartTool(bad)] })
    agent.on('tool.call', p => calls.push(p))
    toolRound('render'); reply('ok')
    await agent.chat('draw')
    assert.equal(calls[0].errorKind, 'invalid_content')
  })

  it('a tool result whose images exceed imageLimits → invalid_content, onError fires, run completes', async () => {
    const calls = []
    const errors = []
    const agent = makeAgent({
      vision: true, imageLimits: { maxImages: 1 },
      tools: [chartTool(contentResult([{ type: 'text', text: 'two charts' }, PNG, PNG2]))],
      hooks: { onError: e => errors.push(e) },
    })
    agent.on('tool.call', p => calls.push(p))
    toolRound('render'); reply('ok')
    assert.equal(await agent.chat('draw'), 'ok')
    assert.equal(calls[0].ok, false)
    assert.equal(calls[0].errorKind, 'invalid_content')
    assert.ok(errors.some(e => e instanceof InvalidContentError && e.code === 'exceeds_image_limits'))
    const tool = requests[1].messages.find(m => m.role === 'tool')
    assert.match(tool.content, /^Error: Tool "render" returned invalid content: Images in this content \(2 images/)
    assert.ok(!JSON.stringify(requests[1]).includes('image_url'))
  })

  it('[Review Focus 4] a plain JSON array result is still JSON-stringified', async () => {
    const agent = makeAgent({ vision: true, tools: [chartTool([1, 2, 3])] })
    toolRound('render'); reply('ok')
    await agent.chat('go')
    assert.equal(requests[1].messages.find(m => m.role === 'tool').content, '[1,2,3]')
  })

  it('a text-only contentResult becomes a plain string tool result', async () => {
    const agent = makeAgent({ tools: [chartTool(contentResult([{ type: 'text', text: 'just text' }]))] })
    toolRound('render'); reply('ok')
    await agent.chat('go')
    assert.equal(requests[1].messages.find(m => m.role === 'tool').content, 'just text')
  })

  it('tool.call bytes count only text; imageCount reports images', async () => {
    const calls = []
    const agent = makeAgent({ vision: true, tools: [chartTool()] })
    agent.on('tool.call', p => calls.push(p))
    toolRound('render'); reply('ok')
    await agent.chat('go')
    assert.equal(calls[0].bytes, Buffer.byteLength('chart ready'))
    assert.equal(calls[0].imageCount, 1)
  })

  it('spill bounds only the text part and keeps the image', async () => {
    const long = 'x'.repeat(5000)
    const agent = makeAgent({
      vision: true,
      tools: [chartTool(contentResult([{ type: 'text', text: long }, PNG]))],
      spill: { maxToolResultBytes: 1200, store: new MemorySpillStore(), onWarn: () => {} },
    })
    toolRound('render'); reply('ok')
    await agent.chat('go')
    const stored = (await nonSystem(agent)).find(m => m.role === 'tool')
    assert.ok(Array.isArray(stored.content))
    assert.ok(stored.content[0].text.length < long.length)
    assert.deepEqual(stored.content.at(-1), PNG)
  })
})

describe('Agent multimodal: tool results via stream() [Review Focus 3]', () => {
  afterEach(() => { globalThis.fetch = ORIGINAL_FETCH })

  it('stream splits tool images identically and tool_end carries the contentResult', async () => {
    installSseFetch([
      [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"render","arguments":"{}"}}]}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        'data: [DONE]',
      ],
      SSE_TEXT,
    ])
    const agent = makeAgent({ vision: true, tools: [chartTool()] })
    const ends = []
    for await (const ev of agent.stream('draw')) if (ev.type === 'tool_end') ends.push(ev)
    assert.ok(isContentResult(ends[0].result))
    const msgs = requests[1].messages
    const t = msgs.findIndex(m => m.role === 'tool')
    assert.equal(msgs[t].content, 'chart ready')
    assert.equal(msgs[t + 1].content[0].text, 'Attached image(s) from tool result:')
  })

  it('stream with vision:false fails the tool call the same way', async () => {
    installSseFetch([
      [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"render","arguments":"{}"}}]}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        'data: [DONE]',
      ],
      SSE_TEXT,
    ])
    const calls = []
    const agent = makeAgent({ tools: [chartTool()] })
    agent.on('tool.call', p => calls.push(p))
    for await (const _ of agent.stream('draw')) { /* drain */ }
    assert.equal(calls[0].errorKind, 'unsupported_content')
  })
})

describe('PlanAndExecute: tool images are unsupported in this version', () => {
  beforeEach(installJsonFetch)
  afterEach(() => { globalThis.fetch = ORIGINAL_FETCH })

  it('a step whose tool returns an image records unsupported_content and sends no image', async () => {
    const strategy = new PlanAndExecuteStrategy({ url: 'https://api.openai.com/v1/chat/completions', apiKey: 'sk-fake', model: 'gpt-4o-mini', tools: [chartTool()] })
    const step = new PlanStep(0, 'draw')
    toolRound('render'); reply('done')
    await strategy._reactLoop('draw', null, 3, undefined, [], step)
    assert.equal(step.toolCalls[0].errorKind, 'unsupported_content')
    assert.ok(!JSON.stringify(requests[1]).includes('image_url'))
  })
})
