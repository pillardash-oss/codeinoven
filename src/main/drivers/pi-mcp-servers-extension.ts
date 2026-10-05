/**
 * Generated TypeScript source for the app-owned Pi MCP registration extension.
 *
 * Pi owns an MCP host: an extension registers a server with
 * `pi.registerMcpServer(name, config)`, pi connects it, reconnects it after a
 * dropped transport, and exposes its tools to codemode scripts as
 * `mcp__<server>__<tool>`. A script then receives the complete
 * `CallToolResult`   `content`, `structuredContent` and `isError`   which is the
 * whole point of this path: the app's own gateway forwards a result through
 * JSON and drops the structured payload whenever an image travels beside it.
 *
 * The servers are turn-scoped data, while a Pi session process persists across
 * turns and loads its extensions once at spawn. The driver therefore publishes
 * a session-keyed document (the servers this thread has activated, with the
 * credential values they read), and this extension reconciles the live
 * registration set against it: at session start, before every agent start, and
 * before a script surface runs (which is what makes a utility activated in the
 * current turn callable from the very next script). `session_shutdown`
 * unregisters everything, so pi closes the servers' child processes with the
 * session.
 *
 * Nothing is registered eagerly: only the utilities the thread has already
 * activated appear in the document, so a session that never touches an MCP
 * server never pays for one, and the app gateway stays the transport for every
 * other harness.
 */

/**
 * The generated extension in one string. The path placeholder is substituted by
 * the composer (`piCioCoreToolsExtension`) with the session's document path.
 *
 * The body deliberately avoids template literals and `${}` interpolation: the
 * generated source is itself built by a template literal here, and a nested
 * interpolation would be swallowed by this module instead of reaching pi.
 */
export function piMcpServersExtension(): string {
  return `import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { readFileSync } from 'node:fs'

/** Absolute path of the per-session MCP server document the driver rewrites. */
const CIO_MCP_SERVERS_PATH = '__CIO_MCP_SERVERS_PATH__'

/** Document revision this extension understands. */
const CIO_MCP_SERVERS_VERSION = 1

/**
 * Script surfaces a server's tools become reachable through. Reconcile before
 * one of these runs so a utility activated earlier in the same turn is
 * connected by the time the script asks for it; a tool call of any other kind
 * cannot reach an MCP tool and does not need the read.
 */
const CIO_MCP_SCRIPT_TOOLS = ['codemode', 'tool_search']

interface CioMcpServerEntry {
  name: string
  config: Record<string, unknown>
}

/** One server this session registered, keyed by name, with the config it used. */
type CioMcpRegistered = Map<string, string>

/**
 * Read the document. A missing or unreadable file answers with null, which
 * means "no instruction" rather than "no servers": a turn that never published
 * must not tear down servers a previous turn started, and a document that was
 * written while the file was half-visible heals on the next write.
 */
function readCioMcpServers(): CioMcpServerEntry[] | null {
  let raw: string
  try {
    raw = readFileSync(CIO_MCP_SERVERS_PATH, 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const document = parsed as { version?: unknown; servers?: unknown }
  if (document.version !== CIO_MCP_SERVERS_VERSION) return null
  if (!Array.isArray(document.servers)) return null
  const servers: CioMcpServerEntry[] = []
  for (const value of document.servers) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const entry = value as { name?: unknown; config?: unknown }
    if (typeof entry.name !== 'string' || entry.name.length === 0) continue
    if (!entry.config || typeof entry.config !== 'object' || Array.isArray(entry.config)) continue
    servers.push({ name: entry.name, config: entry.config as Record<string, unknown> })
  }
  return servers
}

/**
 * Bring pi's registration set in line with the document: register a server that
 * is new or whose config changed, unregister one the app no longer publishes.
 * The registered map is the only record of what this extension owns, so a
 * server somebody else registered is never touched.
 */
function reconcileCioMcpServers(pi: ExtensionAPI, registered: CioMcpRegistered): void {
  if (typeof pi.registerMcpServer !== 'function' || typeof pi.unregisterMcpServer !== 'function') {
    return
  }
  const servers = readCioMcpServers()
  if (servers === null) return
  const desired = new Map<string, string>()
  for (const server of servers) desired.set(server.name, JSON.stringify(server.config))
  for (const name of Array.from(registered.keys())) {
    if (desired.has(name)) continue
    registered.delete(name)
    try {
      pi.unregisterMcpServer(name)
    } catch {
      // A server pi already dropped needs no second removal.
    }
  }
  for (const [name, config] of desired) {
    if (registered.get(name) === config) continue
    try {
      pi.registerMcpServer(name, JSON.parse(config))
      registered.set(name, config)
    } catch (error) {
      // Registration throws for a malformed config or a namespace another
      // server already claims. Report once on the harness's stderr and retry on
      // the next reconcile: a corrected document then recovers without a restart.
      registered.delete(name)
      process.stderr.write(
        '[cio-mcp] server "' + name + '" could not be registered: ' +
          (error instanceof Error ? error.message : String(error)) +
          '\\n'
      )
    }
  }
}

export default function codeInOvenMcpServersExtension(pi: ExtensionAPI): void {
  const registered: CioMcpRegistered = new Map()
  const reconcile = (): void => reconcileCioMcpServers(pi, registered)

  pi.on('session_start', () => reconcile())
  pi.on('before_agent_start', () => reconcile())
  pi.on('tool_call', (event) => {
    if (!CIO_MCP_SCRIPT_TOOLS.includes(event.toolName)) return
    reconcile()
  })
  pi.on('session_shutdown', () => {
    for (const name of Array.from(registered.keys())) {
      registered.delete(name)
      try {
        pi.unregisterMcpServer(name)
      } catch {
        // The session is ending; pi closes whatever is left.
      }
    }
  })
}
`
}
