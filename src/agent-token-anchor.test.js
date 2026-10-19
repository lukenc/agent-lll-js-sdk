/**
 * Agent 层 token 锚定接入测试。
 *
 * 覆盖接线而非算法本身（算法在 token-accounting.test.js）：
 * 真实 usage 有没有被接住、下一轮有没有用上、信封变化会不会失效、
 * 守恒校验在真实数据下是否生效、默认路径有没有被破坏。
 */

import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert'
import { Agent } from './agent.js'
import { SlidingWindowMemory } from './memory.js'
import { defineTool } from './tool.js'
import { defaultTokenBudget } from './context-manager.js'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function mockJson(body) {
  return { ok: true, status: 200, async json() { return body }, async text() { return JSON.stringify(body) } }
}

/** 按序返回若干轮响应；usage 由调用方指定，用来驱动锚点 */
function stubTurns(turns) {
  let i = 0
  globalThis.fetch = async () => {
    const t = turns[Math.min(i++, turns.length - 1)]
    return mockJson({
      model: 'm',
      choices: [{ message: { content: t.content ?? 'ok' }, finish_reason: 'stop' }],
      usage: t.usage,
    })
  }
}

function buildAgent(opts = {}) {
  return new Agent({
    provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o-mini',
    memory: new SlidingWindowMemory(50),
    maxRounds: 3,
    // 必须显式配 tokenBudget：不配时 _runPipeline 走「简单模式」，
    // 根本不经过 ContextManager，也就没有锚定可言。
    tokenBudget: defaultTokenBudget(),
    ...opts,
  })
}

describe('锚点采集', () => {
  test('一轮对话后记下真实用量作为锚点', async () => {
    stubTurns([{ usage: { prompt_tokens: 1234, completion_tokens: 56 } }])
    const agent = buildAgent({ systemPrompt: 'sys' })
    await agent.chat('hi')
    const a = agent.getTokenAnchor()
    assert.ok(a, '应产生锚点')
    // 我方 prompt_tokens 已含缓存，锚点 = prompt + completion（再加 cached 会重复计数）
    assert.equal(a.totalTokens, 1234 + 56)
    assert.ok(typeof a.fingerprint === 'string' && a.fingerprint.length > 0)
    assert.ok(Number.isFinite(a.estimatedAtAnchor))
    assert.ok(Number.isFinite(a.historyTokens))
  })

  test('供应商不返回 usage 时不产生锚点，也不报错', async () => {
    stubTurns([{ usage: undefined }])
    const agent = buildAgent({ systemPrompt: 'sys' })
    await agent.chat('hi')
    assert.equal(agent.getTokenAnchor(), null, '拿不到用量就不该有锚点')
  })

  test('usage 字段缺失（只有 prompt_tokens）也能安全处理', async () => {
    stubTurns([{ usage: { prompt_tokens: 100 } }])
    const agent = buildAgent({ systemPrompt: 'sys' })
    await agent.chat('hi')
    const a = agent.getTokenAnchor()
    assert.ok(a === null || Number.isFinite(a.totalTokens), '要么没锚点，要么是有限数')
  })

  test('多轮对话时锚点更新为最新一次', async () => {
    stubTurns([
      { usage: { prompt_tokens: 100, completion_tokens: 10 } },
      { usage: { prompt_tokens: 900, completion_tokens: 90 } },
    ])
    const agent = buildAgent({ systemPrompt: 'sys' })
    await agent.chat('first')
    assert.equal(agent.getTokenAnchor().totalTokens, 110)
    await agent.chat('second')
    assert.equal(agent.getTokenAnchor().totalTokens, 990, '应是最新一次，不是累加也不是最早')
  })
})

