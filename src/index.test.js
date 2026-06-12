import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as sdk from './index.js'

describe('public exports', () => {
  it('exports runtime history and memory policy APIs', () => {
    for (const name of [
      'RuntimeHistory',
      'SlidingWindowPolicy',
      'TokenBudgetPolicy',
      'SummaryPolicy',
      'estimateMessageTokens',
    ]) {
      assert.ok(name in sdk, `${name} should be exported`)
    }
  })
})
