import test from 'node:test'
import assert from 'node:assert'
import { AGENT_TOOL_DESCRIPTION, renderContract } from './contract.js'

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
