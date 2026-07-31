import test from 'node:test'
import assert from 'node:assert'
import { Agent } from './agent.js'
import { resetBaseTools } from './tool-filter.js'

// 造带 subagents 的 Agent 会把元工具名写进进程级的 BASE_TOOLS Set，跑完还原。
test.after(() => resetBaseTools())

const baseOpts = { provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o' }
const askTool = (agent) => agent.getTools().find(t => t.name === 'ask_user')
const tick = () => new Promise(resolve => setImmediate(resolve))

test('配置 subagents 后即使没有 onAskUser 也注入 ask_user', () => {
  assert.ok(askTool(new Agent({ ...baseOpts, subagents: {} })))
  assert.strictEqual(askTool(new Agent({ ...baseOpts })), undefined)
})

test('旧的单参数 onAskUser 继续工作', async () => {
  const agent = new Agent({ ...baseOpts, hooks: { onAskUser: async (q) => `answered: ${q}` } })
  assert.strictEqual(await askTool(agent).execute({ question: 'ping' }), 'answered: ping')
})

test('hook 收到第二个参数 meta，带 askId 与归属', async () => {
  let meta = null
  const agent = new Agent({
    ...baseOpts, subagents: {},
    hooks: { onAskUser: async (_q, m) => { meta = m; return 'ok' } },
  })
  await askTool(agent).execute({ question: 'q' }, { agentId: 'main', agentName: 'main' })
  assert.ok(meta.askId)
  assert.strictEqual(meta.agentId, 'main')
  assert.strictEqual(meta.parentAgentId, 'main')
})

test('answerQuestion 定向应答，pendingQuestions 可列', async () => {
  const agent = new Agent({ ...baseOpts, subagents: {} })
  const pendingPromise = askTool(agent).execute({ question: '选 A 还是 B？' }, { agentId: 'main', agentName: 'main' })
  await tick()

  const questions = agent.pendingQuestions()
  assert.strictEqual(questions.length, 1)
  assert.strictEqual(questions[0].question, '选 A 还是 B？')
  assert.strictEqual(agent.answerQuestion(questions[0].askId, '选 A'), true)
  assert.strictEqual(await pendingPromise, '选 A')
  assert.strictEqual(agent.pendingQuestions().length, 0)
})

test('hook 与 answerQuestion 竞速，先到先赢', async () => {
  let release
  const agent = new Agent({
    ...baseOpts, subagents: {},
    hooks: { onAskUser: () => new Promise(resolve => { release = resolve }) },
  })
  const p = askTool(agent).execute({ question: 'q' }, { agentId: 'main', agentName: 'main' })
  await tick()
  const [{ askId }] = agent.pendingQuestions()
  agent.answerQuestion(askId, 'from api')
  release('from hook')
  assert.strictEqual(await p, 'from api')
})

test('closeSubagents 拒掉全部待答提问，不留悬挂 Promise', async () => {
  const agent = new Agent({ ...baseOpts, subagents: {} })
  const p = askTool(agent).execute({ question: 'q' }, { agentId: 'main', agentName: 'main' })
  await tick()
  await agent.closeSubagents()
  assert.match(await p, /cancelled/i)
  assert.match(await p, /runtime closed/)
})

// ---- 以下三条覆盖 brief 未展开、但正是本任务立意所在的路径 ----

test('answerQuestion 抢先后，迟到的 hook 回答是静默 no-op', async () => {
  let release
  const agent = new Agent({
    ...baseOpts, subagents: {},
    hooks: { onAskUser: () => new Promise(resolve => { release = resolve }) },
  })
  const p = askTool(agent).execute({ question: 'q' }, { agentId: 'main', agentName: 'main' })
  await tick()
  const [{ askId }] = agent.pendingQuestions()
  agent.answerQuestion(askId, 'from api')
  assert.strictEqual(await p, 'from api')
  // hook 后到：既不抛，也不改已 settle 的结果，且不复活这条提问
  release('from hook')
  await tick()
  assert.strictEqual(agent.pendingQuestions().length, 0)
  assert.strictEqual(agent.answerQuestion(askId, 'third'), false)
})

test('reset() 也会 settle 掉待答提问（它借道 closeSubagents）', async () => {
  const agent = new Agent({ ...baseOpts, subagents: {} })
  const p = askTool(agent).execute({ question: 'q' }, { agentId: 'main', agentName: 'main' })
  await tick()
  assert.strictEqual(agent.pendingQuestions().length, 1)
  agent.reset()
  assert.match(await p, /cancelled/i)
  assert.strictEqual(agent.pendingQuestions().length, 0)
  // 拆完还能继续用：reset 不废掉登记表
  const p2 = askTool(agent).execute({ question: 'again' }, { agentId: 'main', agentName: 'main' })
  await tick()
  const [{ askId }] = agent.pendingQuestions()
  assert.strictEqual(agent.answerQuestion(askId, 'sure'), true)
  assert.strictEqual(await p2, 'sure')
})

test('hook 抢先后，answerQuestion 是静默 no-op（竞速的另一个方向）', async () => {
  const agent = new Agent({
    ...baseOpts, subagents: {},
    hooks: { onAskUser: async () => 'from hook' },
  })
  // hook 一来就 settle，抢不到快照窗口，所以 askId 从 ask.user 事件里取。
  let askId = null
  agent.on('ask.user', (payload) => { askId = payload.askId })
  const p = askTool(agent).execute({ question: 'q' }, { agentId: 'main', agentName: 'main' })
  assert.strictEqual(await p, 'from hook')
  assert.ok(askId)
  assert.strictEqual(agent.answerQuestion(askId, 'from api'), false)
  assert.strictEqual(agent.pendingQuestions().length, 0)
})

test('subagent 的提问带自己的身份，期间 handle 是 waiting_input', async () => {
  const metas = []
  // 假子 Agent：一进 chat 就走自己的 onAskUser，等回答。
  const createAgent = (options) => ({
    options,
    lastStopReason: null,
    on() { return this }, off() { return this },
    getLastRunMetrics: () => null,
    async chat() { return `child got: ${await options.hooks.onAskUser('which db?')}` },
    async closeMCPClients() {},
  })
  const agent = new Agent({
    ...baseOpts,
    subagents: { createAgent },
    hooks: { onAskUser: (_q, meta) => { metas.push(meta) } },
  })

  let handle = null
  const task = agent.subagents.spawn({
    description: 'Audit auth flow', prompt: 'go', background: false,
    onHandle: (h) => { handle = h },
  })
  await tick()

  const [question] = agent.pendingQuestions()
  assert.strictEqual(question.question, 'which db?')
  assert.strictEqual(question.agentId, handle.agentId)
  assert.strictEqual(question.agentName, handle.name)
  assert.strictEqual(question.parentAgentId, 'main')
  assert.strictEqual(question.taskDescription, 'Audit auth flow')
  // 主机 hook 也看得见子 agent 的提问，且归属是子 agent 而不是 main
  assert.strictEqual(metas.length, 1)
  assert.strictEqual(metas[0].agentId, handle.agentId)
  // 阻塞在提问上的 agent 在 agent_status 里可见为 waiting_input
  assert.strictEqual(handle.state, 'waiting_input')

  assert.strictEqual(agent.answerQuestion(question.askId, 'postgres'), true)
  const result = await task
  assert.match(result, /child got: postgres/)
  assert.strictEqual(handle.state, 'succeeded')
})

test('agent_cancel 会 settle 掉被取消 agent 的待答提问，它不再卡在 ask_user 上', async () => {
  const createAgent = (options) => ({
    options,
    lastStopReason: null,
    on() { return this }, off() { return this },
    getLastRunMetrics: () => null,
    async chat() { return `child got: ${await options.hooks.onAskUser('which db?')}` },
    async closeMCPClients() {},
  })
  const agent = new Agent({ ...baseOpts, subagents: { createAgent } })
  let handle = null
  const task = agent.subagents.spawn({
    description: 'Audit auth flow', prompt: 'go', background: false,
    onHandle: (h) => { handle = h },
  })
  await tick()
  assert.strictEqual(agent.pendingQuestions().length, 1)

  const cancelTool = agent.getTools().find(t => t.name === 'agent_cancel')
  await cancelTool.execute({ agent_id: handle.agentId, reason: 'no longer needed' })
  assert.strictEqual(agent.pendingQuestions().length, 0)
  // 提问被 settle 掉了，所以子 agent 走完了这一轮而不是永远等着（这个 await 挂住
  // 就是这条测试要抓的 bug）。渲染成的头部必须是取消而不是成功。
  const result = await task
  assert.match(result, /^\[agent:[^\]]+ cancelled\]/)
  assert.match(result, /reason: no longer needed/)
  assert.strictEqual(handle.result.status, 'cancelled')
})

