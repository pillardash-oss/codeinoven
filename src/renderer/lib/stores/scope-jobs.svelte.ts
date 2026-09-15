/**
 * App-wide managed-worktree jobs (create + adopt).
 *
 * Mirrors `PrLifecycleStore`: the jobs live here, are rendered by
 * `ScopeJobDockHost` at the app root, and stay alive while the user navigates,
 * so a run that spends minutes on `git worktree add`, the environment copy and
 * the setup commands is always visible, expandable and dockable instead of
 * flashing past as a toast.
 */

import { subscribe } from '$lib/ipc.svelte'
import { scopeState } from '$lib/stores/scope.svelte'
import { APP_SLUG } from '$shared/brand'
import type {
  ScopeEnvironmentMode,
  ScopeSetupCommandSpec,
  ScopeWorktreeProgress,
  ScopeWorktreeProgressEvent
} from '$shared/types'

export type ScopeJobKind = 'create' | 'adopt'
export type ScopeJobStatus = 'running' | 'succeeded' | 'failed'

/** Ordered steps of a managed-worktree job, as shown in the panel checklist. */
export const SCOPE_JOB_STAGES = [
  'naming',
  'discovering-repository',
  'creating-worktree',
  'persisting-association',
  'environment',
  'setup'
] as const

export type ScopeWorktreeStage = (typeof SCOPE_JOB_STAGES)[number]

/** Human label for one job stage. */
export function scopeJobStageLabel(stage: ScopeWorktreeProgress['stage']): string {
  switch (stage) {
    case 'naming':
      return 'Naming the scope'
    case 'discovering-repository':
      return 'Reading the repository'
    case 'creating-worktree':
      return 'Creating the Git worktree'
    case 'persisting-association':
      return 'Attaching the worktree to the scope'
    case 'environment':
      return 'Copying environment files'
    case 'setup':
      return 'Running setup commands'
    case 'done':
      return 'Ready'
    case 'failed':
      return 'Failed'
    default:
      return 'Preparing'
  }
}

function isWorktreeStage(stage: ScopeWorktreeProgress['stage']): stage is ScopeWorktreeStage {
  return (SCOPE_JOB_STAGES as readonly string[]).includes(stage)
}

export interface ScopeJob {
  id: string
  projectId: string
  /** Bucket the job belongs to; null until a brand new scope's bucket exists. */
  scopeBucketId: string | null
  kind: ScopeJobKind
  /** Scope display name, used by the panel header and the dock chip. */
  title: string
  /** Whether the run creates or adopts an isolated Git worktree. */
  isolated: boolean
  /** Steps this run actually goes through, in order. */
  steps: readonly ScopeWorktreeStage[]
  /** Last stage the main process reported. */
  stage: ScopeWorktreeProgress
  /** Step the run failed on, so the checklist can mark where it stopped. */
  failedStage: ScopeWorktreeStage | null
  status: ScopeJobStatus
  error: string | null
  /** Setup command total, used to render "2 of 3" while they run. */
  setupCommandCount: number
  /** What the run produced, shown once the scope is usable. */
  result: { branch: string; directoryName: string } | null
  minimized: boolean
  startedAt: number
  finishedAt: number | null
}

export interface ScopeCreateJobInput {
  title: string
  /** Whether an isolated worktree is requested; shared-directory scopes skip setup entirely. */
  isolated: boolean
  runSetup: boolean
  environmentMode: ScopeEnvironmentMode
  baseBranch?: string
  setupCommands?: ScopeSetupCommandSpec[]
}

export interface ScopeCreateJobOptions {
  /** Set when the worktree is created for a scope that already exists. */
  existingBucketId?: string | null
  onCreated?: (bucketId: string) => void
}

/** The step a job is sitting on, or the step it failed on. */
export function scopeJobActiveStage(job: ScopeJob): ScopeWorktreeStage | null {
  if (job.failedStage) return job.failedStage
  if (!isWorktreeStage(job.stage.stage)) return null
  return job.steps.includes(job.stage.stage) ? job.stage.stage : null
}

