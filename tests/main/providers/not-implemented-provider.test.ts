import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CloudDeploymentProviderKind } from '../../../src/lib/types'
import { NotImplementedProvider } from '../../../src/main/providers/not-implemented-provider'

const stubKinds: readonly CloudDeploymentProviderKind[] = [
  'netlify',
  'railway',
  'vercel',
  'dokploy'
]

describe('NotImplementedProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each(stubKinds)('performs no network call for the %s stub', async (kind) => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const provider = new NotImplementedProvider(kind)
    await provider.listContainers()
    await provider.getStatus()
    await provider.getLogs()
    provider.getProviderInfo()

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each(stubKinds)('signals the %s stub as not implemented', (kind) => {
    const provider = new NotImplementedProvider(kind)
    expect(provider.getProviderInfo()).toMatchObject({ kind, implemented: false })
  })
})
