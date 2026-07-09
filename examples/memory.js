/**
 * Memory 与 RuntimeHistory 示例 — 运行时历史与上下文投影
 *
 * 这是 runtime-history-memory-redesign 特性的配套示例。核心思想:
 *   完整会话事实统一存进 RuntimeHistory(all 轨道),再由不同策略投影出
 *   "发送给大模型的上下文"(model 轨道) / "给 UI 看的内容"(visible 轨道) /
 *   "计划与产物"(artifacts 轨道)。Memory 类不再代表完整历史本身,而是
 *   控制 model 轨道长度的策略。
 *
 * 演示四件事:
 *   1. RuntimeHistory 直接使用 —— append / project 轨道 / 自定义轨道 / 主题
 *   2. 投影策略 —— SlidingWindowPolicy / TokenBudgetPolicy / estimateMessageTokens
 *   3. 三种内置 Memory —— SlidingWindowMemory / TokenAwareMemory / SummarizingMemory
 *   4. 与 Agent 集成 —— 注入自定义 memory,对话后读取各轨道
 *
 * 运行:
 *   node examples/memory.js                       # 不需要 API Key,跑示例 1~3
 *   OPENAI_API_KEY=sk-xxx node examples/memory.js  # 额外跑示例 4(真实对话)
 *   DEEPSEEK_API_KEY=sk-xxx node examples/memory.js
 */
import {
  Agent,
  RuntimeHistory,
  SlidingWindowPolicy,
  TokenBudgetPolicy,
  estimateMessageTokens,
  SlidingWindowMemory,
  TokenAwareMemory,
  SummarizingMemory,
} from '../src/index.js'

// ==================== 示例 1: RuntimeHistory 直接使用 ====================

function example1_runtimeHistory() {
  console.log('\n=== 示例 1: RuntimeHistory 轨道投影 ===\n')

  const history = new RuntimeHistory()

  // 追加会话消息 —— 默认进入 all + model 轨道;user / 无 tool_calls 的
  // assistant 还会进入 visible 轨道(适合直接展示给用户)。
  history.appendMessage({ role: 'system', content: '你是一个有用的助手' })
  history.appendMessage({ role: 'user', content: '北京天气怎么样?' })
  history.appendMessage({
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }],
  })
  history.appendMessage({ role: 'tool', tool_call_id: 'c1', content: '晴,26°C' })
  history.appendMessage({ role: 'assistant', content: '北京今天晴,26°C。' })

  // 追加一个产物(artifact) —— 只进 all + artifacts 轨道,不会污染模型上下文。
  history.appendArtifact({ kind: 'final_answer', content: '北京今天晴,26°C。' })

  console.log('all（完整事实源）事件数:', history.getEvents('all').length)

  const visible = history.projectMessages('visible')
  console.log('\nvisible（适合 UI 展示）:')
  for (const m of visible) console.log(`  ${m.role}: ${m.content}`)

  const model = history.projectMessages('model')
  console.log('\nmodel（发送给大模型,含工具调用往返）消息数:', model.length)
  console.log('  角色序列:', model.map(m => m.role).join(' → '))

  const artifacts = history.project('artifacts')
  console.log('\nartifacts:', artifacts.map(a => a.kind).join(', '))

  // ---- 自定义轨道 —— 用 include 谓词把"工具往返"单独拎成一条轨道 ----
  history.registerTrack('tool-trace', {
    description: '工具调用与结果',
    include: (event) =>
      event.type === 'message'
      && (event.message.role === 'tool'
        || (event.message.role === 'assistant' && Array.isArray(event.message.tool_calls))),
  })
  console.log('\n已注册轨道:', history.listTracks().join(', '))
  console.log('tool-trace 轨道事件数:', history.getEvents('tool-trace').length)

  // ---- 主题(topic)—— model 投影默认只取当前主题,便于多话题隔离 ----
  history.setActiveTopic('trip-planning')
  history.appendMessage({ role: 'user', content: '帮我规划周末去哪玩' })
  console.log('\n当前主题:', history.getActiveTopic())
  console.log('当前主题 model 投影消息数:', history.projectMessages('model').length, '(只含本主题)')
}

// ==================== 示例 2: 投影策略(直接作用于消息数组) ====================

