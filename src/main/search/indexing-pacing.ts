import { setTimeout as delay } from 'node:timers/promises'

/**
 * Pause between two indexed threads.
 *
 * A thread costs seconds of single-threaded, lowest-priority work, so the pause
 * is a duty cycle rather than a cooldown: half the time measured, floored so a
 * fast thread still yields, and capped so one slow thread cannot park the whole
 * sweep. The previous rule (`workMs * 99`, floored at 30s, capped at 10 min)
 * paused for minutes per thread, which left an incremental sweep - and with it
 * every semantic query, see `SearchService.searchIntent` - busy for hours.
 */
const MAX_PAUSE_MS = 2_000
const MIN_PAUSE_MS = 150

export async function paceIndexing(startedAt: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const workMs = Math.max(0, performance.now() - startedAt)
  await delay(Math.min(MAX_PAUSE_MS, Math.max(MIN_PAUSE_MS, Math.round(workMs / 2))), undefined, {
    signal
  })
}
