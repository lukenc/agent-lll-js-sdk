/**
 * token 计量测试 —— 设计说明见 docs/design/context-manager.md。
 *
 * 分两部分：
 *   F. 结构开销 —— 消息的 role 框架、tool_calls、工具 schema 的真实成本
 *   G. usage 锚定 —— 用上一次真实用量做基准，只对增量估算
 */

import { test, describe } from 'node:test'
import assert from 'node:assert'
import {
  ContextManager,
  estimateTokens,
  estimateMessageTokens,
  estimateToolsTokens,
  headerFingerprint,
  ROLE_OVERHEAD,
  BLOCK_OVERHEAD,
} from './context-manager.js'

// ---------------------------------------------------------------- F 结构开销

describe('F 结构开销：消息计价', () => {
  test('基准锚定值：单条 4 字符文本消息 = 9 tokens', () => {
    // 4 字符 / 4 = 1，+ BLOCK_OVERHEAD 4，+ ROLE_OVERHEAD 4
    assert.equal(estimateMessageTokens({ role: 'user', content: 'abcd' }), 9)
  })

  test('每条消息都要算 role 框架开销', () => {
    const empty = estimateMessageTokens({ role: 'user', content: '' })
    assert.ok(empty >= ROLE_OVERHEAD, `空消息也有框架成本，实得 ${empty}`)
  })

  test('tool_calls 单独计价：函数名 + 参数 + 框架', () => {
    const plain = estimateMessageTokens({ role: 'assistant', content: 'hi' })
    const withCall = estimateMessageTokens({
      role: 'assistant',
      content: 'hi',
      tool_calls: [{
        id: 'c1', type: 'function',
        function: { name: 'read_file', arguments: '{"path":"/tmp/a.txt"}' },
      }],
    })
    assert.ok(withCall > plain, '带工具调用的消息必须更贵')
    // name(9字符→3) + arguments(21字符→6) + BLOCK(4) = 13
    assert.equal(withCall - plain, 13, `工具调用开销应为 13，实得 ${withCall - plain}`)
  })

  test('多个 tool_calls 逐个累加', () => {
    const mk = n => ({
      role: 'assistant',
      content: '',
      tool_calls: Array.from({ length: n }, (_, i) => ({
        id: `c${i}`, type: 'function', function: { name: 'ab', arguments: '{}' },
      })),
    })
    const one = estimateMessageTokens(mk(1))
    const three = estimateMessageTokens(mk(3))
    assert.equal(three - one, 2 * (one - estimateMessageTokens(mk(0))), '每个调用等价计价')
  })

  test('tool 结果消息带自己的块开销', () => {
    const toolMsg = estimateMessageTokens({ role: 'tool', tool_call_id: 'c1', content: 'result' })
    const userMsg = estimateMessageTokens({ role: 'user', content: 'result' })
    assert.ok(toolMsg > userMsg, 'tool 消息比同长度 user 消息贵（多一层块框架）')
  })

  test('容错：null / undefined / 非法输入不抛', () => {
    for (const bad of [null, undefined, {}, { role: 'user' }, { content: null }]) {
      assert.doesNotThrow(() => estimateMessageTokens(bad), `输入 ${JSON.stringify(bad)} 不应抛`)
      assert.ok(Number.isFinite(estimateMessageTokens(bad)), '必须返回有限数')
    }
  })

  test('中文按字符数算（与英文同一密度启发式）', () => {
    // chars/4 对中文偏低是已知局限，但要保证不抛、不返回 NaN
    const zh = estimateMessageTokens({ role: 'user', content: '中'.repeat(100) })
    assert.ok(zh > 25 && Number.isFinite(zh))
  })
})