test('cancelQuestion 定向取消；未知 askId 返回 false；未配置 subagents 时安全空操作', async () => {
  const agent = new Agent({ ...baseOpts, subagents: {} })
  const p = askTool(agent).execute({ question: 'q' }, { agentId: 'main', agentName: 'main' })
  await tick()
  const [{ askId }] = agent.pendingQuestions()
  assert.strictEqual(agent.cancelQuestion('ask_nope', 'x'), false)
  assert.strictEqual(agent.cancelQuestion(askId, 'host closed the dialog'), true)
  assert.match(await p, /host closed the dialog/)

  const plain = new Agent({ ...baseOpts })
  assert.deepStrictEqual(plain.pendingQuestions(), [])
  assert.strictEqual(plain.answerQuestion('ask_000001', 'x'), false)
  assert.strictEqual(plain.cancelQuestion('ask_000001'), false)
})

test('subagents.ask.timeoutMs 传导到 AskRegistry', async () => {
  const agent = new Agent({ ...baseOpts, subagents: { ask: { timeoutMs: 20 } } })
  const answer = await askTool(agent).execute({ question: 'q' }, { agentId: 'main', agentName: 'main' })
  assert.match(answer, /did not answer/)
  assert.strictEqual(agent.pendingQuestions().length, 0)
})
