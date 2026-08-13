/**
 * Bridge between the main-process event sources (chat engine, thread updates,
 * provider status) and any live remote phone peer.
 *
 * The desktop broadcasts `agent:event`, `thread:updated`, and
 * `providers:status` to its renderer windows. The phone client needs the same
 * live stream over the WebSocket bridge, so these module-level sinks let the
 * remote-mode controller register a forwarder that the sources call alongside
 * their window broadcast.
 */

export type RemoteEventForwarder = (channel: string, payload: unknown) => void

let forwarder: RemoteEventForwarder | null = null

/** Register the forwarder used by the live remote peer (or null to unregister). */
export function setRemoteEventForwarder(next: RemoteEventForwarder | null): void {
  forwarder = next
}

/** Forward a main-process event to the remote peer, if one is live. */
export function forwardRemoteEvent(channel: string, payload: unknown): void {
  try {
    forwarder?.(channel, payload)
  } catch {
    // A failed forward must never break the desktop event path.
  }
}
