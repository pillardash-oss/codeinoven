import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitHubAuthService } from '../../src/main/git/github-auth-service'
import type { SecretVault } from '../../src/main/storage/secret-vault'
import { Logger } from '../../src/main/system/logger'

const fetchMock = vi.hoisted(() => vi.fn())
const lockCalls = vi.hoisted(() => [] as Array<'acquire' | 'release'>)

vi.stubGlobal('fetch', fetchMock)

/**
 * The credential lock's own behaviour is covered against real files in
 * `tests/main/cross-process-mutex.test.ts`. Here it only has to exist and be
 * observable, so a refresh can be asserted to take it without this suite
 * touching the machine's real lock directory.
 */
vi.mock('../../src/main/system/cross-process-mutex', () => ({
  CLAUDE_CREDENTIAL_LOCK_NAME: 'claude-credential-refresh',
  GITHUB_CREDENTIAL_LOCK_NAME: 'github-credential-refresh',
  CrossProcessMutex: class {
    async acquire(): Promise<() => void> {
      lockCalls.push('acquire')
      return () => lockCalls.push('release')
    }
  }
}))

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

/** The avatar download the profile read performs (the renderer CSP blocks remote hosts). */
function avatarResponse(): Response {
  return {
    ok: true,
    headers: new Headers({ 'content-type': 'image/png' }),
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer
  } as unknown as Response
}

function captureRequest(index = 0): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls[index]
  return { url: call[0] as string, init: (call[1] ?? {}) as RequestInit }
}

/** A vault stub that behaves like the real one: what is written is what is read. */
function mapVault(initial: Record<string, string> = {}): SecretVault {
  const values = new Map(Object.entries(initial))
  return {
    save: vi.fn(async (value: string, ref: string) => {
      values.set(ref, value)
      return ref
    }),
    resolve: vi.fn(async (ref: string) => values.get(ref) ?? ''),
    remove: vi.fn(async (ref: string) => {
      values.delete(ref)
    }),
    exists: vi.fn(async (ref: string) => values.has(ref)),
    isAvailable: vi.fn(() => true)
  } as unknown as SecretVault
}

function storedRef(vault: SecretVault, ref: string): string | null {
  const call = vi
    .mocked(vault.save)
    .mock.calls.filter(([, savedRef]) => savedRef === ref)
    .at(-1)
  return call ? (call[0] as string) : null
}

interface StoredFile {
  version: number
  activeId: string | null
  accounts: Array<{
    id: string
    login: string
    name: string | null
    credentials: Record<string, unknown>
  }>
}

/** The account list as the service last wrote it. */
function writtenFile(vault: SecretVault): StoredFile {
  const raw = storedRef(vault, 'github_oauth_accounts')
  if (raw === null) throw new Error('No GitHub accounts were written')
  return JSON.parse(raw) as StoredFile
}

function credentials(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: 1, accessToken: 'gho_secret', ...overrides }
}

/** One account entry of an account list file. */
function accountEntry(
  id: string,
  login: string,
  overrides: Record<string, unknown> = {}
): StoredFile['accounts'][number] {
  return { id, login, name: null, credentials: credentials(overrides) }
}

function accountsFile(accounts: StoredFile['accounts'], activeId: string): string {
  return JSON.stringify({ version: 1, activeId, accounts })
}

/**
 * A vault whose second read of the account list answers with a different file,
 * standing in for the other app instance that rotated the refresh token first.
 */
function rotatingVault(first: string, next: string): SecretVault {
  const vault = mapVault({ github_oauth_accounts: first })
  const base = vi.mocked(vault.resolve).getMockImplementation()
  if (!base) throw new Error('Vault stub has no read behaviour')
  let reads = 0
  vi.mocked(vault.resolve).mockImplementation(async (ref: string) => {
    reads += 1
    if (ref === 'github_oauth_accounts' && reads > 1) return next
    return await base(ref)
  })
  return vault
}

/**
 * A vault that keeps answering with the credential we already tried until
 * `afterMs` has passed, which is what a sibling instance that redeems the
 * refresh token a moment after our refusal looks like from here.
 */
