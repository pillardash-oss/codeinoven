/**
 * How long to wait before capturing a mirrored device again.
 *
 * The cadence has one job: keep a mirror worth looking at without spending the
 * machine on a source that cannot keep up. Two things went wrong when it was
 * "target interval minus the time the capture took, floored at 250 ms":
 *
 * 1. A source slower than its target was captured back to back forever. On a
 *    loaded machine an iOS simulator screenshot went from 422 ms to 1429, 2632,
 *    3931 and 6987 ms while the loop kept re-arming 250 ms later, so the panel
 *    spent most of every wall-clock second inside a `simctl` child process and
 *    held the simulator's render service busy in between. That is a loop that
 *    eats the CPU it is competing with, and it gets worse the more loaded the
 *    machine is.
 * 2. Nothing stretched the cadence when the machine was short, so a mirror kept
 *    paying for frames at the exact moment the app the user was looking at
 *    needed the CPU more.
 *
 * So a frame that cost more than its own target earns at least its own cost as a
 * gap: a source can never take more than half the wall clock, whatever the load.
 * While the device is short the target itself stretches.
 */

/** Smallest gap between two captures of one session. */
export const MIN_CAPTURE_GAP_MS = 250

/** The cadence a source drops to while this machine is short. */
export const PRESSURE_INTERVAL_MS = 3_000

export interface CaptureCadenceInput {
  /** The source's normal interval, from what one of its frames costs. */
  targetIntervalMs: number
  /** How long the capture that just finished took. */
  captureMs: number
  /** How long ago the tick that produced it started. */
  elapsedMs: number
  /** Whether this machine currently reports itself short on CPU or memory. */
  deviceShort: boolean
}

/**
 * The wait before the next capture.
 *
 * At least the target interval is kept as a period, the pressure interval while
 * the device is short, and a capture slower than its own target is followed by a
 * gap of its own length so a slow source settles at no more than half the wall
 * clock instead of hammering the device it is mirroring.
 */
export function nextCaptureDelayMs(input: CaptureCadenceInput): number {
  const target = input.deviceShort
    ? Math.max(input.targetIntervalMs, PRESSURE_INTERVAL_MS)
    : input.targetIntervalMs
  const toKeepThePeriod = target - input.elapsedMs
  const slowSourceGap = input.captureMs > target ? input.captureMs : 0
  return Math.max(MIN_CAPTURE_GAP_MS, toKeepThePeriod, slowSourceGap)
}
