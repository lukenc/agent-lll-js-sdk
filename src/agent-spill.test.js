/**
 * Agent 层 spill 接入测试。
 *
 * 覆盖的是「接线」而非 spill 本身的算法（那些在 spill/*.test.js）：
 * 配置是否生效、两条 ReAct 循环是否都接上、spill_read 是否注册为基础工具、
 * 生命周期是否清理、默认不启用时是否逐字节保持旧行为。
 *
 * 沿用 agent.test.js 的既有约定：替换 globalThis.fetch，
 * 用 SlidingWindowMemory 避免默认 SummarizingMemory 的异步摘要打到 stub 上。
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import { Agent } from './agent.js'
import { SlidingWindowMemory } from './memory.js'
import { defineTool } from './tool.js'
import { isBaseTool } from './tool-filter.js'
import { MemorySpillStore, utf8Bytes } from './spill/index.js'
import { SPILL_READ_TOOL_NAME } from './spill/policy.js'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function mockJson(body) {
  return { ok: true, status: 200, async json() { return body }, async text() { return JSON.stringify(body) } }
}

/** 第一轮调工具，第二轮出最终文本 */
function stubToolThenText(toolName) {
  const responses = [
    {
      model: 'm',
      choices: [{
        message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: toolName, arguments: '{}' } }] },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    },
    {
      model: 'm',
      choices: [{ message: { content: '完成' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    },
  ]
  let i = 0
  globalThis.fetch = async () => mockJson(responses[Math.min(i++, responses.length - 1)])
}

const bigTool = body => defineTool({
  name: 'dump',
  description: '产出大量输出',
  parameters: { type: 'object', properties: {} },
  execute: async () => body,
})

function buildAgent({ tools = [], spill, maxRounds = 3 } = {}) {
  return new Agent({
    provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o-mini',
    memory: new SlidingWindowMemory(50),
    tools, maxRounds,
    ...(spill ? { spill } : {}),
  })
}

const toolMsgOf = agent => agent.memory.messages.find(m => m.role === 'tool')

describe('Agent spill 配置', () => {
  test('默认不启用：工具结果逐字节保持原样', async () => {
    const body = 'x'.repeat(50000)
    stubToolThenText('dump')
    const agent = buildAgent({ tools: [bigTool(body)] })
    await agent.chat('跑一下')
    assert.equal(toolMsgOf(agent).content, body, '未配置 spill 时不应改动工具结果')
  })

  test('配置 maxToolResultBytes 后超限结果被替换', async () => {
    const body = 'HEAD' + 'x'.repeat(50000) + 'TAIL'
    stubToolThenText('dump')
    const agent = buildAgent({
      tools: [bigTool(body)],
      spill: { maxToolResultBytes: 500, store: new MemorySpillStore() },
    })
    await agent.chat('跑一下')
    const content = toolMsgOf(agent).content
    assert.notEqual(content, body)
    assert.ok(utf8Bytes(content) <= 500, `应在上限内，实得 ${utf8Bytes(content)}`)
    assert.ok(content.includes('spill://'), '应含取回地址')
    assert.ok(content.startsWith('HEAD'), '应保留头部')
    assert.ok(content.includes('TAIL'), '应保留尾部')
  })

  test('非法配置在构造 Agent 时就抛', () => {
    assert.throws(() => buildAgent({ spill: { maxToolResultBytes: -5 } }), /non-negative integer/)
    assert.throws(() => buildAgent({ spill: { maxToolResultBytes: 1.5 } }), /non-negative integer/)
  })

  test('未超限的结果不受影响', async () => {
    stubToolThenText('dump')
    const agent = buildAgent({
      tools: [bigTool('小结果')],
      spill: { maxToolResultBytes: 500, store: new MemorySpillStore() },
    })
    await agent.chat('跑一下')
    assert.equal(toolMsgOf(agent).content, '小结果')
  })
})

describe('spill_read 工具注册', () => {
  test('启用 spill 后自动加入工具列表', () => {
    const agent = buildAgent({ spill: { maxToolResultBytes: 500, store: new MemorySpillStore() } })
    assert.ok(agent.tools.some(t => t.name === SPILL_READ_TOOL_NAME), '应注入 spill_read')
  })

  test('spill_read 必须是基础工具，否则意图识别会把它裁掉', () => {
    buildAgent({ spill: { maxToolResultBytes: 500, store: new MemorySpillStore() } })
    assert.ok(isBaseTool(SPILL_READ_TOOL_NAME),
      'spill_read 未注册为基础工具 —— 提示语让模型去调它，工具却可能被过滤掉')
  })

  test('未启用 spill 时不注入该工具', () => {
    const agent = buildAgent({})
    assert.ok(!agent.tools.some(t => t.name === SPILL_READ_TOOL_NAME))
  })

  test('模型能通过 spill_read 取回被转存的完整内容（端到端）', async () => {
    const body = 'BEGIN' + 'y'.repeat(20000) + 'END'
    const store = new MemorySpillStore()
    stubToolThenText('dump')
    const agent = buildAgent({ tools: [bigTool(body)], spill: { maxToolResultBytes: 400, store } })
    await agent.chat('跑一下')
    const locator = toolMsgOf(agent).content.match(/spill:\/\/[^\s]+/)?.[0]
    assert.ok(locator, '提示语里应能取出 locator')

    const readTool = agent.tools.find(t => t.name === SPILL_READ_TOOL_NAME)
    const out = await readTool.execute({ locator, offset: 0, limit: 100 })
    assert.ok(out.includes('BEGIN'), '应能读回开头内容')
    assert.ok(/共\s*\d+/.test(out), '应报告总字节数')
  })
})

describe('流式循环同样接入', () => {
  test('stream() 下超限结果也被替换', async () => {
    const body = 'STREAMHEAD' + 'z'.repeat(30000)
    let call = 0
    globalThis.fetch = async () => {
      call++
      const chunks = call === 1
        ? [`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'dump', arguments: '{}' } }] } }] })}\n\n`,
           `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`, 'data: [DONE]\n\n']
        : [`data: ${JSON.stringify({ choices: [{ delta: { content: '完成' } }] })}\n\n`,
           `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`, 'data: [DONE]\n\n']
      const enc = new TextEncoder()
      let i = 0
      return {
        ok: true, status: 200,
        body: { getReader: () => ({
          read: async () => i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true, value: undefined },
          releaseLock() {},
          cancel: async () => {},
        }) },
      }
    }
    const agent = buildAgent({
      tools: [bigTool(body)],
      spill: { maxToolResultBytes: 400, store: new MemorySpillStore() },
    })
    for await (const _ of agent.stream('跑一下')) { void _ }
    const content = toolMsgOf(agent).content
    assert.notEqual(content, body, '流式路径也必须接入 spill')
    assert.ok(utf8Bytes(content) <= 400)
  })
})

