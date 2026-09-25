import { StdioMcpClient, type McpClient } from '../agents/mcp-stdio-client'
import type { McpUtilityConfig, UtilityCredentialMetadata } from '../../lib/types'
import { resolveEnvironmentReferences } from './utility-orchestration/utility-input'
import { RemoteMcpClient } from './utility-orchestration/remote-mcp-client'

/** The connection half of an MCP utility config, shared by the turn gateway and the connection test. */
export type McpConnectionConfig = Pick<
  McpUtilityConfig,
  'transport' | 'command' | 'args' | 'url' | 'environment' | 'headers'
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
  /** Omit to keep the raw client failure, e.g. inside a turn that reports its own context. */
  owner?: McpConnectionOwner
}

/**
 * Start one MCP server exactly the way a turn does: same transports, same
 * credential environment merge, same `{env:NAME}` header resolution. The turn
 * gateway and the Utilities connection test both call this, so a test that
 * passes is a server the gateway can start.
 */
export async function connectMcpServer(request: McpConnectionRequest): Promise<McpClient> {
  const { config, environment, owner } = request
  if (config.transport === 'stdio') {
    if (!config.command) throw new Error('stdio MCP command is not configured')
    try {
      return await StdioMcpClient.connect(config.command, config.args ?? [], {
        ...config.environment,
        ...environment
      })
    } catch (error) {
      if (!owner) throw error
      throw mcpStartupFailure(owner, environment, error)
    }
  }
  if (!config.url) throw new Error('Remote MCP URL is not configured')
  return RemoteMcpClient.connect(
    config.url,
    resolveEnvironmentReferences(config.headers ?? {}, environment)
  )
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
 * Where a connection actually goes, for display. Headers, credentials, and
 * every other secret stay out: this is the same string the row already shows.
 */
export function mcpTargetLabel(config: McpConnectionConfig): string {
  if (config.transport === 'stdio') {
    return [config.command ?? '', ...(config.args ?? [])].filter(Boolean).join(' ')
  }
  return config.url ?? ''
}
