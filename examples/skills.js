/**
 * Skill 系统示例 — 让 Agent 按需加载「技能包」(SKILL.md + 参考文件)
 *
 * 演示内容:
 *   1. 本地文件夹 provider(examples/skills/ 下每个含 SKILL.md 的子目录是一个技能)
 *   2. 三级渐进披露:
 *      - Level 1: 技能名 + 描述自动注入系统提示(每轮重算,不持久化)
 *      - Level 2: LLM 调用 `skill` 元工具 → SKILL.md 正文进入上下文
 *      - Level 3: 技能附带文件(references/ 等) → LLM 用 read_file 按需读取
 *   3. disable-model-invocation: 对 LLM 隐藏、宿主代码可读
 *   4. refreshSkills(): 运行中重新扫描技能目录
 *
 * 运行:OPENAI_API_KEY=sk-xxx node examples/skills.js
 *
 * 想从远端加载技能?把 providers 换成 HTTP provider 即可(wire 协议见
 * docs/superpowers/specs/2026-07-28-skill-system-design.md):
 *   providers: [{ type: 'http', baseUrl: 'https://example.com/skill-source' }]
 */
import { readFile } from 'fs/promises'
import { resolve, sep } from 'path'
import { fileURLToPath } from 'url'
import { Agent, defineTool } from '../src/index.js'

const SKILLS_DIR = fileURLToPath(new URL('./skills', import.meta.url))

// Level 3 需要一个文件读取工具。这里定义一个只允许读技能目录的 read_file,
// 避免示例代码变成任意文件读取。
const readSkillFile = defineTool({
  name: 'read_file',
  description: '读取技能目录下的文件,传入绝对路径(skill 工具的结果里会给出技能的 base directory)',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件绝对路径' },
    },
    required: ['path'],
  },
  execute: async ({ path }) => {
    const target = resolve(path)
    if (!target.startsWith(SKILLS_DIR + sep)) {
      return `Error: 只允许读取 ${SKILLS_DIR} 下的文件`
    }
    return readFile(target, 'utf8')
  },
})

const agent = new Agent({
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4',
  systemPrompt: '你是一个有用的助手。系统提示末尾会列出可用技能;当用户请求与某个技能匹配时,先调用 skill 工具加载完整指令再作答。请用中文回答。',
  tools: [readSkillFile],
  skills: {
    providers: [{ type: 'local', dir: SKILLS_DIR }],
    // runtime: 'auto'(默认)在 Node 下等价于 'node';浏览器里会改注入 skill_resource 工具
    // filter: { threshold: 50, topK: 20 } — 技能超过 50 个才触发 sidecar 过滤,本示例用不到
  },
})

// ---- 1. 显式预加载并查看技能清单(不预加载也行,首次 chat/stream 前会自动加载) ----
await agent.loadSkills()

console.log('--- 已加载的技能 ---')
for (const s of agent.skills.list()) {
  const flags = s.disableModelInvocation ? ' [对 LLM 隐藏]' : ''
  console.log(`  ${s.name}@${s.version ?? '-'}${flags}: ${s.description}`)
  if (s.files.length > 1) console.log(`    附带文件: ${s.files.filter(f => f !== 'SKILL.md').join(', ')}`)
}

// disable-model-invocation 的技能不进系统提示清单,但宿主代码照样能读
const internal = agent.skills.get('internal-notes')
console.log('\n宿主读取隐藏技能 internal-notes:', internal ? '成功' : '失败')

// ---- 2. Level 1+2:清单在系统提示里,LLM 自己决定调用 skill 工具 ----
console.log('\n--- 触发 haiku-master 技能(Level 2) ---')
const reply = await agent.chat('给我写一首关于夏天的俳句')
console.log('Agent:', reply)

// ---- 3. Level 3:report-writer 的 SKILL.md 会指示 LLM 先 read_file 读模板 ----
console.log('\n--- 触发 report-writer 技能(Level 3,流式) ---')
agent.reset()
for await (const event of agent.stream('帮我写一份本周的工作周报,本周完成了登录模块开发,进度 80%')) {
  switch (event.type) {
    case 'delta':
      process.stdout.write(event.content)
      break
    case 'tool_start':
      console.log(`\n[调用工具: ${event.name}]`)
      break
    case 'tool_end':
      console.log(`[工具返回 ${String(event.result ?? '').length} 字符]`)
      break
    case 'done':
      console.log('\n--- 完成 ---')
      break
  }
}

// ---- 4. 运行中刷新技能(比如你刚往 examples/skills/ 里加了新目录) ----
await agent.refreshSkills()
console.log(`\nrefreshSkills 后技能数: ${agent.skills.list().length}`)
