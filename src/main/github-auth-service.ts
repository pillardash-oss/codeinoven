/// <reference types="vite/client" />
import type { GitHubAuthStatus, GitHubDeviceCode, GitHubPollResult } from '../lib/types'
import { Logger } from './logger'
import type { SecretVault } from './secret-vault'

declare global {
  /**
   * GitHub App public client ID, replaced at build time by Vite's `define` from
   * the `.env` value `MAIN_VITE_GITHUB_CLIENT_ID`. Public by design.
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

const NETWORK_TIMEOUT_MS = 15_000

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
  constructor(private readonly vault: SecretVault) {}

  /**
   * GitHub App public client ID — never a secret, safe to embed or configure via env.
   *
   * Resolution order:
   * 1. `__CODEINOVEN_GITHUB_CLIENT_ID__` — replaced at build time by Vite's
   *    `define` from `.env` (`MAIN_VITE_GITHUB_CLIENT_ID`). The compile-time constant.
   * 2. `CODEINOVEN_GITHUB_CLIENT_ID` — runtime override (CI shells, tests).
   */
  /**
   * GitHub App public client ID — never a secret, safe to embed or configure via env.
   *
   * Resolution order:
   * 1. `__CODEINOVEN_GITHUB_CLIENT_ID__` — replaced at build time by Vite's
   *    `define` from `.env` (`MAIN_VITE_GITHUB_CLIENT_ID`). The compile-time constant.
   * 2. `CODEINOVEN_GITHUB_CLIENT_ID` — runtime override (CI shells, tests).
   */
  private get clientId(): string {
    const baked = typeof __CODEINOVEN_GITHUB_CLIENT_ID__ === 'string' ? __CODEINOVEN_GITHUB_CLIENT_ID__ : undefined
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
    const token = await this.vault.resolve(GITHUB_TOKEN_REF)
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
        return {
          login,
          name: this.readString(record, 'name'),
          avatarUrl
        }
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
        await this.vault.save(token, GITHUB_TOKEN_REF)
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

  async resolveToken(): Promise<string | null> {
    if (!(await this.vault.exists(GITHUB_TOKEN_REF))) return null
    return this.vault.resolve(GITHUB_TOKEN_REF)
  }

  async logout(): Promise<void> {
    await this.vault.remove(GITHUB_TOKEN_REF)
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

  private readString(record: Record<string, unknown>, key: string): string | null {
    const value = record[key]
    return typeof value === 'string' ? value : null
  }

  private readNumber(record: Record<string, unknown>, key: string): number {
    const value = record[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
  }
}
