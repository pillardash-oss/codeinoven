/**
 * The pi-facing shape of the MCP utilities a thread has activated.
 *
 * Pi owns an MCP host of its own: an extension registers a server with
 * `pi.registerMcpServer(name, config)`, pi connects it, reconnects it after a
 * dropped transport, exposes its tools as `mcp__<server>__<tool>` to codemode
 * scripts, and hands a script the complete `CallToolResult` (content,
 * structuredContent, isError). CodeInOven's own gateway forwards a tool result
 * through JSON and drops the structured payload whenever an image travels
 * beside it, which is exactly how a computer-use thread lost the element
 * handles it had just been handed.
 *
 * This module is the pure half of that contract: the server name a utility
 * takes on pi, the config pi validates, and the document the app-owned
 * extension reconciles registrations from. No Electron, no processes, so the
 * naming and config rules stay unit-testable.
 *
 * Credentials travel inside the document, which is written to the session's
 * own file in the app config root (0600, session-keyed, removed with the
 * session). The vault itself stays OS-encrypted at rest; this is the same
 * trust boundary as the turn token the gateway handoff already carries, and it
 * is what makes a credential usable by a pi process that was spawned before the
 * utility was activated. A value never appears in a log or a tool result.
 */

import type { McpExposure, McpServerConfig } from '@earendil-works/pi-coding-agent'
import type { NativeMcpUtilityBinding } from '../../../lib/types'
import { utilityKey } from './pi-values'

/** File inside the session's core-tools directory holding the server document. */
export const PI_MCP_SERVERS_FILE_NAME = 'mcp-servers.json'

/** Document revision the app-owned extension knows how to read. */
export const PI_MCP_SERVERS_DOCUMENT_VERSION = 1

/**
 * Exposure for an app-bound MCP server.
 *
 * `codemode` keeps every MCP tool behind a script: pi neither declares them to
 * the model nor lists them in the codemode description, and a script can filter
 * a large payload before the model pays for it. The server itself is still
 * announced, by the `mcp_servers` system prompt section and by the activation
 * payload, so the model knows which namespace to reach for.
 */
export const PI_MCP_EXPOSURE: McpExposure = 'codemode'

/** One utility to register on pi, with the credential values it reads. */
export type PiMcpUtilityInput = NativeMcpUtilityBinding

/** One server for pi to run, plus the utility it belongs to. */
export interface PiMcpServerRegistration {
  /** The name pi registers. Its tools arrive as `mcp__<name>__<tool>`. */
  name: string
  config: McpServerConfig
  utilityId: string
  utilityName: string
}

/** What the app-owned extension reads: the servers this thread has activated. */
export interface PiMcpServersDocument {
  version: number
  servers: Array<{
    name: string
    utilityId: string
    utilityName: string
    config: McpServerConfig
  }>
}

/**
 * The server name one utility takes on pi.
 *
 * Pi accepts only `[A-Za-z0-9_-]` in a server name and builds the tool
 * namespace with `mcp__<name with - replaced by _>__`, so the name is derived
 * with the same key the harness overlay already uses and then keeps no dash:
 * `svelte-mcp` and `svelte_mcp` would otherwise name the same namespace and
 * two utilities could not be told apart by a tool name.
 */
export function piMcpServerName(source: string): string {
  return utilityKey(source).replace(/-/gu, '_')
}

/** The `mcp__<server>__` prefix pi gives a registered server's tools. */
export function piMcpServerToolPrefix(name: string): string {
  return `mcp__${name}__`
}

/** What one publication produced: the servers to run, and what could not be one. */
export interface PiMcpRegistrationResult {
  registrations: PiMcpServerRegistration[]
  /** Utilities the app could not turn into a pi server, with the reason. */
  failures: Array<{ utilityId: string; utilityName: string; reason: string }>
}

/**
 * Build one registration per utility, in the order the app resolved them, with
 * a deterministic suffix when two utilities would claim the same server name.
 *
 * A utility whose config cannot make a valid pi server is reported rather than
 * thrown: one broken entry must not cost the thread every other server, and the
 * app gateway remains a path to the one that failed.
 */
export function buildPiMcpRegistrations(
  inputs: readonly PiMcpUtilityInput[]
): PiMcpRegistrationResult {
  const taken = new Set<string>()
  const registrations: PiMcpServerRegistration[] = []
  const failures: PiMcpRegistrationResult['failures'] = []
  for (const input of inputs) {
    const base = piMcpServerName(input.utility.id)
    let name = base
    for (let suffix = 2; taken.has(name); suffix += 1) name = `${base}_${suffix}`
    taken.add(name)
    try {
      registrations.push({
        name,
        config: piMcpServerConfig(input),
        utilityId: input.utility.id,
        utilityName: input.utility.name
      })
    } catch (error) {
      failures.push({
        utilityId: input.utility.id,
        utilityName: input.utility.name,
        reason: error instanceof Error ? error.message : String(error)
      })
    }
  }
  return { registrations, failures }
}

