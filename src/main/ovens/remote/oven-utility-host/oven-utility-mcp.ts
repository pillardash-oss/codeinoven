/**
 * What an Oven needs from an MCP server, stated once.
 *
 * A remote turn runs on the Oven, so a server its capability needs must run
 * *there*: the app's own client is in another process on another machine and its
 * child processes are not this machine's children. This module is the contract
 * every Oven-local transport answers to, plus the two things all of them share:
 * the budgets a call may spend, and the vocabulary that tells "this server could
 * not run here" (forward the call to the app) apart from "this server refused
 * the call" (an answer, never forwarded).
 *
 * Nothing here imports Electron or a SvelteKit module: the Oven service bundle
 * carries it to the Oven.
 */
import type { OvenUtilityMcpServer } from '../../../../lib/oven-utility-host'

/** How long one server gets to answer `initialize` before its transport is abandoned. */
export const OVEN_MCP_CONNECT_TIMEOUT_MS = 30_000

/**
 * How long one tool call may run.
 *
 * Generous on purpose: a call can be human-paced on the server's side too (a
 * browser taking a screenshot). It exists so one wedged server costs a turn one
 * call instead of every later call.
 */
export const OVEN_MCP_CALL_TIMEOUT_MS = 120_000

/** One tool a server advertises, as `tools/list` reported it. */
export interface OvenMcpTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

/** One live connection to an MCP server running on this Oven. */
export interface OvenUtilityMcpClient {
  /** Whether this connection can still answer a call. A retired one cannot be resumed. */
  readonly usable: boolean
  listTools(): Promise<OvenMcpTool[]>
  callTool(name: string, input: Record<string, unknown>): Promise<unknown>
  /** Stop the server and fail anything still waiting on it. Idempotent. */
  close(): Promise<void>
}

/**
 * A server this Oven could not run, or lost while running it.
 *
 * This is the one failure a local execution turns into a forward: the app may
 * still be able to run the same call against the same server, so a transport
 * problem on the Oven must not become a failed tool call. A refusal the server
 * itself sent is `OvenUtilityToolError` instead, because the call did run.
 */
export class OvenUtilityMcpUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'OvenUtilityMcpUnavailableError'
  }
}

/** The server answered the call and refused it: a real result, never a forward. */
export class OvenUtilityToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OvenUtilityToolError'
  }
}

/**
 * The variables a stdio server inherits from the Oven account it runs as.
 *
 * The turn's own `env` is the whole configured environment: a server is started
 * with exactly that plus what every process needs to find its executables and
 * its home. Nothing else from the Oven's own environment leaks into it, so two
 * utilities cannot read each other's credentials by accident.
 *
 * The Windows entries are not optional there: `SystemRoot` is what the Win32
 * loader reads its own libraries from, and a child started without it fails
 * before it runs a line of its own code.
 */
const INHERITED_ENVIRONMENT_NAMES: readonly string[] =
  process.platform === 'win32'
    ? ['PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'SystemRoot']
    : ['PATH', 'HOME', 'TMPDIR']

export function ovenUtilityMcpEnvironment(server: OvenUtilityMcpServer): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const name of INHERITED_ENVIRONMENT_NAMES) {
    const value = process.env[name]
    if (value !== undefined) environment[name] = value
  }
  return { ...environment, ...server.env }
}

/**
 * The request headers a remote server is called with, already resolved by the
 * client that owns the vault.
 *
 * A remote MCP server has no environment to inherit, so the bearer it needs is a
 * header the client resolved before the turn ever left the app. This is where it
 * reaches the request; an empty map means the server wants none.
 */
export function ovenUtilityMcpHeaders(server: OvenUtilityMcpServer): Record<string, string> {
  return { ...server.headers }
}

/**
 * The target one server is reached at, for an error a user can act on.
 *
 * Headers and variables never appear: this is the command or the URL, which is
 * what the Utilities page already shows.
 */
export function ovenUtilityMcpTarget(server: OvenUtilityMcpServer): string {
  if (server.transport === 'stdio')
    return [server.command ?? '', ...(server.args ?? [])].filter(Boolean).join(' ')
  return server.url ?? ''
}

/** Read `result.tools` from a `tools/list` answer, ignoring what is not a tool. */
export function parseOvenMcpTools(result: unknown): OvenMcpTool[] {
  if (!isRecord(result)) return []
  const tools = result['tools']
  if (!Array.isArray(tools)) return []
  return tools.flatMap((value) => {
    if (!isRecord(value) || typeof value['name'] !== 'string') return []
    return [
      {
        name: value['name'],
        ...(typeof value['description'] === 'string' ? { description: value['description'] } : {}),
        ...(isRecord(value['inputSchema']) ? { inputSchema: value['inputSchema'] } : {})
      }
    ]
  })
}

/** What a JSON-RPC response carries, as far as a client cares. */
export interface OvenMcpJsonRpcResponse {
  jsonrpc?: string
  id?: number
  result?: unknown
  error?: { code?: number; message?: string }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The message a JSON-RPC refusal carries, with the code when it names one. */
export function ovenMcpRefusalMessage(error: { code?: number; message?: string }): string {
  const message = error.message?.trim()
  if (!message) return 'The MCP server refused the call.'
  return typeof error.code === 'number' ? `${message} (MCP code ${error.code})` : message
}
