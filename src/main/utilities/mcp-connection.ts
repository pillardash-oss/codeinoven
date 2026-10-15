import { StdioMcpClient, type McpClient } from '../agents/mcp-stdio-client'
import type { McpUtilityConfig, UtilityCredentialMetadata } from '../../lib/types'
import { resolveEnvironmentReferences } from './utility-orchestration/utility-input'
import { McpHttpError, RemoteMcpClient } from './utility-orchestration/remote-mcp-client'

/** The connection half of an MCP utility config, shared by the turn gateway and the connection test. */
export type McpConnectionConfig = Pick<
  McpUtilityConfig,
  'transport' | 'command' | 'args' | 'url' | 'environment' | 'headers' | 'oauth'
>

/** Named context that turns a stdio startup failure into something the user can act on. */
export interface McpConnectionOwner {
  /** The utility or server name a failure message should name. */
  name: string
  /** Declared credentials, used to name the variables a failure was missing. */
  credentials: readonly UtilityCredentialMetadata[]
}

export interface McpConnectionRequest {
  config: McpConnectionConfig
  /** Credential variables, already resolved from the vault. */
  environment: Record<string, string>
  /** Declared credentials, used to inject a remote server's secret into its request headers. */
  credentials?: readonly UtilityCredentialMetadata[]
  /**
   * OAuth 2.1 bearer token resolved for this server, when its utility is
   * authorized. It is the credential the authorization server just issued, so it
   * replaces any configured `Authorization` header rather than being ignored
   * behind one.
   */
  authorization?: string | null
  /**
   * Whether the app can complete an OAuth authorization for this server: true
   * for an installed utility, false for a harness-native server the app only
   * reads, whose own host has to authorize it.
   */
  authorizable?: boolean
  /** Omit to keep the raw client failure, e.g. inside a turn that reports its own context. */
  owner?: McpConnectionOwner
  /** Turn that started the server, so the task manager attributes its row. */
  context?: { projectId?: string | null; threadId?: string | null }
}

/**
 * Start one MCP server exactly the way a turn does: same transports, same
 * credential environment merge, same `{env:NAME}` header resolution. The turn
 * gateway and the Utilities connection test both call this, so a test that
 * passes is a server the gateway can start.
 */
export async function connectMcpServer(request: McpConnectionRequest): Promise<McpClient> {
  const { config, environment, owner } = request
  const projectId = request.context?.projectId ?? null
  const threadId = request.context?.threadId ?? null
  const clientOwner = {
    ...(owner?.name ? { name: owner.name } : {}),
    scope: threadId ? ('thread' as const) : projectId ? ('project' as const) : ('app' as const),
    projectId,
    threadId
  }
  if (config.transport === 'stdio') {
    if (!config.command) throw new Error('stdio MCP command is not configured')
    try {
      return await StdioMcpClient.connect(
        config.command,
        config.args ?? [],
        {
          ...config.environment,
          ...environment
        },
        clientOwner
      )
    } catch (error) {
      if (!owner) throw error
      throw mcpStartupFailure(owner, environment, error)
    }
  }
  if (!config.url) throw new Error('Remote MCP URL is not configured')
  try {
    return await RemoteMcpClient.connect(
      config.url,
      resolveMcpHeaders(config, environment, request.credentials, request.authorization),
      clientOwner
    )
  } catch (error) {
    if (!owner) throw error
    throw mcpAuthorizationFailure(request, error)
  }
}

/**
 * The request headers a remote MCP is sent with: the configured values with
 * their `{env:NAME}` references resolved, plus every declared credential that
 * no configured header already carries.
 *
 * A remote server has no process environment to inherit, so a declared secret
 * is inert until it reaches a header: this is where a vault value saved during
 * setup becomes the credential the server actually receives. Most API-key
 * servers read `Authorization: Bearer <key>`, so an unmapped credential becomes
 * exactly that; a server that wants a different header (an `X-API-Key`, a
 * query-shaped key) declares it explicitly in the config, and an explicit
 * `Authorization` header is never overridden.
 */
export function resolveMcpHeaders(
  config: McpConnectionConfig,
  environment: Record<string, string>,
  credentials: readonly UtilityCredentialMetadata[] = [],
  authorization?: string | null
): Record<string, string> {
  const headers = resolveConfiguredHeaders(config, environment, credentials)
  if (!authorization) return headers
  // An OAuth grant is the credential the server itself issued for this app.
  // A leftover `Authorization` header   an API key the user pasted while the
  // server still refused it, say   would shadow the grant, so the grant wins and
  // the stale header is dropped under every spelling of its name.
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === 'authorization') delete headers[name]
  }
  headers['Authorization'] = `Bearer ${authorization}`
  return headers
}

