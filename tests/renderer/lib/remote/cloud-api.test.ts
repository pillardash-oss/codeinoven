import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloudApiError, revokeCloudDesktop } from '../../../../src/renderer/lib/remote/cloud-api'

describe('cloud desktop revocation', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
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
