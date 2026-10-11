/// <reference types="vite/client" />
import type {
  GitHubAuthStatus,
  GitHubDeviceCode,
  GitHubPollResult,
  GitHubUser
} from '../../lib/types'
import { uuidv7 } from '../../lib/id'
import { Logger } from '../system/logger'
import type { SecretVault } from '../storage/secret-vault'

declare global {
  /**
   * Public client ID of the CodeInOven GitHub registration, replaced at build
   * time by Vite's `define` from the shared `.env` value
   * `CODEINOVEN_GITHUB_CLIENT_ID`. Public by design.
   */
  const __CODEINOVEN_GITHUB_CLIENT_ID__: string | undefined
}

/**
 * Scope the app asks for when it signs an account in.
 *
 * `repo` covers pull requests, issues, deployments and pushes. `notifications` is
 * what GitHub's notifications endpoints want, and it is not implied by `repo`
 * there.
 *
 * The sign-in has to be an **OAuth App** for any of this to bite: GitHub Apps
 * ignore the scope entirely (their user tokens are limited to the registration's
 * permissions and their scope field always comes back empty), and GitHub serves
 * notifications to no GitHub App token at all. `.env.example` names the
 * registration and the two settings it needs.
 */
const GITHUB_OAUTH_SCOPES = 'repo notifications'

/** Vault ref holding every signed-in account, as one encrypted blob. */
const GITHUB_ACCOUNTS_REF = 'github_oauth_accounts'

/** Ref the single-account builds wrote, migrated on first read. */
const LEGACY_GITHUB_TOKEN_REF = 'github_oauth_token'

const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const GITHUB_USER_URL = 'https://api.github.com/user'
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'
const REFRESH_GRANT_TYPE = 'refresh_token'

const NETWORK_TIMEOUT_MS = 15_000
const TOKEN_REFRESH_LEEWAY_MS = 5 * 60 * 1000
const ACCOUNTS_VERSION = 1

/**
 * How long a fetched GitHub profile (with its inlined avatar) is served from
 * memory before it is re-fetched. The Git panel remounts on every tab switch and
 * would otherwise re-hit `api.github.com/user` and re-download the avatar image
 * each time   the avatar is inlined as a `data:` URL, so the browser's HTTP cache
 * never applies to it.
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
  /**
   * Client ID these credentials were issued to. GitHub pairs a refresh token
   * with the app that issued it, so presenting it with another client ID is
   * refused with the same generic error as an expired refresh token. Recording
   * the issuer turns that ambiguity into a precise diagnosis.
   */
  clientId?: string
}

/** One signed-in GitHub account, with the credential that authenticates it. */
interface StoredGitHubAccount {
  /** Stable identity of the account inside the app. */
  id: string
  /**
   * Login and display name, filled from the profile the first time the account's
   * token is used. A credential migrated from a single-account build starts
   * empty and is named on the first status call.
   */
  login: string
  name: string | null
  credentials: StoredGitHubCredentials
  addedAt: number
  lastUsedAt: number
}

/** Every signed-in account, and which one GitHub calls run as. */
interface StoredGitHubAccountsFile {
  version: number
  activeId: string | null
  accounts: StoredGitHubAccount[]
}

const EMPTY_FILE = (): StoredGitHubAccountsFile => ({
  version: ACCOUNTS_VERSION,
  activeId: null,
  accounts: []
})

/**
 * OAuth error codes that mean the stored refresh token can never be exchanged
 * again. A refresh token is single use and belongs to the client ID that issued
 * it, so it is dead once it has been redeemed (another app instance won the
 * race, or the app quit before the replacement was persisted), once it expires,
 * or once it is presented with a different registration. GitHub reports every
 * one of those cases with the same generic code, so the app must treat them as
 * terminal and ask the user to sign in again rather than retry forever.
 */
const DEAD_REFRESH_TOKEN_ERRORS: ReadonlySet<string> = new Set([
  'bad_refresh_token',
  'incorrect_client_credentials'
])

/** GitHub's token endpoint answered with an OAuth error code. */
class GitHubOAuthError extends Error {
  constructor(
    readonly code: string,
    readonly description?: string
  ) {
    super(description ?? code)
    this.name = 'GitHubOAuthError'
  }
}

