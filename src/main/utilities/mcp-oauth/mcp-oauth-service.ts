import type {
  McpOAuthAuthorizeRequest,
  McpOAuthConfig,
  McpOAuthConnectionState,
  McpOAuthEventPayload,
  McpOAuthStatus,
  UtilityDefinitionFor
} from '../../../lib/types'
import { Logger } from '../../system/logger'
import type { SecretVault } from '../../storage/secret-vault'
import type { UtilityRegistryService } from '../utility-registry-service'
import { VaultMcpOAuthStateStore } from './mcp-oauth-state-store'
import { loadMcpOAuthProtocol, type McpOAuthProtocol } from './mcp-oauth-protocol'
import type {
  AuthorizationServerMetadata,
  McpOAuthProvider,
  OAuthTokens
} from '@earendil-works/pi-mcp/oauth'

/**
 * How long before an access token expires the app renews it.
 *
 * A turn is long: a token that is valid when a connection opens can expire
 * before the connection's last call runs, and one wasted round trip costs less
 * than a mid-turn 401.
 */
const RENEWAL_LEEWAY_MS = 60_000

/** How long an interactive authorization waits for the user's browser. */
const AUTHORIZATION_TIMEOUT_MS = 5 * 60_000

/**
 * Loopback ports an authorization listener tries, in order.
 *
 * An authorization server may pin the redirect URI to the one it registered, so
 * the app keeps the address stable between authorizations and only falls back to
 * a kernel-assigned port when every preferred one is taken. `0` is that
 * fallback: the callback server then reports the port it actually bound.
 */
const CALLBACK_PORTS = [45_963, 45_964, 45_965, 45_966, 0]

/** Path of the loopback redirect URI; the authorization server echoes the code here. */
export const MCP_OAUTH_CALLBACK_PATH = '/callback'

export interface McpOAuthServiceDependencies {
  registry: UtilityRegistryService
  vault: SecretVault
  /** Delivers one authorization stage to every renderer that is showing it. */
  broadcast: (payload: McpOAuthEventPayload) => void
  /** Test seam: a shorter window than the real five minutes. */
  authorizationTimeoutMs?: number
}

/** One live interactive authorization. */
interface AuthorizationSession {
  abort: AbortController
  /** Released the moment the flow ends, so a cancel never leaves the port held. */
  closeCallback: () => Promise<void>
  cancelled: boolean
}

/**
 * What a remote MCP server last asked for when it refused a request.
 *
 * Kept in memory on purpose: it is a live observation about one server, and the
 * durable answer to "does this utility use OAuth" is its own configuration.
 */
interface ObservedChallenge {
  resourceMetadataUrl?: URL
  scope?: string
}

/**
 * OAuth 2.1 authorization for remote MCP utilities.
 *
 * A remote MCP server that accepts neither anonymous requests nor an API key
 * answers `401` with a `WWW-Authenticate: Bearer resource_metadata="…"`
 * challenge, exactly as the MCP authorization spec requires. This service turns
 * that challenge into a browser authorization the user completes once, keeps the
 * resulting grant in the encrypted vault, and hands a live bearer token to every
 * later connection, renewing it silently when it expires.
 *
 * One instance is shared by the Utilities page (status, authorize, cancel,
 * disconnect) and by the turn gateway (a token per connection), so what the user
 * authorized is exactly what a turn uses.
 */
export class McpOAuthService {
  private readonly sessions = new Map<string, AuthorizationSession>()
  private readonly challenges = new Map<string, ObservedChallenge>()
  private readonly lastErrors = new Map<string, string>()

  constructor(private readonly dependencies: McpOAuthServiceDependencies) {}

