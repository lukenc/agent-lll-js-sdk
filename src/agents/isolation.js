/**
 * worktree 隔离（Node-only）。
 *
 * **状态：搁置 —— Node-only 实验特性，不是推荐的隔离路径。** 实现完整、有测试
 * 覆盖，代码保留，但跨 agent 安全的主线是产物轨（`artifacts.js`）。原因有二：
 * 一是目标环境包含浏览器，那里没有 git worktree，一个在一半目标环境里不存在的
 * 机制不能承担主方案；二是它与 DAG 语义相冲突 —— 一个 DAG 节点是一个子任务、
 * 由一个 subagent 执行，若每个 subagent 各自一个 worktree，下游看到的是上游动手
 * **之前**的仓库状态，据此产生的修改必然与上游错位且不会报错。所以 `agent_graph`
 * / `graph_start` **有意不提供** `isolation` 参数，图节点共享工作区。它仍然适用
 * 于一种情形：Node 环境下、经 `agent` 工具直接派发的、彼此独立且不需要看到对方
 * 改动的并行任务。
 *
 * **框架不重写工具入参** —— `read_file` / `write_file` / `shell_exec` 是主机提供
 * 的，框架无权改其语义；静默把路径重写到 worktree 里会造出"看起来隔离、实际没
 * 隔离"的错觉，而这是最坏的结果：主机会信它。工作目录因此只以两种**通告**方式
 * 传达 —— 写进子 agent 首条消息里的上下文事实（见 `contract.renderContract`），
 * 以及工具执行时的 `ctx.cwd`（见 `runner._runOnce`）。**主机工具认不认 `ctx.cwd`
 * 由主机自己决定，框架给不出保证。** git 在这里的价值正是：它给的是真隔离，补上
 * 约定给不了的那一半。
 *
 * 全部失败都软失败 —— 抛 `WorktreeIsolationError`，由 `runtime.spawn` 转成一句
 * 可纠正的话回给模型（"不带 isolation 参数重试"），而不是让一次派活炸掉。
 */
import { WorktreeIsolationError } from './errors.js'

const DEFAULT_WORKTREE_BASE_DIR = '.worktrees'
const DEFAULT_BRANCH_PREFIX = 'subagent/'

/** 同名分支最多顺延到几号（与 `mcp/namespace.js` 的 `_2/_3` 去重同风格）。 */
const MAX_BRANCH_CANDIDATES = 3

/**
 * 默认 exec：spawn 一个 git 子进程。
 *
 * `node:child_process` 走**动态 import** —— `agents/` 要能被打进浏览器包，
 * 顶层静态 import 一个 node 内置模块会让打包直接失败（同 `skills/providers/local.js`）。
 */
async function defaultExec(cmd, args, { cwd } = {}) {
  const { spawn } = await import('node:child_process')
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr, code })
      else reject(Object.assign(new Error(stderr.trim() || `${cmd} exited ${code}`), { code, stderr }))
    })
  })
}

function isNodeRuntime() {
  return typeof process !== 'undefined' && !!process.versions?.node
}

/**
 * git 输出可能带远程 URL，而远程 URL 可能带凭据
 * （`https://user:ghp_xxx@github.com/...`）。这些消息会一路走进错误字符串、
 * `agent.cancelled` 事件与回给模型的软失败提示 —— 先把 userinfo 抹掉再放行，
 * 并压成一行、截断，免得一段 git 长篇大论挤爆主 agent 的上下文。
 */
function redactGitOutput(text, max = 200) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  const redacted = flat.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, '$1***@')
  return redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted
}

/**
 * 跑一条 git 命令并把两种失败约定归一。
 *
 * 内置的 `defaultExec` 在非零退出码时 reject，但注入的 exec（测试假件、主机
 * 自带的沙箱执行器）完全可能**以 `code: 1` 正常 resolve**。只 catch 不看 code
 * 的写法会把 `git check-ignore` 的"没被忽略"读成"被忽略了" —— 那正是这里唯一
 * 一道硬拒绝的检查，读反了就会往未被 gitignore 的目录里建 worktree。
 */
async function runGit(exec, args, opts) {
  const result = await exec('git', args, opts)
  const code = result?.code
  if (typeof code === 'number' && code !== 0) {
    const detail = redactGitOutput(result?.stderr || result?.stdout)
    throw Object.assign(new Error(detail || `git ${args[0]} exited ${code}`), { code })
  }
  return result ?? { stdout: '', stderr: '', code: 0 }
}

/** 从任意异常里取一段可以安全示人的说明。 */
function describe(err) {
  return redactGitOutput(err?.message ?? err) || 'unknown error'
}

/**
 * 给一个 subagent 建独立 worktree + 分支。
 *
 * @param {object} args
 * @param {string} args.agentId 注册表分配的 id（`agt_<hex>`，因此可以直接进路径与分支名）
 * @param {string} [args.baseDir] worktree 根目录，相对仓库根。**必须已被 gitignore**
 * @param {string} [args.branchPrefix]
 * @param {string} [args.cwd] 探测仓库根时的起始目录，默认进程 cwd
 * @param {(cmd: string, args: string[], opts?: { cwd?: string }) => Promise<{ stdout?: string, stderr?: string, code?: number }>} [args.exec]
 * @param {boolean} [args.isNode]
 * @returns {Promise<{ path: string, branch: string, repoRoot: string }>}
 * @throws {WorktreeIsolationError} reason ∈ not_node / not_a_git_repo / git_unavailable /
 *   base_dir_not_ignored / worktree_add_failed
 */
