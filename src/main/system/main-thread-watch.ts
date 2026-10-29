import { monitorEventLoopDelay } from 'node:perf_hooks'
import { isShippedBuild } from '../bootstrap/app-resources'
import { Logger } from './logger'

/**
 * Dev-only report of the main process holding its thread.
 *
 * A macOS window stops responding when the browser process blocks, and this
 * process is where the app does its file, database-worker and IPC routing. The
 * histogram costs one timer per second and reports only when something actually
 * stalled, so a reproduction of "the window froze" lands in the log with a
 * duration instead of leaving a guess behind.
 */
const STALL_MS = 120
const SAMPLE_WINDOW_MS = 1_000
const NANOSECONDS_PER_MILLISECOND = 1e6

export function installMainThreadWatch(): void {
  if (isShippedBuild()) return
  const histogram = monitorEventLoopDelay({ resolution: 20 })
  histogram.enable()
  const timer = setInterval(() => {
    const maxMs = Math.round(histogram.max / NANOSECONDS_PER_MILLISECOND)
    histogram.reset()
    if (maxMs < STALL_MS) return
    Logger.dev('Main thread stalled', { maxMs })
  }, SAMPLE_WINDOW_MS)
  timer.unref()
}
