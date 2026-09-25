import { gitState } from '$lib/stores/git.svelte'
import type { PrBatchResult, PrBatchStepReport } from '$lib/stores/git-store-pr-operations.svelte'
import { APP_SLUG } from '$shared/brand'

/**
 * Confirmed pull request batches, as background jobs.
 *
 * Closing twenty pull requests costs twenty round trips and possibly twenty more
 * for the note each one carries, so holding the user in front of a dialog for that
 * whole time contradicts the point of a list-wide action. A confirmed batch
 * therefore leaves the confirmation and becomes a job: the shared dockable job
 * panel and the shared minimized chip row (`ui/JobPanel`, `ui/JobDockRow`), the
 * same surfaces a worktree run uses, rendered at the app root so the batch keeps
 * reporting whatever thread, project or view the user moves to.
 *
 * The confirmation itself stays, because closing a pull request cannot be undone
 * from this app: what changes is that the work leaves with it instead of holding
 * the window.
 *
 * One checklist line per pull request, because a sweep's real question is which
 * rows survived. The line carries the reason it failed, and the summary counts the
 * ones the batch never reached after a refusal that would repeat for every row.
 */

/** Which way a batch moves its pull requests. */
export type PrBatchJobMode = 'close' | 'reopen'

/** One pull request in a job's checklist. */
export interface PrBatchJobItem {
  number: number
  title: string
  state: 'pending' | 'active' | 'complete' | 'failed'
  /** Why this row did not change, or why it was never attempted. */
  message: string | null
}

export interface PrBatchJob {
  id: string
  projectId: string
  owner: string
  repo: string
  mode: PrBatchJobMode
  /** The note every pull request receives, or null when the user wrote none. */
  comment: string | null
  items: PrBatchJobItem[]
  status: 'running' | 'succeeded' | 'failed'
  /** The refusal that stopped the batch early, or null. */
  error: string | null
  /** What the batch actually did, once it is over. */
  result: PrBatchResult | null
  minimized: boolean
  startedAt: number
  finishedAt: number | null
}

/** What the list hands over once the user confirms a batch. */
export interface PrBatchJobInput {
  projectId: string
  owner: string
  repo: string
  mode: PrBatchJobMode
  targets: readonly { number: number; title: string }[]
  /** The note to post on every pull request, or null for none. */
  comment: string | null
}

/**
 * Promote the first pull request that has not run yet, so the checklist always
 * marks exactly one row as the one in flight.
 */
function advance(items: readonly PrBatchJobItem[]): PrBatchJobItem[] {
  let promoted = false
  return items.map((item) => {
    if (item.state !== 'pending' || promoted) return item
    promoted = true
    return { ...item, state: 'active' }
  })
}

/**
 * What the panel and the dock chip say the batch is doing right now: how many
 * pull requests it has settled out of how many it took on.
 */
export function prBatchJobStatusLabel(job: PrBatchJob): string {
  const settled = job.items.filter(
    (item) => item.state === 'complete' || item.state === 'failed'
  ).length
  if (job.status === 'running') return `${settled} of ${job.items.length} done`
  if (job.status === 'succeeded') return 'All done'
  return `${job.result?.succeeded.length ?? 0} of ${job.items.length}`
}

/** What the batch acts on, as a heading or a chip names it. */
export function prBatchJobSubject(job: PrBatchJob): string {
  return job.items.length === 1
    ? `pull request #${job.items[0]?.number ?? ''}`
    : `${job.items.length} pull requests`
}

class PrBatchJobStore {
  jobs = $state<PrBatchJob[]>([])

