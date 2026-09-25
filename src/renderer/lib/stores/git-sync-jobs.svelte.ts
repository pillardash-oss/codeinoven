import { gitState } from '$lib/stores/git.svelte'
import { APP_SLUG } from '$shared/brand'
import type { GitPullStrategy, GitSyncDirection, GitSyncPeer, GitSyncResult } from '$shared/types'

/**
 * Syncs between two ends of one repository, as background jobs.
 *
 * A sync trades committed work between two checkouts, so it can be a fetch, an
 * integration, a probe of what the integration broke, and a write into a
 * checkout the user is not even looking at. Holding the window in front of a
 * modal for that contradicts the point of picking two ends from a list: a
 * chosen strategy therefore leaves the chooser and becomes a job. The run
 * reports through the shared dockable job panel and the shared minimized chip
 * row (`ui/JobPanel`, `ui/JobDockRow`), the same surfaces a worktree run uses,
 * rendered at the app root so the sync keeps reporting whatever thread, project
 * or view the user moves to.
 *
 * Every entry point goes through here - the peer chooser in the Git panel, the
 * same chooser from a scope's own menu, and the panel's two "main" shortcuts -
 * so one operation can never be docked from one surface and block the window
 * from another. A refusal (uncommitted work, a detached HEAD, an open
 * integration, a peer that cannot receive commits) and a conflicted integration
 * are outcomes of the job, reported in the panel, never a dialog the user has
 * to answer.
 */

/** How a sync run stands. A conflict counts as `failed`: it needs the user. */
export type GitSyncJobStatus = 'running' | 'succeeded' | 'failed'

export interface GitSyncJob {
  id: string
  projectId: string
  /** Checkout the sync runs in; `undefined` is the project root. */
  scopeBucketId: string | undefined
  direction: GitSyncDirection
  strategy: GitPullStrategy
  /** The other end, as the chooser named it, until git names it itself. */
  peerLabel: string
  status: GitSyncJobStatus
  /** What git answered, once it did. */
  result: GitSyncResult | null
  /** The refusal or the failure that stopped the run, or null. */
  error: string | null
  minimized: boolean
  startedAt: number
  finishedAt: number | null
}

/** Everything one chosen strategy hands over, exactly as the chooser showed it. */
export interface GitSyncJobInput {
  projectId: string
  scopeBucketId: string | undefined
  direction: GitSyncDirection
  strategy: GitPullStrategy
  /** The peer the chooser named, handed back verbatim to `git:syncWith`. */
  peer: GitSyncPeer
  /** That peer's label, for the panel's heading while the run is in flight. */
  peerLabel: string
  /**
   * Called once the run settles, for a surface that has to re-read something
   * the job cannot know about (a commit list it already rendered, say). The run
   * outlives whatever started it, so a caller must not assume it is still
   * mounted when this fires.
   */
  onSettled?: (result: GitSyncResult | null) => void
}

class GitSyncJobStore {
  jobs = $state<GitSyncJob[]>([])

  /**
   * Start a sync and return its job id. The run begins immediately and the
   * caller is free to dismiss whatever asked for it: nothing about this waits
   * on the user.
   */
  start(input: GitSyncJobInput): string {
    const job: GitSyncJob = {
      id: crypto.randomUUID(),
      projectId: input.projectId,
      scopeBucketId: input.scopeBucketId,
      direction: input.direction,
      strategy: input.strategy,
      peerLabel: input.peerLabel,
      status: 'running',
      result: null,
      error: null,
      minimized: false,
      startedAt: Date.now(),
      finishedAt: null
    }
    this.jobs = [...this.jobs, job]
    void this.#run(job.id, input)
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
    return `${APP_SLUG}.gitSyncJobPanel.${id}.v1`
  }

  async #run(id: string, input: GitSyncJobInput): Promise<void> {
    let result: GitSyncResult | null = null
    try {
      result = await gitState.syncWith(input.projectId, input.scopeBucketId, {
        direction: input.direction,
        peer: input.peer,
        strategy: input.strategy
      })

      if (!result) {
        // The refusal or the failure is this run's own answer, so it is taken off
        // the shared error field before anything else reads it as the panel's.
        const message = gitState.error ?? 'The sync could not be completed'
        gitState.error = null
        this.#patch(id, { status: 'failed', error: message, finishedAt: Date.now() })
      } else if (result.status.conflicted.length > 0) {
        // The commits that arrived are on disk, so a conflict is a run that needs
        // the user rather than a retry. What to resolve is read from the result by
        // the panel (`syncOutcomeCopy`), so the job only records that it stopped.
        this.#patch(id, { result, status: 'failed', finishedAt: Date.now() })
      } else {
        this.#patch(id, { result, status: 'succeeded', finishedAt: Date.now() })
      }
    } catch (cause) {
      // Nothing should escape `syncWith`, which reports a refusal as a value. A
      // job left running would spin forever in the dock, so an unexpected throw
      // settles it here instead.
      const message = cause instanceof Error ? cause.message : 'The sync could not be completed'
      this.#patch(id, { status: 'failed', error: message, finishedAt: Date.now() })
    }

    // A sync moves a branch in one checkout and leaves the other's working tree
    // to read again, so the panel's status, branch list and ahead/behind counts
    // are stale either way. Idempotent and a no-op for any project the shell is
    // not showing.
    void gitState.refresh(input.projectId).catch(() => undefined)
    input.onSettled?.(result)
  }

  #find(id: string): GitSyncJob | undefined {
    return this.jobs.find((candidate) => candidate.id === id)
  }

  #patch(id: string, patch: Partial<GitSyncJob>): void {
    this.jobs = this.jobs.map((job) => (job.id === id ? { ...job, ...patch } : job))
  }
}

export const gitSyncJobs = new GitSyncJobStore()
