/**
 * Vocabulary shared by the two surfaces that read the same pull request: the Git
 * panel's header row and the detail reader underneath it. The panel draws the
 * state and check pills in its own row now, so the badge classes cannot live
 * inside the reader any more than the view ids can.
 */

/** The views the pull request detail reader switches between. */
export type PrDetailTabId = 'conversation' | 'commits' | 'files' | 'checks' | 'agent'

/** Badge colour for a pull request's state pill. */
export function prStateBadgeClass(state: string): string {
  if (state === 'merged') return 'bg-primary/10 text-primary'
  if (state === 'closed') return 'bg-danger/10 text-danger'
  return 'bg-success/10 text-success'
}

/** Badge colour for the rolled-up check state pill. */
export function prChecksBadgeClass(state: string): string {
  if (state === 'failure') return 'bg-danger/10 text-danger hover:bg-danger/20'
  if (state === 'pending') return 'bg-warning/10 text-warning hover:bg-warning/20'
  return 'bg-success/10 text-success hover:bg-success/20'
}

/** Wording for the rolled-up check state, sentence-cased for a label or title. */
export function prChecksStateLabel(state: string): string {
  if (state === 'failure') return 'Checks failing'
  if (state === 'pending') return 'Checks running'
  return 'Checks passing'
}