  /** What the Utilities page shows for one MCP utility. Never throws for a missing grant. */
  async status(utilityId: string): Promise<McpOAuthStatus> {
    const utility = await this.utility(utilityId)
    const oauth = utility.config.oauth
    const state = await this.store(utilityId).load()
    const tokens = state?.tokens
    const clientSecretStored = await this.dependencies.vault.resolveMcpOAuthClientSecret(utilityId)
    const issuer = oauth?.issuer ?? state?.discovery?.authorizationServerUrl
    const clientId = oauth?.clientId ?? state?.clientInformation?.client_id
    const scope = tokens?.scope ?? oauth?.scope
    const resource = state?.discovery?.resourceMetadata?.resource ?? oauth?.resource
    const expiresAt = state?.tokensExpireAt ?? (tokens ? oauth?.expiresAt : undefined)
    const accountLabel = accountLabelFrom(tokens)
    const error = this.lastErrors.get(utilityId)
    return {
      utilityId,
      enabled: oauth?.enabled ?? false,
      state: this.connectionState(
        utilityId,
        tokens,
        state?.tokensExpireAt,
        error,
        oauth !== undefined
      ),
      required: oauth !== undefined || this.challenges.has(utilityId),
      ...(issuer ? { issuer } : {}),
      ...(clientId ? { clientId } : {}),
      confidentialClient:
        oauth?.confidentialClient ??
        Boolean(clientSecretStored || state?.clientInformation?.client_secret),
      ...(scope ? { scope } : {}),
      ...(resource ? { resource } : {}),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(accountLabel ? { accountLabel } : {}),
      ...(oauth?.authorizedAt === undefined ? {} : { authorizedAt: oauth.authorizedAt }),
      ...(error ? { error } : {}),
      secureStorageAvailable: this.dependencies.vault.isAvailable()
    }
  }

  /**
   * Run one interactive authorization and resolve when it finishes.
   *
   * The browser is opened through the renderer that receives the `authorize`
   * event, so the URL follows the user's own link routing. The promise resolves
   * with the resulting status or rejects with what went wrong; a cancel resolves
   * with the unchanged status instead of reporting a failure.
   */
  async authorize(
    utilityId: string,
    request: McpOAuthAuthorizeRequest = {}
  ): Promise<McpOAuthStatus> {
    if (this.sessions.has(utilityId)) {
      throw new Error('An authorization for this MCP server is already in progress')
    }
    const utility = await this.utility(utilityId)
    if (utility.config.transport === 'stdio') {
      throw new Error('A stdio MCP server is authorized by its own environment, not with OAuth')
    }
    const url = utility.config.url
    if (!url) throw new Error('This MCP server has no URL to authorize')
    if (!this.dependencies.vault.isAvailable()) {
      throw new Error('Secure credential storage is unavailable on this device')
    }
    const clientSecret = request.clientSecret?.trim()
    if (clientSecret) {
      await this.dependencies.vault.saveMcpOAuthClientSecret(utilityId, clientSecret)
    }

    const session: AuthorizationSession = {
      abort: new AbortController(),
      closeCallback: async () => undefined,
      cancelled: false
    }
    this.sessions.set(utilityId, session)
    this.lastErrors.delete(utilityId)
    let failure: { message: string; cause: unknown } | null = null
    let authorized = false
    try {
      const protocol = await loadMcpOAuthProtocol()
      authorized = await this.runInteractiveFlow(protocol, utility, request, session)
      if (authorized) await this.persistGrant(utility, request)
    } catch (error) {
      // A cancelled flow is not a failure: the user asked for it to stop, and the
      // grant that was stored before it is still the one in force.
      if (!session.cancelled) failure = { message: describeFailure(error), cause: error }
    } finally {
      await session.closeCallback().catch(() => undefined)
      this.sessions.delete(utilityId)
    }
    // The status is read after the session is released, so a finished
    // authorization never reports itself as still running.
    if (failure) {
      this.lastErrors.set(utilityId, failure.message)
      await this.status(utilityId)
      this.dependencies.broadcast({ utilityId, kind: 'failed', error: failure.message })
      throw new Error(failure.message, { cause: failure.cause })
    }
    const status = await this.status(utilityId)
    this.dependencies.broadcast(
      authorized
        ? { utilityId, kind: 'complete', status }
        : { utilityId, kind: 'progress', message: 'Authorization cancelled' }
    )
    return status
  }

