import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitHubAuthService } from './github-auth-service'
import type { SecretVault } from './secret-vault'

const fetchMock = vi.hoisted(() => vi.fn())

vi.stubGlobal('fetch', fetchMock)

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

function captureRequest(): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls[0]
  return { url: call[0] as string, init: (call[1] ?? {}) as RequestInit }
}

function mockVault(): SecretVault {
  return {
    save: vi.fn().mockResolvedValue('ref'),
    resolve: vi.fn().mockResolvedValue('gho_secret'),
    remove: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(false),
    isAvailable: vi.fn(() => true)
  } as unknown as SecretVault
}

describe('GitHubAuthService', () => {
  afterEach(() => {
    fetchMock.mockReset()
    delete process.env['CODEINOVEN_GITHUB_CLIENT_ID']
  })

  it('reports not configured when no client ID is set', async () => {
    const service = new GitHubAuthService(mockVault())
    await expect(service.status()).resolves.toEqual({ connected: false, configured: false })
    await expect(service.startDeviceFlow()).rejects.toThrow('client ID')
  })

  it('starts a device flow and returns the code for the user to approve', async () => {
    process.env['CODEINOVEN_GITHUB_CLIENT_ID'] = 'Iv1.someClientId'
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        device_code: 'device-abc',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5
      })
    )
    const service = new GitHubAuthService(mockVault())

    const code = await service.startDeviceFlow()

    const { url, init } = captureRequest()
    expect(url).toBe('https://github.com/login/device/code')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toMatchObject({
      client_id: 'Iv1.someClientId',
      scope: 'repo'
    })
    expect(code).toEqual({
      deviceCode: 'device-abc',
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://github.com/login/device',
      expiresIn: 900,
      interval: 5
    })
  })

  it('saves refreshable credentials when the poll succeeds and rotates them when expired', async () => {
    process.env['CODEINOVEN_GITHUB_CLIENT_ID'] = 'Iv1.someClientId'
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        access_token: 'ghu_approved',
        expires_in: 28_800,
        refresh_token: 'ghr_initial',
        refresh_token_expires_in: 15_897_600
      })
    )
    const vault = mockVault()
    const service = new GitHubAuthService(vault)

    const result = await service.pollAccessToken('device-abc')

    expect(result).toEqual({ status: 'authorized' })
    const saved = JSON.parse(String(vi.mocked(vault.save).mock.calls[0]?.[0])) as Record<
      string,
      unknown
    >
    expect(saved).toMatchObject({
      version: 1,
      accessToken: 'ghu_approved',
      refreshToken: 'ghr_initial'
    })
    expect(saved['accessTokenExpiresAt']).toEqual(expect.any(Number))
    expect(saved['refreshTokenExpiresAt']).toEqual(expect.any(Number))
    expect(vault.save).toHaveBeenCalledWith(expect.any(String), 'github_oauth_token')

    vi.mocked(vault.exists).mockResolvedValue(true)
    vi.mocked(vault.resolve).mockResolvedValue(
      JSON.stringify({
        version: 1,
        accessToken: 'ghu_expired',
        refreshToken: 'ghr_initial',
        accessTokenExpiresAt: Date.now() - 1,
        refreshTokenExpiresAt: Date.now() + 60_000
      })
    )
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        access_token: 'ghu_refreshed',
        expires_in: 28_800,
        refresh_token: 'ghr_rotated',
        refresh_token_expires_in: 15_897_600
      })
    )

    await expect(service.resolveToken()).resolves.toBe('ghu_refreshed')
    const refreshRequest = fetchMock.mock.calls[1]
    expect(refreshRequest?.[0]).toBe('https://github.com/login/oauth/access_token')
    expect(JSON.parse(String((refreshRequest?.[1] as RequestInit | undefined)?.body))).toEqual({
      client_id: 'Iv1.someClientId',
      grant_type: 'refresh_token',
      refresh_token: 'ghr_initial'
    })
  })

  it('reports pending for authorization_pending and slow_down', async () => {
    process.env['CODEINOVEN_GITHUB_CLIENT_ID'] = 'Iv1.someClientId'
    const service = new GitHubAuthService(mockVault())

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'authorization_pending' }))
    await expect(service.pollAccessToken('device-abc')).resolves.toEqual({ status: 'pending' })

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'slow_down' }))
    await expect(service.pollAccessToken('device-abc')).resolves.toEqual({ status: 'pending' })
  })

  it('reports expired for expired_token and access_denied', async () => {
    process.env['CODEINOVEN_GITHUB_CLIENT_ID'] = 'Iv1.someClientId'
    const service = new GitHubAuthService(mockVault())

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'expired_token' }))
    await expect(service.pollAccessToken('device-abc')).resolves.toEqual({ status: 'expired' })

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'access_denied' }))
    await expect(service.pollAccessToken('device-abc')).resolves.toEqual({ status: 'expired' })
  })

  it('resolves the stored token and reports connected status with the user profile', async () => {
    process.env['CODEINOVEN_GITHUB_CLIENT_ID'] = 'Iv1.someClientId'
    const vault = mockVault()
    vi.mocked(vault.exists).mockResolvedValue(true)
    vi.mocked(vault.resolve).mockResolvedValue('gho_secret')
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        login: 'octocat',
        name: 'The Octocat',
        avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4'
      })
    )
    // Avatar download — inlined as a data URL because the renderer CSP blocks
    // remote image hosts.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'image/png' }),
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer
    } as unknown as Response)
    const service = new GitHubAuthService(vault)

    await expect(service.status()).resolves.toEqual({
      connected: true,
      configured: true,
      user: {
        login: 'octocat',
        name: 'The Octocat',
        avatarUrl: 'data:image/png;base64,AQID'
      }
    })
    await expect(service.resolveToken()).resolves.toBe('gho_secret')
  })

  it('logs out by removing the stored token', async () => {
    process.env['CODEINOVEN_GITHUB_CLIENT_ID'] = 'Iv1.someClientId'
    const vault = mockVault()
    const service = new GitHubAuthService(vault)

    await service.logout()

    expect(vault.remove).toHaveBeenCalledWith('github_oauth_token')
  })
})