/**
 * GitHub device-flow sign-in for the accounts the app holds.
 *
 * Accounts are independent: each carries its own access token, refresh token and
 * expiry, exactly one is active, and every GitHub call the app makes runs as the
 * active account. A credential set also holds the refresh token and issuing
 * client ID when the registration expires user access tokens (GitHub's default).
 * Because a refresh token GitHub refuses is terminal, such a credential is
 * dropped once and reported as signed out, so the sidebar offers sign-in again
 * instead of the app retrying a dead token on every call.
 *
 * The whole list lives in one vault ref, so a token never reaches the renderer
 * and a second account cannot silently overwrite the first.
 */
export class GitHubAuthService {
  /**
   * In-flight refresh, with the account it belongs to. Two callers refreshing
   * the same account share one exchange; another account's refresh waits its
   * turn rather than being answered by the wrong promise.
   */
  private refresh: { accountId: string; promise: Promise<string | null> } | null = null

  /**
   * Last fetched profile per account, with its timestamp. Served without network
   * while fresh, so repeated panel mounts don't re-hit the GitHub API or
   * re-download the avatar. Cleared whenever that account's credentials change,
   * so the cache can never show a stale user.
   */
  private readonly profiles = new Map<string, { user: GitHubUser; at: number }>()

  constructor(private readonly vault: SecretVault) {}

  /**
   * Public client ID of the CodeInOven registration   never a secret.
   *
   * Resolution order:
   * 1. `__CODEINOVEN_GITHUB_CLIENT_ID__`   replaced at build time by Vite's
   *    `define` from `.env` (`CODEINOVEN_GITHUB_CLIENT_ID`). The compile-time constant.
   * 2. `CODEINOVEN_GITHUB_CLIENT_ID`   runtime override (CI shells, tests).
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

  /**
   * Presence-only status for the Git sidebar. Never rejects: credentials that
   * cannot be read or can no longer be renewed are reported as signed out so the
   * UI can offer sign-in again, instead of failing an IPC call every time the
   * Git panel mounts.
   */
  async status(): Promise<GitHubAuthStatus> {
    if (!this.configured) {
      return { connected: false, configured: false, user: null, ...noAccounts() }
    }
    try {
      const account = this.activeAccount(await this.readFile())
      if (!account) return { connected: false, configured: true, user: null, ...noAccounts() }
      // Reading the profile is what renews an expiring access token, so this is
      // also where credentials that can no longer be renewed are dropped.
      await this.refreshProfile(account)
      return this.toStatus(await this.readFile())
    } catch (failure) {
      Logger.error('GitHub auth status failed', failure)
      return { connected: false, configured: true, user: null, ...noAccounts() }
    }
  }

  /**
   * The account every GitHub call runs as, without a network round trip.
   *
   * Separate from `status()` on purpose: callers that tag data with the account
   * (the notification snapshots, for one) must not pay for a profile read to
   * learn whose data it is.
   */
  async activeAccountId(): Promise<string | null> {
    return this.activeAccount(await this.readFile())?.id ?? null
  }

  /** Make one signed-in account the one every GitHub call runs as. */
  async switchAccount(accountId: string): Promise<GitHubAuthStatus> {
    const file = await this.readFile()
    const account = this.accountById(file, accountId)
    if (!account) throw new Error('That GitHub account is no longer signed in')
    account.lastUsedAt = Date.now()
    file.activeId = account.id
    await this.writeFile(file)
    await this.refreshProfile(account)
    return this.toStatus(await this.readFile())
  }

  /** Sign the active account out, falling back to the most recently used one. */
  async logout(): Promise<void> {
    const account = this.activeAccount(await this.readFile())
    if (!account) return
    Logger.info('Signing a GitHub account out', { login: account.login || undefined })
    await this.removeAccount(account.id)
  }

  /**
   * Resolve a usable access token for the active account, renewing it when it is
   * close to expiring.
   *
   * Never throws: `null` means "no usable credential", which every caller treats
   * as signed out. Credentials GitHub has definitively refused are discarded once
   * so the sidebar can offer sign-in again.
   */
  async resolveToken(forceRefresh = false): Promise<string | null> {
    const account = this.activeAccount(await this.readFile())
    if (!account) return null
    return this.tokenForAccount(account, forceRefresh)
  }