  /** Stop a running authorization. The server keeps whatever it was granted before. */
  async cancel(utilityId: string): Promise<McpOAuthStatus> {
    const session = this.sessions.get(utilityId)
    if (session) {
      session.cancelled = true
      session.abort.abort()
      await session.closeCallback().catch(() => undefined)
    }
    return await this.status(utilityId)
  }

  /**
   * Forget this server's grant and client secret.
   *
   * Disconnecting is deliberately total: the tokens, the dynamically registered
   * client, the discovered metadata, a secret the user typed, and the OAuth block
   * in the configuration all go, so nothing about the grant survives to be reused
   * by mistake. Authorizing again is one click for a server that issues clients
   * dynamically.
   */
  async disconnect(utilityId: string): Promise<McpOAuthStatus> {
    const utility = await this.utility(utilityId)
    await this.forget(utilityId)
    const { oauth: _dropped, ...config } = utility.config
    await this.dependencies.registry.update(utilityId, { config })
    return await this.status(utilityId)
  }

  /**
   * Forget a utility's grant without touching its configuration.
   *
   * Used both by an explicit disconnect (which then clears the OAuth block) and
   * by deleting a utility, where the definition   and with it every trace of the
   * OAuth block   is about to disappear anyway.
   */
  async forget(utilityId: string): Promise<void> {
    const utility = await this.dependencies.registry.get(utilityId)
    await this.cancel(utilityId)
    if (utility?.kind === 'mcp') {
      await this.revokeGrant(utility).catch((error: unknown) => {
        // Revocation is a courtesy to the authorization server; the local grant
        // is gone either way, which is what the caller asked for.
        Logger.dev('MCP OAuth revocation failed:', error)
      })
    }
    await this.store(utilityId).clear()
    await this.dependencies.vault.removeMcpOAuthClientSecret(utilityId)
    this.lastErrors.delete(utilityId)
    this.challenges.delete(utilityId)
  }

  /**
   * The bearer token a connection to this server should carry, or null when the
   * grant needs the user in a browser.
   *
   * A stored token that is still valid is returned as-is; an expired one is
   * renewed from its refresh token. An interactive flow is never started here: a
   * turn cannot ask the user to complete a browser sign-in, so a grant that needs
   * one reports null and the caller says so.
   */
  async accessToken(utility: UtilityDefinitionFor<'mcp'>): Promise<string | null> {
    const oauth = utility.config.oauth
    const url = utility.config.url
    if (!oauth?.enabled || !url) return null
    const store = this.store(utility.id)
    const state = await store.load()
    const token = state?.tokens?.access_token
    if (token && !expiresWithin(state.tokensExpireAt, RENEWAL_LEEWAY_MS)) return token
    if (!state?.tokens?.refresh_token) return null
    try {
      const protocol = await loadMcpOAuthProtocol()
      const result = await protocol.authorizeMcp(
        this.provider(protocol, utility, {
          redirectUrl: defaultRedirectUrl(),
          clientSecret: await this.dependencies.vault.resolveMcpOAuthClientSecret(utility.id),
          // A turn is not a browser: a flow that wants the user stops instead.
          onRedirect: () => {
            throw new Error('MCP OAuth authorization has to be completed in a browser')
          }
        }),
        { serverUrl: url, ...this.challenge(utility.id) }
      )
      if (result !== 'AUTHORIZED') return null
      // A disconnect may have landed while this renewal was in flight. The
      // grant it just refreshed is not one the user asked to keep, so it is
      // dropped again rather than left in the vault to resurrect later.
      const current = await this.dependencies.registry.get(utility.id)
      if (current?.kind !== 'mcp' || !current.config.oauth?.enabled) {
        await store.clear()
        return null
      }
      await this.persistGrant(utility, {})
      this.lastErrors.delete(utility.id)
      return (await store.load())?.tokens?.access_token ?? null
    } catch (error) {
      const message = describeFailure(error)
      Logger.dev('MCP OAuth token renewal failed:', error)
      this.lastErrors.set(utility.id, message)
      return null
    }
  }

