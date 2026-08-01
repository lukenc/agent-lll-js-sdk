import test from 'node:test'
import assert from 'node:assert'
import { AGENT_TOOL_DESCRIPTION, AGENT_GRAPH_DESCRIPTION, renderContract } from './contract.js'

test('Tool_Def.description 讲清两个字段的分工', () => {
  const d = AGENT_TOOL_DESCRIPTION
  // description 是标签，prompt 才是契约
  assert.match(d, /3-8 word/)
  assert.match(d, /`prompt`/)
  // 必须提到子 agent 不继承对话历史（否则模型写不全背景）
  assert.match(d, /does not (inherit|share)|不继承/i)
  // 必须提到 history_search 这条找回项目上下文的路
  assert.match(d, /history_search/)
  // 必须给出快/主力模型的选择指导
  assert.match(d, /model/)
  assert.ok(d.length > 400, 'description 太短，不足以约束契约质量')
})

test('AGENT_GRAPH_DESCRIPTION 讲清 depends_on 是安全边界而非调度提示', () => {
  const d = AGENT_GRAPH_DESCRIPTION
  // 核心机制：节点共享工作目录、无 per-node 隔离，所以无依赖路径的节点会并行跑
  assert.match(d, /share.*working directory|shared? working directory/i)
  assert.match(d, /no per-node isolation/i)
  assert.match(d, /concurrently/i)
  // 点 1：一个节点 = 一个单一、边界清晰的子任务
  assert.match(d, /one single, bounded subtask/i)
  // 点 2：文件重叠本身就是依赖，哪怕业务逻辑看起来无关
  assert.match(d, /depends_on whenever/i)
  assert.match(d, /unrelated at the business-logic level/i)
  // 点 3：拿不准就加边；两种代价不对称
  assert.match(d, /when unsure, add the edge/i)
  assert.match(d, /not symmetric/i)
  // 点 4：但不要编造不存在的顺序；判断标准是真实读写重叠，不是顺序舒不舒服
  assert.match(d, /do not invent ordering/i)
  assert.match(d, /genuine read\/write overlap/i)
  assert.match(d, /degenerates into sequential execution/i)
  // 点 5：depends_on 只能指向已声明的节点
  assert.match(d, /already declared/i)
  // 保留现有正确的部分：声明不创建实例；ready 节点等待 graph_start；auto 仅用于预先确定的工作
  assert.match(d, /does NOT create agents/)
  assert.match(d, /graph_start/)
  assert.match(d, /on_ready "auto"/)
  assert.match(d, /fully determined in advance/i)
  assert.ok(d.length > 400, 'description 太短，不足以约束依赖声明质量')
})

test('AGENT_GRAPH_DESCRIPTION 与 AGENT_TOOL_DESCRIPTION 是同一寄存器：都用 Markdown 小标题分节', () => {
  assert.match(AGENT_GRAPH_DESCRIPTION, /^##\s/m)
  assert.match(AGENT_TOOL_DESCRIPTION, /^##\s/m)
})

test('renderContract 输出包含 prompt 原文', () => {
  const text = renderContract({ description: 'Audit auth', prompt: '检查 src/auth 的越权风险，产出问题清单。' })
  assert.ok(text.includes('检查 src/auth 的越权风险，产出问题清单。'))
})

test('renderContract 是确定性的', () => {
  const args = { description: 'd', prompt: 'p' }
  assert.strictEqual(renderContract(args), renderContract(args))
})

test('cwd 存在时作为工作目录事实注入', () => {
  const text = renderContract({ description: 'd', prompt: 'p', cwd: '/tmp/wt/agent-1' })
  assert.ok(text.includes('/tmp/wt/agent-1'))
  assert.match(text, /working directory|工作目录/i)
})

test('cwd 缺失时不出现空的工作目录段', () => {
  const text = renderContract({ description: 'd', prompt: 'p' })
  assert.ok(!/working directory|工作目录/i.test(text))
})

test('inputs 渲染为上游产物段，含 key 与摘要', () => {
  const text = renderContract({
    description: 'd', prompt: 'p',
    inputs: [
      { key: 'docs/findings.md', agentName: 'explorer-1', summary: '6 处问题', sha: 'a1b2c3d4' },
      { key: 'src/probe.js', agentName: 'explorer-2', summary: '探针脚本', sha: 'd4e5f6a7' },
    ],
  })
  assert.ok(text.includes('docs/findings.md'))
  assert.ok(text.includes('explorer-1'))
  assert.ok(text.includes('6 处问题'))
  assert.ok(text.includes('src/probe.js'))
})

test('inputs 为空数组时不出现上游产物段', () => {
  const text = renderContract({ description: 'd', prompt: 'p', inputs: [] })
  assert.ok(!text.includes('upstream'))
})
