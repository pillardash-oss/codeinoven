import { afterEach, describe, expect, it, vi } from 'vitest'

const mobileIdentityMocks = vi.hoisted(() => ({
  current: vi.fn(),
  rotate: vi.fn()
}))

vi.mock('../../../../src/renderer/lib/remote/mobile-control-key', () => ({
  decryptDesktopGrant: vi.fn(),
  mobileGrantIdentity: mobileIdentityMocks.current,
  rotateMobileGrantIdentity: mobileIdentityMocks.rotate
}))

import {
  claimCloudDesktop,
  CloudApiError,
  revokeCloudDesktop
} from '../../../../src/renderer/lib/remote/cloud-api'

describe('cloud desktop revocation', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('rotates a stale browser identity and retries the claim once', async () => {
    mobileIdentityMocks.current.mockResolvedValue({
      id: 'stale-device-1234',
      name: 'Phone',
      publicKey: { kty: 'EC', crv: 'P-256', x: 'old-x', y: 'old-y' }
    })
    mobileIdentityMocks.rotate.mockResolvedValue({
      id: 'fresh-device-1234',
      name: 'Phone',
      publicKey: { kty: 'EC', crv: 'P-256', x: 'new-x', y: 'new-y' }
    })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: 'mobile-device-mismatch' }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ desktopId: 'desktop-1' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(claimCloudDesktop('ABCD-EFGH-IJKL-MNOP')).resolves.toBe('desktop-1')
    expect(mobileIdentityMocks.rotate).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('treats an already-revoked desktop as successfully removed', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ error: 'not-found' }, { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(revokeCloudDesktop('desktop/already-gone')).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledWith('/v1/desktops/desktop%2Falready-gone', {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: {}
    })
  })

  it('still reports real service failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ error: 'request-failed' }, { status: 503 }))
    )

    await expect(revokeCloudDesktop('desktop-1')).rejects.toEqual(
      new CloudApiError(503, 'request-failed')
    )
  })
})
