import test from 'node:test'
import assert from 'node:assert'
import { Agent } from './agent.js'
import { resetBaseTools } from './tool-filter.js'

// 造带 subagents 的 Agent 会把元工具名写进进程级的 BASE_TOOLS Set，跑完还原。
test.after(() => resetBaseTools())

const baseOpts = { provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o' }
const askTool = (agent) => agent.getTools().find(t => t.name === 'ask_user')
const tick = () => new Promise(resolve => setImmediate(resolve))

/** 假子 Agent：一进 chat 就走自己的 onAskUser，阻塞等回答。 */
const askingChild = (options) => ({
  options,
  lastStopReason: null,
  on() { return this }, off() { return this },
  getLastRunMetrics: () => null,
  async chat() { return `child got: ${await options.hooks.onAskUser('which db?')}` },
  async closeMCPClients() {},
})

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
  // 迟到的 hook 回答是静默 no-op：不抛，不覆盖已交付的回答，也不复活这条提问
  await tick()
  assert.strictEqual(agent.pendingQuestions().length, 0)
  assert.strictEqual(agent.answerQuestion(askId, 'third'), false)
})

test('closeSubagents 拒掉全部待答提问，不留悬挂 Promise', async () => {
  const agent = new Agent({ ...baseOpts, subagents: {} })
  const p = askTool(agent).execute({ question: 'q' }, { agentId: 'main', agentName: 'main' })
  await tick()
  await agent.closeSubagents()
  assert.match(await p, /cancelled/i)
  assert.match(await p, /runtime closed/)
})

