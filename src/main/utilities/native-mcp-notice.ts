import type { NativeMcpServerFailure } from '../../lib/types'
import { broadcastAppToast } from '../ipc/app-toast'
import { Logger } from '../system/logger'

/**
 * Telling the user that a capability they enabled did not reach the harness.
 *
 * A thread's activated MCP servers normally run on the harness's own MCP host,
 * which is the transport that hands a codemode script a tool's whole
 * `CallToolResult`. When that fails the app gateway still serves the utility,
 * so the turn works and nothing else would say a word: the harness reports the
 * refusal on its own stderr, and the app-side validation failure only ever
 * reached the dev log. Both are silent to the person who enabled the utility,
 * so both arrive here.
 */
export function notifyNativeMcpFailure(
  failure: NativeMcpServerFailure,
  context: { projectId?: string; threadId?: string } = {}
): void {
  Logger.error('Native MCP server registration failed:', {
    sessionId: failure.sessionId,
    utilityId: failure.utilityId,
    server: failure.server,
    reason: failure.reason
  })
  broadcastAppToast({
    message: nativeMcpFailureMessage(failure),
    type: 'error',
    ...(context.projectId ? { projectId: context.projectId } : {}),
    ...(context.threadId ? { threadId: context.threadId } : {})
  })
}

/**
 * The sentence the user reads. It names the utility when the app got far enough
 * to know one, and always says what still works, because a toast that only
 * reports a failure sends someone looking for a broken thread that is not
 * broken.
 */
export function nativeMcpFailureMessage(failure: NativeMcpServerFailure): string {
  const label = failure.utilityName
    ? `"${failure.utilityName}"${failure.server ? ` (${failure.server})` : ''}`
    : failure.server
      ? `"${failure.server}"`
      : 'an MCP server'
  return `Pi would not run ${label} on its own MCP host: ${failure.reason} The utility gateway still serves it.`
}