/** Steps a managed-worktree run goes through, minus the ones it will skip. */
function worktreeSteps(runSetup: boolean): readonly ScopeWorktreeStage[] {
  return runSetup ? SCOPE_JOB_STAGES : SCOPE_JOB_STAGES.filter((step) => step !== 'setup')
}

class ScopeJobStore {
  jobs = $state<ScopeJob[]>([])
  #unsubscribe: (() => void) | null = null

  /**
   * Create a scope and, when requested, its managed worktree. An existing
   * scope is used as-is when `existingBucketId` is set, which is how a scope
   * gains a worktree without losing its threads.
   */
  create(
    projectId: string,
    input: ScopeCreateJobInput,
    options: ScopeCreateJobOptions = {}
  ): string {
    const job = this.#push({
      projectId,
      scopeBucketId: options.existingBucketId ?? null,
      kind: 'create',
      title: input.title,
      isolated: input.isolated,
      // A scope that shares the project directory only names a bucket; only an
      // isolated run reaches the worktree, environment and setup steps.
      steps: input.isolated ? worktreeSteps(input.runSetup) : ['naming'],
      setupCommandCount: input.setupCommands?.length ?? 0
    })
    void this.#runCreate(job.id, projectId, input, options)
    return job.id
  }

  /** Adopt an existing Git worktree checkout as a scope's managed root. */
  adopt(
    projectId: string,
    input: { bucketId: string; title: string; sourcePath: string; runSetup: boolean },
    options: { onAdopted?: () => void } = {}
  ): string {
    const job = this.#push({
      projectId,
      scopeBucketId: input.bucketId,
      kind: 'adopt',
      title: input.title,
      isolated: true,
      steps: worktreeSteps(input.runSetup),
      setupCommandCount: 0
    })
    void this.#runAdopt(job.id, projectId, input, options)
    return job.id
  }

  minimize(id: string): void {
    this.#patch(id, { minimized: true })
  }

  expand(id: string): void {
    this.#patch(id, { minimized: false })
  }

  /** Dismiss a finished job. A running job only ever minimizes. */
  close(id: string): void {
    const job = this.jobs.find((candidate) => candidate.id === id)
    if (!job || job.status === 'running') return
    this.jobs = this.jobs.filter((candidate) => candidate.id !== id)
    this.#releaseWhenIdle()
  }

  storageKeyFor(id: string): string {
    return `${APP_SLUG}.scopeJobPanel.${id}.v1`
  }

  async #runCreate(
    id: string,
    projectId: string,
    input: ScopeCreateJobInput,
    options: ScopeCreateJobOptions
  ): Promise<void> {
    try {
      let bucketId = options.existingBucketId ?? null
      if (!bucketId) {
        const bucket = await scopeState.createBucketForProject(projectId, input.title)
        bucketId = bucket?.id ?? null
        if (!bucketId) throw new Error('The scope could not be created')
        this.#patch(id, { scopeBucketId: bucketId })
      }
      if (input.isolated) {
        // Persist the entered configuration as project defaults BEFORE creating
        // so the saved defaults can never race ahead of this worktree.
        await scopeState.setWorktreeDefaults(projectId, {
          setupCommands: input.setupCommands ?? [],
          runSetupByDefault: input.runSetup,
          environmentMode: input.environmentMode
        })
        const descriptor = await scopeState.createWorktree(projectId, bucketId, input)
        if (descriptor) {
          this.#patch(id, {
            result: { branch: descriptor.branch, directoryName: descriptor.directoryName }
          })
        }
      }
      this.#finish(id, 'succeeded')
      // Handing the finished scope to the caller (select it, move a thread into
      // it) is navigation, not creation: it runs after the job is settled and
      // can never flip it back to failed.
      try {
        options.onCreated?.(bucketId)
      } catch {
        // The scope exists and works; a failed handoff only loses the shortcut.
      }
    } catch (cause) {
      this.#fail(id, cause, 'The scope could not be created.')
    }
  }

  async #runAdopt(
    id: string,
    projectId: string,
    input: { bucketId: string; sourcePath: string; runSetup: boolean },
    options: { onAdopted?: () => void }
  ): Promise<void> {
    try {
      const descriptor = await scopeState.adoptWorktree(projectId, input.bucketId, {
        sourcePath: input.sourcePath,
        runSetup: input.runSetup
      })
      if (descriptor) {
        this.#patch(id, {
          result: { branch: descriptor.branch, directoryName: descriptor.directoryName }
        })
      }
      this.#finish(id, 'succeeded')
      try {
        options.onAdopted?.()
      } catch {
        // The adopted worktree is registered; a failed handoff only loses the shortcut.
      }
    } catch (cause) {
      this.#fail(id, cause, 'The worktree could not be adopted.')
    }
  }

  #push(input: {
    projectId: string
    scopeBucketId: string | null
    kind: ScopeJobKind
    title: string
    isolated: boolean
    steps: readonly ScopeWorktreeStage[]
    setupCommandCount: number
  }): ScopeJob {
    const job: ScopeJob = {
      id: crypto.randomUUID(),
      projectId: input.projectId,
      scopeBucketId: input.scopeBucketId,
      kind: input.kind,
      title: input.title,
      isolated: input.isolated,
      steps: input.steps,
      stage: { stage: 'naming' },
      failedStage: null,
      status: 'running',
      error: null,
      setupCommandCount: input.setupCommandCount,
      result: null,
      minimized: false,
      startedAt: Date.now(),
      finishedAt: null
    }
    this.jobs = [...this.jobs, job]
    this.#ensureSubscribed()
    return job
  }

  #finish(id: string, status: ScopeJobStatus): void {
    this.#patch(id, { status, finishedAt: Date.now() })
  }

  #fail(id: string, cause: unknown, fallback: string): void {
    const job = this.jobs.find((candidate) => candidate.id === id)
    if (!job || job.status !== 'running') return
    this.#patch(id, {
      status: 'failed',
      error: cause instanceof Error ? cause.message : fallback,
      finishedAt: Date.now()
    })
  }

  #patch(id: string, patch: Partial<ScopeJob>): void {
    this.jobs = this.jobs.map((job) => (job.id === id ? { ...job, ...patch } : job))
  }

  /** Subscribe once, lazily: only a running job can receive progress. */
  #ensureSubscribed(): void {
    this.#unsubscribe ??= subscribe('scope:worktree:progress', (progress) =>
      this.#applyProgress(progress)
    )
  }

  /** Drop the progress listener once no job is left to receive stages. */
  #releaseWhenIdle(): void {
    if (this.jobs.length > 0) return
    this.#unsubscribe?.()
    this.#unsubscribe = null
  }

  #applyProgress(event: ScopeWorktreeProgressEvent): void {
    const running = this.jobs.filter(
      (job) => job.status === 'running' && job.projectId === event.projectId
    )
    // Exact bucket match first: the worktree service serialises one job per
    // project, so a queued sibling job must never steal the live stages.
    const job =
      running.find((candidate) => candidate.scopeBucketId === event.scopeBucketId) ??
      running.find((candidate) => candidate.scopeBucketId === null)
    if (!job) return
    const stage: ScopeWorktreeProgress = {
      stage: event.stage,
      ...(event.detail === undefined ? {} : { detail: event.detail })
    }
    if (event.stage === 'failed') {
      // `failed` names no step of its own; keep the step it interrupted so the
      // checklist can mark where the run stopped.
      const active = scopeJobActiveStage(job)
      this.#patch(job.id, { stage, failedStage: active })
      return
    }
    if (event.stage === 'done') {
      this.#patch(job.id, { stage })
      return
    }
    this.#patch(job.id, { stage, failedStage: null })
  }
}

export const scopeJobs = new ScopeJobStore()