  /**
   * Record that a server refused a request and asked for OAuth.
   *
   * The header is parsed lazily, with the same parser the flow uses, and only
   * when it actually names a protected resource: an API-key server's plain
   * `Bearer` challenge must not pull the OAuth client into memory.
   */
  async noteChallenge(
    utilityId: string,
    wwwAuthenticate: string | null | undefined
  ): Promise<void> {
    if (!wwwAuthenticate || !/resource_metadata\s*=/iu.test(wwwAuthenticate)) return
    try {
      const protocol = await loadMcpOAuthProtocol()
      const challenge = protocol.parseWwwAuthenticate(wwwAuthenticate)
      this.challenges.set(utilityId, {
        ...(challenge.resourceMetadataUrl
          ? { resourceMetadataUrl: challenge.resourceMetadataUrl }
          : {}),
        ...(challenge.scope ? { scope: challenge.scope } : {})
      })
    } catch (error) {
      Logger.dev('MCP OAuth challenge could not be parsed:', error)
    }
  }

  /** Close every listener a running authorization holds. */
  async dispose(): Promise<void> {
    await Promise.allSettled(
      [...this.sessions.keys()].map(async (utilityId) => {
        await this.cancel(utilityId)
      })
    )
  }

  private connectionState(
    utilityId: string,
    tokens: OAuthTokens | undefined,
    tokensExpireAt: number | undefined,
    error: string | undefined,
    /** Whether the utility carries an OAuth block at all. */
    configured: boolean
  ): McpOAuthConnectionState {
    if (this.sessions.has(utilityId)) return 'authorizing'
    // A grant without a configuration block is one nothing sends: disconnecting
    // removes both, and reading the tokens alone would call that "connected".
    if (!configured) return error ? 'error' : 'not_connected'
    if (!tokens?.access_token) return error ? 'error' : 'not_connected'
    // A refresh token renews an expired access token without the user, so the
    // grant is connected even when the token it holds right now is stale.
    if (tokens.refresh_token || !expiresWithin(tokensExpireAt, 0)) return 'connected'
    return 'expired'
  }

  /**
   * The interactive half of an authorization.
   *
   * The listener is opened before the flow starts, because the redirect URI is
   * part of what the client registers: an authorization server that pins a
   * registered redirect has to see the exact address this run answers on.
   */
  private async runInteractiveFlow(
    protocol: McpOAuthProtocol,
    utility: UtilityDefinitionFor<'mcp'>,
    request: McpOAuthAuthorizeRequest,
    session: AuthorizationSession
  ): Promise<boolean> {
    const url = utility.config.url
    if (!url) throw new Error('This MCP server has no URL to authorize')
    const listener = await this.listen(protocol, session)
    const provider = this.provider(protocol, utility, {
      redirectUrl: listener.redirectUrl,
      clientId: request.clientId?.trim() || utility.config.oauth?.clientId,
      clientSecret:
        request.clientSecret?.trim() ||
        (await this.dependencies.vault.resolveMcpOAuthClientSecret(utility.id)),
      onRedirect: (authorizationUrl) => {
        this.dependencies.broadcast({
          utilityId: utility.id,
          kind: 'authorize',
          authUrl: authorizationUrl.href
        })
      }
    })
    // Generated before the flow runs, so the callback can be awaited before the
    // browser has any chance to redirect back with the code.
    const state = await provider.state()
    const waiting = listener.waitForCallback(state, MCP_OAUTH_CALLBACK_PATH)
    // A refresh that succeeds retires the listener without any callback, and the
    // waiter's own rejection is not a failure.
    void waiting.catch(() => undefined)
    const scope = request.scope?.trim() || utility.config.oauth?.scope
    this.dependencies.broadcast({
      utilityId: utility.id,
      kind: 'progress',
      message: 'Finding the authorization server…'
    })
    const outcome = await protocol.authorizeMcp(provider, {
      serverUrl: url,
      ...this.challenge(utility.id),
      ...(scope ? { scope } : {}),
      signal: session.abort.signal
    })
    if (outcome === 'AUTHORIZED') {
      await session.closeCallback()
      return true
    }
    this.dependencies.broadcast({
      utilityId: utility.id,
      kind: 'progress',
      message: 'Waiting for the browser to finish signing in…'
    })
    const callback = await waiting
    // The listener has done its job; the port is free while the code is exchanged.
    await session.closeCallback()
    const finished = await protocol.authorizeMcp(provider, {
      serverUrl: url,
      authorizationCode: callback.code,
      ...(callback.iss ? { iss: callback.iss } : {}),
      ...(scope ? { scope } : {}),
      signal: session.abort.signal
    })
    return finished === 'AUTHORIZED'
  }