function resolveConfiguredHeaders(
  config: McpConnectionConfig,
  environment: Record<string, string>,
  credentials: readonly UtilityCredentialMetadata[]
): Record<string, string> {
  const configured = config.headers ?? {}
  const headers = resolveEnvironmentReferences(configured, environment)
  // A configured header that expands a declared variable already carries that
  // secret, whatever header it lands in.
  const referenced = new Set<string>()
  for (const value of Object.values(configured)) {
    for (const match of value.matchAll(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/gu)) {
      referenced.add(match[1] ?? '')
    }
  }
  let authorizationTaken = Object.keys(headers).some(
    (name) => name.toLowerCase() === 'authorization'
  )
  for (const credential of credentials) {
    const name = credential.environmentVariable
    if (!name || !environment[name] || referenced.has(name) || authorizationTaken) continue
    headers['Authorization'] = `Bearer ${environment[name]}`
    authorizationTaken = true
  }
  return headers
}

/**
 * Resolve declared credentials into the environment an MCP server starts with.
 * A credential with no environment variable is not a process variable, and an
 * optional credential that cannot be read is passed over rather than blocking
 * the server.
 */
export async function credentialEnvironment(
  credentials: readonly UtilityCredentialMetadata[],
  resolveSecret: (secretRef: string) => Promise<string>
): Promise<Record<string, string>> {
  const environment: Record<string, string> = {}
  for (const credential of credentials) {
    if (!credential.environmentVariable) continue
    try {
      environment[credential.environmentVariable] = await resolveSecret(credential.secretRef)
    } catch (error) {
      if (credential.required) throw error
    }
  }
  return environment
}

/** Declared credential variables the connection attempt had no value for. */
export function missingCredentialVariables(
  credentials: readonly UtilityCredentialMetadata[],
  environment: Record<string, string>
): string[] {
  const missing = new Set<string>()
  for (const credential of credentials) {
    const name = credential.environmentVariable
    if (!name || environment[name]) continue
    missing.add(name)
  }
  return [...missing]
}

/**
 * Turn a stdio MCP startup failure into something the agent or the user can act
 * on.
 *
 * A server that exits before it answers `initialize` usually died over missing
 * setup, and the exit message alone does not say which utility or which
 * credential. Naming both here is what stops a missing token from reading as a
 * broken MCP server.
 */
export function mcpStartupFailure(
  owner: McpConnectionOwner,
  environment: Record<string, string>,
  error: unknown
): Error {
  const message = error instanceof Error ? error.message : String(error)
  const missing = missingCredentialVariables(owner.credentials, environment)
  if (missing.length === 0) {
    return new Error(`Utility \`${owner.name}\` could not start: ${message}`, { cause: error })
  }
  return new Error(
    `Utility \`${owner.name}\` could not start: ${message}. Set its credential ${
      missing.length > 1 ? 'variables' : 'variable'
    } ${missing.map((name) => `\`${name}\``).join(', ')} in Utilities`,
    { cause: error }
  )
}

/**
 * The `WWW-Authenticate` header a refusal carried, when it actually asks for
 * OAuth.
 *
 * A `Bearer` challenge without `resource_metadata` is what an API-key server
 * sends, and it is not an invitation to authorize; only the protected-resource
 * form names a server whose authorization this app can complete.
 */
export function mcpOAuthChallengeHeader(error: unknown): string | null {
  // The refusal is wrapped once on its way out of `connectMcpServer` (it is
  // reported as "Utility X could not be reached"), so the challenge is looked for
  // down the cause chain rather than only at the top.
  for (let current: unknown = error, depth = 0; depth < 5; depth += 1) {
    if (current instanceof McpHttpError) {
      const header = current.wwwAuthenticate
      return header && /resource_metadata\s*=/iu.test(header) ? header : null
    }
    current = current instanceof Error ? current.cause : undefined
    if (current === undefined || current === null) return null
  }
  return null
}

/**
 * Turn a remote MCP refusal into something the user can act on.
 *
 * An MCP server that refuses for lack of authorization says so only in its
 * `WWW-Authenticate` header, which no user reads. Naming the utility, the
 * challenge, and the exact fix is the difference between "connection failed" and
 * "this server needs to be authorized".
 */
export function mcpAuthorizationFailure(request: McpConnectionRequest, error: unknown): Error {
  const name = request.owner?.name ?? 'MCP server'
  const message = error instanceof Error ? error.message : String(error)
  const challenge = mcpOAuthChallengeHeader(error)
  if (!challenge) {
    return new Error(`Utility \`${name}\` could not be reached: ${message}`, { cause: error })
  }
  const authorizable = request.authorizable !== false
  const guidance = !authorizable
    ? 'This server requires OAuth authorization, which only the harness that owns it can complete'
    : request.config.oauth?.enabled
      ? request.authorization
        ? 'The server rejected the stored authorization; authorize it again in Utilities'
        : 'Its authorization has not been completed yet; use Authorize in Utilities'
      : 'This server requires OAuth authorization; turn MCP authorization on for it in Utilities'
  return new Error(`Utility \`${name}\` could not be reached: ${message}. ${guidance}`, {
    cause: error
  })
}

/**
 * Where a connection actually goes, for display. Headers, credentials, and every
 * other secret stay out: this is the same string the row already shows.
 */
export function mcpTargetLabel(config: McpConnectionConfig): string {
  if (config.transport === 'stdio') {
    return [config.command ?? '', ...(config.args ?? [])].filter(Boolean).join(' ')
  }
  return config.url ?? ''
}
