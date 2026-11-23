/**
 * How long a parked browser page stays awake when this machine is short.
 *
 * A browser tab that is not on screen is not closed: it is parked in the app's
 * invisible stage window, which is what keeps its real viewport, its
 * `requestAnimationFrame` and therefore its capturability for an agent (see
 * `browser-stage.ts`). The price is that a parked page keeps producing frames,
 * so a page that paints continuously — a video, an animated dashboard, a chat
 * that never goes quiet — keeps costing a share of a core while the user is
 * looking at something else entirely.
 *
 * Measured on this workstation with a paint-heavy page parked exactly the way
 * the stage parks it: the renderer held 9.3% of a core while parked. Electron's
 * `setFrameRate` is not a lever here — it does not throttle a view attached to a
 * shown window (9.3% before the call, 8.3% after, frames still flowing), so the
 * only honest way to stop that work is to release the page, which is what the
 * idle sweep already does.
 *
 * The sweep's window is the user's setting, and it is generous by design: thirty
 * minutes of instant back-navigation is worth having on an idle machine. On a
 * machine that is short of CPU or memory — thirty-odd agent and build processes
 * is a normal busy day here — it is not worth having at any price the user can
 * feel, because every frame a parked page paints is a frame the app they are
 * actually looking at does not get.
 *
 * So while the device reports itself short, the window shortens to
 * {@link PRESSURE_HIBERNATION_WINDOW_MS}. The page still comes back with one
 * tab click and a reload; nothing about the strip, its title, its icon or its
 * address changes.
 */

import { invoke } from '$lib/ipc.svelte'

/** The idle window a parked page gets while this machine is short. */
export const PRESSURE_HIBERNATION_WINDOW_MS = 2 * 60_000

/** How long one device reading is reused before another is asked for. */
const READING_TTL_MS = 60_000

/**
 * The idle window to use right now.
 *
 * Only ever shorter than the configured window: a user who asked for pages to
 * sleep sooner than {@link PRESSURE_HIBERNATION_WINDOW_MS} keeps their answer.
 */
export function effectiveHibernationWindowMs(configuredMs: number, deviceShort: boolean): number {
  const configured = Number.isFinite(configuredMs) ? Math.max(0, configuredMs) : 0
  if (!deviceShort) return configured
  return Math.min(configured, PRESSURE_HIBERNATION_WINDOW_MS)
}

/** The last device reading, and when it was taken. */
let lastReading = { at: 0, short: false }

/** Whether the last reading said this machine is short on CPU or memory. */
export function deviceIsShortCached(): boolean {
  return lastReading.short
}

/**
 * Refresh the device reading, at most once a minute.
 *
 * Callers pass whether there is a parked page whose fate the answer could
 * change. Without one the question is not worth asking, and the reading stays
 * silent, which is what keeps the pressure sampler off a quiet machine: it only
 * runs while somebody is asking it.
 */
export async function refreshDeviceIsShort(hasAwakePage: boolean): Promise<boolean> {
  if (!hasAwakePage) return lastReading.short
  const now = Date.now()
  if (now - lastReading.at < READING_TTL_MS) return lastReading.short
  try {
    const decision = await invoke('system:resourceAdmission')
    lastReading = { at: Date.now(), short: decision.action !== 'proceed' }
  } catch {
    // A reading that cannot be taken is not a reason to shorten a user's window.
    lastReading = { at: Date.now(), short: false }
  }
  return lastReading.short
}

/** Test seam: forget the cached reading. */
export function resetDeviceShortReading(): void {
  lastReading = { at: 0, short: false }
}
