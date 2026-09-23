import { describe, expect, it } from 'vitest'
import {
  openCodeV2HiddenConfig,
  openCodeV2HiddenPolicies,
  readHiddenProviderIds,
  readHiddenProvidersFromDisabledList,
  readHiddenProvidersFromPolicies
} from '../../../src/main/providers/provider-account-orchestrator'

/**
 * OpenCode moved provider hiding from the V1 `disabled_providers` array to V2
 * `experimental.policies` statements (`{action:'provider.use', resource:<id>,
 * effect:'deny'}`), documented as "Use provider.use instead of the V1
 * enabled_providers and disabled_providers lists". Both forms share one global
 * config file, so the reader picks by the detected line.
 */
describe('OpenCode hidden providers', () => {
  it('reads the V1 disabled_providers list, deduped', () => {
    expect(
      readHiddenProvidersFromDisabledList({
        disabled_providers: ['openai', 'openai', 'anthropic']
      })
    ).toEqual(['openai', 'anthropic'])
    expect(readHiddenProvidersFromDisabledList({})).toEqual([])
    expect(readHiddenProvidersFromDisabledList({ disabled_providers: 'openai' })).toEqual([])
  })

  it('reads only V2 provider.use deny statements', () => {
    const config = {
      experimental: {
        policies: [
          { action: 'provider.use', resource: 'openai', effect: 'deny' },
          { action: 'provider.use', resource: 'anthropic', effect: 'allow' },
          { action: 'permission', resource: 'shell:*', effect: 'deny' },
          { action: 'provider.use', resource: 'openai', effect: 'deny' },
          { action: 'provider.use', resource: '   ', effect: 'deny' }
        ]
      }
    }
    expect(readHiddenProvidersFromPolicies(config)).toEqual(['openai'])
  })

  it('returns nothing for an absent or malformed policies key', () => {
    expect(readHiddenProvidersFromPolicies({})).toEqual([])
    expect(readHiddenProvidersFromPolicies({ experimental: null })).toEqual([])
    expect(readHiddenProvidersFromPolicies({ experimental: { policies: 'nope' } })).toEqual([])
  })

  it('merges the hidden set without dropping unrelated statements', () => {
    const raw = JSON.stringify({
      experimental: {
        policies: [
          { action: 'permission', resource: 'shell:*', effect: 'deny' },
          { action: 'provider.use', resource: 'anthropic', effect: 'allow' },
          { action: 'provider.use', resource: 'old', effect: 'deny' }
        ]
      }
    })
    expect(openCodeV2HiddenPolicies(raw, ['openai'])).toEqual([
      { action: 'permission', resource: 'shell:*', effect: 'deny' },
      { action: 'provider.use', resource: 'anthropic', effect: 'allow' },
      { action: 'provider.use', resource: 'openai', effect: 'deny' }
    ])
  })

  it('removes the policies key when nothing is hidden and nothing is left', () => {
    expect(openCodeV2HiddenPolicies('{}', [])).toBeUndefined()
    expect(
      openCodeV2HiddenPolicies(
        JSON.stringify({
          experimental: {
            policies: [{ action: 'provider.use', resource: 'x', effect: 'deny' }]
          }
        }),
        []
      )
    ).toBeUndefined()
  })

  it('survives a config that is not JSON', () => {
    expect(openCodeV2HiddenPolicies('not json', ['openai'])).toEqual([
      { action: 'provider.use', resource: 'openai', effect: 'deny' }
    ])
  })
})

describe('OpenCode hidden-provider reads', () => {
  it('reads only the V1 list at the V1 line', () => {
    const config = {
      disabled_providers: ['openai'],
      experimental: {
        policies: [{ action: 'provider.use', resource: 'anthropic', effect: 'deny' }]
      }
    }
    expect(readHiddenProviderIds(config, false)).toEqual(['openai'])
  })

  it('unions both forms at the V2 line, since V2 still honors the V1 list', () => {
    const config = {
      disabled_providers: ['openai'],
      experimental: {
        policies: [{ action: 'provider.use', resource: 'anthropic', effect: 'deny' }]
      }
    }
    expect(readHiddenProviderIds(config, true)).toEqual(['openai', 'anthropic'])
    expect(readHiddenProviderIds({}, true)).toEqual([])
  })
})

describe('openCodeV2HiddenConfig', () => {
  it('writes the native policy and mirrors the V1 list', () => {
    const raw = JSON.stringify({
      experimental: { policies: [{ action: 'permission', resource: 'shell:*', effect: 'deny' }] }
    })
    const config = JSON.parse(openCodeV2HiddenConfig(raw, ['openai'])) as {
      experimental: { policies: unknown }
      disabled_providers?: unknown
    }
    expect(config.experimental.policies).toEqual([
      { action: 'permission', resource: 'shell:*', effect: 'deny' },
      { action: 'provider.use', resource: 'openai', effect: 'deny' }
    ])
    // Mirrored so the same hiding survives a switch back to a V1 install.
    expect(config.disabled_providers).toEqual(['openai'])
  })

  it('rewrites an inherited V1 list so an un-hide actually takes effect', () => {
    const raw = JSON.stringify({ disabled_providers: ['openai', 'anthropic'] })
    const config = JSON.parse(openCodeV2HiddenConfig(raw, ['openai'])) as {
      experimental: { policies: unknown }
      disabled_providers?: unknown
    }
    expect(config.disabled_providers).toEqual(['openai'])
    expect(config.experimental.policies).toEqual([
      { action: 'provider.use', resource: 'openai', effect: 'deny' }
    ])
  })

  it('removes both keys once nothing is hidden', () => {
    const raw = JSON.stringify({
      disabled_providers: ['openai'],
      experimental: { policies: [{ action: 'provider.use', resource: 'openai', effect: 'deny' }] }
    })
    const config = JSON.parse(openCodeV2HiddenConfig(raw, [])) as {
      experimental: { policies?: unknown }
      disabled_providers?: unknown
    }
    expect(config.disabled_providers).toBeUndefined()
    expect(config.experimental.policies).toBeUndefined()
  })

  it('leaves an unrelated key untouched', () => {
    const raw = JSON.stringify({ theme: 'dark' })
    const config = JSON.parse(openCodeV2HiddenConfig(raw, ['openai'])) as { theme?: unknown }
    expect(config.theme).toBe('dark')
  })
})