  /**
   * Start a batch and return its job id. The run begins immediately and the caller
   * is free to dismiss whatever asked for it: nothing about this waits on the user.
   */
  start(input: PrBatchJobInput): string {
    const job: PrBatchJob = {
      id: crypto.randomUUID(),
      projectId: input.projectId,
      owner: input.owner,
      repo: input.repo,
      mode: input.mode,
      comment: input.comment,
      items: input.targets.map((target, index) => ({
        number: target.number,
        title: target.title,
        // The first row is what the run is doing from the moment the panel appears,
        // rather than waiting for the first write to come back.
        state: index === 0 ? 'active' : 'pending',
        message: null
      })),
      status: 'running',
      error: null,
      result: null,
      minimized: false,
      startedAt: Date.now(),
      finishedAt: null
    }
    this.jobs = [...this.jobs, job]
    void this.#run(job.id)
    return job.id
  }

  minimize(id: string): void {
    this.#patch(id, { minimized: true })
  }

  expand(id: string): void {
    this.#patch(id, { minimized: false })
  }

  /** Dismiss a finished job. A running one only ever minimizes. */
  close(id: string): void {
    const job = this.#find(id)
    if (!job || job.status === 'running') return
    this.jobs = this.jobs.filter((candidate) => candidate.id !== id)
  }

  storageKeyFor(id: string): string {
    return `${APP_SLUG}.prBatchJobPanel.${id}.v1`
  }

  async #run(id: string): Promise<void> {
    const job = this.#find(id)
    if (!job) return
    const numbers = job.items.map((item) => item.number)
    const onStep = (report: PrBatchStepReport): void => this.#settle(id, report)
    try {
      const result =
        job.mode === 'close'
          ? await gitState.closePullRequests(
              job.projectId,
              job.owner,
              job.repo,
              numbers,
              job.comment,
              onStep
            )
          : await gitState.reopenPullRequests(
              job.projectId,
              job.owner,
              job.repo,
              numbers,
              job.comment,
              onStep
            )
      this.#complete(id, result)
    } catch (cause) {
      const job = this.#find(id)
      if (!job) return
      const message = cause instanceof Error ? cause.message : 'The batch could not be completed'
      this.#patch(id, {
        items: this.#unattempted(job, message),
        status: 'failed',
        error: message,
        finishedAt: Date.now()
      })
    }
  }

  /**
   * Every row the batch never ran, marked as such.
   *
   * A stopped batch leaves one row promoted to `active` (the loop settles the row
   * it refused on and the checklist advances before the run ends) and the rest
   * still `pending`, so both are settled here: a spinner on a row nothing is doing
   * is worse than a plain dimmed line, and "17 of 20" is only honest if the three
   * are named.
   */
  #unattempted(job: PrBatchJob, reason: string | null): PrBatchJobItem[] {
    return job.items.map((item) =>
      item.state === 'pending' || item.state === 'active'
        ? {
            ...item,
            state: 'pending' as const,
            message: reason ? `Not attempted: ${reason}` : 'Not attempted'
          }
        : item
    )
  }

  /** Record one pull request's outcome and move the run onto the next row. */
  #settle(id: string, report: PrBatchStepReport): void {
    const job = this.#find(id)
    if (!job) return
    this.#patch(id, {
      items: advance(
        job.items.map((item) =>
          item.number === report.number
            ? { ...item, state: report.ok ? 'complete' : 'failed', message: report.message }
            : item
        )
      )
    })
  }

  /**
   * Settle the job on the batch's own result.
   *
   * The job is a failure whenever anything did not land, so a partial sweep reads
   * as needing attention rather than as done.
   */
  #complete(id: string, result: PrBatchResult): void {
    const job = this.#find(id)
    if (!job) return
    this.#patch(id, {
      items: this.#unattempted(job, result.stoppedBy),
      result,
      status: result.failed.length === 0 && result.skipped.length === 0 ? 'succeeded' : 'failed',
      error: result.stoppedBy,
      finishedAt: Date.now()
    })
  }

  #find(id: string): PrBatchJob | undefined {
    return this.jobs.find((candidate) => candidate.id === id)
  }

  #patch(id: string, patch: Partial<PrBatchJob>): void {
    this.jobs = this.jobs.map((job) => (job.id === id ? { ...job, ...patch } : job))
  }
}

export const prBatchJobs = new PrBatchJobStore()
