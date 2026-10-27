import { gitState } from '$lib/stores/git.svelte'
import { APP_SLUG } from '$shared/brand'
import type { GitPullStrategy, GitStatus } from '$shared/types'

/**
 * Pulls, as background jobs.
 *
 * A pull is a round trip plus an integration, and the integration can stop on
 * conflicts the user has to resolve: exactly the shape of run every other git
 * job in the app already reports through the shared dockable job panel
 * (`ui/JobPanel`, `ui/JobDockRow`). Holding the window in front of a modal for
 * it was the odd one out, so a chosen strategy now leaves the chooser and
 * becomes a job, rendered at the app root so the run keeps reporting whatever
 * thread, project or view the user moves to.
 *
 * The job reads the status the pull left behind rather than parsing git's
 * output: a conflicted integration is a run that needs the user, reported in
 * the panel, never a dialog on top of the work they were doing.
 */

/** How a pull stands. A conflict counts as `failed`: it needs the user. */
export type GitPullJobStatus = 'running' | 'succeeded' | 'failed'

export interface GitPullJob {
  id: string
  projectId: string
  /** Remote the branch was read from. */
  remote: string
  /** The remote branch that was integrated. */
  branch: string
  strategy: GitPullStrategy
  /** Commits the remote was ahead by when the run started, from the last fetch. */
  incoming: number
  status: GitPullJobStatus
  /** The status the pull left behind, or null when it never read one. */
  result: GitStatus | null
  /** The refusal or the failure that stopped the run, or null. */
  error: string | null
  minimized: boolean
  startedAt: number
  finishedAt: number | null
}

/** Everything one chosen strategy hands over. */
export interface GitPullJobInput {
  projectId: string
  remote: string
  branch: string
  strategy: GitPullStrategy
  /** The remote's lead, from the fetch the panel already showed. */
  incoming: number
  /**
   * Called once the run settles, for a surface that has to re-read something
   * the job cannot know about (the commit list it already rendered, say). The
   * run outlives whatever started it, so a caller must not assume it is still
   * mounted when this fires.
   */
  onSettled?: () => void
}

class GitPullJobStore {
  jobs = $state<GitPullJob[]>([])

  /**
   * Start a pull and return its job id. The run begins immediately and the
   * caller is free to dismiss the chooser it came from.
   */
  start(input: GitPullJobInput): string {
    const job: GitPullJob = {
      id: crypto.randomUUID(),
      projectId: input.projectId,
      remote: input.remote,
      branch: input.branch,
      strategy: input.strategy,
      incoming: input.incoming,
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
    return `${APP_SLUG}.gitPullJobPanel.${id}.v1`
  }

  async #run(id: string, input: GitPullJobInput): Promise<void> {
    try {
      const result = await gitState.pullIntegrate(
        input.projectId,
        input.remote,
        input.branch,
        input.strategy
      )
      if (!result) {
        // The refusal or the failure is this run's own answer, so it is taken off
        // the shared error field before anything else reads it as the panel's.
        const message = gitState.error ?? 'The pull could not be completed'
        gitState.error = null
        this.#patch(id, { status: 'failed', error: message, finishedAt: Date.now() })
      } else if (result.conflicted.length > 0) {
        // The commits that arrived are on disk, so a conflict is a run that needs
        // the user rather than a retry. What to resolve is read from the result by
        // the panel, so the job only records that it stopped.
        this.#patch(id, { result, status: 'failed', finishedAt: Date.now() })
      } else {
        this.#patch(id, { result, status: 'succeeded', finishedAt: Date.now() })
      }
    } catch (cause) {
      // Nothing should escape `pullIntegrate`, which reports a refusal as a value.
      // A job left running would spin forever in the dock, so an unexpected throw
      // settles it here instead.
      const message = cause instanceof Error ? cause.message : 'The pull could not be completed'
      this.#patch(id, { status: 'failed', error: message, finishedAt: Date.now() })
    }

    // A pull moves remote-tracking refs, so the branch list and its ahead/behind
    // counts are stale either way. Idempotent and a no-op for a project the shell
    // is not showing.
    void gitState.refresh(input.projectId).catch(() => undefined)
    input.onSettled?.()
  }

  #find(id: string): GitPullJob | undefined {
    return this.jobs.find((candidate) => candidate.id === id)
  }

  #patch(id: string, patch: Partial<GitPullJob>): void {
    this.jobs = this.jobs.map((job) => (job.id === id ? { ...job, ...patch } : job))
  }
}

export const gitPullJobs = new GitPullJobStore()
