/**
 * CIO Cleanup in the renderer: the exclusions the file tree draws, the last-run
 * state the settings page reports, and the dockable job a manual run publishes.
 *
 * The daily sweep is silent, so nothing here ever mints a job for it. A job is
 * created only from a progress event, and main only streams those for a run the
 * user started, which is what keeps an automatic pass from opening a panel.
 */

import { invoke, subscribe } from '$lib/ipc.svelte'
import { reportError } from '$lib/stores/app-errors.svelte'
import { APP_SLUG } from '$shared/brand'
import { findCioCleanupExclusion } from '$shared/cio-cleanup'
import type {
  CioCleanupExclusion,
  CioCleanupExclusionToggleInput,
  CioCleanupMount,
  CioCleanupProgress,
  CioCleanupState
} from '$shared/types'
import type { JobStatus } from '$lib/components/ui/job-view'

/** Closest guess at the state before main answers, so nothing renders undefined. */
const EMPTY_STATE: CioCleanupState = {
  retentionDays: 0,
  nextRunAt: null,
  running: false,
  lastRun: null,
  exclusions: []
}

/** One cleanup run in the dock: its live counters and how it ended. */
export interface CioCleanupJob {
  id: string
  status: JobStatus
  progress: CioCleanupProgress
  minimized: boolean
  startedAt: number
  finishedAt: number | null
}

/** The step checklist a cleanup run shows, resolved from its own counters. */
export function cioCleanupStepViews(progress: CioCleanupProgress): Array<{
  id: string
  label: string
  state: 'complete' | 'active' | 'failed' | 'pending'
  detail?: string
}> {
  const settled =
    progress.phase === 'completed' || progress.phase === 'cancelled' || progress.phase === 'failed'
  const failed = progress.phase === 'failed'
  const total = progress.targetsTotal
  return [
    {
      id: 'workspaces',
      label: 'Finding scratch folders',
      state: total > 0 ? 'complete' : failed ? 'failed' : 'active',
      ...(total > 0 ? { detail: `${total} folder${total === 1 ? '' : 's'}` } : {})
    },
    {
      id: 'sweep',
      label: 'Removing stale content',
      state: failed ? 'failed' : settled ? 'complete' : total > 0 ? 'active' : 'pending',
      detail:
        total > 0
          ? `${progress.targetsDone} of ${total} swept · ${progress.entriesRemoved} removed`
          : undefined
    },
    {
      id: 'done',
      label: progress.phase === 'cancelled' ? 'Stopped' : failed ? 'Failed' : 'Scratch reclaimed',
      state: settled ? (failed ? 'failed' : 'complete') : 'pending'
    }
  ]
}

class CioCleanupStore {
  /** Live manual runs, rendered at the app root so navigation never loses them. */
  jobs = $state<CioCleanupJob[]>([])
  state = $state<CioCleanupState>(EMPTY_STATE)

  #listening = false

  /** Subscribe once for the app's lifetime; every surface reads this store. */
  listen(): void {
    if (this.#listening) return
    this.#listening = true
    subscribe('cioCleanup:progress', (progress) => this.#applyProgress(progress))
    subscribe('cioCleanup:stateChanged', (state) => {
      this.state = state
    })
    void this.load()
  }

  async load(): Promise<void> {
    try {
      this.state = await invoke('cioCleanup:state')
    } catch (error) {
      reportError(error, 'CIO Cleanup state could not be read.')
    }
  }

  /** Start a cleanup now, or surface the run already in flight. */
  async runNow(): Promise<void> {
    try {
      await invoke('cioCleanup:run')
    } catch (error) {
      reportError(error, 'The cleanup could not be started.')
    }
  }

  async cancel(runId: string): Promise<void> {
    try {
      await invoke('cioCleanup:cancel', runId)
    } catch (error) {
      reportError(error, 'The cleanup could not be stopped.')
    }
  }

  /** Exclude a path inside a workspace's `.cio` folder, or include it again. */
  async toggleExclusion(input: CioCleanupExclusionToggleInput): Promise<void> {
    try {
      const result = await invoke('cioCleanup:toggleExclusion', input)
      this.state = { ...this.state, exclusions: result.exclusions }
    } catch (error) {
      reportError(error, 'The cleanup exclusion could not be saved.')
    }
  }

  /** The exclusion covering a path, so the tree can offer to remove it. */
  exclusionFor(mount: CioCleanupMount, relativePath: string): CioCleanupExclusion | null {
    return findCioCleanupExclusion(this.state.exclusions, mount, relativePath)
  }

  /** Exclusions of one workspace mount, for the settings list. */
  exclusionsForProject(projectId: string): CioCleanupExclusion[] {
    return this.state.exclusions.filter((exclusion) => exclusion.projectId === projectId)
  }

  minimize(id: string): void {
    this.#patch(id, { minimized: true })
  }

  expand(id: string): void {
    this.#patch(id, { minimized: false })
  }

  /** Dismiss a settled job. A running cleanup only ever minimizes. */
  close(id: string): void {
    const job = this.jobs.find((candidate) => candidate.id === id)
    if (!job) return
    if (job.status === 'running') {
      this.minimize(id)
      return
    }
    this.jobs = this.jobs.filter((candidate) => candidate.id !== id)
  }

  storageKeyFor(id: string): string {
    return `${APP_SLUG}.cioCleanupDock.${id}.v1`
  }

  #applyProgress(progress: CioCleanupProgress): void {
    const settled =
      progress.phase === 'completed' ||
      progress.phase === 'cancelled' ||
      progress.phase === 'failed'
    const existing = this.jobs.find((job) => job.id === progress.runId)
    if (!existing) {
      this.jobs = [
        ...this.jobs,
        {
          id: progress.runId,
          status: settled ? (progress.phase === 'failed' ? 'failed' : 'succeeded') : 'running',
          progress,
          minimized: false,
          startedAt: progress.startedAt,
          finishedAt: settled ? (progress.finishedAt ?? Date.now()) : null
        }
      ]
      return
    }
    this.#patch(progress.runId, {
      progress,
      status: settled ? (progress.phase === 'failed' ? 'failed' : 'succeeded') : 'running',
      ...(settled ? { finishedAt: progress.finishedAt ?? Date.now() } : {})
    })
  }

  #patch(id: string, patch: Partial<CioCleanupJob>): void {
    this.jobs = this.jobs.map((job) => (job.id === id ? { ...job, ...patch } : job))
  }
}

export const cioCleanupStore = new CioCleanupStore()
