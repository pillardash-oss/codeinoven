/// <reference types="vite/client" />
import type {
  GitHubAuthStatus,
  GitHubDeviceCode,
  GitHubPollResult,
  GitHubUser
} from '../../lib/types'
import { uuidv7 } from '../../lib/id'
import { CrossProcessMutex, GITHUB_CREDENTIAL_LOCK_NAME } from '../system/cross-process-mutex'
import { Logger } from '../system/logger'
import { clearRepeatedFailure, reportRepeatedFailure } from '../system/repeated-failure-log'
import type { SecretVault } from '../storage/secret-vault'
import { isNetworkError, networkErrorCode } from '../util/network-error'

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

/**
 * How long the device-code request keeps retrying a transport failure.
 *
 * A click on "Sign in" is the only thing that can start a flow, so one dropped
 * connection there (a flap, a VPN reconnecting, a resolver hiccup) cost the user
 * the whole attempt until they clicked again. The request is an idempotent POST
 * that GitHub answers with a fresh code, and a request that never arrived issued
 * none, so retrying it costs one round trip and saves the click.
 */
const DEVICE_CODE_RETRY_DELAYS_MS = [250, 750] as const

const TOKEN_REFRESH_LEEWAY_MS = 5 * 60 * 1000
const ACCOUNTS_VERSION = 1

/**
 * How long a refresh waits for another instance's exchange before it overtakes
 * the credential lock.
 *
 * Short on purpose: the wait sits behind an IPC status read the Git panel is
 * awaiting, and a caller that overtakes re-reads the vault before it exchanges
 * anything, so waiting longer buys nothing except a slow panel.
 */
const REFRESH_LOCK_WAIT_MS = 5_000

/**
 * Delays a refused refresh waits out before the credential is declared dead.
 *
 * GitHub answers `incorrect_client_credentials` for every refresh token that is
 * not currently valid, which covers a token that is gone for good and one a
 * sibling instance redeemed a moment ago. Two instances share one vault and the
 * winner's write lands tens of milliseconds after the loser's refusal (24 ms to
 * 113 ms in the app's own logs), and an instance running older code takes no
 * credential lock at all, so the vault is polled across this window before an
 * account is dropped. Without it, losing the race reads as a terminal failure and
 * signs the user out of an account that is still perfectly healthy.
 */
const REFUSED_REFRESH_RECOVERY_DELAYS_MS = [200, 300, 500, 750, 1_000] as const

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * How long a fetched GitHub profile (with its inlined avatar) is served from
 * memory before it is re-fetched. The Git panel remounts on every tab switch and
 * would otherwise re-hit `api.github.com/user` and re-download the avatar image
 * each time   the avatar is inlined as a `data:` URL, so the browser's HTTP cache
 * never applies to it.
 */
const GITHUB_USER_CACHE_TTL_MS = 5 * 60 * 1000

/**
 * Labels the polling paths report under.
 *
 * A mounted Git sidebar re-reads this status continuously, so a condition that
 * persists (offline, an unreachable GitHub, a credential that can no longer be
 * renewed) is one incident here: reported once at error level, then at dev level,
 * instead of rewriting `error.log` on every poll.
 */