// ---- 以下覆盖 brief 未展开、但正是本任务立意所在的路径 ----

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
  const agent = new Agent({
    ...baseOpts,
    subagents: { createAgent: askingChild },
    // 返回 undefined：主机只是"被通知"，回答走命令式通道（Web UI 的典型形态）
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
  const agent = new Agent({ ...baseOpts, subagents: { createAgent: askingChild } })
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

// ---- 宿主自带 ask_user 时的注入策略 ----
// 回归背景：配置 subagents 后，注入逻辑无条件把同名的宿主工具过滤掉，换成 SDK 版。
// 宿主那个走 IPC 弹窗、带富 schema（多选题）的 ask_user 就此被静默丢弃，而 SDK 版
// 在宿主没接 hooks.onAskUser 时没有任何送达通道 —— 提问登记进 AskRegistry 后既无
// hook 可通知，宿主也不知道要调 answerQuestion，timeoutMs 又默认 null，于是那次工具
// 调用永久挂起。表象是"流上几分钟没有事件后被看门狗掐断"，看起来像网络故障。

/** 宿主自带的 ask_user：富 schema（多选题），execute 走宿主自己的通道。 */
const hostAskUser = (record = []) => ({
  name: 'ask_user',
  description: 'host-owned ask_user with rich schema',
  parameters: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string' },
            options: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
    required: ['questions'],
  },
  execute: async (params, ctx = {}) => {
    record.push({ params, ctx })
    return `host answered: ${params.questions?.[0]?.question ?? params.question}`
  },
})

test('宿主自带的 ask_user 不被 SDK 版顶替：富 schema 与 execute 都保留', async () => {
  const calls = []
  const agent = new Agent({ ...baseOpts, subagents: {}, tools: [hostAskUser(calls)] })

  const tool = askTool(agent)
  // 工具表里只有一个 ask_user —— 保留宿主版不能变成"两个同名工具"。
  assert.strictEqual(agent.getTools().filter(t => t.name === 'ask_user').length, 1)
  // 富 schema 原样保留：模型看到的仍是宿主那个 questions 数组，而不是单个 question 串。
  assert.deepStrictEqual(tool.parameters, hostAskUser().parameters)

  const answer = await tool.execute(
    { questions: [{ question: '选 A 还是 B？', options: ['A', 'B'] }] },
    { agentId: 'main', agentName: 'main' },
  )
  assert.strictEqual(answer, 'host answered: 选 A 还是 B？')
  // 宿主 execute 拿到的是原样参数（含 options），不是被降级成字符串的问题。
  assert.strictEqual(calls.length, 1)
  assert.deepStrictEqual(calls[0].params.questions[0].options, ['A', 'B'])
})

test('宿主版 ask_user 仍登记进 AskRegistry：归属可见、可被取消', async () => {
  let release = null
  const agent = new Agent({
    ...baseOpts,
    subagents: {},
    tools: [{
      ...hostAskUser(),
      execute: () => new Promise(resolve => { release = resolve }),
    }],
  })

  const p = askTool(agent).execute(
    { questions: [{ question: '要删库吗？' }] },
    { agentId: 'main', agentName: 'main' },
  )
  await tick()

  // 登记表看得见这次提问 —— 归属标注是包装层存在的理由。
  const pending = agent.pendingQuestions()
  assert.strictEqual(pending.length, 1)
  assert.strictEqual(pending[0].agentId, 'main')
  assert.match(pending[0].question, /要删库吗/)

  // 宿主自己的通道答上来，结果原样交还给模型。
  release('不要')
  assert.strictEqual(await p, '不要')
  assert.strictEqual(agent.pendingQuestions().length, 0)
})

test('宿主版挂起时 answerQuestion 仍可解围（宿主 UI 被关掉的情形）', async () => {
  let hostCalled = false
  const agent = new Agent({
    ...baseOpts,
    subagents: {},
    // 永不 settle：模拟宿主弹窗打开后用户直接关掉窗口
    tools: [{
      ...hostAskUser(),
      execute: () => { hostCalled = true; return new Promise(() => {}) },
    }],
  })

  const p = askTool(agent).execute({ questions: [{ question: 'q' }] }, { agentId: 'main', agentName: 'main' })
  await tick()
  // 宿主通道确实被走了 —— 少了这条断言，SDK 版顶替宿主版时这个测试照样通过。
  assert.ok(hostCalled, '包装层必须真的调用宿主的 execute')
  const [{ askId }] = agent.pendingQuestions()
  assert.strictEqual(agent.answerQuestion(askId, '命令式通道的回答'), true)
  assert.strictEqual(await p, '命令式通道的回答')
})

test('子 agent 继承的是宿主版 ask_user，且提问归属到子 agent 自己', async () => {
  const seen = []
  /** 假子 Agent：走继承来的 ask_user **工具**（而不是 hook），带上自己的归属 ctx。 */
  const toolCallingChild = (options) => ({
    options,
    lastStopReason: null,
    on() { return this }, off() { return this },
    getLastRunMetrics: () => null,
    async chat() {
      const tool = options.tools.find(t => t.name === 'ask_user')
      return `child got: ${await tool.execute(
        { questions: [{ question: 'which db?' }] },
        { agentId: options._agentId, agentName: options._agentName },
      )}`
    },
    async closeMCPClients() {},
  })

  const agent = new Agent({
    ...baseOpts,
    subagents: { createAgent: toolCallingChild },
    tools: [{
      ...hostAskUser(seen),
      execute: async (params) => `host answered: ${params.questions?.[0]?.question}`,
    }],
  })

  let handle = null
  const task = agent.subagents.spawn({
    description: 'Audit auth flow', prompt: 'go', background: false,
    onHandle: (h) => { handle = h },
  })
  await tick()

  // 子 agent 的工具表里也只能有一个 ask_user：父的闭包被继承下去，子构造时不能再叠一个。
  const childTools = handle._child.options.tools.filter(t => t.name === 'ask_user')
  assert.strictEqual(childTools.length, 1)
  // 而且是宿主那个富 schema 版本，不是 SDK 的单串版。
  assert.deepStrictEqual(childTools[0].parameters, hostAskUser().parameters)

  // 提问经宿主通道答复，结果原样回到子 agent。
  assert.match(await task, /child got: host answered: which db\?/)
  assert.strictEqual(handle.state, 'succeeded')
})

test('继承来的 SDK 包装被留用而不是再包一层（否则一次提问会登记进两张表）', async () => {
  let releaseHost = null
  const parent = new Agent({
    ...baseOpts,
    subagents: {},
    tools: [{ ...hostAskUser(), execute: () => new Promise(r => { releaseHost = r }) }],
  })
  // 子 agent 继承的就是父那张**已经包过**的工具表（runner 的 `'*'` 分支原样传下去），
  // 而子 Agent 的构造会再次走到 ask_user 注入分支。
  const child = new Agent({ ...baseOpts, subagents: {}, tools: parent.tools })

  const tool = child.getTools().find(t => t.name === 'ask_user')
  assert.strictEqual(child.getTools().filter(t => t.name === 'ask_user').length, 1)
  // 留用 = 原样复用父的那个闭包对象,而不是造一个新的把它裹起来。
  assert.strictEqual(tool, parent.getTools().find(t => t.name === 'ask_user'))

  const p = tool.execute({ questions: [{ question: 'q' }] }, { agentId: 'main', agentName: 'main' })
  await tick()
  await tick()

  // 闭包捕获的是**父**的登记表,所以提问登记在父这边 —— 这正是 runner 想要的归属:
  // 子 agent 的提问要出现在编排者那张全局待答清单上。关键是它**只**登记一次:
  // 再包一层的话子、父两张表各有一条,主机用命令式通道只答得掉外层那条,内层那条
  // 永远留在父的表里,宿主 UI 上就是一个永不消失的幽灵提问。
  assert.strictEqual(parent.pendingQuestions().length, 1)
  assert.strictEqual(child.pendingQuestions().length, 0, '同一次提问不能登记进第二张表')

  const [{ askId }] = parent.pendingQuestions()
  parent.answerQuestion(askId, 'API 答案')
  assert.strictEqual(await p, 'API 答案')
  await tick()
  assert.strictEqual(parent.pendingQuestions().length, 0, '不能留下答不掉的残留')
  releaseHost?.('late')
})
