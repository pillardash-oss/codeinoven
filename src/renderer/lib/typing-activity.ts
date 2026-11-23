/**
 * Typing priority for work that is not worth a stutter.
 *
 * Reported symptom: typing stutters whenever a thread completes or changes
 * status. A status update is a lifecycle boundary, and the conversation reacts to
 * it by re-reading its tail and re-rendering it — work that is worth doing, and
 * never worth doing between two keystrokes.
 *
 * What was measured first, so the guesswork stops here: the merge of a realistic
 * tail page (40 messages, 536 KiB of parts, taken from this app's own database)
 * costs 0.19 ms median. The merge is not the cost. The cost of a completion is the
 * render that follows it — the settled message being adopted by the markdown
 * pipeline and the transcript tail re-rendering — and that lands on the same
 * thread that turns a keystroke into a character.
 *
 * There is no way to make that render free, and there is a way to make it harmless:
 * do not start it while the user is typing. A keystroke is latency-critical and a
 * completion can wait a fraction of a second. So the reconcile that a status
 * update triggers runs on the first quiet moment after the last keystroke.
 *
 * Nothing is ever dropped, and nothing waits forever: `TYPING_HOLD_MAX_MS` bounds
 * the delay, so a user who types continuously still sees the conversation catch up
 * inside a second.
 */

/** How long after a keystroke the user still counts as typing. */
export const TYPING_WINDOW_MS = 200

/** The longest any deferred work may wait for the typing to stop. */
export const TYPING_HOLD_MAX_MS = 800

/** How long after the last keystroke the deferred work is retried. */
const RETRY_MS = 120

/** Never a real timestamp: the process may start at any clock value, and "has
 *  never typed" must not read as "typing right now" on a clock near zero. */
const NEVER = Number.NEGATIVE_INFINITY

let lastKeystrokeAt = NEVER

/**
 * Note one keystroke.
 *
 * Called from the single window-level keydown the composer already owns, so every
 * surface that can be typed into counts, and a shortcut press counts too: the user
 * is at the keyboard either way, and holding the reconcile for a shortcut is as
 * cheap as holding it for a letter.
 */
export function noteKeystroke(now: number = Date.now()): void {
  lastKeystrokeAt = now
}

/** Whether the user is typing right now. */
export function isTyping(now: number = Date.now()): boolean {
  return now - lastKeystrokeAt < TYPING_WINDOW_MS
}

/** Test seam: forget any keystroke. */
export function resetTypingActivity(): void {
  lastKeystrokeAt = NEVER
}

/**
 * Run `task` now when the user is idle, or on the first quiet moment when they are
 * not. The returned promise settles when the task has run, so a caller that awaits
 * it still knows when its work is done; failures are the task's own business.
 */
export function whenTypingPauses(task: () => void): Promise<void> {
  if (typeof window === 'undefined') {
    task()
    return Promise.resolve()
  }
  const deadline = Date.now() + TYPING_HOLD_MAX_MS
  return new Promise<void>((resolve) => {
    const attempt = (): void => {
      if (isTyping() && Date.now() < deadline) {
        setTimeout(attempt, RETRY_MS)
        return
      }
      try {
        task()
      } finally {
        resolve()
      }
    }
    attempt()
  })
}
