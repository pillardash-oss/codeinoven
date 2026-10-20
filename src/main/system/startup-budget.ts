import type { StartupPhase, StartupTelemetrySnapshot } from './startup-telemetry'

/******************************************************************************
 *                                                                           *
 *   STOP.  THE 5,000 ms BUDGET BELOW IS A HARD CEILING.                     *
 *                                                                           *
 *   STARTUP TIME IS THE FIRST ETHOS OF THIS APPLICATION.  THIS NUMBER IS    *
 *   UNDER AN EXPLICIT AND STANDING USER FREEZE.  YOU, THE AGENT READING    *
 *   THIS, ARE FORBIDDEN FROM RAISING, RELAXING, WIDENING, OR OTHERWISE     *
 *   WEAKENING IT.  NOT BY A MILLISECOND.  NOT ONCE.  NOT "TEMPORARILY".    *
 *   NOT BECAUSE A MACHINE WAS SLOW, NOT BECAUSE CI IS RED, NOT BECAUSE     *
 *   SOMETHING NEW MADE BOOT HEAVIER.  THOSE ARE THE REASONS TO FIX THE     *
 *   BOOT, NOT TO MOVE THE GOALPOST.                                       *
 *                                                                           *
 *   RAISING THIS REQUIRES THE USER'S PRIOR, EXPLICIT, FORMAL APPROVAL.     *
 *   NOT AN ASSUMPTION, NOT A SILENCE, NOT A "THE USER NAMED NO NUMBER".     *
 *   AN ACTUAL STATEMENT FROM THE USER THAT THIS BUDGET MAY GO UP, AND     *
 *   THE REASON RECORDED ALONGSIDE IT.  WITHOUT THAT APPROVAL ON RECORD,    *
 *   A CHANGE TO THIS CONSTANT IS A STARTUP REGRESSION SHIPPED ON PURPOSE.  *
 *   DO NOT DO IT.  GO MAKE THE BOOT FASTER INSTEAD.                        *
 *                                                                           *
 ******************************************************************************/
/**
 * The first-paint startup budget, in milliseconds.
 *
 * The budget is enforced on `window:visualReady` - the moment Electron reports
 * the first rendered frame, which is also the moment the splash closes and the
 * user is looking at an interactive app. Later phases are deliberately not part
 * of the budget: `features:ready` and `workspace:ready` describe the post-paint
 * service boot, which is designed to happen *behind* a visible window, so a slow
 * service graph degrades optional features instead of holding the user off a
 * blank screen.
 *
 * The budget exists so a startup regression fails a release gate instead of
 * being absorbed by quietly raising a bundle budget. The renderer's eager
 * JavaScript closure is what the first paint actually waits on, and it is
 * measured independently by `bun run check:bundle`; this is the runtime half of
 * the same promise.
 *
 * The budget describes a renderer that executes the packaged bundle. A launch
 * whose renderer is served by the Vite dev server fetches every unbundled module
 * over HTTP before it can paint, so it misses the budget by seconds while
 * booting no slower than the shipped app; the caller must not measure that
 * renderer against this number.
 */
export const STARTUP_BUDGET_MS = 5_000

export interface StartupBudgetViolation {
  /** The phase the budget is measured on. */
  phase: StartupPhase
  /** Recorded elapsed time for that phase, in milliseconds. */
  atMs: number
  /** Milliseconds by which the phase exceeded {@link STARTUP_BUDGET_MS}. */
  overByMs: number
  /** The budget that was exceeded, in milliseconds. */
  budgetMs: number
}

/**
 * The first-paint violation in a telemetry snapshot, or `null` when the boot met
 * the budget or never recorded the phase at all.
 *
 * A snapshot without `window:visualReady` is not a violation: a headless launch
 * never paints, and a crashed renderer is diagnosed by its own signals rather
 * than by being reported as a startup that was too slow.
 */
export function startupBudgetViolation(
  snapshot: StartupTelemetrySnapshot,
  budgetMs: number = STARTUP_BUDGET_MS
): StartupBudgetViolation | null {
  const firstPaint = snapshot.phases.find((record) => record.phase === 'window:visualReady')
  if (!firstPaint || firstPaint.atMs <= budgetMs) return null
  return {
    phase: 'window:visualReady',
    atMs: firstPaint.atMs,
    overByMs: firstPaint.atMs - budgetMs,
    budgetMs
  }
}
