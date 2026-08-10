/// <reference types="vite/client" />
import type { GitHubAuthStatus, GitHubDeviceCode, GitHubPollResult } from '../lib/types'
import { Logger } from './logger'
import type { SecretVault } from './secret-vault'

declare global {
  /**
   * GitHub App public client ID, replaced at build time by Vite's `define` from
   * the shared `.env` value `CODEINOVEN_GITHUB_CLIENT_ID`. Public by design.
   */
  const __CODEINOVEN_GITHUB_CLIENT_ID__: string | undefined
}

/** OAuth scopes required to read and manage pull requests. */
const GITHUB_OAUTH_SCOPES = 'repo'

/** OAuth token ref stored in the SecretVault. */
const GITHUB_TOKEN_REF = 'github_oauth_token'

const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'
const REFRESH_GRANT_TYPE = 'refresh_token'

const NETWORK_TIMEOUT_MS = 15_000
const TOKEN_REFRESH_LEEWAY_MS = 5 * 60 * 1000

/**
 * How long a fetched GitHub profile (with its inlined avatar) is served from
 * memory before it is re-fetched. The Git panel remounts on every tab switch
 * and would otherwise re-hit `api.github.com/user` and re-download the avatar
 * image each time — the avatar is inlined as a `data:` URL, so the browser's
 * HTTP cache never applies to it.
 */
const GITHUB_USER_CACHE_TTL_MS = 5 * 60 * 1000

/** Refuse to inline an avatar larger than this (guards the IPC payload). */
const AVATAR_MAX_BYTES = 512 * 1024

interface StoredGitHubCredentials {
  version: 1
  accessToken: string
  refreshToken?: string
  accessTokenExpiresAt?: number
  refreshTokenExpiresAt?: number
}

/**
 * GitHub device-flow OAuth for the Git sidebar.
 *
 * Device flow is the OAuth variant designed for CLI/desktop apps: no client
 * secret is needed, the user authorizes by typing a short code into the
 * github.com/login/device page in any browser, and the app polls the token
 * endpoint until approval (or expiry).
 *
 * The token is resolved from `SecretVault` in the main process only and is
 * never serialized into IPC payloads or logs.
 */
export class GitHubAuthService {
  private refreshPromise: Promise<string | null> | null = null

  /**
   * Last fetched profile (login, name, inlined avatar) with its timestamp.
   * Served without network while fresh, so repeated panel mounts don't re-hit
   * the GitHub API or re-download the avatar. Cleared whenever credentials
   * change (login/logout/token rotation) so the cache can never show a stale user.
   */
  private cachedUser: { user: GitHubAuthStatus['user']; at: number } | null = null

  constructor(private readonly vault: SecretVault) {}

  /**
   * GitHub App public client ID — never a secret, safe to embed or configure via env.
   *
   * Resolution order:
   * 1. `__CODEINOVEN_GITHUB_CLIENT_ID__` — replaced at build time by Vite's
   *    `define` from `.env` (`CODEINOVEN_GITHUB_CLIENT_ID`). The compile-time constant.
   * 2. `CODEINOVEN_GITHUB_CLIENT_ID` — runtime override (CI shells, tests).
   */
  private get clientId(): string {
    const baked =
      typeof __CODEINOVEN_GITHUB_CLIENT_ID__ === 'string'
        ? __CODEINOVEN_GITHUB_CLIENT_ID__
        : undefined
    const runtime = process.env['CODEINOVEN_GITHUB_CLIENT_ID']
    return (baked?.trim() ? baked : (runtime ?? '')).trim()
  }

  get configured(): boolean {
    return this.clientId.length > 0
  }

  async status(): Promise<GitHubAuthStatus> {
    if (!this.configured) return { connected: false, configured: false }
    const connected = await this.vault.exists(GITHUB_TOKEN_REF)
    if (!connected) return { connected: false, configured: true }
    return {
      connected: true,
      configured: true,
      user: await this.fetchUserProfile()
    }
  }

