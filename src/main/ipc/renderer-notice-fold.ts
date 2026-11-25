import { Logger } from '../system/logger'

/**
 * Collapse a burst of identical engine notices into one line and a count.
 *
 * Chromium raises "ResizeObserver loop completed with undelivered notifications"
 * from ordinary layout, and a layout loop that does not settle emits it every
 * frame: one real burst on 2026-11-25 wrote 1,293 identical records in 34 seconds,
 * which buried everything else in `main.jsonl` and filled the dev terminal.
 *
 * The classification in `lib/renderer-error-classification` already keeps these
 * out of `error.log` and off the Errors panel. That leaves the diagnostic record,
 * which is worth keeping but not once per frame: the first notice of a burst is
 * written as it arrives, the rest are counted, and when the burst has been quiet
 * for `NOTICE_BURST_QUIET_MS` one line states the total and how long it ran.
 *
 * The fold is per message, so two different notices never mask each other, and it
 * is only ever applied to classified engine notices: a real app failure still
 * writes every occurrence.
 */

/** How long one message must stay quiet before its burst is closed with a count. */
export const NOTICE_BURST_QUIET_MS = 10_000

interface NoticeBurst {
  /** Log prefix the first notice used, repeated on the summary for grepping. */
  prefix: string
  /** Notices seen in this burst, including the one already written. */
  count: number
  /** When the burst started, so the summary can state how long it ran. */
  firstAt: number
  /** When the last notice of the burst arrived, so the summary states the real span. */
  lastAt: number
  /** Fires once the burst has been quiet for `NOTICE_BURST_QUIET_MS`. */
  timer: ReturnType<typeof setTimeout>
}

const bursts = new Map<string, NoticeBurst>()

/** Readable duration for a summary line: seconds under a minute, then minutes. */
function describeDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`
}

/** Write one burst's total, which is all a reader needs besides the first line. */
function writeSummary(message: string, burst: NoticeBurst): void {
  if (burst.count <= 1) return
  const lasted = describeDuration(burst.lastAt - burst.firstAt)
  Logger.dev(burst.prefix, `${message} (${burst.count} identical notices over ${lasted})`)
}

function closeBurst(message: string): void {
  const burst = bursts.get(message)
  if (!burst) return
  bursts.delete(message)
  writeSummary(message, burst)
}

function scheduleClose(message: string): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => closeBurst(message), NOTICE_BURST_QUIET_MS)
  // The timer only closes a count; it must never be the reason the app stays alive.
  timer.unref?.()
  return timer
}

/**
 * Record one classified engine notice: the first of a burst is written, the rest
 * are folded into a single summary line once the burst goes quiet.
 */
export function logEngineNotice(prefix: string, message: string): void {
  const existing = bursts.get(message)
  if (existing) {
    existing.count += 1
    existing.lastAt = Date.now()
    clearTimeout(existing.timer)
    existing.timer = scheduleClose(message)
    return
  }
  const now = Date.now()
  bursts.set(message, {
    prefix,
    count: 1,
    firstAt: now,
    lastAt: now,
    timer: scheduleClose(message)
  })
  Logger.dev(prefix, message)
}

/** Write the counts of every open burst immediately, without waiting for quiet. */
export function flushEngineNoticeBursts(): void {
  for (const [message, burst] of bursts) {
    clearTimeout(burst.timer)
    writeSummary(message, burst)
  }
  bursts.clear()
}
