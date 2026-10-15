/**
 * Generated TypeScript source for the app-owned Pi script-surface extension.
 *
 * Pi's script runner is registered inactive and activated only when an MCP
 * server of pi's own asks for that exposure. CodeInOven's MCP servers never
 * register on pi's host   they run behind the app-owned gateway, which is the
 * one transport for every harness   so without this extension a session would
 * have no way to script at all, even though the gateway's own tools are
 * scriptable and a utility activated mid-session has to be reachable from the
 * script that follows it.
 *
 * The surface is therefore activated here, once per session start and before
 * every agent start, and never turned off. A runtime that never registered the
 * tool (a build without the built-in script extension) is left alone.
 */

export function piCodemodeExtension(): string {
  return `import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

/** Pi's script runner. Registered inactive, so this extension activates it. */
const CIO_SCRIPT_SURFACE = 'codemode'

/**
 * Keep pi's script runner available for this session.
 *
 * Pi leaves it inactive until an MCP server with \`codemode\` exposure connects,
 * which is later than the app needs it: the gateway's own operations are
 * scriptable, and a utility activated mid-session must be reachable from the
 * script that follows it. A runtime that never registered the tool is left
 * alone.
 */
function ensureCioScriptSurface(pi: ExtensionAPI): void {
  if (typeof pi.getAllTools !== 'function') return
  const registered = pi.getAllTools().some((tool) => tool && tool.name === CIO_SCRIPT_SURFACE)
  if (!registered) return
  const active = pi.getActiveTools()
  if (active.includes(CIO_SCRIPT_SURFACE)) return
  pi.setActiveTools([...active, CIO_SCRIPT_SURFACE])
}

export default function codeInOvenCodemodeExtension(pi: ExtensionAPI): void {
  pi.on('session_start', () => {
    ensureCioScriptSurface(pi)
  })
  pi.on('before_agent_start', () => {
    ensureCioScriptSurface(pi)
  })
}
`
}