  private provider(
    protocol: McpOAuthProtocol,
    utility: UtilityDefinitionFor<'mcp'>,
    options: {
      redirectUrl: string
      clientId?: string
      clientSecret?: string | null
      onRedirect: (url: URL) => void
    }
  ): McpOAuthProvider {
    const url = utility.config.url
    if (!url) throw new Error('This MCP server has no URL to authorize')
    return new protocol.McpOAuthProvider({
      serverUrl: url,
      redirectUrl: options.redirectUrl,
      clientMetadata: {
        client_name: 'CodeInOven',
        software_id: 'codeinoven',
        software_version: '1'
      },
      ...(options.clientId ? { clientId: options.clientId } : {}),
      ...(options.clientSecret ? { clientSecret: options.clientSecret } : {}),
      store: this.store(utility.id),
      onRedirect: (authorizationUrl) => options.onRedirect(authorizationUrl)
    })
  }

  private async listen(
    protocol: McpOAuthProtocol,
    session: AuthorizationSession
  ): Promise<Awaited<ReturnType<McpOAuthProtocol['OAuthCallbackServer']['listen']>>> {
    let lastError: unknown
    for (const port of CALLBACK_PORTS) {
      try {
        const listener = await protocol.OAuthCallbackServer.listen({
          host: '127.0.0.1',
          port,
          path: MCP_OAUTH_CALLBACK_PATH,
          timeoutMs: this.dependencies.authorizationTimeoutMs ?? AUTHORIZATION_TIMEOUT_MS
        })
        session.closeCallback = () => listener.close()
        return listener
      } catch (error) {
        lastError = error
      }
    }
    throw new Error('No loopback port was free for the authorization redirect', {
      cause: lastError
    })
  }

  /**
   * Write the non-secret half of a grant into the utility's configuration, so
   * the Utilities page can show who authorized and until when without asking the
   * vault, and so the OAuth block survives a config round-trip.
   */
  private async persistGrant(
    utility: UtilityDefinitionFor<'mcp'>,
    request: McpOAuthAuthorizeRequest
  ): Promise<void> {
    const state = await this.store(utility.id).load()
    const previous = utility.config.oauth
    const discovery = state?.discovery
    const clientId =
      request.clientId?.trim() || previous?.clientId || state?.clientInformation?.client_id
    const confidentialClient = Boolean(
      state?.clientInformation?.client_secret ??
      (await this.dependencies.vault.resolveMcpOAuthClientSecret(utility.id))
    )
    const issuer = discovery?.authorizationServerUrl ?? previous?.issuer
    const scope = state?.tokens?.scope ?? request.scope?.trim() ?? previous?.scope
    const resource = discovery?.resourceMetadata?.resource ?? previous?.resource
    const oauth: McpOAuthConfig = {
      enabled: true,
      ...(issuer ? { issuer } : {}),
      ...(clientId ? { clientId } : {}),
      ...(confidentialClient ? { confidentialClient } : {}),
      ...(scope ? { scope } : {}),
      ...(resource ? { resource } : {}),
      ...(state?.tokensExpireAt === undefined ? {} : { expiresAt: state.tokensExpireAt }),
      authorizedAt: Date.now()
    }
    await this.dependencies.registry.update(utility.id, {
      config: { ...utility.config, oauth }
    })
  }

