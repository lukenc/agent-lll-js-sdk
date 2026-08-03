import test from 'node:test'
import assert from 'node:assert'
import {
  encodeEnvelope, decodeEnvelope, newEnvelopeId,
  registerA2ATransport, resolveA2ATransport, RESERVED_A2A_TRANSPORTS,
} from './a2a/index.js'
import { A2AError } from './errors.js'

const sample = {
  jsonrpc: '2.0', id: 'env_1', method: 'message/send',
  params: {
    from: { agentId: 'agt_1', name: 'planner-1' },
    to: { agentId: 'agt_2' },
    kind: 'message', correlationId: null, body: 'hello', meta: {},
  },
}

test('编解码往返', () => {
  assert.deepStrictEqual(decodeEnvelope(encodeEnvelope(sample)), sample)
})

test('编码是单行（为远程 transport 的行分帧预留）', () => {
  assert.ok(!encodeEnvelope(sample).includes('\n'))
})

test('畸形帧抛 A2AError 且 kind 为 malformed_frame', () => {
  for (const bad of ['', '{', 'null', '[]', '{"jsonrpc":"1.0"}', '{"jsonrpc":"2.0"}']) {
    assert.throws(() => decodeEnvelope(bad),
      (err) => err instanceof A2AError && err.kind === 'malformed_frame', `应拒绝: ${bad}`)
  }
})

test('缺 params.to / params.from 被拒', () => {
  assert.throws(() => decodeEnvelope(JSON.stringify({ jsonrpc: '2.0', method: 'message/send', params: {} })), A2AError)
  // `to` 在但没有 agentId 同样必须被拒：Mailbox 用 `to.agentId` 当收件箱的键，
  // 放过这种帧会让消息静默投进一个键为 undefined 的收件箱，永远没人读。
  assert.throws(() => decodeEnvelope(JSON.stringify({
    ...sample, params: { ...sample.params, to: {} },
  })), (err) => err instanceof A2AError && err.kind === 'malformed_frame')
})

test('未知 method 被拒', () => {
  const bad = { ...sample, method: 'agent/nope' }
  assert.throws(() => decodeEnvelope(JSON.stringify(bad)), A2AError)
})

test('保留 transport 名不可覆盖', () => {
  for (const name of RESERVED_A2A_TRANSPORTS) {
    assert.throws(() => registerA2ATransport(name, () => ({})), A2AError)
  }
})

test('自定义 transport 可注册与解析', () => {
  registerA2ATransport('test-transport', () => ({ tag: 'custom' }))
  assert.strictEqual(resolveA2ATransport({ transport: 'test-transport' }).tag, 'custom')
})

test('未知 transport 名解析时抛错', () => {
  assert.throws(() => resolveA2ATransport({ transport: 'nope' }), A2AError)
})

test('信封 id 是单调计数器，不会在同一毫秒内撞号', () => {
  const ids = new Set()
  for (let i = 0; i < 1000; i++) ids.add(newEnvelopeId())
  assert.strictEqual(ids.size, 1000, '同一毫秒内批量发信不能拿到重复的 envelopeId')
})
