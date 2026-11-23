/**
 * The app's one honest measure of "somebody is at the keyboard".
 *
 * Nothing on screen waits for this. It exists so work that is *not* on screen —
 * the titles, summaries and memory proposals a finishing thread starts, each of
 * which boots a harness process — does not start between two keystrokes. Main
 * holds that work for the first quiet moment and never longer than its own
 * ceiling, so a keystroke and a click both get the CPU they were competing for.
 */

/** How long after a keystroke the user still counts as typing. */
export const TYPING_WINDOW_MS = 200

/** Never a real timestamp: the process may start at any clock value, and "has
 *  never typed" must not read as "typing right now" on a clock near zero. */
const NEVER = Number.NEGATIVE_INFINITY

let lastKeystrokeAt = NEVER

/** When the window last told main somebody is typing. */
let lastReportAt = Number.NEGATIVE_INFINITY

/** How often a keystroke is forwarded to main. Main only needs to know whether
 *  the keyboard was touched inside its own 250 ms window, so a few reports a
 *  second are enough and a fast typist does not cost an IPC message per letter. */
const REPORT_INTERVAL_MS = 250

/**
 * Note one keystroke.
 *
 * Called from the single window-level keydown the composer already owns, so every
 * surface that can be typed into counts, and a shortcut press counts too: the user
 * is at the keyboard either way.
 */
export function noteKeystroke(now: number = Date.now()): void {
  lastKeystrokeAt = now
  // Background work started by a finishing thread (a title, a summary, a memory
  // proposal) boots a harness process or runs an embedding pass. None of it is
  // urgent, and all of it competes with the letter being typed, so main is told
  // the keyboard is in use and holds that work for its first quiet moment.
  if (now - lastReportAt < REPORT_INTERVAL_MS) return
  lastReportAt = now
  try {
    window.api?.send('system:typingActivity')
  } catch {
    // A report that cannot be sent is not worth surfacing: the next keystroke
    // carries the same fact a quarter of a second later.
  }
}

/** Whether the user is typing right now. */
export function isTyping(now: number = Date.now()): boolean {
  return now - lastKeystrokeAt < TYPING_WINDOW_MS
}

/** Test seam: forget any keystroke. */
export function resetTypingActivity(): void {
  lastKeystrokeAt = NEVER
  lastReportAt = Number.NEGATIVE_INFINITY
}
