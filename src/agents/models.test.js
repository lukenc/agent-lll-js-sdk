import test from 'node:test'
import assert from 'node:assert'
import { resolveModelAliases, modelEnum, resolveModel } from './models.js'
import { AgentTypeError } from './errors.js'

const parent = {
  model: 'gpt-4o', apiKey: 'sk-main', url: 'https://main.example/v1/chat/completions',
  simpleModel: 'gpt-4o-mini', simpleApiKey: 'sk-simple', simpleUrl: 'https://simple.example/v1/chat/completions',
}

test('未配置时默认给出 fast / main 两个别名', () => {
  const aliases = resolveModelAliases(parent, undefined)
  assert.deepStrictEqual(Object.keys(aliases), ['fast', 'main'])
  assert.deepStrictEqual(aliases.fast,
    { model: 'gpt-4o-mini', apiKey: 'sk-simple', url: 'https://simple.example/v1/chat/completions' })
  assert.deepStrictEqual(aliases.main,
    { model: 'gpt-4o', apiKey: 'sk-main', url: 'https://main.example/v1/chat/completions' })
  assert.deepStrictEqual(modelEnum(aliases), ['fast', 'main'])
})

test('主机配置的别名替换默认表，缺失字段回退父配置', () => {
  const aliases = resolveModelAliases(parent, {
    haiku: { model: 'claude-haiku-4-5', apiKey: 'sk-anthropic', url: 'https://api.anthropic.com/v1/messages' },
    cheap: { model: 'deepseek-chat' },   // 只给 model → apiKey/url 回退父主配置
  })
  assert.deepStrictEqual(modelEnum(aliases), ['haiku', 'cheap'])
  assert.strictEqual(aliases.cheap.apiKey, 'sk-main')
  assert.strictEqual(aliases.cheap.url, 'https://main.example/v1/chat/completions')
  assert.strictEqual(aliases.haiku.model, 'claude-haiku-4-5')
})

test('resolveModel 优先级：入参 > 类型 > 继承父', () => {
  const aliases = resolveModelAliases(parent, undefined)
  const type = { model: 'main' }

  const byArg = resolveModel({ requested: 'fast', type, aliases, parent })
  assert.strictEqual(byArg.alias, 'fast')
  assert.strictEqual(byArg.model, 'gpt-4o-mini')

  const byType = resolveModel({ requested: undefined, type, aliases, parent })
  assert.strictEqual(byType.alias, 'main')
  assert.strictEqual(byType.model, 'gpt-4o')

  const inherited = resolveModel({ requested: undefined, type: { model: null }, aliases, parent })
  assert.strictEqual(inherited.alias, null)
  assert.strictEqual(inherited.model, 'gpt-4o')
  assert.strictEqual(inherited.apiKey, 'sk-main')
})

test('未知别名抛 AgentTypeError 且消息列出可用别名', () => {
  const aliases = resolveModelAliases(parent, undefined)
  assert.throws(
    () => resolveModel({ requested: 'opus', type: { model: null }, aliases, parent }),
    (err) => err instanceof AgentTypeError && err.message.includes('fast') && err.message.includes('main'),
  )
})

test('解析结果不把 apiKey 暴露在 alias 枚举里', () => {
  const aliases = resolveModelAliases(parent, undefined)
  assert.ok(!JSON.stringify(modelEnum(aliases)).includes('sk-'))
})
