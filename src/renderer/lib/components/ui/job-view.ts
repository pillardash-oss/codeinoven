/**
 * The vocabulary a background job's panel and dock chip share.
 *
 * Both are presentational: a job owner resolves its own steps into these views
 * and renders them, so the worktree runs, the pull request batches and the
 * syncs between checkouts draw the same panel without any one of them knowing
 * about another's job shape.
 */

/** Where one step of a run sits relative to the run itself. */
export type JobStepState = 'complete' | 'active' | 'failed' | 'pending'

/** One checklist line, with its state already resolved by the job's owner. */
export interface JobStepView {
  id: string
  /** The line as the user reads it, e.g. `Close #149 - Bump lodash`. */
  label: string
  state: JobStepState
  /** An extra line under the label, e.g. why this step failed. */
  detail?: string
}

/** How a run stands as a whole. */
export type JobStatus = 'running' | 'succeeded' | 'failed'

/** One minimized run, as the shared dock row draws it. */
export interface JobDockEntry {
  id: string
  /** The project the run belongs to, or an empty string when it has none. */
  project: string
  title: string
  /** What the run is doing now, or how it ended. */
  statusLabel: string
  status: JobStatus
}
