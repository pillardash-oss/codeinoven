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

  it('saves the access token to the vault when the poll succeeds', async () => {
    process.env['CODEINOVEN_GITHUB_CLIENT_ID'] = 'Iv1.someClientId'
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'gho_approved' }))
    const vault = mockVault()
    const service = new GitHubAuthService(vault)

    const result = await service.pollAccessToken('device-abc')

    expect(result).toEqual({ status: 'authorized' })
    expect(vault.save).toHaveBeenCalledWith('gho_approved', 'github_oauth_token')
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
    const service = new GitHubAuthService(vault)

    await expect(service.status()).resolves.toEqual({
      connected: true,
      configured: true,
      user: {
        login: 'octocat',
        name: 'The Octocat',
        avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4'
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