function example2_policies() {
  console.log('\n=== 示例 2: 投影策略 SlidingWindow / TokenBudget ===\n')

  // 造一段较长的对话:1 条 system + 12 条 user/assistant 往返
  const messages = [{ role: 'system', content: '你是助手' }]
  for (let i = 1; i <= 6; i++) {
    messages.push({ role: 'user', content: `问题 ${i}`.repeat(20) })
    messages.push({ role: 'assistant', content: `回答 ${i}`.repeat(20) })
  }

  console.log('原始非 system 消息数:', messages.filter(m => m.role !== 'system').length)

  // 滑动窗口 —— 只保留最近 N 条(system 始终保留)
  const sliding = new SlidingWindowPolicy(4).apply(messages)
  console.log('\nSlidingWindowPolicy(4) 后:', sliding.length, '条')
  console.log('  保留:', sliding.map(m => m.role).join(', '))

  // Token 预算 —— 按估算 token 从后往前保留,不超预算
  const totalTokens = messages.reduce((s, m) => s + estimateMessageTokens(m), 0)
  console.log('\n全量估算 tokens:', totalTokens, '(estimateMessageTokens 求和)')
  const budgeted = new TokenBudgetPolicy(120).apply(messages)
  console.log('TokenBudgetPolicy(120) 后:', budgeted.length, '条,估算 tokens:',
    budgeted.reduce((s, m) => s + estimateMessageTokens(m), 0))

  // 两个策略都会避免把 assistant(tool_calls) 与其 tool 结果拆散(防孤儿工具消息)。
  console.log('\n策略保证不产生孤儿 tool 消息(裁剪点对齐工具调用对)。')
}

// ==================== 示例 3: 三种内置 Memory ====================

async function example3_memoryStrategies() {
  console.log('\n=== 示例 3: SlidingWindow / TokenAware / Summarizing Memory ===\n')

  function seed(memory, turns = 8) {
    memory.add({ role: 'system', content: '你是助手' })
    for (let i = 1; i <= turns; i++) {
      memory.add({ role: 'user', content: `第 ${i} 个问题` })
      memory.add({ role: 'assistant', content: `第 ${i} 个回答` })
    }
    return memory
  }

  // 1) 滑动窗口 —— getMessages() 返回裁剪后的模型上下文,
  //    runtimeHistory.all 仍保留全部事实。
  const sw = seed(new SlidingWindowMemory(6))
  console.log('SlidingWindowMemory(6):')
  console.log('  getMessages() 模型上下文:', sw.getMessages().length, '条')
  console.log('  runtimeHistory(all) 完整事实:', sw.runtimeHistory.getEvents('all').length, '条')

  // 2) Token 感知 —— 按 token 预算从后往前保留(预算调小以触发裁剪)
  const ta = seed(new TokenAwareMemory(20))
  const taFull = ta.runtimeHistory.getEvents('all').length
  console.log('\nTokenAwareMemory(20):')
  console.log('  getMessages() 模型上下文:', ta.getMessages().length, `条(从全部 ${taFull} 条按 token 预算裁剪)`)

  // 3) 摘要记忆 —— 超阈值时用 summarizer 压缩旧消息。
  //    这里用一个离线假 summarizer(真实场景由 LLM 生成),避免示例依赖网络。
  const sm = new SummarizingMemory({
    threshold: 6,
    keepRecent: 2,
    summarizer: async (text) => `【摘要】共压缩 ${text.split('\n').length} 行历史`,
  })
  seed(sm, 8)
  const projected = await sm.getMessages()    // 异步 —— 触发摘要
  console.log('\nSummarizingMemory(threshold=6, keepRecent=2):')
  console.log('  getMessages() 压缩后:', projected.length, '条')
  console.log('  首条(摘要并入 system):', `${projected[0].role}: ${String(projected[0].content).slice(0, 30)}...`)
  console.log('  lastSummary:', sm.lastSummary)
  console.log('  runtimeHistory(all) 仍保留全部:', sm.runtimeHistory.getEvents('all').length, '条')
}

// ==================== 示例 4: 与 Agent 集成(需要 API Key) ====================

async function example4_withAgent() {
  console.log('\n=== 示例 4: Agent 注入自定义 memory + 读取轨道 ===\n')

  const apiKey = process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY
  if (!apiKey) {
    console.log('(未设置 OPENAI_API_KEY / DEEPSEEK_API_KEY,跳过真实对话)')
    console.log('设置后会:用 SlidingWindowMemory 构造 Agent → 对话 → 打印 visible/model 轨道:')
    console.log('  OPENAI_API_KEY=sk-xxx node examples/memory.js')
    return
  }

  const useDeepseek = !!process.env.DEEPSEEK_API_KEY && !process.env.OPENAI_API_KEY
  const agent = new Agent({
    provider: useDeepseek ? 'deepseek' : 'openai',
    apiKey,
    model: useDeepseek ? 'deepseek-chat' : 'gpt-4',
    systemPrompt: '你是一个有用的助手,请用中文回答。',
    // 注入自定义 memory —— 不传则默认 SummarizingMemory。
    memory: new SlidingWindowMemory(40),
  })

  await agent.chat('用一句话介绍你自己')
  await agent.chat('刚才我问了你什么?')

  const visible = await agent.getHistory('visible')
  const model = await agent.getHistory('model')
  const artifacts = await agent.getArtifacts()

  console.log('visible 轨道(适合 UI):')
  for (const m of visible) console.log(`  ${m.role}: ${String(m.content).slice(0, 50)}`)
  console.log('\nmodel 轨道消息数:', model.length)
  console.log('artifacts 轨道条数:', artifacts.length)
}

// ==================== 运行 ====================

example1_runtimeHistory()
example2_policies()
await example3_memoryStrategies()
await example4_withAgent()

console.log('\n完成')