  /** Resolve the public profile of the signed-in user (never the token). */
  private async fetchUserProfile(): Promise<GitHubAuthStatus['user']> {
    const cached = this.cachedUser
    if (cached && Date.now() - cached.at < GITHUB_USER_CACHE_TTL_MS) return cached.user
    const token = await this.resolveToken()
    if (!token) return null
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS)
      try {
        const response = await fetch('https://api.github.com/user', {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'User-Agent': 'CodeInOven'
          },
          signal: controller.signal
        })
        if (!response.ok) return null
        const record = (await response.json()) as Record<string, unknown>
        const login = this.readString(record, 'login')
        const avatarUrl = this.readString(record, 'avatar_url')
        if (!login || !avatarUrl) return null
        const user = {
          login,
          name: this.readString(record, 'name'),
          // Never hand back the remote URL: the renderer CSP would block it.
          avatarUrl: await this.inlineAvatar(avatarUrl)
        }
        this.cachedUser = { user, at: Date.now() }
        return user
      } finally {
        clearTimeout(timer)
      }
    } catch {
      return null
    }
  }

  async startDeviceFlow(): Promise<GitHubDeviceCode> {
    if (!this.configured) {
      throw new Error('GitHub App client ID is not configured')
    }
    const response = await this.postJson(DEVICE_CODE_URL, {
      client_id: this.clientId,
      scope: GITHUB_OAUTH_SCOPES
    })
    const record = response as Record<string, unknown>
    const deviceCode = this.readString(record, 'device_code')
    const userCode = this.readString(record, 'user_code')
    const verificationUri = this.readString(record, 'verification_uri')
    const expiresIn = this.readNumber(record, 'expires_in')
    const interval = this.readNumber(record, 'interval')
    if (!deviceCode || !userCode || !verificationUri) {
      throw new Error('GitHub device flow returned an incomplete response')
    }
    Logger.info('GitHub device flow started', {
      verificationUri,
      expiresIn: expiresIn || undefined,
      interval: interval || undefined
    })
    return {
      deviceCode,
      userCode,
      verificationUri,
      expiresIn: expiresIn > 0 ? expiresIn : 900,
      interval: interval > 0 ? interval : 5
    }
  }

  async pollAccessToken(deviceCode: string): Promise<GitHubPollResult> {
    if (!this.configured) {
      return { status: 'error', message: 'GitHub App client ID is not configured' }
    }
    try {
      const response = await this.postJson(ACCESS_TOKEN_URL, {
        client_id: this.clientId,
        device_code: deviceCode,
        grant_type: GRANT_TYPE
      })
      const record = response as Record<string, unknown>
      const token = this.readString(record, 'access_token')
      if (token) {
        await this.saveCredentials(record)
        Logger.info('GitHub OAuth token stored in secure vault')
        return { status: 'authorized' }
      }
      const error = this.readString(record, 'error') ?? 'unknown_error'
      switch (error) {
        case 'authorization_pending':
          return { status: 'pending' }
        case 'slow_down':
          return { status: 'pending' }
        case 'expired_token':
        case 'access_denied':
          return { status: 'expired' }
        default:
          return { status: 'error', message: error }
      }
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : 'GitHub token poll failed'
      return { status: 'error', message }
    }
  }

  async resolveToken(forceRefresh = false): Promise<string | null> {
    if (!(await this.vault.exists(GITHUB_TOKEN_REF))) return null
    const stored = this.parseCredentials(await this.vault.resolve(GITHUB_TOKEN_REF))
    if (!stored.refreshToken) return stored.accessToken

    const now = Date.now()
    const shouldRefresh =
      forceRefresh ||
      (stored.accessTokenExpiresAt !== undefined &&
        stored.accessTokenExpiresAt - now <= TOKEN_REFRESH_LEEWAY_MS)
    if (!shouldRefresh) return stored.accessToken
    if (stored.refreshTokenExpiresAt !== undefined && stored.refreshTokenExpiresAt <= now) {
      return stored.accessToken
    }
    if (this.refreshPromise) return this.refreshPromise

    const refresh = this.refreshCredentials(stored)
    this.refreshPromise = refresh
    try {
      return await refresh
    } finally {
      if (this.refreshPromise === refresh) this.refreshPromise = null
    }
  }

  async logout(): Promise<void> {
    this.cachedUser = null
    await this.vault.remove(GITHUB_TOKEN_REF)
  }

  private async refreshCredentials(stored: StoredGitHubCredentials): Promise<string | null> {
    if (!stored.refreshToken) return stored.accessToken
    const response = await this.postJson(ACCESS_TOKEN_URL, {
      client_id: this.clientId,
      grant_type: REFRESH_GRANT_TYPE,
      refresh_token: stored.refreshToken
    })
    const record = response as Record<string, unknown>
    const accessToken = this.readString(record, 'access_token')
    if (!accessToken) {
      const error = this.readString(record, 'error') ?? 'unknown_error'
      throw new Error(`GitHub token refresh failed: ${error}`)
    }
    await this.saveCredentials(record, stored.refreshToken)
    Logger.info('GitHub OAuth token refreshed')
    return accessToken
  }

  private async saveCredentials(
    record: Record<string, unknown>,
    fallbackRefreshToken?: string
  ): Promise<void> {
    const accessToken = this.readString(record, 'access_token')
    if (!accessToken) throw new Error('GitHub token response did not include an access token')
    // Credentials changed — the cached profile may belong to the previous user.
    this.cachedUser = null
    const now = Date.now()
    const expiresIn = this.readNumber(record, 'expires_in')
    const refreshTokenExpiresIn = this.readNumber(record, 'refresh_token_expires_in')
    const refreshToken = this.readString(record, 'refresh_token') ?? fallbackRefreshToken
    const credentials: StoredGitHubCredentials = {
      version: 1,
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      ...(expiresIn > 0 ? { accessTokenExpiresAt: now + expiresIn * 1000 } : {}),
      ...(refreshTokenExpiresIn > 0
        ? { refreshTokenExpiresAt: now + refreshTokenExpiresIn * 1000 }
        : {})
    }
    await this.vault.save(JSON.stringify(credentials), GITHUB_TOKEN_REF)
  }

  private parseCredentials(value: string): StoredGitHubCredentials {
    try {
      const parsed = JSON.parse(value) as unknown
      if (typeof parsed !== 'object' || parsed === null) throw new Error('Invalid credentials')
      const record = parsed as Record<string, unknown>
      const accessToken = this.readString(record, 'accessToken')
      if (record['version'] !== 1 || !accessToken) throw new Error('Invalid credentials')
      const refreshToken = this.readString(record, 'refreshToken')
      const accessTokenExpiresAt = this.readNumber(record, 'accessTokenExpiresAt')
      const refreshTokenExpiresAt = this.readNumber(record, 'refreshTokenExpiresAt')
      return {
        version: 1,
        accessToken,
        ...(refreshToken ? { refreshToken } : {}),
        ...(accessTokenExpiresAt > 0 ? { accessTokenExpiresAt } : {}),
        ...(refreshTokenExpiresAt > 0 ? { refreshTokenExpiresAt } : {})
      }
    } catch {
      // Existing installations stored the access token directly. Keep accepting
      // it; the next successful device flow migrates the entry to versioned JSON.
      return { version: 1, accessToken: value }
    }
  }

  private async postJson(url: string, body: Record<string, string>): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS)
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'CodeInOven'
        },
        body: JSON.stringify(body),
        signal: controller.signal
      })
      if (!response.ok) {
        throw new Error(`GitHub returned HTTP ${response.status}`)
      }
      return await response.json()
    } catch (failure) {
      if (failure instanceof Error && failure.name === 'AbortError') {
        throw new Error('GitHub request timed out', { cause: failure })
      }
      throw failure
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Download the avatar here and hand the renderer a `data:` URL.
   *
   * The renderer's CSP is `img-src 'self' data: blob: file: appfile:` — remote
   * hosts are deliberately not allowed, so a raw githubusercontent URL renders
   * as a broken image. Inlining keeps the CSP tight and the avatar visible.
   * Returns null on any failure so the caller can fall back to the remote URL.
   */
  private async inlineAvatar(url: string): Promise<string | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS)
    try {
      // Ask for a small square; the UI never renders it larger than 32px.
      const sized = `${url}${url.includes('?') ? '&' : '?'}s=128`
      const response = await fetch(sized, {
        headers: { 'User-Agent': 'CodeInOven' },
        signal: controller.signal
      })
      if (!response.ok) return null
      const type = response.headers.get('content-type') ?? 'image/png'
      if (!type.startsWith('image/')) return null
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.byteLength > AVATAR_MAX_BYTES) return null
      return `data:${type};base64,${bytes.toString('base64')}`
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  private readString(record: Record<string, unknown>, key: string): string | null {
    const value = record[key]
    return typeof value === 'string' ? value : null
  }

  private readNumber(record: Record<string, unknown>, key: string): number {
    const value = record[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
  }
}
