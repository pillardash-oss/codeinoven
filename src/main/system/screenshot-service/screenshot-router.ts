import type { ScreenshotCaptureOutcome } from '../../../lib/types'

/**
 * Which instance answers a region-screenshot chord.
 *
 * The chord is claimed system-wide, so exactly one process holds it, and that
 * process is not necessarily the one the user is working in: open two instances
 * and the first to claim the shortcut keeps it for its whole life. A capture
 * delivered to it would land in a window the user is not looking at, and the
 * delivery would depend on whether *that* window happened to have a prompt open.
 *
 * So holding the chord and taking the capture are separated here. The holder asks
 * the instance the user is looking at to take the capture, and only takes it
 * itself when nobody else can be named or reached. Nothing in this decision looks
 * at threads or composers: the window the user is in answers, whether or not a
 * prompt is open in it.
 *
 * Pure logic over an injected host and an injected request source, so the decision
 * can be checked without an Electron window, a registry or a socket.
 */

/** How a capture started by the chord reaches the window that should answer it. */
export interface ScreenshotRoutingHost {
  /** This process, so the host's own window can be recognised as the target. */
  localPid: number
  /** The instance the user is looking at, or null when no instance ever was. */
  focusedInstancePid(): number | null
  /** Ask another instance to take the capture; false when it cannot be reached. */
  requestRemoteCapture(targetPid: number): boolean
  /** Take the capture in this process. */
  captureLocally(): Promise<ScreenshotCaptureOutcome>
}

/** One screenshot request a sibling addressed to an instance. */
export interface ScreenshotRequest {
  requestId: string
  targetPid: number
  emittedAt: number
}

/** Where sibling requests come from, and how to stop listening. */
export type ScreenshotRequestSource = (listener: (request: ScreenshotRequest) => void) => () => void

/** A request older than this describes a chord nobody is still waiting on. */
const REQUEST_STALE_MS = 10_000
/** Requests already answered, so a repeat can never start a second selector. */
const MAX_SEEN_REQUESTS = 64

/**
 * Take the region screenshot the chord started, in the window the user is in.
 *
 * A capture taken here is the fallback, not the rule: when the focused instance
 * cannot be named (nobody has ever focused one) or reached (its link is still
 * forming), responding in the wrong window is still better than a chord that does
 * nothing, which is what the user would otherwise be left with.
 */
export function routeScreenshotCapture(host: ScreenshotRoutingHost): void {
  const target = host.focusedInstancePid()
  if (target === null || target === host.localPid) {
    void host.captureLocally()
    return
  }
  if (host.requestRemoteCapture(target)) return
  void host.captureLocally()
}

/**
 * Answer the screenshot requests siblings address to this instance.
 *
 * Only the addressed process acts: the caller chose it from the shared focus
 * record, and a second instance opening its own selector would capture the same
 * region twice and deliver it into two different prompts.
 */
export function installScreenshotRequests(
  host: ScreenshotRoutingHost,
  source: ScreenshotRequestSource
): () => void {
  const seen = new Set<string>()
  return source((request) => {
    if (request.targetPid !== host.localPid) return
    if (Date.now() - request.emittedAt > REQUEST_STALE_MS) return
    if (!markSeen(seen, request.requestId)) return
    void host.captureLocally()
  })
}

/** Whether this request is the first sighting of it, keeping the set bounded. */
function markSeen(seen: Set<string>, requestId: string): boolean {
  if (seen.has(requestId)) return false
  seen.add(requestId)
  if (seen.size > MAX_SEEN_REQUESTS) {
    const oldest = seen.values().next().value
    if (oldest) seen.delete(oldest)
  }
  return true
}