  /**
   * Ask the authorization server to drop the grant, when it offers a revocation
   * endpoint. Best effort: the grant is already unusable locally.
   */
  private async revokeGrant(utility: UtilityDefinitionFor<'mcp'>): Promise<void> {
    const state = await this.store(utility.id).load()
    const endpoint = revocationEndpoint(state?.discovery?.authorizationServerMetadata)
    const token = state?.tokens?.refresh_token ?? state?.tokens?.access_token
    if (!endpoint || !token) return
    const clientId = utility.config.oauth?.clientId ?? state?.clientInformation?.client_id
    const clientSecret =
      state?.clientInformation?.client_secret ??
      (await this.dependencies.vault.resolveMcpOAuthClientSecret(utility.id))
    const body = new URLSearchParams({ token })
    if (clientId) {
      body.set('client_id', clientId)
      if (clientSecret) body.set('client_secret', clientSecret)
    }
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded'
      },
      body,
      signal: AbortSignal.timeout(30_000)
    })
    if (!response.ok) throw new Error(`Revocation endpoint answered ${response.status}`)
  }

  /** The discovery hints a flow may start from, filled in by an observed challenge. */
  private challenge(utilityId: string): { resourceMetadataUrl?: URL; scope?: string } {
    const observed = this.challenges.get(utilityId)
    if (!observed) return {}
    return {
      ...(observed.resourceMetadataUrl
        ? { resourceMetadataUrl: observed.resourceMetadataUrl }
        : {}),
      ...(observed.scope ? { scope: observed.scope } : {})
    }
  }

  private store(utilityId: string): VaultMcpOAuthStateStore {
    return new VaultMcpOAuthStateStore(this.dependencies.vault, utilityId)
  }

  private async utility(utilityId: string): Promise<UtilityDefinitionFor<'mcp'>> {
    const utility = await this.dependencies.registry.get(utilityId)
    if (!utility) throw new Error(`Utility not found: ${utilityId}`)
    if (utility.kind !== 'mcp') throw new Error('Only an MCP server can be authorized with OAuth')
    return utility
  }
}

/**
 * Who the authorization server says authorized this app, for display.
 *
 * The identity is read from the id token's own claims and is deliberately never
 * verified and never used for a decision: it exists so the Utilities page can
 * say which account a grant belongs to (two workspaces of the same product are
 * otherwise indistinguishable). A token whose payload is not readable simply has
 * no label.
 */
function accountLabelFrom(tokens: OAuthTokens | undefined): string | undefined {
  const payload = tokens?.id_token?.split('.')[1]
  if (!payload) return undefined
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'))
    if (claims === null || typeof claims !== 'object' || Array.isArray(claims)) return undefined
    const record = claims as Record<string, unknown>
    for (const key of ['email', 'preferred_username', 'name', 'sub']) {
      const value = record[key]
      if (typeof value !== 'string') continue
      const trimmed = value.trim()
      if (trimmed && !/\p{Cc}/u.test(trimmed)) return trimmed
    }
    return undefined
  } catch {
    return undefined
  }
}

/** The redirect a silent renewal uses; a refresh grant never touches it. */
function defaultRedirectUrl(): string {
  return `http://127.0.0.1:${CALLBACK_PORTS[0]}${MCP_OAUTH_CALLBACK_PATH}`
}

function revocationEndpoint(metadata: AuthorizationServerMetadata | undefined): string | null {
  const endpoint = metadata?.['revocation_endpoint']
  return typeof endpoint === 'string' && URL.canParse(endpoint) ? endpoint : null
}

/** Whether an access token expires inside `leewayMs`. An unknown lifetime never expires. */
function expiresWithin(expiresAt: number | undefined, leewayMs: number): boolean {
  if (expiresAt === undefined) return false
  return expiresAt - leewayMs <= Date.now()
}

/** A failure the user can read; an abort is a cancel rather than an error. */
function describeFailure(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'Authorization was cancelled'
  const message = error instanceof Error ? error.message : String(error)
  return message.trim() || 'Authorization failed'
}