describe('生命周期', () => {
  test('reset() 清掉本会话的转存内容', async () => {
    const body = 'x'.repeat(20000)
    const store = new MemorySpillStore()
    stubToolThenText('dump')
    const agent = buildAgent({ tools: [bigTool(body)], spill: { maxToolResultBytes: 400, store } })
    await agent.chat('跑一下')
    const locator = toolMsgOf(agent).content.match(/spill:\/\/[^\s]+/)[0]
    assert.equal(await store.readText(locator), body)

    agent.reset()
    await new Promise(r => setTimeout(r, 20)) // reset 同步返回、异步清理
    await assert.rejects(() => store.readText(locator), /不存在|已被清理/)
  })

  test('reset() 仍然同步返回 undefined（不能改成 async）', () => {
    const agent = buildAgent({ spill: { maxToolResultBytes: 400, store: new MemorySpillStore() } })
    assert.equal(agent.reset(), undefined)
  })
})

describe('降级不影响主流程', () => {
  test('存储后端故障时工具调用照常成功，内容保留', async () => {
    const body = 'x'.repeat(20000)
    const broken = { async saveText() { throw new Error('后端故障') }, async readText() {}, async clear() {} }
    const warns = []
    stubToolThenText('dump')
    const agent = buildAgent({
      tools: [bigTool(body)],
      spill: { maxToolResultBytes: 400, store: broken, onWarn: m => warns.push(m) },
    })
    const reply = await agent.chat('跑一下')
    assert.equal(reply, '完成', '工具调用不应因 spill 故障而失败')
    assert.equal(toolMsgOf(agent).content, body, '应保留完整内容')
    assert.ok(warns.length > 0, '应有降级告警')
  })
})
