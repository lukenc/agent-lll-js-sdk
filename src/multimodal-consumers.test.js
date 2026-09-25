import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { SummaryPolicy } from './memory-policy.js'
import { IntentRecognizer } from './intent-recognizer.js'
import { SkillFilter } from './skills/filter.js'
import { RuntimeHistory } from './runtime-history.js'
import { searchHistory } from './agents/history-search.js'
import { imagePart } from './content/index.js'

function pngBytes(w, h) {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20)
  return b
}
const PNG = imagePart(pngBytes(64, 48))
const B64 = PNG.image_url.url.split(',')[1]
const imageMsg = { role: 'user', content: [{ type: 'text', text: 'look' }, PNG] }
const ORIGINAL_FETCH = globalThis.fetch

describe('text-only consumers use the text projection', () => {
  afterEach(() => { globalThis.fetch = ORIGINAL_FETCH })

  it('summarizer input shows a placeholder, never base64', () => {
    const events = [imageMsg, { role: 'assistant', content: 'a dog' }, { role: 'user', content: 'more' }]
      .map((message, i) => ({ id: `e${i}`, type: 'message', message }))
    const plan = new SummaryPolicy({ threshold: 2, keepRecent: 1 }).plan(events, null)
    assert.match(plan.text, /\[user\]: look\n\[image png 64×48 #[0-9a-f]{8}\]/)
    assert.ok(!plan.text.includes(B64))
  })

  it('intent history keeps image turns as text and dedupes against the text projection', async () => {
    let body
    globalThis.fetch = async (_u, init) => {
      body = JSON.parse(init.body)
      return { ok: true, status: 200, headers: new Headers(), async json() { return { choices: [{ message: { content: '{}' } }] } }, async text() { return '' } }
    }
    const r = new IntentRecognizer({ url: 'https://api.openai.com/v1/chat/completions', apiKey: 'k', model: 'm' })
    await r.analyze([{ type: 'text', text: 'look' }, PNG], [], { history: [imageMsg] })
    const users = body.messages.filter(m => m.role === 'user')
    assert.equal(users.length, 1, 'the trailing duplicate of the current message is removed')
    assert.match(users[0].content, /^look\n\[image png/)
    assert.ok(!JSON.stringify(body).includes(B64))
  })

  it('skill filter sends the text projection', async () => {
    let body
    const f = new SkillFilter({ url: 'u', apiKey: 'k', model: 'm' })
    f._syncChat = async ({ body: b }) => { body = b; return { choices: [{ message: { content: '["a"]' } }] } }
    await f.filter([{ type: 'text', text: 'pick' }, PNG], [{ name: 'a', description: 'd' }])
    assert.match(body.messages.at(-1).content, /^pick\n\[image png/)
  })

  it('history search indexes the text projection, not base64', () => {
    const h = new RuntimeHistory()
    h.appendMessage(imageMsg)
    assert.equal(searchHistory(h, { query: B64.slice(10, 30) }).length, 0)
    assert.equal(searchHistory(h, { query: 'image png 64×48' }).length, 1)
  })
})
