/**
 * A short lease on the Cua driver's per-window snapshot slot, held by whoever is
 * about to act on that window and honoured by the app's own computer-use preview.
 *
 * The driver keeps one snapshot per window: a snapshot carries the screenshot and
 * the element map an action addresses, the next snapshot of that window replaces
 * it, and an action whose reference was replaced is refused. Anything that
 * photographs the window therefore invalidates whatever another client was about
 * to act on, measured directly: after another client's snapshot, the first
 * client's zoom reports `screenshot_context_missing` until it snapshots again.
 *
 * The app is several of those clients. The computer-use preview photographs the
 * window a run is driving at up to 15 frames a second to show the work, and every
 * thread driving computer use has its own gateway turn. So when a gateway has to
 * take a fresh snapshot and act on it   because the reference the model read was
 * superseded   its own preview, or another thread's gateway, would otherwise be
 * free to take that snapshot's place in the milliseconds between the two.
 *
 * The lease is per window and short (one snapshot plus one action). The preview
 * asks before each frame and simply waits a tick, so it loses at most one frame,
 * and a lease that is never released expires on its own within a few seconds   a
 * gateway that throws between its snapshot and its action cannot stall the
 * preview or another turn.
 */

import { setTimeout as delay } from 'node:timers/promises'

/** How long a lease is honoured without being released. No in-process pairing
 *  needs longer than this, and it is the ceiling that keeps a crashed holder
 *  from freezing the preview. */
const LEASE_TTL_MS = 5_000

/** How long a second actor waits for a busy window before taking its own lease
 *  anyway: an action is never blocked for ever by another turn's bookkeeping. */
const DEFAULT_WAIT_MS = 1_000

/** How often a waiting actor re-checks the window. */
const WAIT_STEP_MS = 10

interface Lease {
  token: symbol
  until: number
}

const leases = new Map<string, Lease>()

/** The lease key for one window, matching the gateway's own per-window
 *  bookkeeping. */
function leaseKey(pid: number, windowId: number): string {
  return `${pid}:${windowId}`
}

/** The live lease of one window, pruning one that has expired. */
function activeLease(key: string): Lease | null {
  const lease = leases.get(key)
  if (!lease) return null
  if (lease.until <= Date.now()) {
    leases.delete(key)
    return null
  }
  return lease
}

/**
 * Take the lease for one window and return the release. Waits for a lease that
 * is still live, briefly, then takes the window anyway: a stale holder must not
 * be able to fail the action that is waiting on it.
 */
export async function acquireCuaSnapshotLease(
  pid: number,
  windowId: number,
  waitMs = DEFAULT_WAIT_MS
): Promise<() => void> {
  const key = leaseKey(pid, windowId)
  const deadline = Date.now() + waitMs
  while (activeLease(key) && Date.now() < deadline) {
    await delay(WAIT_STEP_MS)
  }
  const token = Symbol(key)
  leases.set(key, { token, until: Date.now() + LEASE_TTL_MS })
  return () => {
    // Only the holder that still owns the window may release it: a waiter that
    // took over an expired lease must not have its own lease deleted by the
    // previous holder's late release.
    if (leases.get(key)?.token === token) leases.delete(key)
  }
}

/**
 * Whether something is about to act on this window from a snapshot it took
 * itself. A held window is one whose next snapshot would take the slot out from
 * under a live action, so a frame for it is simply skipped.
 */
export function cuaSnapshotLeased(pid: number, windowId: number): boolean {
  return activeLease(leaseKey(pid, windowId)) !== null
}
