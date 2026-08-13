import { describe, expect, it } from 'vitest'
import { normalizePricingEntries } from './model-pricing-service'

describe('normalizePricingEntries', () => {
  it('normalizes a payload with reference prices and derives cache-write/reasoning', () => {
    const entries = normalizePricingEntries({
      meta: { models: 1, providers: 1 },
      count: 1,
      models: [
        {
          id: 'openai/gpt-5',
          name: 'GPT-5',
          reference: {
            provider: 'openai',
            input: 1.25,
            output: 10,
            cacheRead: 0.125,
            official: true
          },
          cheapest: { provider: 'nano-gpt', input: 1.1, output: 9, cacheRead: 0.11 }
        }
      ]
    })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual({
      id: 'openai/gpt-5',
      inputUsdPer1M: 1.25,
      outputUsdPer1M: 10,
      cacheReadUsdPer1M: 0.125,
      cacheWriteUsdPer1M: 1.25 * 1.25,
      reasoningUsdPer1M: 10,
      official: true
    })
  })

  it('skips entries without an official reference price or a valid id', () => {
    const entries = normalizePricingEntries({
      models: [
        { id: 'openai/gpt-5', reference: { input: 1.25, output: 10, official: true } },
        { id: 'openai/gpt-5', reference: { input: 1.25, output: 10 } },
        { id: 'no-lab-model', reference: { input: 1, output: 2, official: true } },
        { id: 'bad/gpt-x', reference: { input: 'nope', output: 2, official: true } },
        { reference: { input: 1, output: 2, official: true } }
      ]
    })
    expect(entries).toHaveLength(1)
    expect(entries[0].id).toBe('openai/gpt-5')
  })

  it('drops reseller (non-official) reference prices entirely', () => {
    const entries = normalizePricingEntries({
      models: [
        {
          id: 'openai/gpt-5',
          reference: { provider: 'nano-gpt', input: 1.1, output: 9, official: false }
        },
        {
          id: 'openai/gpt-5-2',
          reference: { provider: 'openai', input: 1.75, output: 14, official: true }
        }
      ]
    })
    expect(entries).toHaveLength(1)
    expect(entries[0].id).toBe('openai/gpt-5-2')
    expect(entries[0].inputUsdPer1M).toBe(1.75)
  })

  it('returns an empty array for a malformed payload', () => {
    expect(normalizePricingEntries(null)).toEqual([])
    expect(normalizePricingEntries({ models: 'nope' })).toEqual([])
    expect(normalizePricingEntries({})).toEqual([])
  })
})
