/**
 * worktree 隔离的测试。
 *
 * **没有一个用例碰真 git** —— 全部经注入的 `exec` 假件跑。这不是图省事：真跑
 * `git worktree add/remove` 的测试会在开发者自己的仓库里留下（或删掉）工作树，
 * 一次失败的断言就能让人丢工作。
 */
import test from 'node:test'
import assert from 'node:assert'
import { createWorktree, finalizeWorktree } from './isolation.js'
import { WorktreeIsolationError } from './errors.js'
import { RuntimeHistory } from '../runtime-history.js'
import { createSubagentRuntime } from './runtime.js'
import { resetAgentTypes } from './types.js'

/** 假 exec：按命令前缀返回脚本化结果。 */
function fakeExec(script) {
  const calls = []
  return Object.assign(async (cmd, args) => {
    const key = `${cmd} ${args[0] ?? ''}`.trim()
    calls.push([cmd, ...args].join(' '))
    const handler = Object.entries(script).find(([prefix]) => key.startsWith(prefix))?.[1]
    if (!handler) return { stdout: '', stderr: '', code: 0 }
    if (handler instanceof Error) throw handler
    return handler
  }, { calls })
}

const okRepo = {
  'git rev-parse': { stdout: '/repo\n', code: 0 },
  'git check-ignore': { stdout: '.worktrees\n', code: 0 },
  'git worktree': { stdout: '', code: 0 },
  'git branch': { stdout: '', code: 0 },
  'git status': { stdout: '', code: 0 },
}

test('正常路径：建出 worktree 与分支', async () => {
  const exec = fakeExec(okRepo)
  const wt = await createWorktree({ agentId: 'agt_1', baseDir: '.worktrees', branchPrefix: 'subagent/', exec })
  assert.ok(wt.path.includes('agent-agt_1'))
  assert.strictEqual(wt.branch, 'subagent/agt_1')
  assert.ok(exec.calls.some(c => c.includes('worktree add')))
  // 问的是完整的 worktree 路径，不是 baseDir —— `.gitignore` 里写 `.worktrees/`
  // 时 `check-ignore .worktrees` 会答"没被忽略"（目录型 pattern 匹配不上一个
  // 还不存在的路径），据此拒绝创建就成了误报。
  assert.ok(exec.calls.includes('git check-ignore -q .worktrees/agent-agt_1'))
})

test('非 git 仓库 → not_a_git_repo', async () => {
  const exec = fakeExec({ 'git rev-parse': Object.assign(new Error('fatal: not a git repository'), { code: 128 }) })
  await assert.rejects(
    createWorktree({ agentId: 'a', baseDir: '.worktrees', branchPrefix: 'subagent/', exec }),
    (err) => err instanceof WorktreeIsolationError && err.reason === 'not_a_git_repo')
})

test('git 不可执行 → git_unavailable', async () => {
  const exec = fakeExec({ 'git rev-parse': Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }) })
  await assert.rejects(
    createWorktree({ agentId: 'a', baseDir: '.worktrees', branchPrefix: 'subagent/', exec }),
    (err) => err instanceof WorktreeIsolationError && err.reason === 'git_unavailable')
})

test('baseDir 未被 gitignore → 拒绝创建', async () => {
  const exec = fakeExec({
    ...okRepo,
    'git check-ignore': { stdout: '', code: 1 },
  })
  await assert.rejects(
    createWorktree({ agentId: 'a', baseDir: '.worktrees', branchPrefix: 'subagent/', exec }),
    (err) => err instanceof WorktreeIsolationError && err.reason === 'base_dir_not_ignored')
  assert.ok(!exec.calls.some(c => c.includes('worktree add')))
})

test('分支重名时加 _2 后缀', async () => {
  let firstAdd = true
  const exec = fakeExec(okRepo)
  const guarded = async (cmd, args) => {
    if (args.includes('add') && firstAdd) {
      firstAdd = false
      throw Object.assign(new Error("fatal: a branch named 'subagent/a' already exists"), { code: 128 })
    }
    return exec(cmd, args)
  }
  const wt = await createWorktree({ agentId: 'a', baseDir: '.worktrees', branchPrefix: 'subagent/', exec: guarded })
  assert.strictEqual(wt.branch, 'subagent/a_2')
})

