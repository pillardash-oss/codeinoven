/**
 * Tracking for calls the harness's own MCP host runs.
 *
 * A native MCP call never passes the app gateway, so the app sees neither its
 * traffic nor its end: the only evidence is the tool part the harness fold
 * attributes to a utility. Everything upstream of it is bounded already (pi
 * caps one request at `PI_MCP_REQUEST_TIMEOUT_SECONDS`, and the gateway caps a
 * call at `MCP_TIMEOUT_MS`), so a native call still open minutes later is a
 * wedged host, not slow work. This window is what lets the chat-engine
 * watchdog end that wait instead of extending the silence window by half an
 * hour, which is how one wedged svelte-autofixer call burned a whole audit run.
 */

import type { AgentPart } from '../../../lib/types'

/** Identity of one native MCP call, read from the tool part's attribution. */
export interface NativeMcpCallIdentity {
  utilityName?: string
  server: string
  tool: string
}

/** One native call the app has seen start and not yet seen settle. */
export interface OpenNativeMcpCall extends NativeMcpCallIdentity {
  /** When the app first saw the call running. */
  startedAt: number
}

type ToolPart = Extract<AgentPart, { type: 'tool' }>

/**
 * The utility a tool part belongs to, or null when the call went through the
 * app gateway, or is not an MCP call at all.
 *
 * The fold writes this attribution only for calls a harness's own MCP host
 * ran, so it is exactly the set the gateway's own timeout does not cover.
 */
export function nativeMcpCallIdentity(part: ToolPart): NativeMcpCallIdentity | null {
  const metadata = part.state.metadata
  if (!metadata) return null
  const server = metadata['server']
  const tool = metadata['tool']
  if (typeof server !== 'string' || server.length === 0) return null
  if (typeof tool !== 'string' || tool.length === 0) return null
  const utilityName = metadata['utilityName']
  return {
    server,
    tool,
    ...(typeof utilityName === 'string' && utilityName.length > 0 ? { utilityName } : {})
  }
}

/** Add a running native call to the window, or drop it once it settled. */
export function trackNativeMcpCall(
  calls: Map<string, OpenNativeMcpCall>,
  part: ToolPart,
  now: number
): void {
  const identity = nativeMcpCallIdentity(part)
  if (!identity) return
  const status = part.state.status
  if (status === 'pending' || status === 'running') {
    if (!calls.has(part.id)) calls.set(part.id, { ...identity, startedAt: now })
    return
  }
  calls.delete(part.id)
}

/**
 * The first open native call that overran the ceiling, or null while every one
 * of them is still within it.
 */
export function overdueNativeMcpCall(
  calls: Map<string, OpenNativeMcpCall>,
  now: number,
  ceilingMs: number
): OpenNativeMcpCall | null {
  for (const call of calls.values()) {
    if (now - call.startedAt >= ceilingMs) return call
  }
  return null
}

/** How a user-facing message names a wedged call. */
export function describeNativeMcpCall(call: OpenNativeMcpCall): string {
  return call.utilityName ? `${call.utilityName} (${call.tool})` : `${call.server}/${call.tool}`
}
