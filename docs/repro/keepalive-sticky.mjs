/**
 * lll-web-agent 缺陷最小复现：keep-alive 首次超时后，主 agent 会在**仍有子 agent
 * 在飞**时结束整个 run，且对外报告 stopReason = 'completed'。
 *
 * 运行（在 SDK 仓库根目录）：
 *   node path/to/keepalive-sticky.mjs
 * 或显式指定 SDK 入口：
 *   LLL_SDK=/abs/path/to/agent-lll-js-sdk/src/agent.js node path/to/keepalive-sticky.mjs
 *
 * 期望：全部断言通过 = 缺陷仍在。
 */
import assert from 'node:assert'
import { pathToFileURL } from 'node:url'

const SDK = process.env.LLL_SDK
  ? pathToFileURL(process.env.LLL_SDK).href
  : pathToFileURL(`${process.cwd()}/src/agent.js`).href
const { Agent } = await import(SDK)

// 缩短仅为让复现秒级完成；生产默认是 600_000。缩放不改变行为，只改变触发时刻。
const KEEP_ALIVE_MS = 300

let mainRound = 0
let childCalls = 0
let childSignalAborted = null

/**
 * 假 LLM：
 *   - 主 agent 第 0 轮派一个后台子 agent，之后每轮只说话（无工具调用）——
 *     这正是"我在等子 agent 通知"的真实形态。
 *   - 子 agent 的请求永久挂起，模拟一次生成大 payload 的慢/静默请求
 *     （真实场景：一次 edit_deck 的 12 页 JSON，或一个 13KB 单文件 HTML）。
 */
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body)
  const isMain = String(body.messages[0]?.content ?? '').includes('MAIN')

  if (!isMain) {
    childCalls += 1
    init.signal?.addEventListener('abort', () => { childSignalAborted = true })
    await new Promise(() => {})        // 永不 resolve，也永不 reject
  }

  const message = mainRound++ === 0
    ? {
        content: '',
        tool_calls: [{
          id: 'c1', type: 'function',
          function: {
            name: 'agent',
            arguments: JSON.stringify({ description: 'slow task', prompt: 'generate a large document' }),
          },
        }],
      }
    : { content: `第 ${mainRound} 轮：子 agent 还在跑，我继续等它的通知。` }

  return {
    ok: true, status: 200, headers: new Map(),
    json: async () => ({ choices: [{ message }] }),
    text: async () => '',
  }
}

const agent = new Agent({
  provider: 'openai', url: 'http://mock/v1/chat/completions', apiKey: 'k', model: 'm',
  systemPrompt: 'MAIN agent', tools: [], maxRounds: 20,
  subagents: { maxConcurrent: 4, maxDepth: 2, keepAliveTimeoutMs: KEEP_ALIVE_MS },
})

const keepAliveTimeouts = []
agent.on('run.keep_alive.timeout', (p) => keepAliveTimeouts.push(p))
const terminalEvents = []
for (const t of ['agent.succeeded', 'agent.failed', 'agent.cancelled', 'agent.retry']) {
  agent.on(t, (p) => terminalEvents.push({ event: t, ...p }))
}

const t0 = Date.now()
const answer = await agent.chat('请并行处理这件事')
const elapsed = Date.now() - t0

console.log('--- run 结束时的状态 ---')
console.log('主 agent 的最终回答      :', JSON.stringify(answer))
console.log('lastStopReason           :', agent.lastStopReason)
console.log('run 耗时 ms              :', elapsed, `(keepAliveTimeoutMs=${KEEP_ALIVE_MS})`)
console.log('主 agent 轮数            :', mainRound)
console.log('keep_alive.timeout 次数  :', keepAliveTimeouts.length, JSON.stringify(keepAliveTimeouts))
console.log('子 agent 终态/重试事件   :', terminalEvents.length, JSON.stringify(terminalEvents))
console.log('run 结束时 hasInFlight() :', agent.subagents.hasInFlight())
console.log('注册表（含终态）         :', agent.subagents.registry.list({ includeFinished: true })
  .map(h => `${h.name}:${h.state}`))
console.log('子 agent 的 LLM 调用次数 :', childCalls)
console.log('子 agent signal 被 abort :', childSignalAborted)

// run 已经结束，再等一段时间：证明被弃置的子 agent 既不会超时，也不会被回收
await new Promise(r => setTimeout(r, 800))
console.log('\n--- run 结束 800ms 后 ---')
console.log('hasInFlight()            :', agent.subagents.hasInFlight())
console.log('子 agent 终态/重试事件   :', terminalEvents.length)
console.log('_pendingInjections       :', agent._pendingInjections.length)

console.log('\n--- 断言 ---')
assert.strictEqual(keepAliveTimeouts.length, 1, 'keep-alive 应恰好超时一次')
assert.strictEqual(agent.subagents.hasInFlight(), true, 'run 结束时子 agent 仍在飞')
assert.strictEqual(agent.lastStopReason, 'completed', "stopReason 报的是 'completed'")
assert.strictEqual(terminalEvents.length, 0, '子 agent 没有任何终态/重试事件')
assert.strictEqual(childSignalAborted, null, '子 agent 的 signal 从未被 abort')
console.log('全部断言通过 —— 缺陷复现成功。')
process.exit(0)
