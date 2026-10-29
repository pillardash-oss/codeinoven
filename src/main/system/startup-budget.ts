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
 * The budget is enforced on `window:revealed` - the moment the splash comes down
 * on a restored conversation, which is the moment the user is looking at an
 * interactive app. Its fallback is `window:visualReady`, the first rendered
 * frame, for a launch that never reveals. Later phases are deliberately not part
 * of the budget: `features:ready` and `workspace:ready` describe the post-reveal
 * service boot, which is designed to happen *behind* a visible window, so a slow
 * service graph degrades optional features instead of holding the user off the
 * conversation.
 *
 * The budget exists so a startup regression fails a release gate instead of
 * being absorbed by quietly raising a bundle budget. The renderer's eager
 * JavaScript closure is what the first paint actually waits on, and it is
 * measured independently by `bun run check:bundle`; this is the runtime half of
 * the same promise.
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
 * The phases the first-paint budget is measured on, best first.
 *
 * `window:revealed` is the moment the splash comes down on a restored
 * conversation, which is the moment the user can actually act. It replaced
 * `window:visualReady` as the budgeted phase when the splash started waiting for
 * the conversation: `visualReady` is only the first frame of a window the splash
 * still covers, so a launch could sit inside the budget while the user watched a
 * splash for seconds. `visualReady` stays as the fallback for a launch that never
 * records a reveal (a headless boot, or a renderer that never painted).
 */
const BUDGET_PHASES: readonly StartupPhase[] = ['window:revealed', 'window:visualReady']

/**
 * The first-paint violation in a telemetry snapshot, or `null` when the boot met
 * the budget or never recorded a budgeted phase at all.
 *
 * A snapshot with neither phase is not a violation: a headless launch never
 * paints, and a crashed renderer is diagnosed by its own signals rather than by
 * being reported as a startup that was too slow.
 */
export function startupBudgetViolation(
  snapshot: StartupTelemetrySnapshot,
  budgetMs: number = STARTUP_BUDGET_MS
): StartupBudgetViolation | null {
  for (const phase of BUDGET_PHASES) {
    const record = snapshot.phases.find((candidate) => candidate.phase === phase)
    if (!record) continue
    if (record.atMs <= budgetMs) return null
    return {
      phase: record.phase,
      atMs: record.atMs,
      overByMs: record.atMs - budgetMs,
      budgetMs
    }
  }
  return null
}
