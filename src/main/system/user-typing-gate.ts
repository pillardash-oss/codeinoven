/**
 * Whether the person at this keyboard is typing, for work that is not worth a
 * stutter.
 *
 * A finishing thread starts background work all over the app: an auto-title
 * one-shot, a memory proposal, a search summary, an embedding sweep. Each of
 * those boots a harness process or runs a CPU-bound embedding pass, and the doc
 * beside `SpawnAdmission` already measures what a background one-shot costs on
 * this machine — "5.4 s to come up while four background one-shot sessions were
 * spawned beside it, against 1.5 s on an idle machine".
 *
 * Measured from this app's own log, one busy hour produced 60 auto-title calls,
 * 73 memory proposals and 182 search summaries. None of them is urgent, all of
 * them compete with the frame the user is typing into, and the reported symptom is
 * exactly that shape: typing stutters when a thread the user is not even looking
 * at settles, because the settle is what starts them.
 *
 * So background work asks this first and starts on the first quiet moment. A
 * keystroke is worth more than a title, and nothing here waits forever: an answer
 * is always delivered within `TYPING_QUIET_MAX_MS` of asking.
 */

/** How long after a keystroke the user still counts as typing. Matches the
 *  renderer's own window, so both halves of the app agree about the same moment. */
export const TYPING_WINDOW_MS = 250

/**
 * The longest background work may be held back. A user who types without pause
 * still gets titles and summaries; they simply arrive a few seconds later than a
 * user who has stepped away from the keyboard.
 */
export const TYPING_QUIET_MAX_MS = 4_000

/** How often a held caller re-checks the keyboard. */
const RECHECK_MS = 200

/** Never a real timestamp: "has never typed" must not read as "typing now". */
const NEVER = Number.NEGATIVE_INFINITY

let lastTypingAt = NEVER

/** Note one keystroke reported by the window that saw it. */
export function noteUserTyping(now: number = Date.now()): void {
  lastTypingAt = now
}

/** Whether the user is at the keyboard right now. */
export function isUserTyping(now: number = Date.now()): boolean {
  return now - lastTypingAt < TYPING_WINDOW_MS
}

/** Test seam: forget any keystroke. */
export function resetUserTyping(): void {
  lastTypingAt = NEVER
}

/**
 * Resolve once the keyboard has been quiet for {@link TYPING_WINDOW_MS}, or once
 * `maxWaitMs` has passed, whichever comes first.
 *
 * Callers await this before starting work nobody is waiting for. It never
 * rejects and never holds past its ceiling, so a background job can be delayed
 * but can never be starved by a user who keeps typing.
 */
export function whenUserQuiet(maxWaitMs: number = TYPING_QUIET_MAX_MS): Promise<void> {
  const deadline = Date.now() + Math.max(0, maxWaitMs)
  if (!isUserTyping() || Date.now() >= deadline) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const attempt = (): void => {
      if (!isUserTyping() || Date.now() >= deadline) {
        resolve()
        return
      }
      setTimeout(attempt, RECHECK_MS)
    }
    setTimeout(attempt, RECHECK_MS)
  })
}