  async startDeviceFlow(): Promise<GitHubDeviceCode> {
    if (!this.configured) {
      throw new Error('GitHub client ID is not configured')
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
      return { status: 'error', message: 'GitHub client ID is not configured' }
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
        await this.addAccount(record)
        Logger.info('GitHub account signed in and stored in the secure vault')
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

  /**
   * Add (or re-authorize) the account a completed device flow returned, and make
   * it active.
   *
   * Re-authorizing an account the app already holds replaces that account's
   * credentials instead of adding a second row for the same login.
   */
  private async addAccount(record: Record<string, unknown>): Promise<void> {
    const credentials = this.buildCredentials(record)
    const login = await this.loginForToken(credentials.accessToken)
    const file = await this.readFile()
    const now = Date.now()
    const existing = login ? this.accountByLogin(file, login) : null
    if (existing) {
      existing.credentials = credentials
      existing.lastUsedAt = now
      if (login) existing.login = login
      this.profiles.delete(existing.id)
      file.activeId = existing.id
    } else {
      const account: StoredGitHubAccount = {
        id: uuidv7(),
        login: login ?? '',
        name: null,
        credentials,
        addedAt: now,
        lastUsedAt: now
      }
      file.accounts.push(account)
      file.activeId = account.id
    }
    await this.writeFile(file)
  }

  /**
   * The token one account's credentials resolve to, renewing when needed.
   *
   * This is where a credential set that GitHub has definitively refused is
   * dropped: the account leaves the list and the active one moves on.
   */
  private async tokenForAccount(
    account: StoredGitHubAccount,
    forceRefresh: boolean
  ): Promise<string | null> {
    const stored = account.credentials
    const now = Date.now()
    const accessTokenExpired =
      stored.accessTokenExpiresAt !== undefined && stored.accessTokenExpiresAt <= now
    const refreshable =
      stored.refreshToken !== undefined &&
      (stored.refreshTokenExpiresAt === undefined || stored.refreshTokenExpiresAt > now)

    if (!refreshable) {
      // Nothing left that can renew this credential. An expired access token can
      // only be refused by GitHub, so drop the account instead of looping on a
      // token that cannot work.
      if (accessTokenExpired) {
        await this.discardAccount(
          account.id,
          'the access token has expired and no usable refresh token is left'
        )
        return null
      }
      return stored.accessToken
    }

    const expiringSoon =
      stored.accessTokenExpiresAt !== undefined &&
      stored.accessTokenExpiresAt - now <= TOKEN_REFRESH_LEEWAY_MS
    if (!forceRefresh && !expiringSoon) return stored.accessToken

    if (this.refresh?.accountId === account.id) return this.refresh.promise

    const promise = this.renewCredentials(account)
    this.refresh = { accountId: account.id, promise }
    try {
      return await promise
    } finally {
      if (this.refresh?.promise === promise) this.refresh = null
    }
  }

  /**
   * Exchange one account's refresh token for a new access token, recovering from
   * the ways GitHub refuses it. Never throws.
   */
  private async renewCredentials(account: StoredGitHubAccount): Promise<string | null> {
    const stored = account.credentials
    const refreshToken = stored.refreshToken
    if (!refreshToken) return stored.accessToken
    if (stored.clientId !== undefined && stored.clientId !== this.clientId) {
      // GitHub pairs a refresh token with the registration that issued it, so
      // this build can never renew it. Keep using a still-valid access token and
      // name the real cause once it expires, instead of a generic refusal.
      Logger.error(
        `GitHub credentials were issued to client ID ${stored.clientId}, but this build is configured with ${this.clientId}`
      )
      if (this.isAccessTokenStillValid(stored)) return stored.accessToken
      await this.discardAccount(account.id, 'they belong to a different GitHub client ID')
      return null
    }
    try {
      return await this.exchangeRefreshToken(account.id, refreshToken)
    } catch (failure) {
      if (failure instanceof GitHubOAuthError && DEAD_REFRESH_TOKEN_ERRORS.has(failure.code)) {
        const rotated = await this.accessTokenAfterRotation(account.id, refreshToken)
        if (rotated) return rotated
        await this.discardAccount(account.id, `GitHub refused the refresh token (${failure.code})`)
        return null
      }
      // Transient (timeout, HTTP error, offline). Keep the credentials: the
      // refresh token is normally still valid, so a later call can succeed.
      Logger.error('GitHub token refresh failed', failure)
      return this.isAccessTokenStillValid(stored) ? stored.accessToken : null
    }
  }

  /** True while the stored access token is still accepted by GitHub. */
  private isAccessTokenStillValid(stored: StoredGitHubCredentials): boolean {
    return stored.accessTokenExpiresAt === undefined || stored.accessTokenExpiresAt > Date.now()
  }

  private async exchangeRefreshToken(accountId: string, refreshToken: string): Promise<string> {
    const response = await this.postJson(ACCESS_TOKEN_URL, {
      client_id: this.clientId,
      grant_type: REFRESH_GRANT_TYPE,
      refresh_token: refreshToken
    })
    const record = response as Record<string, unknown>
    const accessToken = this.readString(record, 'access_token')
    if (!accessToken) {
      throw new GitHubOAuthError(
        this.readString(record, 'error') ?? 'unknown_error',
        this.readString(record, 'error_description') ?? undefined
      )
    }
    await this.replaceCredentials(accountId, this.buildCredentials(record, refreshToken))
    Logger.info('GitHub access token refreshed')
    return accessToken
  }

  /**
   * Recover when another app instance redeemed the refresh token first.
   *
   * The guard against reusing a refresh token lives in this process only, so two
   * instances sharing one vault (a dev run beside the packaged app) can refresh
   * at the same moment. The loser is refused even though the winner has just
   * stored a usable replacement, so re-read the vault once before declaring the
   * credentials dead.
   */
  private async accessTokenAfterRotation(
    accountId: string,
    previousRefreshToken: string
  ): Promise<string | null> {
    try {
      const current = this.accountById(await this.readFile(), accountId)
      const refreshToken = current?.credentials.refreshToken
      if (!current || !refreshToken || refreshToken === previousRefreshToken) return null
      if (this.isAccessTokenStillValid(current.credentials)) return current.credentials.accessToken
      return await this.exchangeRefreshToken(accountId, refreshToken)
    } catch (failure) {
      Logger.error('GitHub token recovery after a rotated refresh token failed', failure)
      return null
    }
  }

  /** Build a credential set from a token endpoint response. */
  private buildCredentials(
    record: Record<string, unknown>,
    fallbackRefreshToken?: string
  ): StoredGitHubCredentials {
    const accessToken = this.readString(record, 'access_token')
    if (!accessToken) throw new Error('GitHub token response did not include an access token')
    const now = Date.now()
    const expiresIn = this.readNumber(record, 'expires_in')
    const refreshTokenExpiresIn = this.readNumber(record, 'refresh_token_expires_in')
    const refreshToken = this.readString(record, 'refresh_token') ?? fallbackRefreshToken
    return {
      version: 1,
      accessToken,
      // Record the issuer, so a later client ID change is reported as such
      // instead of surfacing as a generic credentials refusal.
      ...(this.clientId ? { clientId: this.clientId } : {}),
      ...(refreshToken ? { refreshToken } : {}),
      ...(expiresIn > 0 ? { accessTokenExpiresAt: now + expiresIn * 1000 } : {}),
      ...(refreshTokenExpiresIn > 0
        ? { refreshTokenExpiresAt: now + refreshTokenExpiresIn * 1000 }
        : {})
    }
  }

  /**
   * Warm (or reuse) one account's profile, and remember the login it reveals.
   *
   * A credential migrated from a single-account build arrives without a login, so
   * this is also what names it. A refused token drops the account from inside the
   * token resolution, which the next read observes.
   */
  private async refreshProfile(account: StoredGitHubAccount): Promise<void> {
    const cached = this.profiles.get(account.id)
    if (cached && Date.now() - cached.at < GITHUB_USER_CACHE_TTL_MS) return
    const token = await this.tokenForAccount(account, false)
    if (!token) return
    const user = await this.fetchProfile(token)
    if (!user) return
    this.profiles.set(account.id, { user, at: Date.now() })
    if (user.login !== account.login || user.name !== account.name) {
      await this.rememberLogin(account.id, user)
    }
  }

  /** The public profile a token belongs to, or null when GitHub won't say. */
  private async fetchProfile(token: string): Promise<GitHubUser | null> {
    const user = await this.fetchUser(token)
    if (!user) return null
    return {
      login: user.login,
      name: user.name,
      // Never hand back the remote URL: the renderer CSP would block it.
      avatarUrl: user.avatarUrl ? await this.inlineAvatar(user.avatarUrl) : null
    }
  }

  /**
   * The bare `user` record a token belongs to.
   *
   * Kept apart from `fetchProfile` because naming a fresh account needs only the
   * login: downloading and inlining an avatar for that would be waste.
   */
  private async fetchUser(token: string): Promise<{
    login: string
    name: string | null
    avatarUrl: string | null
  } | null> {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS)
      try {
        const response = await fetch(GITHUB_USER_URL, {
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
        if (!login) return null
        return {
          login,
          name: this.readString(record, 'name'),
          avatarUrl: this.readString(record, 'avatar_url')
        }
      } finally {
        clearTimeout(timer)
      }
    } catch {
      return null
    }
  }

  /** The login a freshly issued token belongs to, or null when GitHub won't say. */
  private async loginForToken(token: string): Promise<string | null> {
    return (await this.fetchUser(token))?.login ?? null
  }

  /** Write a profile's login and name onto the account that carries it. */
  private async rememberLogin(accountId: string, user: GitHubUser): Promise<void> {
    const file = await this.readFile()
    const account = this.accountById(file, accountId)
    if (!account) return
    account.login = user.login
    account.name = user.name
    await this.writeFile(file)
  }

  /** Replace one account's credentials after a refresh, keeping its identity. */ private async replaceCredentials(
    accountId: string,
    credentials: StoredGitHubCredentials
  ): Promise<void> {
    const file = await this.readFile()
    const account = this.accountById(file, accountId)
    if (!account) return
    account.credentials = credentials
    account.lastUsedAt = Date.now()
    this.profiles.delete(accountId)
    await this.writeFile(file)
  }

  /**
   * Drop an account whose credentials GitHub has definitively refused.
   *
   * Distinct from a sign-out: this one is worth naming in the log, because the
   * account disappearing from the sidebar is otherwise unexplained.
   */
  private async discardAccount(
    accountId: string,
    reason: string,
    failure?: unknown
  ): Promise<void> {
    Logger.error(
      'Discarding unusable GitHub credentials for an account',
      reason,
      ...(failure === undefined ? [] : [failure])
    )
    await this.removeAccount(accountId)
  }

  /**
   * Remove one account, and hand the active slot to the most recently used
   * account that is left.
   */
  private async removeAccount(accountId: string): Promise<void> {
    this.profiles.delete(accountId)
    try {
      const file = await this.readFile()
      file.accounts = file.accounts.filter((account) => account.id !== accountId)
      if (file.activeId === accountId) {
        const next = [...file.accounts].sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0]
        file.activeId = next?.id ?? null
      }
      await this.writeFile(file)
    } catch (failure) {
      Logger.error('GitHub account removal failed', failure)
    }
  }

  private activeAccount(file: StoredGitHubAccountsFile): StoredGitHubAccount | null {
    return file.activeId ? this.accountById(file, file.activeId) : null
  }

  private accountById(file: StoredGitHubAccountsFile, id: string): StoredGitHubAccount | null {
    return file.accounts.find((account) => account.id === id) ?? null
  }

  private accountByLogin(
    file: StoredGitHubAccountsFile,
    login: string
  ): StoredGitHubAccount | null {
    const wanted = login.toLowerCase()
    return file.accounts.find((account) => account.login.toLowerCase() === wanted) ?? null
  }

  /** The status the renderer reads, built from the stored list. */
  private toStatus(file: StoredGitHubAccountsFile): GitHubAuthStatus {
    const active = this.activeAccount(file)
    return {
      connected: active !== null,
      configured: this.configured,
      user: active ? (this.profiles.get(active.id)?.user ?? null) : null,
      accounts: file.accounts.map((account) => ({
        id: account.id,
        login: account.login,
        name: account.name,
        active: account.id === file.activeId
      })),
      activeAccountId: file.activeId
    }
  }

  /**
   * Read the account list, migrating a single-account vault on first use.
   *
   * Malformed or unreadable state is reported as no accounts rather than thrown:
   * a bad blob must not take the Git panel down, and signing in again is always
   * available.
   */
  private async readFile(): Promise<StoredGitHubAccountsFile> {
    const raw = await this.readRef(GITHUB_ACCOUNTS_REF)
    if (raw === null) return this.migrateLegacyCredentials()
    try {
      return this.parseFile(raw)
    } catch (failure) {
      Logger.error('Discarding unusable GitHub accounts', failure)
      await this.removeRef(GITHUB_ACCOUNTS_REF)
      return EMPTY_FILE()
    }
  }

  /**
   * Move a credential written by a single-account build into the account list.
   *
   * The account is stored without a login, because naming it would mean a network
   * call here; the first status call reads the profile and names it.
   */
  private async migrateLegacyCredentials(): Promise<StoredGitHubAccountsFile> {
    const raw = await this.readRef(LEGACY_GITHUB_TOKEN_REF)
    if (raw === null) return EMPTY_FILE()
    try {
      const account: StoredGitHubAccount = {
        id: uuidv7(),
        login: '',
        name: null,
        credentials: this.parseCredentials(
          this.parseJson(raw, 'Invalid stored GitHub credentials')
        ),
        addedAt: Date.now(),
        lastUsedAt: Date.now()
      }
      const file: StoredGitHubAccountsFile = {
        version: ACCOUNTS_VERSION,
        activeId: account.id,
        accounts: [account]
      }
      await this.writeFile(file)
      await this.removeRef(LEGACY_GITHUB_TOKEN_REF)
      Logger.info('Moved the stored GitHub credential into the account list')
      return file
    } catch (failure) {
      Logger.error('Discarding unusable GitHub credentials', failure)
      await this.removeRef(LEGACY_GITHUB_TOKEN_REF)
      return EMPTY_FILE()
    }
  }

  /** Read one vault ref; a read failure is logged and reported as absent. */
  private async readRef(ref: string): Promise<string | null> {
    try {
      if (!(await this.vault.exists(ref))) return null
      return await this.vault.resolve(ref)
    } catch (failure) {
      // A vault read failure is not proof that the credential is invalid, so
      // leave it in place and report signed out for this call only.
      Logger.error('Stored GitHub credentials could not be read', failure)
      return null
    }
  }

  private async removeRef(ref: string): Promise<void> {
    try {
      await this.vault.remove(ref)
    } catch (failure) {
      Logger.error('GitHub credential removal failed', failure)
    }
  }

  /** Serialized so two sign-ins cannot interleave a read-modify-write. */
  private async writeFile(file: StoredGitHubAccountsFile): Promise<void> {
    await this.vault.save(JSON.stringify(file), GITHUB_ACCOUNTS_REF)
  }

  private parseFile(value: string): StoredGitHubAccountsFile {
    const record = this.parseJson(value, 'Invalid accounts')
    if (record['version'] !== ACCOUNTS_VERSION) throw new Error('Invalid accounts version')
    const rawAccounts = record['accounts']
    if (!Array.isArray(rawAccounts)) throw new Error('Invalid accounts')
    const accounts = rawAccounts
      .map((entry) => this.parseAccount(entry))
      .filter((account): account is StoredGitHubAccount => account !== null)
    const activeId = this.readString(record, 'activeId')
    const activeExists = activeId !== null && accounts.some((account) => account.id === activeId)
    return {
      version: ACCOUNTS_VERSION,
      activeId: activeExists ? activeId : (accounts[0]?.id ?? null),
      accounts
    }
  }

  private parseAccount(value: unknown): StoredGitHubAccount | null {
    if (typeof value !== 'object' || value === null) return null
    const record = value as Record<string, unknown>
    const id = this.readString(record, 'id')
    const credentials = record['credentials']
    if (!id || typeof credentials !== 'object' || credentials === null) return null
    try {
      return {
        id,
        login: this.readString(record, 'login') ?? '',
        name: this.readString(record, 'name'),
        credentials: this.parseCredentials(credentials as Record<string, unknown>),
        addedAt: this.readNumber(record, 'addedAt'),
        lastUsedAt: this.readNumber(record, 'lastUsedAt')
      }
    } catch {
      Logger.error('Discarding a malformed GitHub account entry')
      return null
    }
  }

  private parseCredentials(record: Record<string, unknown>): StoredGitHubCredentials {
    const accessToken = this.readString(record, 'accessToken')
    if (record['version'] !== 1 || !accessToken) throw new Error('Invalid credentials')
    const refreshToken = this.readString(record, 'refreshToken')
    const clientId = this.readString(record, 'clientId')
    const accessTokenExpiresAt = this.readNumber(record, 'accessTokenExpiresAt')
    const refreshTokenExpiresAt = this.readNumber(record, 'refreshTokenExpiresAt')
    return {
      version: 1,
      accessToken,
      ...(clientId ? { clientId } : {}),
      ...(refreshToken ? { refreshToken } : {}),
      ...(accessTokenExpiresAt > 0 ? { accessTokenExpiresAt } : {}),
      ...(refreshTokenExpiresAt > 0 ? { refreshTokenExpiresAt } : {})
    }
  }

  /** Parse a JSON object, or refuse with the caller's message. */
  private parseJson(value: string, message: string): Record<string, unknown> {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed !== 'object' || parsed === null) throw new Error(message)
    return parsed as Record<string, unknown>
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
   * The renderer's CSP is `img-src 'self' data: blob: file: appfile:`   remote
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

/** The account fields of a status with nothing signed in. */
function noAccounts(): Pick<GitHubAuthStatus, 'accounts' | 'activeAccountId'> {
  return { accounts: [], activeAccountId: null }
}