describe('F 结构开销：工具 schema 计价', () => {
  const tool = {
    name: 'search',
    description: '搜索',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词' },
        limit: { type: 'number', description: '条数上限' },
        filters: { type: 'array', items: { type: 'string' } },
      },
      required: ['query'],
    },
  }

  test('按真实发送的 JSON 计价，而不是 markdown 描述', () => {
    const actual = estimateToolsTokens([tool])
    // 旧算法只算 `### name\ndescription`
    const oldStyle = estimateTokens(`### ${tool.name}\n${tool.description}`)
    assert.ok(actual > oldStyle * 2,
      `schema JSON 远比描述文本长，实得 ${actual} vs 旧算法 ${oldStyle}`)
  })

  test('空工具列表为 0', () => {
    assert.equal(estimateToolsTokens([]), 0)
    assert.equal(estimateToolsTokens(null), 0)
    assert.equal(estimateToolsTokens(undefined), 0)
  })

  test('工具越多越贵', () => {
    assert.ok(estimateToolsTokens([tool, tool]) > estimateToolsTokens([tool]))
  })
})

// ---------------------------------------------------------------- G usage 锚定

describe('G 信封指纹', () => {
  test('相同 system + 相同工具集 → 指纹相同', () => {
    const t = [{ name: 'a', description: 'd', parameters: {} }]
    assert.equal(headerFingerprint('sys', t), headerFingerprint('sys', t))
  })

  test('system 变化 → 指纹变化', () => {
    assert.notEqual(headerFingerprint('a', []), headerFingerprint('b', []))
  })

  test('工具集变化 → 指纹变化', () => {
    const t1 = [{ name: 'a', description: 'd', parameters: {} }]
    const t2 = [{ name: 'b', description: 'd', parameters: {} }]
    assert.notEqual(headerFingerprint('s', t1), headerFingerprint('s', t2))
  })

  test('工具的 schema 变化也要反映（不只是名字）', () => {
    const t1 = [{ name: 'a', description: 'd', parameters: { type: 'object' } }]
    const t2 = [{ name: 'a', description: 'd', parameters: { type: 'object', properties: { x: {} } } }]
    assert.notEqual(headerFingerprint('s', t1), headerFingerprint('s', t2))
  })

  test('空工具数组与无工具视为同一信封', () => {
    assert.equal(headerFingerprint('s', []), headerFingerprint('s', null))
    assert.equal(headerFingerprint('s', []), headerFingerprint('s', undefined))
  })

  test('空 system 与无 system 视为同一信封', () => {
    assert.equal(headerFingerprint('', []), headerFingerprint(null, []))
  })

  // 真实场景暴露的问题：开启意图识别后 ToolFilter 每轮可能返回不同的工具
  // 子集（浏览器 demo 实测 18 → 28 → 28），指纹随之抖动，锚点几乎每轮失效。
  //
  // 语义上「工具集变了 → 请求体变了 → 锚点失效」是对的，不能为了
  // 让锚点常驻就假装信封没变。但**工具的先后顺序**不影响计费内容，只影响
  // 序列化顺序 —— 那种抖动是纯噪声，必须消除。
  test('工具顺序不同不算信封变化（消除纯噪声抖动）', () => {
    const a = { name: 'alpha', description: 'd1', parameters: { type: 'object' } }
    const b = { name: 'beta', description: 'd2', parameters: { type: 'object' } }
    assert.equal(headerFingerprint('s', [a, b]), headerFingerprint('s', [b, a]),
      '同一组工具换个顺序，请求内容没变，指纹不该变')
  })

  test('但工具集合本身变了必须反映出来', () => {
    const a = { name: 'alpha', description: 'd1', parameters: { type: 'object' } }
    const b = { name: 'beta', description: 'd2', parameters: { type: 'object' } }
    assert.notEqual(headerFingerprint('s', [a]), headerFingerprint('s', [a, b]),
      '少一个工具就是少一段 schema，计费不同')
  })
})