test('worktree add 因别的原因失败 → worktree_add_failed，且不重试', async () => {
  const exec = fakeExec({
    ...okRepo,
    'git worktree': Object.assign(new Error('fatal: disk full'), { code: 128 }),
  })
  await assert.rejects(
    createWorktree({ agentId: 'a', baseDir: '.worktrees', branchPrefix: 'subagent/', exec }),
    (err) => err instanceof WorktreeIsolationError && err.reason === 'worktree_add_failed')
  assert.strictEqual(exec.calls.filter(c => c.includes('worktree add')).length, 1)
})

test('git 输出里的远程凭据不会随错误消息外泄', async () => {
  const exec = fakeExec({
    ...okRepo,
    'git worktree': { stdout: '', stderr: 'fatal: could not read https://user:s3cr3t@example.com/x.git', code: 128 },
  })
  await assert.rejects(
    createWorktree({ agentId: 'a', baseDir: '.worktrees', branchPrefix: 'subagent/', exec }),
    (err) => err.reason === 'worktree_add_failed'
      && !err.message.includes('s3cr3t')
      && err.message.includes('***@example.com'))
})

test('收尾：无改动时移除 worktree 与分支', async () => {
  const exec = fakeExec({ ...okRepo, 'git status': { stdout: '', code: 0 } })
  const out = await finalizeWorktree({ path: '/repo/.worktrees/agent-a', branch: 'subagent/a', exec })
  assert.strictEqual(out.removed, true)
  assert.strictEqual(out.changedFiles, 0)
  assert.strictEqual(out.branchRemoved, true)
  assert.ok(exec.calls.some(c => c.includes('worktree remove')))
})

test('收尾：有改动时保留并报告文件数', async () => {
  const exec = fakeExec({
    ...okRepo,
    'git status': { stdout: ' M src/a.js\n?? src/b.js\n M src/c.js\n', code: 0 },
  })
  const out = await finalizeWorktree({ path: '/repo/.worktrees/agent-a', branch: 'subagent/a', exec })
  assert.strictEqual(out.removed, false)
  assert.strictEqual(out.changedFiles, 3)
  assert.ok(!exec.calls.some(c => c.includes('worktree remove')))
})

test('收尾：分支有未合并提交时保留分支（worktree 仍移除）', async () => {
  const exec = fakeExec({
    ...okRepo,
    'git branch': { stdout: '', stderr: "error: the branch 'subagent/a' is not fully merged", code: 1 },
  })
  const out = await finalizeWorktree({ path: '/repo/.worktrees/agent-a', branch: 'subagent/a', exec })
  assert.strictEqual(out.removed, true)
  assert.strictEqual(out.branchRemoved, false)
  // 用 `-d` 而不是 `-D`：让 git 自己判断"这个分支上还有没人要的提交吗"，
  // 而不是由框架替它决定丢弃。
  assert.ok(exec.calls.some(c => c.includes('branch -d ')))
  assert.ok(!exec.calls.some(c => c.includes('branch -D')))
})

test('非 Node 运行时 → not_node', async () => {
  await assert.rejects(
    createWorktree({ agentId: 'a', baseDir: '.worktrees', branchPrefix: 'subagent/', exec: null, isNode: false }),
    (err) => err instanceof WorktreeIsolationError && err.reason === 'not_node')
})

// ---------------------------------------------------------------------------
// runtime 接线
// ---------------------------------------------------------------------------

function fakeParent(reply = '子 agent 报告') {
  return {
    _providerName: 'openai',
    model: 'gpt-4o', apiKey: 'sk-main', url: 'https://main/v1',
    simpleModel: 'gpt-4o-mini', simpleApiKey: 'sk-simple', simpleUrl: 'https://simple/v1',
    tools: [],
    hooks: {}, knowledgeBase: null, tokenBudget: null, validateStreamCompletion: true,
    memory: { runtimeHistory: new RuntimeHistory(), add() {} },
    _events: [],
    emit(type, payload) { this._events.push({ type, payload }) },
    _injected: [],
    enqueueMessage(msg) { this._injected.push(msg) },
    _reply: reply,
  }
}

