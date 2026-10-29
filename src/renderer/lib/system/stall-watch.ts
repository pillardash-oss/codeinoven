import { logRendererDev } from './renderer-logger'

/**
 * Dev-only reporters for the two ways the reader loses the window.
 *
 * A stall can come from this process doing work (a long task) or from frames
 * never arriving (the compositor waiting on something else, often the main
 * process), and the two look identical from the outside while needing opposite
 * fixes. Both are forwarded to the durable log through the renderer bridge, so a
 * report of "the window stopped responding" is answered with numbers instead of
 * another guess.
 *
 * Off in a shipped build: this is a diagnostic, not a feature.
 */
const LONG_TASK_MS = 100
const FRAME_GAP_MS = 120

/** Report main-thread work that took a visible amount of time. */
function watchLongTasks(): void {
  if (typeof PerformanceObserver === 'undefined') return
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration < LONG_TASK_MS) continue
        logRendererDev(
          `main thread busy ${Math.round(entry.duration)}ms at ${Math.round(entry.startTime)}ms`
        )
      }
    }).observe({ type: 'longtask' })
  } catch {
    // An entry type this runtime does not support must never break the app.
  }
}

/**
 * Report a gap between frames.
 *
 * Reported separately from a long task on purpose: a gap with no long task is
 * the signature of a stall outside this process, and a gap that overlaps one is
 * this process holding the thread.
 */
function watchFrameGaps(): void {
  let previous = performance.now()
  const tick = (now: number): void => {
    const gap = now - previous
    previous = now
    if (gap >= FRAME_GAP_MS) {
      logRendererDev(`frame gap ${Math.round(gap)}ms at ${Math.round(now)}ms`)
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

export function installStallWatch(): void {
  if (!import.meta.env.DEV) return
  watchLongTasks()
  watchFrameGaps()
}
