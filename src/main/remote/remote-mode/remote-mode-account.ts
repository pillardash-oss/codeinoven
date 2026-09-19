/**
 * Account session for remote mode.
 *
 * Owns the desktop account credential: the PKCE browser sign-in callback, the
 * token refresh schedule, and the cached/live account profile. The remote-mode
 * controller keeps it as a member and routes the `account:*` IPC channels here,
 * so the controller only manages transports and devices.
 */

import { BrowserWindow } from 'electron'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { Logger } from '../../system/logger'
import { sendToRenderer } from '../../ipc/renderer-delivery'
import type { SecretVault } from '../../storage/secret-vault'
import type { StorageEngine } from '../../storage/storage-engine'
import type { AccountProfileRepo } from '../../database/repositories/account-profile-repo'
import {
  mergeTombstones,
  readMemorySyncState,
  tombstonesForDeletions,
  writeMemorySyncState
} from '../memory-sync-state'
import type {
  AccountAuthProvider,
  AccountProfile,
  AccountProfileState,
  AccountProfileSyncPayload,
  AccountSignInStart,
  MemoryEntry
} from '../../../lib/types'
import {
  ACCOUNT_CONFIG_PATH,
  ACCOUNT_PROFILE_REFRESH_MIN_INTERVAL_MS,
  ACCOUNT_PROFILE_REFRESH_RETRY_INITIAL_MS,
  ACCOUNT_PROFILE_REFRESH_RETRY_MAX_MS,
  ACCOUNT_TOKEN_REFRESH_LEAD_MS,
  ACCOUNT_TOKEN_REFRESH_RETRY_MS,
  ACCOUNT_TOKEN_REFRESH_TIMER_MAX_MS,
  CLOUD_CONFIG_PATH,
  CLOUD_REQUEST_TIMEOUT_MS,
  fetchWithDeadline,
  isExpectedCloudFailure,
  parseAccountProfile,
  type AccountSessionConfig,
  type CloudAccessConfig
} from './remote-mode-cloud-protocol'

export interface RemoteAccountSessionOptions {
  storage: StorageEngine | null
  vault: SecretVault | null
  accountProfileRepo: AccountProfileRepo | null
  cloudApiOrigin: string | null
  accountAuthOrigin: string | null
  /** Supplies local usage and global memory for authenticated profile sync. */
  loadAccountProfileData?: () => Promise<AccountProfileSyncPayload>
  /** Applies the merged cloud memory snapshot to local global memory. */
  applyGlobalMemories?: (entries: MemoryEntry[]) => Promise<void>
  /** Current cloud enrollment config, used to fall back to its profile token. */
  getCloudConfig: () => CloudAccessConfig | null
  /** Cancellation signal shared with cloud requests (undefined when idle). */
  getAbortSignal: () => AbortSignal | undefined
  /** Whether a cloud enrollment is still waiting to be claimed. */
  isEnrollmentPending: () => boolean
}

export class RemoteAccountSession {
  private readonly storage: StorageEngine | null
  private readonly vault: SecretVault | null
  private readonly accountProfileRepo: AccountProfileRepo | null
  private readonly cloudApiOrigin: string | null
  private readonly accountAuthOrigin: string | null
  private readonly loadAccountProfileData?: () => Promise<AccountProfileSyncPayload>
  private readonly applyGlobalMemories?: (entries: MemoryEntry[]) => Promise<void>
  private readonly getCloudConfig: () => CloudAccessConfig | null
  private readonly getAbortSignal: () => AbortSignal | undefined
  private readonly isEnrollmentPending: () => boolean
  private accountConfig: AccountSessionConfig | null = null
  private accountSignInServer: Server | null = null
  private accountSignInTimeout: ReturnType<typeof setTimeout> | null = null
  private accountTokenRefreshTimer: ReturnType<typeof setTimeout> | null = null
  private accountTokenRefreshPromise: Promise<AccountSessionConfig> | null = null
  /** Bumped on sign-out so in-flight profile refreshes never re-broadcast stale state. */
  private accountProfileGeneration = 0
  private accountProfileRefreshPromise: Promise<void> | null = null
  private accountProfileRefreshFailureCount = 0
  private accountProfileRefreshRetryAt = 0
  private accountProfileRefreshedAt = 0