function makeRuntime(parent, extra = {}, seen = {}) {
  return createSubagentRuntime({
    parent,
    createAgent: () => {
      const child = {
        lastStopReason: null,
        on() { return this }, off() { return this },
        getLastRunMetrics: () => ({ totalRounds: 1, totalLlmCalls: 1, totalToolCalls: 0, usage: null, wallClockMs: 5 }),
        async chat(text) {
          seen.contract = text
          seen.cwd = child._toolContextExtra?.cwd ?? null
          return parent._reply
        },
      }
      seen.child = child
      return child
    },
    ...extra,
  })
}

test.beforeEach(() => resetAgentTypes())

test('spawn 建出 worktree，把工作目录同时写进契约与 ctx.cwd，收尾时清理', async () => {
  const exec = fakeExec(okRepo)
  const seen = {}
  const rt = makeRuntime(fakeParent(), { isolation: { exec } }, seen)
  const out = await rt.spawn({
    description: 'x', prompt: '干活', background: false, isolation: { mode: 'worktree' },
  })
  assert.match(out, /succeeded/)

  const handle = rt.registry.list({ includeFinished: true })[0]
  assert.strictEqual(handle.isolation.mode, 'worktree')
  assert.strictEqual(handle.isolation.path, '/repo/.worktrees/agent-' + handle.agentId)
  assert.strictEqual(handle.isolation.branch, `subagent/${handle.agentId}`)
  // 两条**都是通告，不是保证**：框架不改写工具入参，主机工具认不认 cwd 由主机定。
  assert.ok(seen.contract.includes(handle.isolation.path))
  assert.strictEqual(seen.cwd, handle.isolation.path)
  // 干净的树自动收掉
  assert.strictEqual(handle.isolation.removed, true)
  assert.strictEqual(handle.isolation.dirty, false)
  assert.ok(exec.calls.some(c => c.includes('worktree remove')))
})

test('spawn 收尾：有改动的 worktree 保留，并写进给主 agent 的结果里', async () => {
  const exec = fakeExec({ ...okRepo, 'git status': { stdout: ' M a.js\n?? b.js\n', code: 0 } })
  const rt = makeRuntime(fakeParent(), { isolation: { exec } })
  const out = await rt.spawn({
    description: 'x', prompt: '干活', background: false, isolation: { mode: 'worktree' },
  })
  const handle = rt.registry.list({ includeFinished: true })[0]
  assert.strictEqual(handle.isolation.dirty, true)
  assert.strictEqual(handle.isolation.changedFiles, 2)
  assert.match(out, /--- worktree ---/)
  assert.match(out, /changed=2 files/)
  assert.ok(!exec.calls.some(c => c.includes('worktree remove')))
})

test('worktree 建不出来 → 软失败字符串 + handle 取消，绝不起 agent', async () => {
  const exec = fakeExec({ 'git rev-parse': Object.assign(new Error('fatal: not a git repository'), { code: 128 }) })
  const seen = {}
  const rt = makeRuntime(fakeParent(), { isolation: { exec } }, seen)
  const out = await rt.spawn({
    description: 'x', prompt: '干活', background: false, isolation: { mode: 'worktree' },
  })
  assert.match(out, /not_a_git_repo/)
  assert.match(out, /Retry without the isolation parameter/)
  assert.strictEqual(seen.child, undefined)
  const handle = rt.registry.list({ includeFinished: true })[0]
  assert.strictEqual(handle.state, 'cancelled')
  assert.strictEqual(handle.isolation, null)
})

test('不带 isolation 时一行 git 都不跑', async () => {
  const exec = fakeExec(okRepo)
  const rt = makeRuntime(fakeParent(), { isolation: { exec } })
  await rt.spawn({ description: 'x', prompt: '干活', background: false })
  assert.deepStrictEqual(exec.calls, [])
  assert.strictEqual(rt.registry.list({ includeFinished: true })[0].isolation, null)
})

test('还没排到并发槽就被取消：worktree 照样收干净', async () => {
  const exec = fakeExec(okRepo)
  const rt = makeRuntime(fakeParent(), { isolation: { exec } })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(rt.spawn({
    description: 'x', prompt: '干活', background: false,
    isolation: { mode: 'worktree' }, signal: controller.signal,
  }))
  assert.ok(exec.calls.some(c => c.includes('worktree add')))
  assert.ok(exec.calls.some(c => c.includes('worktree remove')))
})
