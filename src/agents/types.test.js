import test from 'node:test'
import assert from 'node:assert'
import {
  registerAgentType, getAgentType, listAgentTypes,
  unregisterAgentType, resetAgentTypes, AGENT_TYPE_NAME_RE,
} from './types.js'
import { AgentTypeError } from './errors.js'

test.beforeEach(() => resetAgentTypes())
test.after(() => resetAgentTypes())

test('内置 general-purpose 存在且带默认值', () => {
  const t = getAgentType('general-purpose')
  assert.strictEqual(t.name, 'general-purpose')
  assert.strictEqual(t.tools, '*')
  assert.strictEqual(t.model, 'main')
  assert.strictEqual(t.canSpawn, false)
  assert.strictEqual(t.enableIntentRecognition, false)
  assert.strictEqual(t.maxRounds, 60)
  assert.strictEqual(t.maxAttempts, 3)
  assert.ok(t.description.length > 0)
  assert.ok(t.systemPrompt.length > 0)
})

test('注册后可查、可列，顺序为注册顺序', () => {
  registerAgentType({ name: 'explorer', description: '只读检索', systemPrompt: 'read only' })
  registerAgentType({ name: 'writer', description: '写文档', systemPrompt: 'write' })
  assert.deepStrictEqual(listAgentTypes().map(t => t.name),
    ['general-purpose', 'explorer', 'writer'])
  assert.strictEqual(getAgentType('explorer').description, '只读检索')
})

test('未注册的类型返回 null', () => {
  assert.strictEqual(getAgentType('nope'), null)
})

test('缺失字段默认继承：model/tools 未给时为 null/"*"', () => {
  const t = registerAgentType({ name: 'x', description: 'd', systemPrompt: 's' })
  assert.strictEqual(t.model, null)   // null = 继承父模型
  assert.strictEqual(t.tools, '*')
})

test('非法 name 抛 AgentTypeError', () => {
  for (const bad of ['', 'Has-Upper', 'has_underscore', 'a'.repeat(65), 'has space']) {
    assert.throws(() => registerAgentType({ name: bad, description: 'd', systemPrompt: 's' }),
      AgentTypeError)
  }
  assert.ok(AGENT_TYPE_NAME_RE.test('ok-name-1'))
})

test('description / systemPrompt 必填', () => {
  assert.throws(() => registerAgentType({ name: 'a', systemPrompt: 's' }), AgentTypeError)
  assert.throws(() => registerAgentType({ name: 'a', description: 'd' }), AgentTypeError)
})

test('tools 必须是 "*" 或字符串数组', () => {
  assert.throws(() => registerAgentType({ name: 'a', description: 'd', systemPrompt: 's', tools: 'read_file' }),
    AgentTypeError)
  const t = registerAgentType({ name: 'b', description: 'd', systemPrompt: 's', tools: ['read_file'] })
  assert.deepStrictEqual(t.tools, ['read_file'])
})

test('内置类型不可覆盖也不可删除', () => {
  assert.throws(() => registerAgentType({ name: 'general-purpose', description: 'd', systemPrompt: 's' }),
    AgentTypeError)
  assert.strictEqual(unregisterAgentType('general-purpose'), false)
  assert.ok(getAgentType('general-purpose'))
})

test('同名自定义类型重复注册 = 替换', () => {
  registerAgentType({ name: 'x', description: 'v1', systemPrompt: 's' })
  registerAgentType({ name: 'x', description: 'v2', systemPrompt: 's' })
  assert.strictEqual(getAgentType('x').description, 'v2')
  assert.strictEqual(listAgentTypes().filter(t => t.name === 'x').length, 1)
})

test('返回值是副本，改它不影响注册表', () => {
  registerAgentType({ name: 'x', description: 'd', systemPrompt: 's', tools: ['a'] })
  const t = getAgentType('x')
  t.description = 'mutated'
  t.tools.push('b')
  assert.strictEqual(getAgentType('x').description, 'd')
  assert.deepStrictEqual(getAgentType('x').tools, ['a'])
})

test('unregister 自定义类型返回 true 且移除', () => {
  registerAgentType({ name: 'x', description: 'd', systemPrompt: 's' })
  assert.strictEqual(unregisterAgentType('x'), true)
  assert.strictEqual(getAgentType('x'), null)
  assert.strictEqual(unregisterAgentType('x'), false)
})
