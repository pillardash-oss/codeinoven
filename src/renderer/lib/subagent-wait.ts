import type { AgentMessage, AgentPart } from '$shared/types'
import {
  CIO_AGENT_OUTPUT_TOOL_NAME,
  CIO_AGENT_STATUS_TOOL_NAME,
  CIO_SPAWN_AGENT_TOOL_NAME
} from '$shared/core-tools'

/**
 * Whether a turn is standing still on delegated work.
 *
 * A running turn is normally producing work of its own, and the row says so
 * with a climbing spine. One tool call changes that: while the agent awaits a
 * worker, the parent is not producing anything until the worker reports. The
 * spine has to stop climbing and say what it is waiting for, or a thread that
 * is idle behind a worker looks identical to a thread that is thinking.
 *
 * Three calls hold the parent:
 *
 * - an inline `cio_spawn_agent`, which does not return until its worker is
 *   done. A background spawn returns immediately, so it is not a wait.
 * - `cio_agent_status` with `wait: true`, which blocks until the running
 *   workers finish.
 * - `cio_agent_output` with `wait: true`, which blocks until the requested
 *   workers finish.
 *
 * A blocking call is only a wait while it is still in flight. The moment its
 * part settles, the parent is doing something again and the ordinary working
 * mark is the truth.
 */

/** True while a tool part is still in flight: pending or running. */
function toolPartIsActive(part: Extract<AgentPart, { type: 'tool' }>): boolean {
  return part.state.status === 'pending' || part.state.status === 'running'
}

/**
 * Whether this one part is a blocking sub-agent call that has not returned.
 *
 * Two shapes report the same wait. A spawn call renders as a sub-agent card, so
 * an inline worker's card stays live for as long as the parent is waiting on
 * it; a background worker's card is live too, but its parent moved on, so
 * `activity.background` is what separates the two. The status and output tools
 * stay ordinary tool parts, and only their `wait: true` form blocks.
 *
 * A tool that is not a sub-agent call is not a wait at all.
 */
export function partWaitsOnSubagents(part: AgentPart): boolean {
  if (part.type === 'subagent') {
    return (
      part.activity.background !== true &&
      (part.activity.status === 'pending' || part.activity.status === 'running')
    )
  }
  if (part.type !== 'tool') return false
  if (part.tool === CIO_SPAWN_AGENT_TOOL_NAME) {
    return part.state.input['background'] !== true && toolPartIsActive(part)
  }
  if (part.tool === CIO_AGENT_STATUS_TOOL_NAME || part.tool === CIO_AGENT_OUTPUT_TOOL_NAME) {
    return part.state.input['wait'] === true && toolPartIsActive(part)
  }
  return false
}

/**
 * Whether the turn that owns these messages is currently blocked on a worker.
 *
 * Only the current turn counts: the walk goes backwards and stops at its user
 * message, because a settled turn cannot be waiting on anything, and a blocking
 * part left behind it by a crash must not paint a later turn as waiting. A
 * transcript with no user message loaded yet (a cold page of a long turn) is
 * still scanned, and only in-flight parts answer true, so an old settled trace
 * never does.
 */
export function turnWaitsOnSubagents(messages: readonly AgentMessage[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    // A steer is a user-role row inside the running turn, not a new turn, so the
    // walk passes through it the way the trace does.
    if (message.role === 'user' && message.turnTransparent !== true) return false
    if (message.parts.some(partWaitsOnSubagents)) return true
  }
  return false
}
