/**
 * spill 策略层测试 —— 设计说明见 docs/design/spill.md。
 *
 * 策略层回答的是「什么时候截、截完跟模型说什么」，
 * D1–D9 每一条都在这里有对应断言。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert'
import { MemorySpillStore, SpillError, utf8Bytes } from './index.js'
import { createSpillPolicy, SPILL_READ_TOOL_NAME } from './policy.js'

const bigBody = 'HEAD'.repeat(200) + 'TAIL'.repeat(200) // 1600 字节

// ---- D1 未配置 = 完全不启用 ----

describe('D1 未配置时是真 no-op', () => {
  test('maxInlineBytes 为 null 时返回 null（不创建策略）', () => {
    assert.equal(createSpillPolicy({ maxInlineBytes: null }), null)
    assert.equal(createSpillPolicy({}), null)
    assert.equal(createSpillPolicy(), null)
  })
})

// ---- D2 配置非法 = 构造时抛 ----

describe('D2 非法配置在构造时就抛', () => {
  test('负数 / 小数直接抛，不等到调用时', () => {
    assert.throws(() => createSpillPolicy({ maxInlineBytes: -1 }), /non-negative integer/)
    assert.throws(() => createSpillPolicy({ maxInlineBytes: 2.5 }), /non-negative integer/)
  })
})

// ---- 基本替换行为 ----

describe('超限内容被转存并替换（D5/D8/D9）', () => {
  test('保存完整内容，替换成预览 + 地址，且不超过上限', async () => {
    const store = new MemorySpillStore()
    const policy = createSpillPolicy({ maxInlineBytes: 200, store })
    const out = await policy.apply({ sessionId: 's1', toolName: 'big', callId: 'c1', text: bigBody })

    assert.notEqual(out, bigBody, '应被替换')
    assert.ok(out.startsWith('HEAD'), '应保留头部')
    assert.ok(out.includes('Omitted'), '应包含省略说明')
    assert.ok(out.includes('spill://'), '应包含取回地址')
    // D6 硬不变量：替换结果不得超过上限
    assert.ok(utf8Bytes(out) <= 200, `替换结果 ${utf8Bytes(out)} 字节，超过了上限 200`)
    assert.ok(utf8Bytes(out) < utf8Bytes(bigBody), '应比原文小，否则失去意义')
  })

  test('完整内容能通过 locator 原样取回', async () => {
    const store = new MemorySpillStore()
    const policy = createSpillPolicy({ maxInlineBytes: 200, store })
    const out = await policy.apply({ sessionId: 's1', toolName: 'big', callId: 'c1', text: bigBody })
    const locator = out.match(/spill:\/\/[^\s]+/)?.[0]
    assert.ok(locator, `应能从提示语里解析出 locator，实得：${out.slice(-120)}`)
    assert.equal(await store.readText(locator), bigBody)
  })

  test('头尾各留一半（D8）：结论在尾部也能看到', async () => {
    const store = new MemorySpillStore()
    const policy = createSpillPolicy({ maxInlineBytes: 300, store })
    const body = 'START' + 'x'.repeat(2000) + 'EXITCODE=1'
    const out = await policy.apply({ sessionId: 's1', toolName: 'sh', callId: 'c', text: body })
    assert.ok(out.startsWith('START'), '应保留头部')
    assert.ok(out.includes('EXITCODE=1'), '应保留尾部——退出码这类结论通常在最后')
  })

  test('未超限的内容原样返回，不产生任何存储记录', async () => {
    const store = new MemorySpillStore()
    const policy = createSpillPolicy({ maxInlineBytes: 1000, store })
    const out = await policy.apply({ sessionId: 's1', toolName: 't', callId: 'c', text: 'tiny' })
    assert.equal(out, 'tiny')
    await assert.rejects(() => store.readText('spill://any'), SpillError)
  })

  test('恰好等于上限时不触发（边界）', async () => {
    const store = new MemorySpillStore()
    const policy = createSpillPolicy({ maxInlineBytes: 10, store })
    const body = '0123456789' // 正好 10 字节
    assert.equal(await policy.apply({ sessionId: 's', toolName: 't', callId: 'c', text: body }), body)
  })
})

// ---- D6 上限是硬不变量 ----

describe('D6 上限是硬不变量', () => {
  test('提示语本身就超上限时，保留原文而不是产出超限内容', async () => {
    const store = new MemorySpillStore()
    const warns = []
    const policy = createSpillPolicy({ maxInlineBytes: 4, store, onWarn: m => warns.push(m) })
    const body = 'xxxxx' // 5 字节 > 4，但远短于提示语
    const out = await policy.apply({ sessionId: 's', toolName: 't', callId: 'c', text: body })
    assert.equal(out, body, '没有合规替换方案时应保留原文')
    assert.ok(warns.length > 0, '应记一条警告')
  })

  test('原文很大但上限极小时，同样保留原文', async () => {
    const store = new MemorySpillStore()
    const warns = []
    const policy = createSpillPolicy({ maxInlineBytes: 8, store, onWarn: m => warns.push(m) })
    const body = 'x'.repeat(5000)
    assert.equal(await policy.apply({ sessionId: 's', toolName: 't', callId: 'c', text: body }), body)
    assert.ok(warns.length > 0)
  })

  test('各种上限下，替换结果永远不超限（性质测试）', async () => {
    const store = new MemorySpillStore()
    for (const cap of [120, 200, 512, 1024, 4096]) {
      const policy = createSpillPolicy({ maxInlineBytes: cap, store })
      const out = await policy.apply({ sessionId: 's', toolName: 'tool', callId: 'c', text: 'y'.repeat(50000) })
      assert.ok(utf8Bytes(out) <= cap || out.length === 50000,
        `cap=${cap} 时替换结果 ${utf8Bytes(out)} 字节超限了`)
    }
  })

  // 提示语（describeOmitted + locator + retrievalHint）整条都算进预留里。
  // 它越长，留给预览的字节越少；长到一定程度小上限就再无合规替换方案，
  // 触发 D6 保留原文 —— 此时 spill 等于没生效，而且是**静默**的。
  // 这条守卫把那个隐性边界钉住：改长 hint 时会在这里失败，而不是等到线上。
  test('在 400 字节这种常见小上限下，spill 仍能生效（提示语不能太长）', async () => {
    const store = new MemorySpillStore()
    const policy = createSpillPolicy({ maxInlineBytes: 400, store })
    const body = 'HEAD' + 'x'.repeat(50000) + 'TAIL'
    const out = await policy.apply({ sessionId: 's', toolName: 'build', callId: 'c', text: body })
    assert.notEqual(out, body,
      '400 字节上限下应当仍能转存 —— 若这条失败，多半是 retrievalHint 或提示语被加长了')
    assert.ok(utf8Bytes(out) <= 400)
    assert.ok(out.includes('HEAD') && out.includes('TAIL'), '预览仍应留有头尾')
  })
})

// ---- D7 失败一律降级 ----

describe('D7 失败绝不影响工具结果', () => {
  test('存储抛异常时保留原文并告警', async () => {
    const failing = {
      async saveText() { throw new Error('磁盘满') },
      async readText() { throw new Error('nope') },
      async clear() {},
    }
    const warns = []
    const policy = createSpillPolicy({ maxInlineBytes: 10, store: failing, onWarn: m => warns.push(m) })
    const body = 'x'.repeat(1000)
    assert.equal(await policy.apply({ sessionId: 's', toolName: 't', callId: 'c', text: body }), body)
    assert.ok(warns.some(w => /磁盘满|保留/.test(w)), `应有降级告警，实得 ${JSON.stringify(warns)}`)
  })

  test('没有存储后端时保留原文并告警', async () => {
    const warns = []
    const policy = createSpillPolicy({ maxInlineBytes: 10, store: null, onWarn: m => warns.push(m) })
    const body = 'x'.repeat(1000)
    assert.equal(await policy.apply({ sessionId: 's', toolName: 't', callId: 'c', text: body }), body)
    assert.ok(warns.length > 0)
  })

  test('没有 sessionId 时保留原文并告警', async () => {
    const store = new MemorySpillStore()
    const warns = []
    const policy = createSpillPolicy({ maxInlineBytes: 10, store, onWarn: m => warns.push(m) })
    const body = 'x'.repeat(1000)
    const out = await policy.apply({ sessionId: null, toolName: 't', callId: 'c', text: body })
    assert.equal(out, body)
    assert.ok(warns.length > 0)
  })

  test('存储层慢/抛错都不会让 apply 自己抛出去', async () => {
    const throwing = {
      async saveText() { throw new SpillError('后端挂了', { code: 'x' }) },
      async readText() {}, async clear() {},
    }
    const policy = createSpillPolicy({ maxInlineBytes: 10, store: throwing, onWarn: () => {} })
    // 不应 reject
    const out = await policy.apply({ sessionId: 's', toolName: 't', callId: 'c', text: 'x'.repeat(100) })
    assert.equal(out, 'x'.repeat(100))
  })
})

// ---- D4 跳过 read 类工具 ----

describe('D4 跳过会造成循环的工具', () => {
  test('spill_read 自身不被转存（否则读溢出内容又溢出）', async () => {
    const store = new MemorySpillStore()
    const policy = createSpillPolicy({ maxInlineBytes: 10, store })
    const body = 'x'.repeat(1000)
    assert.equal(
      await policy.apply({ sessionId: 's', toolName: SPILL_READ_TOOL_NAME, callId: 'c', text: body }),
      body,
    )
  })

  test('默认跳过 read_file', async () => {
    const store = new MemorySpillStore()
    const policy = createSpillPolicy({ maxInlineBytes: 10, store })
    const body = 'x'.repeat(1000)
    assert.equal(await policy.apply({ sessionId: 's', toolName: 'read_file', callId: 'c', text: body }), body)
  })

  test('跳过清单可以由宿主覆盖', async () => {
    const store = new MemorySpillStore()
    // 上限要留得下提示语，否则会触发 D6 保留原文，测不出跳过逻辑
    const policy = createSpillPolicy({ maxInlineBytes: 300, store, skipTools: ['my_reader'] })
    const body = 'x'.repeat(1000)
    assert.equal(await policy.apply({ sessionId: 's', toolName: 'my_reader', callId: 'c', text: body }), body)
    // 不在清单里的照常转存
    const out = await policy.apply({ sessionId: 's', toolName: 'other', callId: 'c', text: body })
    assert.notEqual(out, body)
  })

  test('宿主覆盖清单后，read_file 不再自动跳过（清单是替换不是叠加）', async () => {
    const store = new MemorySpillStore()
    const policy = createSpillPolicy({ maxInlineBytes: 300, store, skipTools: ['my_reader'] })
    const out = await policy.apply({ sessionId: 's', toolName: 'read_file', callId: 'c', text: 'x'.repeat(1000) })
    assert.notEqual(out, 'x'.repeat(1000))
  })

  test('跳过清单支持通配', async () => {
    const store = new MemorySpillStore()
    const policy = createSpillPolicy({ maxInlineBytes: 100, store, skipTools: ['mcp_*_read'] })
    const body = 'x'.repeat(1000)
    assert.equal(await policy.apply({ sessionId: 's', toolName: 'mcp_fs_read', callId: 'c', text: body }), body)
  })
})

// ---- 非字符串输入 ----

describe('输入健壮性', () => {
  test('非字符串输入原样返回，不抛', async () => {
    const store = new MemorySpillStore()
    const policy = createSpillPolicy({ maxInlineBytes: 10, store })
    for (const v of [null, undefined, 123, { a: 1 }]) {
      assert.equal(await policy.apply({ sessionId: 's', toolName: 't', callId: 'c', text: v }), v)
    }
  })

  test('中文内容按字节判定，不按字符数', async () => {
    const store = new MemorySpillStore()
    const policy = createSpillPolicy({ maxInlineBytes: 200, store })
    // 100 个汉字 = 300 字节 > 200，即使字符数只有 100
    const body = '中'.repeat(100)
    const out = await policy.apply({ sessionId: 's', toolName: 't', callId: 'c', text: body })
    assert.notEqual(out, body, '应按字节判定为超限')
    assert.ok(!out.includes('�'), '不应出现乱码')
  })
})

// ---- spill_read 工具 ----

describe('spill_read 工具', () => {
  test('能按 offset/limit 分段读回', async () => {
    const store = new MemorySpillStore()
    const policy = createSpillPolicy({ maxInlineBytes: 200, store })
    const tool = policy.createReadTool()
    assert.equal(tool.name, SPILL_READ_TOOL_NAME)

    const ref = await store.saveText({ sessionId: 's', toolName: 't', callId: 'c', content: 'abcdefghij' })
    const r = await tool.execute({ locator: ref.locator, offset: 0, limit: 4 })
    assert.ok(r.includes('abcd'), `应包含内容，实得 ${r}`)
  })

  test('返回结果带进度信息，让模型知道还剩多少', async () => {
    const store = new MemorySpillStore()
    const policy = createSpillPolicy({ maxInlineBytes: 200, store })
    const tool = policy.createReadTool()
    const ref = await store.saveText({ sessionId: 's', toolName: 't', callId: 'c', content: 'x'.repeat(100) })
    const r = await tool.execute({ locator: ref.locator, offset: 0, limit: 10 })
    assert.match(r, /\d+\s*[-–]\s*\d+|共\s*100|\/\s*100/, `应含进度信息，实得 ${r}`)
  })

  test('不传 limit 时有默认上限，不会把全部内容倒回上下文', async () => {
    const store = new MemorySpillStore()
    const policy = createSpillPolicy({ maxInlineBytes: 200, store, readDefaultLimit: 64 })
    const tool = policy.createReadTool()
    const ref = await store.saveText({ sessionId: 's', toolName: 't', callId: 'c', content: 'x'.repeat(100000) })
    const r = await tool.execute({ locator: ref.locator })
    assert.ok(utf8Bytes(r) < 1000, `不带 limit 时不应倒回全部，实得 ${utf8Bytes(r)} 字节`)
  })

  test('limit 超过硬上限时被夹住', async () => {
    const store = new MemorySpillStore()
    const policy = createSpillPolicy({ maxInlineBytes: 200, store, readMaxLimit: 128 })
    const tool = policy.createReadTool()
    const ref = await store.saveText({ sessionId: 's', toolName: 't', callId: 'c', content: 'x'.repeat(100000) })
    const r = await tool.execute({ locator: ref.locator, offset: 0, limit: 999999 })
    assert.ok(utf8Bytes(r) < 1000, `limit 应被夹到硬上限，实得 ${utf8Bytes(r)} 字节`)
  })

  test('locator 不存在时返回可读错误，而不是抛异常', async () => {
    const store = new MemorySpillStore()
    const policy = createSpillPolicy({ maxInlineBytes: 200, store })
    const tool = policy.createReadTool()
    const r = await tool.execute({ locator: 'spill://nope/xxx' })
    assert.match(r, /不存在|已被清理|Error/, `应返回可读错误，实得 ${r}`)
  })

  test('缺少 locator 参数时返回可读错误', async () => {
    const store = new MemorySpillStore()
    const policy = createSpillPolicy({ maxInlineBytes: 200, store })
    const tool = policy.createReadTool()
    const r = await tool.execute({})
    assert.match(r, /locator/, `应提示缺参数，实得 ${r}`)
  })
})

// ---- 搜索能力 ----
//
// 为什么必须有：只提示「去 grep 这个路径」的前提是宿主已有能搜真实路径的
// grep 工具。我们是库，宿主不一定有 grep，浏览器里更没有文件路径。
// 只给顺序分段读的话，模型在 150KB 日志里找一行错误要线性扫 19 轮，
// 真实跑下来会直接撞 maxRounds（examples/spill.js 第 3 幕实测复现）。
describe('spill_search：在转存内容里定位，而不是线性扫', () => {
  const HAYSTACK = [
    ...Array.from({ length: 500 }, (_, i) => `[${i}] compiling module_${i}.ts ... ok`),
    "[500] ERROR: cannot find module 'left-pad'",
    ...Array.from({ length: 500 }, (_, i) => `[${i + 501}] compiling ok`),
    'EXIT_CODE=1',
  ].join('\n')

  async function setup() {
    const store = new MemorySpillStore()
    const policy = createSpillPolicy({ maxInlineBytes: 300, store })
    const ref = await store.saveText({ sessionId: 's', toolName: 'build', callId: 'c', content: HAYSTACK })
    return { policy, ref, tool: policy.createSearchTool() }
  }

  test('能按关键词找到匹配行及其行号', async () => {
    const { tool, ref } = await setup()
    const r = await tool.execute({ locator: ref.locator, pattern: 'ERROR' })
    assert.ok(r.includes('left-pad'), `应包含匹配内容，实得：${r.slice(0, 200)}`)
    assert.ok(/50[01]/.test(r), '应给出行号，方便模型定位')
  })

  test('返回结果自身受限，不能把整个文件倒回来', async () => {
    const { tool, ref } = await setup()
    // 搜一个几乎每行都命中的词
    const r = await tool.execute({ locator: ref.locator, pattern: 'compiling' })
    assert.ok(utf8Bytes(r) < 20000, `搜索结果必须受限，实得 ${utf8Bytes(r)} 字节`)
    assert.match(r, /还有|更多|超过|仅显示/, '截断时要告诉模型还有更多匹配')
  })

  test('没有匹配时明确说没找到，而不是返回空', async () => {
    const { tool, ref } = await setup()
    const r = await tool.execute({ locator: ref.locator, pattern: 'ZZZ_NOT_PRESENT' })
    assert.match(r, /没有找到|未找到|no match/i, `实得：${r}`)
  })

  test('支持正则', async () => {
    const { tool, ref } = await setup()
    const r = await tool.execute({ locator: ref.locator, pattern: 'ERROR.*left-pad', regex: true })
    assert.ok(r.includes('left-pad'))
  })

  // 实测发现的高频失误：模型写 `error|Error` 这种大小写枚举，
  // 匹配不到全大写的 ERROR，于是判断「日志里没有错误」。
  // grep 的 -i 是标配，这里补上等价能力。
  test('ignore_case 让大小写不再是坑', async () => {
    const { tool, ref } = await setup()
    const sensitive = await tool.execute({ locator: ref.locator, pattern: 'error' })
    assert.match(sensitive, /没有找到|未找到/, '默认大小写敏感（保持可预期）')

    const insensitive = await tool.execute({ locator: ref.locator, pattern: 'error', ignore_case: true })
    assert.ok(insensitive.includes('left-pad'), `ignore_case 应能命中 ERROR，实得：${insensitive.slice(0, 150)}`)
  })

  test('ignore_case 与 regex 可组合', async () => {
    const { tool, ref } = await setup()
    const r = await tool.execute({ locator: ref.locator, pattern: 'err.r', regex: true, ignore_case: true })
    assert.ok(r.includes('left-pad'))
  })

  test('非法正则返回可读错误，不抛异常', async () => {
    const { tool, ref } = await setup()
    const r = await tool.execute({ locator: ref.locator, pattern: '[unclosed', regex: true })
    assert.match(r, /Error|无效|非法/, `实得：${r}`)
  })

  test('带上下文行，让模型看到匹配前后', async () => {
    const { tool, ref } = await setup()
    const r = await tool.execute({ locator: ref.locator, pattern: 'left-pad', context: 2 })
    assert.ok(r.includes('module_499') || r.includes('[499]'), `应含前文，实得：${r.slice(0, 300)}`)
  })

  test('locator 不存在时返回可读错误', async () => {
    const { tool } = await setup()
    const r = await tool.execute({ locator: 'spill://nope/x', pattern: 'a' })
    assert.match(r, /不存在|已被清理|Error/)
  })

  test('缺 pattern 时提示', async () => {
    const { tool, ref } = await setup()
    const r = await tool.execute({ locator: ref.locator })
    assert.match(r, /pattern/)
  })

  test('搜索工具自身也要在跳过清单里（否则结果过大又被转存）', async () => {
    const { policy } = await setup()
    assert.ok(policy.shouldSkip('spill_search'), 'spill_search 必须被跳过')
  })
})
