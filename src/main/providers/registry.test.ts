import { describe, expect, it } from 'vitest'
import { CLOUD_DEPLOYMENT_PROVIDER_KIND_VALUES } from '../../lib/types'
import { resolveDeploymentProvider } from './registry'

describe('resolveDeploymentProvider', () => {
  it('resolves the coolify kind to the real Coolify adapter', () => {
    const provider = resolveDeploymentProvider('coolify', {
      baseUrl: 'https://coolify.internal',
      token: 'test-token'
    })
    expect(provider.kind).toBe('coolify')
    expect(provider.getProviderInfo().implemented).toBe(true)
  })

  it('carries the verified base URL through to the Coolify adapter', () => {
    const provider = resolveDeploymentProvider('coolify', {
      baseUrl: 'https://coolify.internal',
      token: 'test-token'
    })
    expect(provider.getProviderInfo().baseUrl).toBe('https://coolify.internal')
  })

  it('keeps every non-coolify kind on the not-implemented stub', () => {
    const stubbedKinds = CLOUD_DEPLOYMENT_PROVIDER_KIND_VALUES.filter((kind) => kind !== 'coolify')
    expect(stubbedKinds).not.toHaveLength(0)
    for (const kind of stubbedKinds) {
      const provider = resolveDeploymentProvider(kind)
      expect(provider.kind).toBe(kind)
      expect(provider.getProviderInfo().implemented).toBe(false)
    }
  })
})
