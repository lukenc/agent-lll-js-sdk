/**
 * node examples/tool-call-id.js
 * Baseline investigation, not a fixed-behavior contract: two identical calls,
 * real local HTTP + filesystem tools + intent filtering + memory + hooks/telemetry.
 * Model responses are scripted; the SDK and tool execution are unmodified.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent, defineTool, SlidingWindowMemory } from '../src/index.js'
import { reportIds, startToolCallIdFixture } from './support/tool-call-id-fixture.js'

const root = await mkdtemp(join(tmpdir(), 'toolcallid-report-'))
await writeFile(join(root, 'a.txt'), 'contents of a.txt')
await writeFile(join(root, 'b.txt'), 'contents of b.txt')
try {
  for (const mode of ['stream', 'chat', 'followup', 'stream-different-args', 'stream-tool-error', 'stream-rejected']) {
    const fixture = await startToolCallIdFixture({ differentArgs: mode === 'stream-different-args' })
    const contexts = [], hooks = [], telemetry = [], events = []
    let running = 0, maxRunning = 0
    const agent = new Agent({
      provider: 'openai', apiKey: 'fixture', model: 'fixture', url: fixture.url,
      enableIntentRecognition: true, memory: new SlidingWindowMemory(30), maxRounds: 5,
      tools: [defineTool({
        name: 'read_file', description: 'read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
        execute: async (args, context) => {
          contexts.push(Object.keys(context)); maxRunning = Math.max(maxRunning, ++running)
          try {
            if (mode === 'stream-tool-error') throw new Error('fixture tool error')
            return await readFile(join(root, args.path), 'utf8')
          } finally { running-- }
        },
      })],
      hooks: {
        beforeToolCall: (...args) => { hooks.push({ hook: 'before', argc: args.length }); return mode === 'stream-rejected' ? false : undefined },
        afterToolCall: (...args) => { hooks.push({ hook: 'after', argc: args.length }) },
      },
    })
    agent.on('tool.call', p => telemetry.push(p))
    try {
      let answer
      if (mode === 'chat') answer = await agent.chat('读两次 a.txt')
      else if (mode === 'followup') { agent.enqueueMessage({ content: '读两次 a.txt' }); answer = await agent.followup() }
      else for await (const event of agent.stream('读两次 a.txt')) { events.push(event); if (event.type === 'done') answer = event.content }
      assert.match(answer, /^done:/)
      const messages = await agent.memory.getMessages()
      const resultIds = messages.filter(m => m.role === 'tool').map(m => m.tool_call_id)
      assert.deepEqual(resultIds, reportIds)
      assert.equal(telemetry.length, 2)
      assert.equal(new Set(telemetry.map(p => p.spanId)).size, 2)
      assert.ok(telemetry.every(p => p.toolCallId === undefined))
      assert.ok(contexts.every(keys => !keys.includes('toolCallId')))
      assert.ok(hooks.every(h => h.argc === (h.hook === 'before' ? 2 : 3)))
      const lifecycle = events.filter(e => ['tool_start', 'tool_end'].includes(e.type))
      if (mode !== 'chat' && mode !== 'followup') {
        assert.deepEqual(lifecycle.map(e => e.type), ['tool_start', 'tool_end', 'tool_start', 'tool_end'])
        assert.ok(lifecycle.every(e => e.toolCallId === undefined))
        const fullRaw = events.filter(e => e.type === 'tool_call' && e.toolCall.arguments)
        assert.deepEqual(fullRaw.map(e => e.toolCall.id), reportIds)
        // Demonstrate the report's counterexample: ordered pairs are distinguishable.
        assert.equal(lifecycle[0].name, lifecycle[1].name)
        assert.equal(lifecycle[2].name, lifecycle[3].name)
      }
      assert.equal(maxRunning, mode === 'stream-rejected' ? 0 : 1)
      assert.match(await agent.chat('上一轮的调用 ID 是什么？'), /call_AAA,call_BBB/)
      assert.ok(fixture.requests.some(b => String(b.messages[0]?.content).includes('You are an intent analyzer')))
      console.log(JSON.stringify({ mode, maxRunning, lifecycle, contexts, hooks, telemetry: telemetry.map(p => ({ name: p.name, spanId: p.spanId, ok: p.ok, toolCallId: p.toolCallId ?? null })), resultIds, memoryFollowup: 'passed' }))
    } finally { await fixture.close() }
  }
  console.log('PASS: 6 baseline scenarios; missing public ID reproduced, serial pairing and protocol history intact')
} finally { await rm(root, { recursive: true, force: true }) }