describe('G usage 锚定', () => {
  const cm = () => new ContextManager()
  const history = [{ role: 'user', content: 'hello' }]

  test('没有锚点时是纯估算，置信度为 estimated', () => {
    const r = cm().assemblePrompt({ systemPrompt: 'sys', history })
    assert.equal(r.tokenConfidence, 'estimated')
    assert.ok(r.totalTokens > 0)
  })

  test('信封相同时采用锚点，置信度为 usage', () => {
    const m = cm()
    const req = { systemPrompt: 'sys', history, filteredTools: [] }
    const first = m.assemblePrompt(req)
    // 模拟一次真实调用返回：真实用量高于当时的估算
    const anchor = {
      fingerprint: headerFingerprint('sys', []),
      totalTokens: first.totalTokens + 500,
      estimatedAtAnchor: first.totalTokens,
      historyTokens: first.historyTokens,
    }
    const second = m.assemblePrompt({ ...req, anchor })
    assert.equal(second.tokenConfidence, 'usage')
    assert.equal(second.totalTokens, anchor.totalTokens, '历史没变时应等于锚点值')
  })

  test('历史增长 → 增量为正', () => {
    const m = cm()
    const base = m.assemblePrompt({ systemPrompt: 'sys', history, filteredTools: [] })
    const anchor = {
      fingerprint: headerFingerprint('sys', []),
      totalTokens: 1000,
      estimatedAtAnchor: base.totalTokens,
      historyTokens: base.historyTokens,
    }
    const grown = m.assemblePrompt({
      systemPrompt: 'sys', filteredTools: [], anchor,
      history: [...history, { role: 'assistant', content: 'x'.repeat(400) }],
    })
    assert.equal(grown.tokenConfidence, 'usage')
    assert.ok(grown.totalTokens > 1000, `应大于锚点，实得 ${grown.totalTokens}`)
  })

  test('历史收缩（摘要压缩）→ 增量为负', () => {
    const m = cm()
    const long = [{ role: 'user', content: 'y'.repeat(4000) }]
    const base = m.assemblePrompt({ systemPrompt: 'sys', history: long, filteredTools: [] })
    const anchor = {
      fingerprint: headerFingerprint('sys', []),
      totalTokens: 5000,
      estimatedAtAnchor: base.totalTokens,
      historyTokens: base.historyTokens,
    }
    const shrunk = m.assemblePrompt({
      systemPrompt: 'sys', filteredTools: [], anchor,
      history: [{ role: 'system', content: '摘要', _isSummary: true }],
    })
    assert.ok(shrunk.totalTokens < 5000, `压缩后应低于锚点，实得 ${shrunk.totalTokens}`)
  })

  test('总量永不为负', () => {
    const m = cm()
    const anchor = {
      fingerprint: headerFingerprint('sys', []),
      totalTokens: 10,
      estimatedAtAnchor: 10,
      historyTokens: 99999, // 锚点时历史极大，现在几乎为空
    }
    const r = m.assemblePrompt({ systemPrompt: 'sys', history: [], filteredTools: [], anchor })
    assert.ok(r.totalTokens >= 0, `不能为负，实得 ${r.totalTokens}`)
  })

  test('信封变化 → 锚点失效，退回 estimated', () => {
    const m = cm()
    const anchor = {
      fingerprint: headerFingerprint('old-sys', []),
      totalTokens: 9999,
      estimatedAtAnchor: 100,
      historyTokens: 10,
    }
    const r = m.assemblePrompt({ systemPrompt: 'new-sys', history, filteredTools: [], anchor })
    assert.equal(r.tokenConfidence, 'estimated', '信封变了就不该复用锚点')
    assert.ok(r.totalTokens < 9999)
  })

  test('加载新工具 → 锚点失效', () => {
    const m = cm()
    const anchor = {
      fingerprint: headerFingerprint('sys', []),
      totalTokens: 9999,
      estimatedAtAnchor: 100,
      historyTokens: 10,
    }
    const r = m.assemblePrompt({
      systemPrompt: 'sys', history, anchor,
      filteredTools: [{ name: 'newtool', description: 'd', parameters: {} }],
    })
    assert.equal(r.tokenConfidence, 'estimated')
  })

  test('守恒校验：真实用量低于同期估算时不采信', () => {
    const m = cm()
    const base = m.assemblePrompt({ systemPrompt: 'sys', history, filteredTools: [] })
    const anchor = {
      fingerprint: headerFingerprint('sys', []),
      totalTokens: 1,                        // 真实用量异常低（如命中缓存计费）
      estimatedAtAnchor: base.totalTokens,   // 同期估算高得多
      historyTokens: base.historyTokens,
    }
    const r = m.assemblePrompt({ systemPrompt: 'sys', history, filteredTools: [], anchor })
    assert.equal(r.tokenConfidence, 'estimated',
      '锚点小于同期估算时必须退回估算 —— 否则有符号增量会系统性偏低')
  })

  test('缺字段的锚点被安全忽略，不抛', () => {
    const m = cm()
    for (const bad of [{}, { fingerprint: 'x' }, { totalTokens: 5 }, null]) {
      assert.doesNotThrow(() => m.assemblePrompt({
        systemPrompt: 'sys', history, filteredTools: [], anchor: bad,
      }))
    }
  })
})

