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
 * registration set against it. Reconciles happen at session start, before every
 * agent start, before a script surface runs, and immediately after a gateway
 * call that can change the set, so a utility activated mid-session is connected
 * inside the running process: nothing here ever needs a restart, and a script
 * that follows the activation can call the server natively. The document's
 * revision is cached, so a reconcile costs one `stat` until the app rewrites it.
 * `session_shutdown` unregisters everything, so pi closes the servers' child
 * processes with the session.
 *
 * This extension also owns the script surface itself. Pi registers `codemode`
 * inactive and activates it only when an MCP server of its own asks for that
 * exposure, which would leave a thread that has activated no server with no way
 * to script at all   including the app's own gateway tools, which are scriptable
 * whether or not any MCP server exists. The surface is therefore activated here,
 * once, and never turned off.
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

export interface PiMcpServersExtensionOptions {
  /**
   * Gateway tool names whose call can change the activated set   activation and
   * management. Reconciling right after one of them is what makes a utility
   * activated mid-session reachable from the running process, instead of
   * waiting for the next turn.
   */
  activationTools: readonly string[]
}

/**
 * Status key the extension reports a refused registration under.
 *
 * The driver reads it on the same `extension_ui_request` channel the status and
 * usage extensions use, so a server pi would not run becomes a notice in the
 * app instead of a line on a stderr nobody reads.
 */
export const PI_MCP_FAILURE_STATUS_KEY = 'codeinoven-mcp'

export function piMcpServersExtension(options: PiMcpServersExtensionOptions): string {
  const reconcileTools = JSON.stringify([
    'codemode',
    'tool_search',
    ...options.activationTools.filter((name) => name !== 'codemode' && name !== 'tool_search')
  ])
  return `import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { readFileSync, statSync } from 'node:fs'

/** Absolute path of the per-session MCP server document the driver rewrites. */
const CIO_MCP_SERVERS_PATH = '__CIO_MCP_SERVERS_PATH__'

/** Document revision this extension understands. */
const CIO_MCP_SERVERS_VERSION = 1

/**
 * Tool calls worth a reconcile: the script surfaces, whose tool table is built
 * from the registrations at that moment, and the gateway calls that rewrite the
 * document. Any other call cannot change or read the registration set.
 */
const CIO_MCP_RECONCILE_TOOLS = ${reconcileTools}

/** Pi's script runner. Registered inactive, so this extension activates it. */
const CIO_MCP_SCRIPT_SURFACE = 'codemode'

/** Status key the app reads a refused registration from. */
const CIO_MCP_FAILURE_STATUS_KEY = '${PI_MCP_FAILURE_STATUS_KEY}'

/**
 * Report a server pi refused through the app-owned status channel, so the user
 * hears about it while the session that tried to register it is still alive.
 * The reason is pi's own; the stderr line stays as the fallback for a runtime
 * whose status channel is unavailable.
 */
function reportCioMcpRegistrationFailure(ctx, name, error) {
  try {
    ctx?.ui?.setStatus(
      CIO_MCP_FAILURE_STATUS_KEY,
      JSON.stringify({
        failures: [
          { name: name, reason: error instanceof Error ? error.message : String(error) }
        ]
      })
    )
  } catch {
    // A runtime without the status channel still has the stderr line.
  }
}

interface CioMcpServerEntry {
  name: string
  config: Record<string, unknown>
}

/** One server this session registered, keyed by name, with the config it used. */
type CioMcpRegistered = Map<string, string>

/** What the last reconcile saw, so an unchanged document costs one stat. */
interface CioMcpRevision {
  value: string
}

/**
 * The document's revision, or null when there is no document to read. A missing
 * or unreadable file means "no instruction" rather than "no servers": a turn
 * that never published must not tear down servers a previous turn started.
 */
function readCioMcpRevision(): string | null {
  try {
    const info = statSync(CIO_MCP_SERVERS_PATH)
    return String(info.mtimeMs) + ':' + String(info.size)
  } catch {
    return null
  }
}

/**
 * Read the document. Null means the file is gone, half-written, or written by a
 * revision this extension does not know, and the previous registrations stay in
 * force until the next publication heals it.
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
 * Keep pi's script runner available for this session.
 *
 * Pi leaves it inactive until an MCP server with \`codemode\` exposure connects,
 * which is later than the app needs it: the gateway's own operations are
 * scriptable, and a utility activated mid-session must be reachable from the
 * script that follows it. A runtime that never registered the tool (a build
 * without the built-in codemode extension) is left alone.
 */
function ensureCioScriptSurface(pi: ExtensionAPI): void {
  if (typeof pi.getAllTools !== 'function') return
  const registered = pi.getAllTools().some((tool) => tool && tool.name === CIO_MCP_SCRIPT_SURFACE)
  if (!registered) return
  const active = pi.getActiveTools()
  if (active.includes(CIO_MCP_SCRIPT_SURFACE)) return
  pi.setActiveTools([...active, CIO_MCP_SCRIPT_SURFACE])
}

/**
 * Bring pi's registration set in line with the document: register a server that
 * is new or whose config changed, unregister one the app no longer publishes.
 * The registered map is the only record of what this extension owns, so a
 * server somebody else registered is never touched.
 */
function reconcileCioMcpServers(
  pi: ExtensionAPI,
  ctx,
  registered: CioMcpRegistered,
  revision: CioMcpRevision
): void {
  if (typeof pi.registerMcpServer !== 'function' || typeof pi.unregisterMcpServer !== 'function') {
    return
  }
  const current = readCioMcpRevision()
  if (current === null) return
  if (current === revision.value) return
  const servers = readCioMcpServers()
  if (servers === null) return
  revision.value = current
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
      revision.value = ''
      reportCioMcpRegistrationFailure(ctx, name, error)
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
  const revision: CioMcpRevision = { value: '' }
  const reconcile = (ctx): void => reconcileCioMcpServers(pi, ctx, registered, revision)

  pi.on('session_start', (event, ctx) => {
    ensureCioScriptSurface(pi)
    reconcile(ctx)
  })
  pi.on('before_agent_start', (event, ctx) => {
    ensureCioScriptSurface(pi)
    reconcile(ctx)
  })
  pi.on('tool_call', (event, ctx) => {
    if (!CIO_MCP_RECONCILE_TOOLS.includes(event.toolName)) return
    reconcile(ctx)
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