/** The document the extension reads, ready to be serialized onto disk. */
export function piMcpServersDocument(
  registrations: readonly PiMcpServerRegistration[]
): PiMcpServersDocument {
  return {
    version: PI_MCP_SERVERS_DOCUMENT_VERSION,
    servers: registrations.map(({ name, config, utilityId, utilityName }) => ({
      name,
      config,
      utilityId,
      utilityName
    }))
  }
}

/**
 * The registration that owns a pi tool name, or null when none does.
 *
 * Matched by prefix rather than by splitting on `__`: a server name is free to
 * contain a double underscore, and a split would then read the wrong one.
 */
export function piMcpToolOwner(
  registrations: readonly PiMcpServerRegistration[],
  toolName: string
): PiMcpServerRegistration | null {
  return (
    registrations.find((registration) =>
      toolName.startsWith(`${piMcpServerToolPrefix(registration.name)}`)
    ) ?? null
  )
}

/** The config pi validates and connects for one utility. */
function piMcpServerConfig(input: PiMcpUtilityInput): McpServerConfig {
  const { utility, environment } = input
  const base = {
    description: utility.description,
    exposure: PI_MCP_EXPOSURE
  }
  if (utility.config.transport === 'stdio') {
    if (!utility.config.command) {
      throw new TypeError(`MCP utility "${utility.name}" requires a stdio command`)
    }
    return {
      ...base,
      type: 'stdio',
      command: utility.config.command,
      args: [...(utility.config.args ?? [])],
      env: stdioEnvironment(utility, environment)
    }
  }
  if (!utility.config.url) {
    throw new TypeError(`MCP utility "${utility.name}" requires a URL`)
  }
  // Pi rejects the legacy SSE transport by name and reaches every remote server
  // over streamable HTTP, so an `sse` utility keeps its URL and loses the label.
  return {
    ...base,
    type: 'http',
    url: utility.config.url,
    headers: httpHeaders(utility, environment)
  }
}

/**
 * The process environment one stdio server starts with: the utility's own
 * configured values, with the app's `{env:NAME}` references resolved, plus
 * every declared credential the app resolved this turn.
 *
 * Values are written out rather than inherited, so a server started by a pi
 * process that was spawned before this thread activated the utility still
 * receives its credential.
 */
function stdioEnvironment(
  utility: PiMcpUtilityInput['utility'],
  environment: Record<string, string>
): Record<string, string> {
  const values: Record<string, string> = {}
  for (const [key, value] of Object.entries(utility.config.environment ?? {})) {
    values[key] = resolveReference(utility, value, environment)
  }
  for (const credential of utility.credentials) {
    const name = credential.environmentVariable
    if (!name || !(name in environment)) continue
    if (values[name] !== undefined) continue
    values[name] = environment[name] ?? ''
  }
  return values
}

/**
 * The request headers a remote server is sent: the configured values with their
 * `{env:NAME}` references resolved, plus every declared credential that no
 * configured header already carries.
 *
 * The same rule the app's own remote client applies, so a server that is
 * configured once works on both paths; most API-key servers read
 * `Authorization: Bearer <key>`, and an explicit Authorization header is never
 * overridden.
 */
function httpHeaders(
  utility: PiMcpUtilityInput['utility'],
  environment: Record<string, string>
): Record<string, string> {
  const configured = utility.config.headers ?? {}
  const headers: Record<string, string> = {}
  const referenced = new Set<string>()
  for (const [key, value] of Object.entries(configured)) {
    for (const match of value.matchAll(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/gu)) {
      referenced.add(match[1] ?? '')
    }
    headers[key] = resolveReference(utility, value, environment)
  }
  let authorizationTaken = Object.keys(headers).some(
    (name) => name.toLowerCase() === 'authorization'
  )
  for (const credential of utility.credentials) {
    const name = credential.environmentVariable
    if (!name || referenced.has(name) || authorizationTaken) continue
    const value = environment[name]
    if (value === undefined) continue
    headers['Authorization'] = `Bearer ${value}`
    authorizationTaken = true
  }
  return headers
}

/** One configured value with the app's `{env:NAME}` references expanded. */
function resolveReference(
  utility: PiMcpUtilityInput['utility'],
  value: string,
  environment: Record<string, string>
): string {
  return value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_, name: string) => {
    const resolved = environment[name]
    if (resolved === undefined) {
      throw new Error(
        `MCP utility "${utility.name}" references the unavailable credential variable ${name}`
      )
    }
    return resolved
  })
}