  constructor(private readonly options: RemoteAccountSessionOptions) {
    this.storage = options.storage
    this.vault = options.vault
    this.accountProfileRepo = options.accountProfileRepo
    this.cloudApiOrigin = options.cloudApiOrigin
    this.accountAuthOrigin = options.accountAuthOrigin
    this.loadAccountProfileData = options.loadAccountProfileData
    this.applyGlobalMemories = options.applyGlobalMemories
    this.getCloudConfig = options.getCloudConfig
    this.getAbortSignal = options.getAbortSignal
    this.isEnrollmentPending = options.isEnrollmentPending
  }

  /** Current persisted account session config, if signed in. */
  get config(): AccountSessionConfig | null {
    return this.accountConfig
  }

  /** Adopt a session config produced by cloud enrollment and persist it. */
  async adoptConfig(config: AccountSessionConfig): Promise<void> {
    this.accountConfig = config
    if (this.storage) await this.storage.write(ACCOUNT_CONFIG_PATH, config)
  }

  /** Stop the sign-in listener and the token refresh timer. */
  dispose(): void {
    this.closeAccountSignInListener()
    if (this.accountTokenRefreshTimer) clearTimeout(this.accountTokenRefreshTimer)
    this.accountTokenRefreshTimer = null
  }

  private async accountRequest(init?: RequestInit): Promise<Response | null> {
    if (!this.vault) return null
    const accountConfig =
      this.accountConfig ??
      (await this.storage?.read<AccountSessionConfig>(ACCOUNT_CONFIG_PATH)) ??
      null
    this.accountConfig = accountConfig
    const freshAccountConfig = accountConfig
      ? await this.ensureFreshAccountToken(accountConfig)
      : null
    const cloudConfig =
      this.getCloudConfig() ??
      (await this.storage?.read<CloudAccessConfig>(CLOUD_CONFIG_PATH)) ??
      null
    const tokenRef = freshAccountConfig?.profileTokenRef ?? cloudConfig?.profileTokenRef
    if (!tokenRef) return null
    let token: string | null
    try {
      token = await this.vault.resolve(tokenRef)
    } catch (error) {
      if (error instanceof Error && error.message === 'Credential not found') {
        token = null
      } else {
        throw error
      }
    }
    if (token === null) return null
    const apiOrigin = freshAccountConfig?.apiOrigin ?? cloudConfig?.apiOrigin
    return fetchWithDeadline(
      new URL('/v1/profile', apiOrigin),
      {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
          ...init?.headers
        }
      },
      CLOUD_REQUEST_TIMEOUT_MS,
      this.getAbortSignal()
    )
  }

  private async loadProfileImage(profile: AccountProfile): Promise<AccountProfile> {
    if (!profile.image || profile.image.startsWith('data:')) return profile
    try {
      const url = new URL(profile.image)
      if (url.protocol !== 'https:') return { ...profile, image: null }
      const response = await fetchWithDeadline(url, {}, 5_000)
      const contentType = response.headers.get('content-type') ?? ''
      const contentLength = Number(response.headers.get('content-length') ?? 0)
      const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
      if (!response.ok || !allowedTypes.has(contentType) || contentLength > 2 * 1_024 * 1_024) {
        return { ...profile, image: null }
      }
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength > 2 * 1_024 * 1_024) return { ...profile, image: null }
      return {
        ...profile,
        image: `data:${contentType};base64,${Buffer.from(bytes).toString('base64')}`
      }
    } catch {
      return { ...profile, image: null }
    }
  }

  /**
   * Current account profile, served from the SQLite cache first so a restart
   * (or an offline window) never loses the signed-in identity. When a cached
   * profile exists the live fetch runs in the background and broadcasts a fresh
   * copy via `account:profileChanged` when it lands.
   */
  async accountProfile(): Promise<AccountProfileState> {
    const cached = await this.readCachedAccountProfile()
    if (cached) {
      void this.refreshAccountProfileInBackground()
      return { status: 'signed-in', profile: cached }
    }
    try {
      return await this.fetchAccountProfile()
    } catch (error) {
      if (!isExpectedCloudFailure(error)) {
        Logger.dev('Account profile could not be fetched:', error)
      }
      return {
        status: this.accountSignInServer || this.isEnrollmentPending() ? 'pending' : 'signed-out',
        profile: null
      }
    }
  }

  private async fetchAccountProfile(): Promise<AccountProfileState> {
    const response = await this.accountRequest()
    if (!response || response.status === 401) {
      return {
        status: this.accountSignInServer || this.isEnrollmentPending() ? 'pending' : 'signed-out',
        profile: null
      }
    }
    if (!response.ok) throw new Error('Account profile is unavailable')
    const profile = parseAccountProfile(await response.json())
    if (!profile) throw new Error('Account profile response is invalid')
    const withImage = await this.loadProfileImage(profile)
    await this.cacheAccountProfile(withImage)
    return { status: 'signed-in', profile: withImage }
  }

  /**
   * Revalidate a cached profile from the network without disturbing the state
   * already served. Network failures are deliberately swallowed   the cached
   * signed-in identity stays until a successful fetch or an explicit sign-out.
   */
  private refreshAccountProfileInBackground(): Promise<void> {
    if (this.accountProfileRefreshPromise) return this.accountProfileRefreshPromise
    if (Date.now() < this.accountProfileRefreshRetryAt) return Promise.resolve()
    if (Date.now() - this.accountProfileRefreshedAt < ACCOUNT_PROFILE_REFRESH_MIN_INTERVAL_MS) {
      return Promise.resolve()
    }
    this.accountProfileRefreshPromise = this.runAccountProfileRefresh().finally(() => {
      this.accountProfileRefreshPromise = null
    })
    return this.accountProfileRefreshPromise
  }

  private async runAccountProfileRefresh(): Promise<void> {
    const generation = this.accountProfileGeneration
    this.accountProfileRefreshedAt = Date.now()
    try {
      const state = await this.fetchAccountProfile()
      if (generation !== this.accountProfileGeneration) return
      // A background probe must never drop a cached identity   only a successful
      // fetch (or an explicit sign-out) changes what the user sees.
      if (state.status !== 'signed-in') {
        Logger.dev('Account profile revalidation is not signed in; keeping the cached profile')
        this.deferAccountProfileRefresh()
        return
      }
      this.accountProfileRefreshFailureCount = 0
      this.accountProfileRefreshRetryAt = 0
      this.broadcastAccountProfile(state)
    } catch (error) {
      if (generation !== this.accountProfileGeneration) return
      const retryDelay = this.deferAccountProfileRefresh()
      // Cancellation (cloud teardown/enrollment resets the shared abort
      // controller) and timeouts are expected while offline, so keep the log
      // quiet while the bounded retry delay is active.
      if (!isExpectedCloudFailure(error)) {
        Logger.dev(
          `Account profile refresh deferred for ${Math.ceil(retryDelay / 1_000)}s; keeping the cached profile:`,
          error
        )
      }
    }
  }

  private deferAccountProfileRefresh(): number {
    const exponent = Math.min(this.accountProfileRefreshFailureCount, 4)
    const retryDelay = Math.min(
      ACCOUNT_PROFILE_REFRESH_RETRY_INITIAL_MS * 2 ** exponent,
      ACCOUNT_PROFILE_REFRESH_RETRY_MAX_MS
    )
    this.accountProfileRefreshFailureCount += 1
    this.accountProfileRefreshRetryAt = Date.now() + retryDelay
    return retryDelay
  }

  private async readCachedAccountProfile(): Promise<AccountProfile | null> {
    try {
      return this.accountProfileRepo?.load() ?? null
    } catch (error) {
      Logger.dev('Could not read the cached account profile:', error)
      return null
    }
  }

  private async cacheAccountProfile(profile: AccountProfile): Promise<void> {
    try {
      this.accountProfileRepo?.save(profile)
    } catch (error) {
      Logger.dev('Could not cache the account profile:', error)
    }
  }

  private async clearCachedAccountProfile(): Promise<void> {
    try {
      this.accountProfileRepo?.clear()
    } catch (error) {
      Logger.dev('Could not clear the cached account profile:', error)
    }
  }

  /**
   * Explicit account sign-out: revoke the persisted session token, remove the
   * session config, and delete the cached profile (the only thing that removes
   * the cached identity). Remote-device enrollment is independent and untouched.
   */
  async signOutAccount(): Promise<void> {
    this.accountProfileGeneration++
    this.accountProfileRefreshFailureCount = 0
    this.accountProfileRefreshRetryAt = 0
    this.accountProfileRefreshedAt = 0
    const config =
      this.accountConfig ??
      (await this.storage?.read<AccountSessionConfig>(ACCOUNT_CONFIG_PATH)) ??
      null
    if (config?.profileTokenRef && this.vault) {
      await this.vault.remove(config.profileTokenRef).catch(() => undefined)
    }
    if (this.storage) {
      await this.storage.remove(ACCOUNT_CONFIG_PATH).catch(() => undefined)
    }
    this.accountConfig = null
    await this.clearCachedAccountProfile()
    this.broadcastAccountProfile({ status: 'signed-out', profile: null })
  }

  async beginAccountSignIn(provider: AccountAuthProvider): Promise<AccountSignInStart> {
    if (provider !== 'google' && provider !== 'apple') throw new Error('Invalid account provider')
    if (!this.cloudApiOrigin) throw new Error('REMOTE_API_ORIGIN is not configured')
    if (!this.accountAuthOrigin) throw new Error('ACCOUNT_AUTH_ORIGIN is not configured')
    if (!this.storage || !this.vault || !this.vault.isAvailable()) {
      throw new Error('Secure desktop storage is unavailable')
    }

    this.closeAccountSignInListener()
    const state = randomBytes(32).toString('base64url')
    const codeVerifier = randomBytes(48).toString('base64url')
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
    const callback = await this.listenForAccountCallback(state, codeVerifier)
    const url = new URL('/desktop/sign-in', this.accountAuthOrigin)
    url.search = new URLSearchParams({
      provider,
      redirect_uri: callback,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256'
    }).toString()
    return { url: url.toString() }
  }

  private closeAccountSignInListener(): void {
    if (this.accountSignInTimeout) clearTimeout(this.accountSignInTimeout)
    this.accountSignInTimeout = null
    this.accountSignInServer?.close()
    this.accountSignInServer = null
  }

  private failAccountSignIn(message: string): void {
    this.closeAccountSignInListener()
    this.broadcastAccountProfile({ status: 'error', profile: null, message })
  }

  private accountCallbackResponse(response: ServerResponse, status: number, message: string): void {
    response.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'"
    })
    response.end(
      `<!doctype html><meta charset="utf-8"><title>CodeInOven sign-in</title><style>body{font:16px system-ui;margin:48px;color:#081825}main{max-width:560px}p{line-height:1.6}</style><main><h1>${status === 200 ? 'Sign-in complete' : 'Sign-in failed'}</h1><p>${message}</p></main>`
    )
  }

  private async listenForAccountCallback(state: string, codeVerifier: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = createServer((request, response) => {
        void (async () => {
          let terminalCallback = false
          try {
            const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
            if (request.method !== 'GET' || requestUrl.pathname !== '/account/callback') {
              this.accountCallbackResponse(response, 404, 'This callback is not valid.')
              return
            }
            terminalCallback = true
            const callbackState = requestUrl.searchParams.get('state')
            const code = requestUrl.searchParams.get('code')
            if (callbackState !== state || !code) {
              this.broadcastAccountProfile({
                status: 'error',
                profile: null,
                message: 'The browser callback could not be verified. Start sign-in again.'
              })
              this.accountCallbackResponse(
                response,
                400,
                'The sign-in response could not be verified.'
              )
              return
            }
            const callbackUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/account/callback`
            const exchange = await fetchWithDeadline(
              new URL('/v1/desktop-auth/exchange', this.cloudApiOrigin!),
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code, codeVerifier, redirectUri: callbackUrl })
              },
              CLOUD_REQUEST_TIMEOUT_MS
            )
            const payload = (await exchange.json()) as Record<string, unknown>
            const profileToken = payload['profileToken']
            const expiresAt = payload['expiresAt']
            if (
              !exchange.ok ||
              typeof profileToken !== 'string' ||
              profileToken.length === 0 ||
              typeof expiresAt !== 'number' ||
              !Number.isFinite(expiresAt)
            ) {
              throw new Error('Account credential exchange failed')
            }
            const profileTokenRef = await this.vault!.save(
              profileToken,
              this.accountConfig?.profileTokenRef
            )
            this.accountConfig = { apiOrigin: this.cloudApiOrigin!, profileTokenRef, expiresAt }
            await this.storage!.write(ACCOUNT_CONFIG_PATH, this.accountConfig)
            this.scheduleAccountTokenRefresh(expiresAt)
            this.accountProfileGeneration++
            this.accountProfileRefreshFailureCount = 0
            this.accountProfileRefreshRetryAt = 0
            const profile = await this.syncAccountProfile()
            this.accountProfileRefreshedAt = Date.now()
            this.broadcastAccountProfile(profile)
            this.accountCallbackResponse(
              response,
              200,
              'Your account is connected. You can close this tab and return to CodeInOven.'
            )
          } catch (error) {
            Logger.error('Desktop account sign-in callback failed:', error)
            this.broadcastAccountProfile({
              status: 'error',
              profile: null,
              message: 'The browser returned to CodeInOven, but the account could not be connected.'
            })
            this.accountCallbackResponse(
              response,
              500,
              'CodeInOven could not finish connecting your account. Return to the app and try again.'
            )
          } finally {
            if (terminalCallback) this.closeAccountSignInListener()
          }
        })()
      })
      server.once('error', (error) => {
        this.failAccountSignIn('CodeInOven could not open a local callback port. Try again.')
        reject(error)
      })
      server.listen(0, '127.0.0.1', () => {
        this.accountSignInServer = server
        const address = server.address()
        if (!address || typeof address === 'string') {
          this.closeAccountSignInListener()
          reject(new Error('Desktop sign-in callback listener is unavailable'))
          return
        }
        this.accountSignInTimeout = setTimeout(
          () =>
            this.failAccountSignIn('Sign-in timed out. Start again to open a new secure callback.'),
          5 * 60 * 1_000
        )
        this.broadcastAccountProfile({ status: 'pending', profile: null })
        resolve(`http://127.0.0.1:${address.port}/account/callback`)
      })
    })
  }

  private scheduleAccountTokenRefresh(expiresAt: number): void {
    if (this.accountTokenRefreshTimer) clearTimeout(this.accountTokenRefreshTimer)
    const delay = Math.min(
      ACCOUNT_TOKEN_REFRESH_TIMER_MAX_MS,
      Math.max(60_000, expiresAt - Date.now() - ACCOUNT_TOKEN_REFRESH_LEAD_MS)
    )
    this.accountTokenRefreshTimer = setTimeout(() => {
      this.accountTokenRefreshTimer = null
      const config = this.accountConfig
      if (!config) return
      void this.ensureFreshAccountToken(config).catch((error) => {
        Logger.dev('Account token refresh unavailable:', error)
      })
    }, delay)
  }

  async ensureFreshAccountToken(config: AccountSessionConfig): Promise<AccountSessionConfig> {
    if (!config.expiresAt || config.expiresAt - Date.now() > ACCOUNT_TOKEN_REFRESH_LEAD_MS) {
      if (config.expiresAt) this.scheduleAccountTokenRefresh(config.expiresAt)
      return config
    }
    if (this.accountTokenRefreshPromise) return this.accountTokenRefreshPromise
    this.accountTokenRefreshPromise = (async () => {
      try {
        if (!this.vault || !this.storage) return config
        const currentToken = await this.vault.resolve(config.profileTokenRef)
        const response = await fetchWithDeadline(
          new URL('/v1/desktop-auth/refresh', config.apiOrigin),
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${currentToken}` }
          },
          CLOUD_REQUEST_TIMEOUT_MS
        )
        const payload = (await response.json()) as Record<string, unknown>
        const profileToken = payload['profileToken']
        const expiresAt = payload['expiresAt']
        if (
          !response.ok ||
          typeof profileToken !== 'string' ||
          !profileToken ||
          typeof expiresAt !== 'number' ||
          !Number.isFinite(expiresAt)
        ) {
          throw new Error('Account token refresh failed')
        }
        const profileTokenRef = await this.vault.save(profileToken, config.profileTokenRef)
        const refreshed = { ...config, profileTokenRef, expiresAt }
        this.accountConfig = refreshed
        await this.storage.write(ACCOUNT_CONFIG_PATH, refreshed)
        this.scheduleAccountTokenRefresh(expiresAt)
        return refreshed
      } catch (error) {
        this.accountTokenRefreshTimer = setTimeout(() => {
          this.accountTokenRefreshTimer = null
          void this.ensureFreshAccountToken(config).catch(() => undefined)
        }, ACCOUNT_TOKEN_REFRESH_RETRY_MS)
        if (!config.expiresAt || config.expiresAt > Date.now()) {
          Logger.dev('Account token refresh deferred; current token remains valid:', error)
          return config
        }
        throw error
      } finally {
        this.accountTokenRefreshPromise = null
      }
    })()
    return this.accountTokenRefreshPromise
  }

  private broadcastAccountProfile(state: AccountProfileState): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) sendToRenderer(window.webContents, 'account:profileChanged', state)
    }
  }

  async syncAccountProfile(): Promise<AccountProfileState> {
    if (!this.loadAccountProfileData) return this.accountProfile()
    const cached = await this.readCachedAccountProfile()
    try {
      const local = await this.loadAccountProfileData()
      const now = Date.now()
      const syncState = await readMemorySyncState(this.storage)
      const localIds = local.globalMemories.map((entry) => entry.id)
      // Entries that were part of the last synced snapshot but are gone locally
      // now were deleted   record a tombstone so the deletion sticks server-side.
      const newTombstones = syncState
        ? tombstonesForDeletions(syncState.lastSnapshotIds, localIds, now)
        : []
      const tombstones = mergeTombstones(
        [...(syncState?.tombstones ?? []), ...local.globalMemoryTombstones, ...newTombstones],
        now
      )
      const response = await this.accountRequest({
        method: 'PUT',
        body: JSON.stringify({
          ...local,
          globalMemoryTombstones: tombstones
        })
      })
      if (!response || response.status === 401) return { status: 'signed-out', profile: null }
      if (!response.ok) throw new Error('Account profile sync failed')
      const profile = parseAccountProfile(await response.json())
      if (!profile) throw new Error('Account profile response is invalid')
      await this.applyGlobalMemories?.(profile.globalMemories)
      await writeMemorySyncState(this.storage, {
        lastSnapshotIds: profile.globalMemories.map((entry) => entry.id),
        tombstones: profile.globalMemoryTombstones,
        updatedAt: now
      })
      const withImage = await this.loadProfileImage(profile)
      await this.cacheAccountProfile(withImage)
      return { status: 'signed-in', profile: withImage }
    } catch (error) {
      if (cached) return { status: 'signed-in', profile: cached }
      throw error
    }
  }
}