export async function createWorktree({
  agentId, baseDir = DEFAULT_WORKTREE_BASE_DIR, branchPrefix = DEFAULT_BRANCH_PREFIX, cwd,
  exec = defaultExec, isNode = isNodeRuntime(),
}) {
  if (!isNode) {
    throw new WorktreeIsolationError('worktree isolation requires Node.js', { reason: 'not_node' })
  }

  let repoRoot
  try {
    const { stdout } = await runGit(exec, ['rev-parse', '--show-toplevel'], { cwd })
    repoRoot = String(stdout ?? '').trim()
  } catch (err) {
    const reason = /not a git repository/i.test(String(err?.message ?? '')) ? 'not_a_git_repo' : 'git_unavailable'
    throw new WorktreeIsolationError(`worktree isolation unavailable: ${describe(err)}`, { reason, cause: err })
  }
  if (!repoRoot) {
    throw new WorktreeIsolationError('worktree isolation unavailable: empty repo root', { reason: 'not_a_git_repo' })
  }

  // baseDir 必须被 gitignore，否则 worktree 里的东西会被当成仓库里的新文件，
  // 跟着下一次 `git add -A` 提交进去。这条不软化成警告：默默把几千个文件塞进
  // 别人的提交，比不给隔离糟得多。
  //
  // 问的是**将要创建的那个路径**而不是 baseDir 本身 —— `.gitignore` 里写
  // `.worktrees/`（带斜杠，最常见的写法）时 `check-ignore .worktrees` 返回 1：
  // 目录型 pattern 匹配不上一个还不存在、因而 git 无法判定其为目录的路径。问
  // 完整路径两种写法（`.worktrees` / `.worktrees/`）都答得对。
  const relBase = String(baseDir).replace(/^\.\/+/, '').replace(/\/+$/, '')
  const relPath = `${relBase}/agent-${agentId}`
  try {
    await runGit(exec, ['check-ignore', '-q', relPath], { cwd: repoRoot })
  } catch (err) {
    throw new WorktreeIsolationError(
      `worktree base directory "${relBase}" is not gitignored — add it to .gitignore first, `
      + 'otherwise the worktree contents get committed into the repository.',
      { reason: 'base_dir_not_ignored', cause: err },
    )
  }

  const path = `${repoRoot}/${relPath}`
  let lastError = null
  for (let n = 1; n <= MAX_BRANCH_CANDIDATES; n++) {
    const branch = n === 1 ? `${branchPrefix}${agentId}` : `${branchPrefix}${agentId}_${n}`
    try {
      await runGit(exec, ['worktree', 'add', path, '-b', branch], { cwd: repoRoot })
      return { path, branch, repoRoot }
    } catch (err) {
      lastError = err
      // 只有"这名字被占了"值得换个名字再试；磁盘满、路径已存在之类换名字也没用。
      if (!/already exists/i.test(String(err?.message ?? ''))) break
    }
  }
  throw new WorktreeIsolationError(
    `git worktree add failed: ${describe(lastError)}`,
    { reason: 'worktree_add_failed', cause: lastError },
  )
}

/**
 * 收尾。
 *
 * 干净的树自动收掉；**只要还有没交代的东西就一律保留** —— 未提交的改动按文件数
 * 上报，交由主 agent 决定合并还是丢弃；已提交但未合并的提交则由 `git branch -d`
 * 自己拦下（用 `-d` 而不是 `-D`：判断"这些提交还有没有人要"是 git 的活，框架不
 * 该替它决定丢弃）。删分支失败不影响"worktree 目录已移除"这个事实，两件事分开报。
 *
 * 全程不抛：收尾失败最多是留下一个待清理的目录，不该把一次成功的子任务变成失败。
 *
 * @returns {Promise<{ removed: boolean, changedFiles: number, branchRemoved: boolean }>}
 */
export async function finalizeWorktree({ path, branch, cwd, exec = defaultExec, isNode = isNodeRuntime() }) {
  if (!isNode || !path) return { removed: false, changedFiles: 0, branchRemoved: false }

  let changedFiles = 0
  try {
    const { stdout } = await runGit(exec, ['status', '--porcelain'], { cwd: path })
    changedFiles = String(stdout ?? '').split('\n').filter(line => line.trim().length > 0).length
  } catch {
    // 状态都读不出来（目录被人删了 / git 挂了）—— 什么都别动，如实报"没移除"。
    return { removed: false, changedFiles: 0, branchRemoved: false }
  }
  if (changedFiles > 0) return { removed: false, changedFiles, branchRemoved: false }

  try {
    await runGit(exec, ['worktree', 'remove', path], { cwd })
  } catch {
    return { removed: false, changedFiles: 0, branchRemoved: false }
  }

  let branchRemoved = false
  if (branch) {
    try {
      await runGit(exec, ['branch', '-d', branch], { cwd })
      branchRemoved = true
    } catch {
      // 分支上还有未合并的提交（或分支压根不存在）。目录已经没了，提交还在，
      // 主 agent 能靠分支名找回来。
      branchRemoved = false
    }
  }
  return { removed: true, changedFiles: 0, branchRemoved }
}
