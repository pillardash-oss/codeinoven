import { describe, expect, it } from 'vitest'
import {
  isHarnessScopedModelKey,
  modelKey,
  parseModelKey
} from '../../../src/renderer/lib/model-keys'

describe('modelKey', () => {
  it('builds a harness-scoped key', () => {
    expect(modelKey('opencode', 'openai', 'gpt-5.6')).toBe('opencode:openai:gpt-5.6')
    expect(modelKey('codex', 'openai', 'gpt-5.6')).toBe('codex:openai:gpt-5.6')
  })

  it('keeps same provider+model in different harnesses distinct', () => {
    const opencode = modelKey('opencode', 'openai', 'gpt-5.6')
    const codex = modelKey('codex', 'openai', 'gpt-5.6')
    expect(opencode).not.toBe(codex)
    expect(parseModelKey(opencode)).toEqual({
      harnessId: 'opencode',
      providerId: 'openai',
      modelId: 'gpt-5.6'
    })
    expect(parseModelKey(codex)).toEqual({
      harnessId: 'codex',
      providerId: 'openai',
      modelId: 'gpt-5.6'
    })
  })
})

describe('parseModelKey', () => {
  it('parses current 3-segment keys', () => {
    expect(parseModelKey('opencode:openai:gpt-5.6')).toEqual({
      harnessId: 'opencode',
      providerId: 'openai',
      modelId: 'gpt-5.6'
    })
  })

  it('rejects keys without a harness-scoped provider', () => {
    expect(parseModelKey('openai:gpt-5.6')).toBeNull()
    expect(parseModelKey('gpt-5.6')).toBeNull()
  })

  it('preserves colons inside the model id', () => {
    expect(parseModelKey('opencode:openai:gpt-5.6:preview')).toEqual({
      harnessId: 'opencode',
      providerId: 'openai',
      modelId: 'gpt-5.6:preview'
    })
  })
})

describe('isHarnessScopedModelKey', () => {
  it('detects current harness-scoped keys', () => {
    expect(isHarnessScopedModelKey('opencode:openai:gpt-5.6')).toBe(true)
    expect(isHarnessScopedModelKey('openai:gpt-5.6')).toBe(false)
  })
})
