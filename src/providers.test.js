import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { resolveProviderUrl } from './providers.js'
import { syncChat } from './llm-client.js'
import { TelemetryBus } from './telemetry.js'

const ORIGINAL_FETCH = globalThis.fetch

describe('xiaomi provider', () => {
  afterEach(() => { globalThis.fetch = ORIGINAL_FETCH })

  it('resolves the MiMo OpenAI-compatible endpoint', () => {
    assert.equal(resolveProviderUrl('xiaomi'), 'https://api.xiaomimimo.com/v1/chat/completions')
  })

  it('llm.call reports gen_ai.system = "xiaomi"', async () => {
    globalThis.fetch = async () => ({
      ok: true, status: 200, headers: new Headers(),
      async json() { return { model: 'mimo-v2.5', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] } },
      async text() { return '' },
    })
    const bus = new TelemetryBus()
    const events = []
    bus.on('llm.call', e => events.push(e))
    await syncChat({
      url: resolveProviderUrl('xiaomi'),
      apiKey: 'sk-test',
      body: { model: 'mimo-v2.5', messages: [] },
      telemetry: { ctx: { traceId: 't', parentSpanId: 'p', operationName: 'agent.chat', bus } },
    })
    assert.equal(events[0]['gen_ai.system'], 'xiaomi')
  })
})