function lateRotatingVault(first: string, next: string, afterMs: number): SecretVault {
  const vault = mapVault({ github_oauth_accounts: first })
  const base = vi.mocked(vault.resolve).getMockImplementation()
  if (!base) throw new Error('Vault stub has no read behaviour')
  const startedAt = Date.now()
  vi.mocked(vault.resolve).mockImplementation(async (ref: string) => {
    if (ref === 'github_oauth_accounts' && Date.now() - startedAt >= afterMs) return next
    return await base(ref)
  })
  return vault
}

describe('GitHubAuthService', () => {
  beforeEach(() => {
    delete process.env['CODEINOVEN_GITHUB_CLIENT_ID']
    lockCalls.length = 0
  })

  afterEach(() => {
    fetchMock.mockReset()
    delete process.env['CODEINOVEN_GITHUB_CLIENT_ID']
  })

  it('reports not configured when no client ID is set', async () => {
    const service = new GitHubAuthService(mapVault())
    await expect(service.status()).resolves.toEqual({
      connected: false,
      configured: false,
      user: null,
      accounts: [],
      activeAccountId: null
    })
    await expect(service.startDeviceFlow()).rejects.toThrow('client ID')
  })

  it('starts a device flow asking for the scope this registration needs', async () => {
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
    const service = new GitHubAuthService(mapVault())

    const code = await service.startDeviceFlow()

    const { url, init } = captureRequest()
    expect(url).toBe('https://github.com/login/device/code')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toMatchObject({
      client_id: 'Iv1.someClientId',
      scope: 'repo notifications'
    })
    expect(code).toEqual({
      deviceCode: 'device-abc',
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://github.com/login/device',
      expiresIn: 900,
      interval: 5
    })
  })

  it('adds an account, named from its profile, when the poll succeeds', async () => {
    process.env['CODEINOVEN_GITHUB_CLIENT_ID'] = 'Iv1.someClientId'
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: 'ghu_approved',
          expires_in: 28_800,
          refresh_token: 'ghr_initial',
          refresh_token_expires_in: 15_897_600
        })
      )
      .mockResolvedValueOnce(jsonResponse({ login: 'octocat', name: 'The Octocat' }))
    const vault = mapVault()
    const service = new GitHubAuthService(vault)

    await expect(service.pollAccessToken('device-abc')).resolves.toEqual({ status: 'authorized' })

    const file = writtenFile(vault)
    expect(file.accounts).toHaveLength(1)
    expect(file.accounts[0]).toMatchObject({
      login: 'octocat',
      credentials: {
        version: 1,
        accessToken: 'ghu_approved',
        refreshToken: 'ghr_initial'
      }
    })
    expect(file.accounts[0]?.credentials['accessTokenExpiresAt']).toEqual(expect.any(Number))
    expect(file.accounts[0]?.credentials['refreshTokenExpiresAt']).toEqual(expect.any(Number))
    expect(file.activeId).toBe(file.accounts[0]?.id)
    expect(captureRequest(1).url).toBe('https://api.github.com/user')
  })

  it('re-authorizing the same account replaces its credentials instead of adding a row', async () => {
    process.env['CODEINOVEN_GITHUB_CLIENT_ID'] = 'Iv1.someClientId'
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: 'ghu_new', expires_in: 28_800 }))
      .mockResolvedValueOnce(jsonResponse({ login: 'octocat', name: 'The Octocat' }))
    const vault = mapVault({
      github_oauth_accounts: accountsFile([accountEntry('account-1', 'octocat')], 'account-1')
    })
    const service = new GitHubAuthService(vault)

    await service.pollAccessToken('device-abc')

    const file = writtenFile(vault)
    expect(file.accounts).toHaveLength(1)
    expect(file.accounts[0]?.credentials['accessToken']).toBe('ghu_new')
    expect(file.activeId).toBe('account-1')
  })

  it('reports every signed-in account, with the active one named and its avatar inlined', async () => {
    process.env['CODEINOVEN_GITHUB_CLIENT_ID'] = 'Iv1.someClientId'
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          login: 'octocat',
          name: 'The Octocat',
          avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4'
        })
      )
      .mockResolvedValueOnce(avatarResponse())
    const vault = mapVault({
      github_oauth_accounts: accountsFile(
        [
          accountEntry('account-1', 'octocat', { accessToken: 'gho_one' }),
          accountEntry('account-2', 'hubot')
        ],
        'account-1'
      )
    })
    const service = new GitHubAuthService(vault)

    await expect(service.status()).resolves.toEqual({
      connected: true,
      configured: true,
      user: { login: 'octocat', name: 'The Octocat', avatarUrl: 'data:image/png;base64,AQID' },
      accounts: [
        // The profile read names the account it belongs to.
        { id: 'account-1', login: 'octocat', name: 'The Octocat', active: true },
        { id: 'account-2', login: 'hubot', name: null, active: false }
      ],
      activeAccountId: 'account-1'
    })
    await expect(service.resolveToken()).resolves.toBe('gho_one')
  })

  it('switches the active account, and every later call runs as that one', async () => {
    process.env['CODEINOVEN_GITHUB_CLIENT_ID'] = 'Iv1.someClientId'
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          login: 'hubot',
          name: 'Hubot',
          avatar_url: 'https://avatars.githubusercontent.com/u/2?v=4'
        })
      )
      .mockResolvedValueOnce(avatarResponse())
    const vault = mapVault({
      github_oauth_accounts: accountsFile(
        [
          accountEntry('account-1', 'octocat', { accessToken: 'gho_one' }),
          accountEntry('account-2', 'hubot', { accessToken: 'gho_two' })
        ],
        'account-1'
      )
    })
    const service = new GitHubAuthService(vault)

    const status = await service.switchAccount('account-2')

    expect(status.activeAccountId).toBe('account-2')
    expect(status.user?.login).toBe('hubot')
    expect(status.accounts.find((account) => account.id === 'account-2')?.active).toBe(true)
    await expect(service.resolveToken()).resolves.toBe('gho_two')
    expect(writtenFile(vault).activeId).toBe('account-2')
  })

  it('refuses to switch to an account that is not signed in', async () => {
    process.env['CODEINOVEN_GITHUB_CLIENT_ID'] = 'Iv1.someClientId'
    const vault = mapVault({
      github_oauth_accounts: accountsFile([accountEntry('account-1', 'octocat')], 'account-1')
    })
    const service = new GitHubAuthService(vault)

    await expect(service.switchAccount('account-9')).rejects.toThrow('no longer signed in')
  })

  it('signing out removes only the active account and moves to another one', async () => {
    process.env['CODEINOVEN_GITHUB_CLIENT_ID'] = 'Iv1.someClientId'
    const vault = mapVault({
      github_oauth_accounts: accountsFile(
        [accountEntry('account-1', 'octocat'), accountEntry('account-2', 'hubot')],
        'account-1'
      )
    })
    const service = new GitHubAuthService(vault)

    await service.logout()

    const file = writtenFile(vault)
    expect(file.accounts.map((account) => account.id)).toEqual(['account-2'])
    expect(file.activeId).toBe('account-2')
    expect(vault.remove).not.toHaveBeenCalled()
  })

  it('signing out the last account leaves nothing signed in', async () => {
    process.env['CODEINOVEN_GITHUB_CLIENT_ID'] = 'Iv1.someClientId'
    const vault = mapVault({
      github_oauth_accounts: accountsFile([accountEntry('account-1', 'octocat')], 'account-1')
    })
    const service = new GitHubAuthService(vault)

    await service.logout()

    expect(writtenFile(vault)).toMatchObject({ activeId: null, accounts: [] })
    await expect(service.activeAccountId()).resolves.toBeNull()
  })

  it('migrates a single-account credential into the account list on first read', async () => {
    process.env['CODEINOVEN_GITHUB_CLIENT_ID'] = 'Iv1.someClientId'
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          login: 'octocat',
          name: 'The Octocat',
          avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4'
        })
      )
      .mockResolvedValueOnce(avatarResponse())
    const vault = mapVault({
      github_oauth_token: JSON.stringify({ version: 1, accessToken: 'gho_legacy' })
    })
    const service = new GitHubAuthService(vault)

    const status = await service.status()

    expect(status.connected).toBe(true)
    // The migrated credential carried no login; the profile read names it.
    expect(status.accounts[0]).toMatchObject({ login: 'octocat', active: true })
    expect(status.user?.login).toBe('octocat')
    expect(vault.remove).toHaveBeenCalledWith('github_oauth_token')
    expect(writtenFile(vault).accounts[0]?.credentials['accessToken']).toBe('gho_legacy')
  })

  it('rotates an expired access token per account', async () => {
    process.env['CODEINOVEN_GITHUB_CLIENT_ID'] = 'Iv1.someClientId'
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        access_token: 'ghu_refreshed',
        expires_in: 28_800,
        refresh_token: 'ghr_rotated',
        refresh_token_expires_in: 15_897_600
      })
    )
    const vault = mapVault({
      github_oauth_accounts: accountsFile(
        [
          accountEntry('account-1', 'octocat', {
            accessToken: 'ghu_expired',
            refreshToken: 'ghr_initial',
            accessTokenExpiresAt: Date.now() - 1,
            refreshTokenExpiresAt: Date.now() + 60_000
          })
        ],
        'account-1'
      )
    })
    const service = new GitHubAuthService(vault)

    await expect(service.resolveToken()).resolves.toBe('ghu_refreshed')

    expect(captureRequest().url).toBe('https://github.com/login/oauth/access_token')
    expect(JSON.parse(String(captureRequest().init.body))).toEqual({
      client_id: 'Iv1.someClientId',
      grant_type: 'refresh_token',
      refresh_token: 'ghr_initial'
    })
    expect(writtenFile(vault).accounts[0]?.credentials['refreshToken']).toBe('ghr_rotated')
  })

  it('reports pending for authorization_pending and slow_down', async () => {
    process.env['CODEINOVEN_GITHUB_CLIENT_ID'] = 'Iv1.someClientId'
    const service = new GitHubAuthService(mapVault())

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'authorization_pending' }))
    await expect(service.pollAccessToken('device-abc')).resolves.toEqual({ status: 'pending' })

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'slow_down' }))
    await expect(service.pollAccessToken('device-abc')).resolves.toEqual({ status: 'pending' })
  })

  it('reports expired for expired_token and access_denied', async () => {
    process.env['CODEINOVEN_GITHUB_CLIENT_ID'] = 'Iv1.someClientId'
    const service = new GitHubAuthService(mapVault())

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'expired_token' }))
    await expect(service.pollAccessToken('device-abc')).resolves.toEqual({ status: 'expired' })

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'access_denied' }))
    await expect(service.pollAccessToken('device-abc')).resolves.toEqual({ status: 'expired' })
  })

  it('drops an account GitHub refuses, leaving the others signed in', async () => {
    process.env['CODEINOVEN_GITHUB_CLIENT_ID'] = 'Iv1.someClientId'
    // GitHub answers a refresh token it cannot redeem with this generic code,
    // whether it expired, was already used, or belongs to another app.
    fetchMock.mockResolvedValue(
      jsonResponse({
        error: 'incorrect_client_credentials',
        error_description: 'The client_id and/or client_secret passed are incorrect.'
      })
    )
    const vault = mapVault({
      github_oauth_accounts: accountsFile(
        [
          accountEntry('account-1', 'octocat', {
            accessToken: 'ghu_expired',
            refreshToken: 'ghr_dead',
            accessTokenExpiresAt: Date.now() - 1,
            refreshTokenExpiresAt: Date.now() + 60_000
          }),
          accountEntry('account-2', 'hubot', { accessToken: 'gho_two' })
        ],
        'account-1'
      )
    })
    const service = new GitHubAuthService(vault)

    // A refusal is held open for the window in which another instance could
    // still persist the replacement, so the clock is advanced past it.
    vi.useFakeTimers()
    try {
      const refusal = service.resolveToken()
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(refusal).resolves.toBeNull()
    } finally {
      vi.useRealTimers()
    }

    // The refused account is gone, and the healthy one took its place.
    const file = writtenFile(vault)
    expect(file.accounts.map((account) => account.id)).toEqual(['account-2'])
    expect(file.activeId).toBe('account-2')
    await expect(service.resolveToken()).resolves.toBe('gho_two')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps credentials when a refresh fails transiently and uses the still-valid token', async () => {
    process.env['CODEINOVEN_GITHUB_CLIENT_ID'] = 'Iv1.someClientId'
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'server error' }, 500))
    const vault = mapVault({
      github_oauth_accounts: accountsFile(
        [
          accountEntry('account-1', 'octocat', {
            accessToken: 'ghu_valid',
            refreshToken: 'ghr_live',
            accessTokenExpiresAt: Date.now() + 60_000,
            refreshTokenExpiresAt: Date.now() + 60_000
          })
        ],
        'account-1'
      )
    })
    const service = new GitHubAuthService(vault)

    await expect(service.resolveToken(true)).resolves.toBe('ghu_valid')

    // A transient failure is not a reason to forget the account.
    const stored = JSON.parse(String(await vault.resolve('github_oauth_accounts'))) as StoredFile
    expect(stored.accounts).toHaveLength(1)
  })

  it('names a client ID change instead of calling GitHub with credentials from another app', async () => {
    process.env['CODEINOVEN_GITHUB_CLIENT_ID'] = 'Iv1.someClientId'
    const vault = mapVault({
      github_oauth_accounts: accountsFile(
        [
          accountEntry('account-1', 'octocat', {
            clientId: 'Iv1.otherApp',
            accessToken: 'ghu_other_app',
            refreshToken: 'ghr_other_app',
            accessTokenExpiresAt: Date.now() - 1,
            refreshTokenExpiresAt: Date.now() + 60_000
          })
        ],
        'account-1'
      )
    })
    const service = new GitHubAuthService(vault)

    await expect(service.resolveToken(true)).resolves.toBeNull()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(writtenFile(vault)).toMatchObject({ activeId: null, accounts: [] })
  })

  it('drops an expired access token that no refresh token can renew', async () => {
    process.env['CODEINOVEN_GITHUB_CLIENT_ID'] = 'Iv1.someClientId'
    const vault = mapVault({
      github_oauth_accounts: accountsFile(
        [
          accountEntry('account-1', 'octocat', {
            accessToken: 'ghu_expired',
            accessTokenExpiresAt: Date.now() - 1
          })
        ],
        'account-1'
      )
    })
    const service = new GitHubAuthService(vault)

    await expect(service.resolveToken()).resolves.toBeNull()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(writtenFile(vault).accounts).toEqual([])
  })

  it('discards a malformed account list and reports signed out', async () => {
    process.env['CODEINOVEN_GITHUB_CLIENT_ID'] = 'Iv1.someClientId'
    const vault = mapVault({ github_oauth_accounts: '{not json' })
    const service = new GitHubAuthService(vault)

    await expect(service.status()).resolves.toMatchObject({
      connected: false,
      configured: true,
      accounts: []
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(vault.remove).toHaveBeenCalledWith('github_oauth_accounts')
  })

  it('uses the credential a sibling instance stored instead of redeeming the token again', async () => {
    process.env['CODEINOVEN_GITHUB_CLIENT_ID'] = 'Iv1.someClientId'
    const vault = rotatingVault(
      accountsFile(
        [
          accountEntry('account-1', 'octocat', {
            accessToken: 'ghu_stale',
            refreshToken: 'ghr_used',
            accessTokenExpiresAt: Date.now() - 1,
            refreshTokenExpiresAt: Date.now() + 60_000
          })
        ],
        'account-1'
      ),
      // What the winning instance stored a moment ago: a fresh access token.
      accountsFile(
        [
          accountEntry('account-1', 'octocat', {
            accessToken: 'ghu_rotated',
            refreshToken: 'ghr_rotated',
            accessTokenExpiresAt: Date.now() + 60_000,
            refreshTokenExpiresAt: Date.now() + 60_000
          })
        ],
        'account-1'
      )
    )
    const service = new GitHubAuthService(vault)

    await expect(service.resolveToken()).resolves.toBe('ghu_rotated')

    // The account keeps its sibling's credential, and GitHub is never asked to
    // redeem the token that sibling already spent.
    expect(vault.remove).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('holds the cross-instance credential lock across the exchange', async () => {
    process.env['CODEINOVEN_GITHUB_CLIENT_ID'] = 'Iv1.someClientId'
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ access_token: 'ghu_fresh', refresh_token: 'ghr_fresh', expires_in: 28_800 })
    )
    const vault = mapVault({
      github_oauth_accounts: accountsFile(
        [
          accountEntry('account-1', 'octocat', {
            accessToken: 'ghu_expired',
            refreshToken: 'ghr_used',
            accessTokenExpiresAt: Date.now() - 1,
            refreshTokenExpiresAt: Date.now() + 60_000
          })
        ],
        'account-1'
      )
    })
    const service = new GitHubAuthService(vault)

    await expect(service.resolveToken()).resolves.toBe('ghu_fresh')

    // Two instances sharing this vault must not redeem one single-use refresh
    // token at the same time.
    expect(lockCalls).toEqual(['acquire', 'release'])
  })

  it('keeps the account when the instance that won the race writes after our refusal', async () => {
    process.env['CODEINOVEN_GITHUB_CLIENT_ID'] = 'Iv1.someClientId'
    const vault = lateRotatingVault(
      accountsFile(
        [
          accountEntry('account-1', 'octocat', {
            accessToken: 'ghu_stale',
            refreshToken: 'ghr_used',
            accessTokenExpiresAt: Date.now() - 1,
            refreshTokenExpiresAt: Date.now() + 60_000
          })
        ],
        'account-1'
      ),
      accountsFile(
        [
          accountEntry('account-1', 'octocat', {
            accessToken: 'ghu_rotated',
            refreshToken: 'ghr_rotated',
            accessTokenExpiresAt: Date.now() + 60_000,
            refreshTokenExpiresAt: Date.now() + 60_000
          })
        ],
        'account-1'
      ),
      100
    )
    // Every exchange is refused: the sibling instance's request is the one
    // GitHub accepted, and its vault write lands after our refusal.
    fetchMock.mockResolvedValue(
      jsonResponse({
        error: 'incorrect_client_credentials',
        error_description: 'The client_id and/or client_secret passed are incorrect.'
      })
    )
    const service = new GitHubAuthService(vault)

    await expect(service.resolveToken()).resolves.toBe('ghu_rotated')

    // Losing the race must not sign the user out of an account that is healthy.
    expect(vault.remove).not.toHaveBeenCalled()
  })

  it('reports signed out at dev level when the vault cannot decrypt the stored credential', async () => {
    process.env['CODEINOVEN_GITHUB_CLIENT_ID'] = 'Iv1.someClientId'
    const errorSpy = vi.spyOn(Logger, 'error').mockImplementation(() => {})
    const devSpy = vi.spyOn(Logger, 'dev').mockImplementation(() => {})
    // A credential written under another build's keyring key: the record is there
    // and the read fails, which is not proof that the credential is invalid.
    const vault = mapVault({ github_oauth_accounts: 'written-by-another-build' })
    vi.mocked(vault.resolve).mockRejectedValue(
      new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
    )
    const service = new GitHubAuthService(vault)

    await expect(service.status()).resolves.toMatchObject({
      connected: false,
      configured: true,
      accounts: []
    })
    await expect(service.status()).resolves.toMatchObject({ connected: false, accounts: [] })

    // The vault owns the durable report for an unreadable credential (once per
    // incident, then at dev level); the sidebar poll must not add an error line
    // of its own every few seconds.
    expect(errorSpy).not.toHaveBeenCalled()
    expect(devSpy).toHaveBeenCalled()
    expect(vault.remove).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})