describe('锚点复用', () => {
  test('第二轮请求的组装带上了锚点，置信度变为 usage', async () => {
    // 真实用量远高于估算 —— 满足守恒校验
    stubTurns([{ usage: { prompt_tokens: 5000, completion_tokens: 100 } }])
    const agent = buildAgent({ systemPrompt: 'sys' })
    await agent.chat('first')

    const assembled = await agent._runPipeline('second')
    assert.equal(assembled.tokenConfidence, 'usage', '第二轮应基于真实用量')
    assert.ok(assembled.totalTokens >= 5000, `应从锚点出发，实得 ${assembled.totalTokens}`)
  })

  test('第一轮没有锚点可用，置信度为 estimated', async () => {
    const agent = buildAgent({ systemPrompt: 'sys' })
    const assembled = await agent._runPipeline('first')
    assert.equal(assembled.tokenConfidence, 'estimated')
  })

  test('系统提示变化后锚点失效', async () => {
    stubTurns([{ usage: { prompt_tokens: 5000, completion_tokens: 100 } }])
    const agent = buildAgent({ systemPrompt: 'sys-A' })
    await agent.chat('first')
    assert.equal((await agent._runPipeline('x')).tokenConfidence, 'usage')

    agent.systemPrompt = 'sys-B-completely-different'
    assert.equal((await agent._runPipeline('y')).tokenConfidence, 'estimated',
      '换了系统提示就不该复用旧锚点')
  })

  test('工具集变化后锚点失效', async () => {
    stubTurns([{ usage: { prompt_tokens: 5000, completion_tokens: 100 } }])
    const agent = buildAgent({ systemPrompt: 'sys' })
    await agent.chat('first')
    assert.equal((await agent._runPipeline('x')).tokenConfidence, 'usage')

    agent.tools = [...agent.tools, defineTool({
      name: 'newly_added', description: 'd', parameters: { type: 'object', properties: {} },
      execute: async () => 'ok',
    })]
    assert.equal((await agent._runPipeline('y')).tokenConfidence, 'estimated',
      '加载新工具后信封变了，锚点必须失效')
  })

  test('守恒校验：真实用量低于同期估算时退回估算', async () => {
    // 造一个很长的历史让估算值很高，而真实用量报得很低
    const agent = buildAgent({ systemPrompt: 'x'.repeat(20000) })
    stubTurns([{ usage: { prompt_tokens: 5, completion_tokens: 1 } }])
    await agent.chat('hi')
    const assembled = await agent._runPipeline('next')
    assert.equal(assembled.tokenConfidence, 'estimated',
      '锚点小于同期估算时必须退回估算，否则预算会系统性偏低')
  })

  test('reset() 清掉锚点（新会话不该带着上一轮的基准）', async () => {
    stubTurns([{ usage: { prompt_tokens: 5000, completion_tokens: 100 } }])
    const agent = buildAgent({ systemPrompt: 'sys' })
    await agent.chat('first')
    assert.ok(agent.getTokenAnchor())
    agent.reset()
    assert.equal(agent.getTokenAnchor(), null)
  })
})

describe('遥测与向后兼容', () => {
  test('context.assembled 事件带上置信度', async () => {
    stubTurns([{ usage: { prompt_tokens: 5000, completion_tokens: 100 } }])
    const agent = buildAgent({ systemPrompt: 'sys' })
    const events = []
    agent.on('context.assembled', e => events.push(e))
    await agent.chat('first')
    await agent.chat('second')
    const withConfidence = events.filter(e => 'tokenConfidence' in e)
    assert.ok(withConfidence.length > 0, 'context.assembled 应带 tokenConfidence')
    assert.ok(withConfidence.some(e => e.tokenConfidence === 'usage'),
      `第二轮应出现 usage 置信度，实得 ${withConfidence.map(e => e.tokenConfidence).join(',')}`)
  })

  test('不订阅任何事件时行为不变', async () => {
    stubTurns([{ usage: { prompt_tokens: 100, completion_tokens: 10 } }])
    const agent = buildAgent({ systemPrompt: 'sys' })
    const reply = await agent.chat('hi')
    assert.equal(reply, 'ok')
  })

  test('getTokenAnchor() 返回快照，外部改动不影响内部状态', async () => {
    stubTurns([{ usage: { prompt_tokens: 100, completion_tokens: 10 } }])
    const agent = buildAgent({ systemPrompt: 'sys' })
    await agent.chat('hi')
    const a = agent.getTokenAnchor()
    a.totalTokens = 999999
    assert.equal(agent.getTokenAnchor().totalTokens, 110, '返回的应是副本')
  })
})