const STATUS_FAILURE_LABEL = 'GitHub auth status failed'
const REFRESH_FAILURE_LABEL = 'GitHub token refresh failed'
const DEVICE_FLOW_FAILURE_LABEL = 'GitHub device flow start failed'
const DEVICE_POLL_FAILURE_LABEL = 'GitHub device flow poll failed'

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
 * instead of the app retrying a dead token on every call. That drop is the last
 * resort: a refusal is first given the window in which the instance that really
 * redeemed the token persists its replacement, because a refresh token is single
 * use and every instance sharing this vault refreshes through one cross-process
 * lock.
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
   * Cross-instance lock around a refresh exchange. A packaged app and a dev run
   * share this config root and therefore this vault, and only one of them may
   * redeem an account's single-use refresh token at a time.
   */
  private readonly refreshLock = new CrossProcessMutex(GITHUB_CREDENTIAL_LOCK_NAME)

  /**
   * Tail of the in-process account-file queue, so two writers here cannot lose
   * each other's change. Without it a sign-in, a switch or a profile write that
   * read the list before a refresh replaced the credentials would write that
   * older snapshot back and restore a refresh token GitHub has already spent.
   */
  private fileTail: Promise<void> = Promise.resolve()
  /** How deep this call stack is inside its own account-file lock. */
  private fileDepth = 0

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
      const status = await this.readStatus()
      clearRepeatedFailure(STATUS_FAILURE_LABEL)
      return status
    } catch (failure) {
      reportRepeatedFailure(STATUS_FAILURE_LABEL, failure)
      return { connected: false, configured: true, user: null, ...noAccounts() }
    }
  }

  /**
   * Build the status the renderer reads.
   *
   * Kept apart from `status()` so a failing condition is reported as one incident
   * rather than one per poll: a mounted Git panel calls this every few seconds.
   */
  private async readStatus(): Promise<GitHubAuthStatus> {
    const account = this.activeAccount(await this.readFile())
    if (!account) return { connected: false, configured: true, user: null, ...noAccounts() }
    // Reading the profile is what renews an expiring access token, so this is
    // also where credentials that can no longer be renewed are dropped.
    await this.refreshProfile(account)
    return this.toStatus(await this.readFile())
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
    await this.withFileLock(async () => {
      const file = await this.readFile()
      const account = this.accountById(file, accountId)
      if (!account) throw new Error('That GitHub account is no longer signed in')
      account.lastUsedAt = Date.now()
      file.activeId = account.id
      await this.writeFile(file)
    })
    const account = this.activeAccount(await this.readFile())
    if (!account) throw new Error('That GitHub account is no longer signed in')
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
    const response = await this.requestDeviceCode()
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

  /**
   * Ask GitHub for a device code, riding out a transport failure on the way.
   *
   * The failure is recorded once in `error.log` with its whole cause chain. The
   * panel can only show one sentence, and a `TypeError: fetch failed` that
   * crossed IPC with no line behind it is what made an unreachable GitHub
   * indistinguishable from a broken sign-in.
   */
  private async requestDeviceCode(): Promise<unknown> {
    const retryDelays = DEVICE_CODE_RETRY_DELAYS_MS
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await this.postJson(DEVICE_CODE_URL, {
          client_id: this.clientId,
          scope: GITHUB_OAUTH_SCOPES
        })
        clearRepeatedFailure(DEVICE_FLOW_FAILURE_LABEL)
        return response
      } catch (failure) {
        if (!isNetworkError(failure) || attempt >= retryDelays.length) {
          reportRepeatedFailure(DEVICE_FLOW_FAILURE_LABEL, failure)
          throw failure
        }
        Logger.dev('GitHub device code request failed, retrying', failure)
        await sleep(retryDelays[attempt] ?? 0)
      }
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
      clearRepeatedFailure(DEVICE_POLL_FAILURE_LABEL)
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
      // A poll that never reached GitHub says nothing about the code the user is
      // typing. Ending the attempt over it asked them to start a whole new
      // sign-in because their connection had one bad moment, so this reports the
      // reason and lets the flow keep waiting on the same code.
      if (isNetworkError(failure)) {
        reportRepeatedFailure(DEVICE_POLL_FAILURE_LABEL, failure)
        return { status: 'retrying', message }
      }
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
    await this.withFileLock(async () => {
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
    })
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
    // A credential belongs to the registration that issued it, and this build
    // signs in for exactly one. A token left behind by another registration is
    // not partially usable: GitHub pairs the refresh token with its issuer, and
    // the access token was minted for a different application with a different
    // permission model (CodeInOven's GitHub App registration, which GitHub
    // serves no notifications to, was replaced by the OAuth App one). Keeping it
    // would leave the app signed in to a registration that cannot do the work,
    // which is the half-working state this check exists to end.
    if (stored.clientId !== undefined && stored.clientId !== this.clientId) {
      Logger.error(
        `GitHub credentials were issued to client ID ${stored.clientId}, but this build is configured with ${this.clientId}`
      )
      await this.discardAccount(account.id, 'they belong to a different GitHub client ID')
      return null
    }
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
   *
   * The exchange runs inside the account-file lock and behind the cross-instance
   * credential lock, and the vault is re-read once both are held before anything
   * is sent: a refresh token is single use, so an instance that waited out a
   * sibling's exchange must use the credential that sibling stored, never the one
   * it read before the sibling ran.
   */
  private async renewCredentials(account: StoredGitHubAccount): Promise<string | null> {
    const stored = account.credentials
    const refreshToken = stored.refreshToken
    if (!refreshToken) return stored.accessToken
    return await this.withFileLock(async () => {
      const release = await this.refreshLock.acquire({ timeoutMs: REFRESH_LOCK_WAIT_MS })
      try {
        const rotated = await this.credentialRotatedBySibling(account.id, refreshToken)
        if (rotated) return rotated
        try {
          return await this.exchangeRefreshToken(account.id, refreshToken)
        } catch (failure) {
          if (failure instanceof GitHubOAuthError && DEAD_REFRESH_TOKEN_ERRORS.has(failure.code)) {
            const recovered = await this.credentialAfterRefusal(account.id, refreshToken)
            if (recovered) return recovered
            await this.discardAccount(
              account.id,
              `GitHub refused the refresh token (${failure.code})`
            )
            return null
          }
          // Transient (timeout, HTTP error, offline). Keep the credentials: the
          // refresh token is normally still valid, so a later call can succeed.
          reportRepeatedFailure(REFRESH_FAILURE_LABEL, failure)
          const current = await this.credentialRotatedBySibling(account.id, refreshToken)
          if (current) return current
          return this.isAccessTokenStillValid(stored) ? stored.accessToken : null
        }
      } finally {
        release()
      }
    })
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
    clearRepeatedFailure(REFRESH_FAILURE_LABEL)
    Logger.info('GitHub access token refreshed')
    return accessToken
  }

  /**
   * The credential the vault holds now, when a sibling instance rotated this
   * account's refresh token after `previousRefreshToken` was read.
   *
   * Null means the vault still holds the token we tried, or the account is gone;
   * either way there is nothing to gain from asking GitHub again with the same
   * token. A rotated credential whose access token is still valid is handed back
   * as it is, and an expired one is exchanged for a fresh pair.
   */
  private async credentialRotatedBySibling(
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

  /**
   * Give a refused refresh token the window in which the instance that actually
   * redeemed it persists the replacement, before the account is declared dead.
   *
   * The refusal alone cannot tell "this token is gone" from "another instance
   * just spent it": GitHub answers `incorrect_client_credentials` for both. The
   * winner's vault write lands tens of milliseconds after our refusal, and an
   * instance running older code or another client takes no credential lock at
   * all, so the vault is polled across the window instead of being read once.
   */
  private async credentialAfterRefusal(
    accountId: string,
    previousRefreshToken: string
  ): Promise<string | null> {
    for (const delayMs of REFUSED_REFRESH_RECOVERY_DELAYS_MS) {
      const rotated = await this.credentialRotatedBySibling(accountId, previousRefreshToken)
      if (rotated) return rotated
      await sleep(delayMs)
    }
    return await this.credentialRotatedBySibling(accountId, previousRefreshToken)
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
    await this.withFileLock(async () => {
      const file = await this.readFile()
      const account = this.accountById(file, accountId)
      if (!account) return
      account.login = user.login
      account.name = user.name
      await this.writeFile(file)
    })
  }

  /** Replace one account's credentials after a refresh, keeping its identity. */
  private async replaceCredentials(
    accountId: string,
    credentials: StoredGitHubCredentials
  ): Promise<void> {
    await this.withFileLock(async () => {
      const file = await this.readFile()
      const account = this.accountById(file, accountId)
      if (!account) return
      account.credentials = credentials
      account.lastUsedAt = Date.now()
      this.profiles.delete(accountId)
      await this.writeFile(file)
    })
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
      await this.withFileLock(async () => {
        const file = await this.readFile()
        file.accounts = file.accounts.filter((account) => account.id !== accountId)
        if (file.activeId === accountId) {
          const next = [...file.accounts].sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0]
          file.activeId = next?.id ?? null
        }
        await this.writeFile(file)
      })
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
      // leave it in place and report signed out for this call only. The vault
      // reports an unreadable ciphertext itself, once per incident and then at dev
      // level, so this polled read must not add an error line of its own.
      Logger.dev('Stored GitHub credentials could not be read', failure)
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

  /**
   * Run one read-modify-write of the account list against every other writer in
   * this process.
   *
   * The vault serializes its own writes, but a read-modify-write of the account
   * list is not one write: a caller that read the list before a refresh replaced
   * an account's credentials would write its older snapshot back and restore a
   * refresh token GitHub has already spent. Re-entrant, so a mutation made by a
   * caller that already holds it (a refresh persisting its new credentials, a
   * refused account being dropped) runs inline instead of waiting on itself.
   */
  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    if (this.fileDepth > 0) return await operation()
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const previous = this.fileTail
    this.fileTail = previous.then(() => held)
    await previous
    this.fileDepth += 1
    try {
      return await operation()
    } finally {
      this.fileDepth -= 1
      release()
    }
  }

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
      throw this.readableTransportError(failure)
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * The failure to surface for a request GitHub did not answer.
   *
   * Node's fetch reports every transport problem as `TypeError: fetch failed` and
   * keeps the reason (a DNS miss, a refused connection, a TLS rejection) in
   * `cause`, which the IPC boundary drops. The panel showed that bare sentence,
   * so a user could not tell a dropped connection from a broken feature. The
   * message below names the state and the next step, the cause chain stays on the
   * error for the call sites that log it, and an HTTP or OAuth verdict passes
   * through untouched because it is a real answer rather than a transport story.
   */
  private readableTransportError(failure: unknown): Error {
    if (failure instanceof Error && failure.name === 'AbortError') {
      return new Error(`GitHub did not answer within ${Math.round(NETWORK_TIMEOUT_MS / 1000)}s`, {
        cause: failure
      })
    }
    if (!isNetworkError(failure)) {
      return failure instanceof Error ? failure : new Error('GitHub request failed')
    }
    const code = networkErrorCode(failure)
    return new Error(
      code
        ? `GitHub could not be reached (${code}). Check your connection and try again.`
        : 'GitHub could not be reached. Check your connection and try again.',
      { cause: failure }
    )
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