describe('向后兼容', () => {
  test('不传 anchor 时行为与从前一致（仍返回全部既有字段）', () => {
    const r = new ContextManager().assemblePrompt({
      systemPrompt: 'sys',
      history: [{ role: 'user', content: 'hi' }],
    })
    for (const k of ['messages', 'systemPromptTokens', 'knowledgeTokens',
      'historyTokens', 'toolsTokens', 'totalTokens', 'trimmed']) {
      assert.ok(k in r, `既有字段 ${k} 不能消失`)
    }
  })

  test('estimateTokens 仍是纯文本估算（别处在用，语义不能变）', () => {
    assert.equal(estimateTokens('abcd'), 1)
    assert.equal(estimateTokens(''), 0)
    assert.equal(estimateTokens(null), 0)
  })

  test('裁剪与预算用同一套计价（否则两者会打架）', () => {
    const m = new ContextManager()
    const many = Array.from({ length: 200 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(300),
    }))
    const r = m.assemblePrompt({
      systemPrompt: 'sys', history: many,
      tokenBudget: { totalTokens: 2000, systemPromptRatio: .15, knowledgeRatio: .2, historyRatio: .45, toolsRatio: .2 },
    })
    assert.equal(r.trimmed, true, '应触发裁剪')
    // 裁剪后重新计价，不能仍然超预算
    const after = r.messages.filter(x => x.role !== 'system')
      .reduce((s, x) => s + estimateMessageTokens(x), 0)
    assert.ok(after <= 2000, `裁剪后仍超预算说明两处算法不一致，实得 ${after}`)
  })

  // 加上结构开销后，单条消息的最低成本是 BLOCK+ROLE=8 起。预算被设得极小时，
  // 朴素的「装不下就不装」会把历史清空 —— 模型连用户刚说的话都看不到，
  // 这比略微超预算糟糕得多。trimHistory 里也是同样取舍：保住协议
  // 有效性优先于严格预算。
  test('预算极小时至少保住最后一条消息', () => {
    const r = new ContextManager().assemblePrompt({
      systemPrompt: '',
      history: [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'two' },
        { role: 'user', content: 'three' },
      ],
      tokenBudget: { totalTokens: 4, systemPromptRatio: 0, knowledgeRatio: 0, historyRatio: 1, toolsRatio: 0 },
    })
    const nonSys = r.messages.filter(m => m.role !== 'system')
    assert.ok(nonSys.length >= 1, '不能把历史清空')
    assert.equal(nonSys[nonSys.length - 1].content, 'three', '保住的必须是最新那条')
  })

  test('预算为 0 时同样保住最后一条', () => {
    const r = new ContextManager().assemblePrompt({
      systemPrompt: '',
      history: [{ role: 'user', content: 'only' }],
      tokenBudget: { totalTokens: 0, systemPromptRatio: 0, knowledgeRatio: 0, historyRatio: 1, toolsRatio: 0 },
    })
    assert.ok(r.messages.some(m => m.content === 'only'))
  })

  test('保底不会破坏 tool 消息配对（孤儿 tool 不能成为唯一保底）', () => {
    const r = new ContextManager().assemblePrompt({
      systemPrompt: '',
      history: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 't1', content: 'r' },
      ],
      tokenBudget: { totalTokens: 4, systemPromptRatio: 0, knowledgeRatio: 0, historyRatio: 1, toolsRatio: 0 },
    })
    const nonSys = r.messages.filter(m => m.role !== 'system')
    if (nonSys.length > 0 && nonSys[0].role === 'tool') {
      assert.fail('首条不能是孤儿 tool 消息 —— 会被供应商拒绝')
    }
  })
})
