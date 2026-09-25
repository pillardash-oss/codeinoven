/**
 * App-wide scope work: create, adopt and remove a scope's managed worktree.
 *
 * Mirrors `PrLifecycleStore`: the jobs live here, are rendered by
 * `ScopeJobDockHost` at the app root, and stay alive while the user navigates,
 * so a run that spends minutes on `git worktree add`, the environment copy and
 * the setup commands is always visible, expandable and dockable instead of
 * flashing past as a toast. Removal is a job for the same reason: it removes a
 * checkout and disposes every thread in the scope, which the user should be able
 * to run in the background rather than watch in a dialog.
 *
 * An agent's run (`cio:scope`) is the same kind of job: it streams the same
 * stages on the same channel, so the first event mints the job record here and
 * the run becomes visible exactly like one the user started in this window.
 */

import { invoke, subscribe } from '$lib/ipc.svelte'
import { scopeState } from '$lib/stores/scope.svelte'
import { workspaceState } from '$lib/stores/workspace.svelte'
import { APP_SLUG } from '$shared/brand'
import { DEFAULT_SCOPE_BUCKET_ID } from '$shared/types'
import type {
  ScopeWorktreeCreateInput,
  ScopeWorktreeProgress,
  ScopeWorktreeProgressEvent
} from '$shared/types'

export type ScopeJobKind = 'create' | 'adopt' | 'agent' | 'remove'
export type ScopeJobStatus = 'running' | 'succeeded' | 'failed'
/** Who started a worktree run: the user in this window, or an agent turn. */
export type ScopeJobOrigin = 'user' | 'agent'

/** Ordered steps of a managed-worktree run, as shown in the panel checklist. */
export const SCOPE_WORKTREE_STAGES = [
  'naming',
  'discovering-repository',
  'creating-worktree',
  'persisting-association',
  'environment',
  'setup'
] as const

export type ScopeWorktreeStage = (typeof SCOPE_WORKTREE_STAGES)[number]

/**
 * Ordered steps of removing a scope. They are the renderer's own steps: the
 * thread disposition, the checkout removal and the record removal happen in
 * that order across two IPC calls, so the run reports them itself instead of
 * waiting for progress main never sends.
 */
export const SCOPE_REMOVAL_STAGES = ['threads', 'worktree', 'scope'] as const

export type ScopeRemovalStage = (typeof SCOPE_REMOVAL_STAGES)[number]

/** Every step a job can sit on. The checklist compares steps by id, never by index. */
export type ScopeJobStepId = ScopeWorktreeStage | ScopeRemovalStage

/** One checklist line: a stable id plus the sentence it renders. */
export interface ScopeJobStep {
  id: ScopeJobStepId
  label: string
}

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
  return (SCOPE_WORKTREE_STAGES as readonly string[]).includes(stage)
}

/**
 * What the panel and the dock chip say the run is doing right now. A worktree
 * run reports the stage main streamed; a removal run reports the step it is on,
 * because nothing streams its progress.
 */
export function scopeJobStatusLabel(job: ScopeJob): string {
  if (job.status === 'succeeded') return job.kind === 'remove' ? 'Deleted' : 'Ready'
  if (job.status === 'failed') return 'Failed'
  if (job.stage) return scopeJobStageLabel(job.stage.stage)
  return job.steps.find((step) => step.id === job.activeStepId)?.label ?? 'Working'
}

export interface ScopeJob {
  id: string
  projectId: string
  /** Bucket the job belongs to; null until a brand new scope's bucket exists. */
  scopeBucketId: string | null
  kind: ScopeJobKind
  /** Who started the run, so the panel can say an agent did it. */
  origin: ScopeJobOrigin
  /** Scope display name, used by the panel header and the dock chip. */
  title: string
  /** Whether the run creates or adopts an isolated Git worktree. */
  isolated: boolean
  /** Steps this run actually goes through, in order. */
  steps: readonly ScopeJobStep[]
  /** Last stage main streamed for a worktree run; null when the run has none. */
  stage: ScopeWorktreeProgress | null
  /** Step the run is on right now, or the step it stopped on. */
  activeStepId: ScopeJobStepId | null
  /** Step the run failed on, so the checklist can mark where it stopped. */
  failedStepId: ScopeJobStepId | null
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

export interface ScopeCreateJobInput extends ScopeWorktreeCreateInput {
  /** Whether an isolated worktree is requested; shared-directory scopes skip setup entirely. */
  isolated: boolean
}

export interface ScopeCreateJobOptions {
  /** Set when the worktree is created for a scope that already exists. */
  existingBucketId?: string | null
  onCreated?: (bucketId: string) => void
}

export interface ScopeRemoveJobInput {
  bucketId: string
  /** Scope display name, as the confirmation showed it. */
  title: string
  /** Whether the scope owns a managed worktree checkout to remove. */
  isolated: boolean
  /** Delete the scope's threads instead of returning them to Default. */
  deleteThreads: boolean
}

export interface ScopeRemoveJobOptions {
  /** Handoff once the scope is gone (point the scoped sidebar away from it). */
  onRemoved?: (bucketId: string) => void
}

/** The step a job is sitting on, or the step it failed on. */
export function scopeJobActiveStepId(job: ScopeJob): ScopeJobStepId | null {
  if (job.failedStepId) return job.failedStepId
  if (!job.activeStepId) return null
  return job.steps.some((step) => step.id === job.activeStepId) ? job.activeStepId : null
}

/** Steps a managed-worktree run goes through, minus the ones it will skip. */
function worktreeSteps(runSetup: boolean): readonly ScopeJobStep[] {
  const stages = runSetup
    ? SCOPE_WORKTREE_STAGES
    : SCOPE_WORKTREE_STAGES.filter((step) => step !== 'setup')
  return stages.map((stage) => ({ id: stage, label: scopeJobStageLabel(stage) }))
}

/** The one step a scope that shares the project directory goes through. */
const SHARED_SCOPE_STEPS: readonly ScopeJobStep[] = [
  { id: 'naming', label: scopeJobStageLabel('naming') }
]

/**
 * Steps removing a scope goes through. A managed scope has a checkout to remove
 * as well, and the thread disposition is named for what the user chose, so the
 * checklist states the outcome rather than a generic "handling threads".
 */
function removalSteps(isolated: boolean, deleteThreads: boolean): readonly ScopeJobStep[] {
  const steps: ScopeJobStep[] = [
    {
      id: 'threads',
      label: deleteThreads ? 'Deleting the scope’s threads' : 'Moving its threads to Default'
    }
  ]
  if (isolated) steps.push({ id: 'worktree', label: 'Removing the worktree and its branch' })
  steps.push({ id: 'scope', label: 'Removing the scope from the board' })
  return steps
}

class ScopeJobStore {
  jobs = $state<ScopeJob[]>([])
  /** True once the app-lifetime progress listener is attached. */
  #listening = false

  /**
   * Listen for worktree progress from app start, not from the first local job:
   * an agent's run has no renderer-owned record until its first progress event,
   * and that event is what mints one here so the run is visible while it works.
   * The store is a module singleton living as long as the window, so nothing
   * ever needs to detach it; the flag only keeps the call idempotent.
   */
  listen(): void {
    if (this.#listening) return
    this.#listening = true
    subscribe('scope:worktree:progress', (event) => this.#applyProgress(event))
  }

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
      steps: input.isolated ? worktreeSteps(input.runSetup) : SHARED_SCOPE_STEPS,
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

  /**
   * Remove a scope: settle its threads, remove its managed checkout (when it
   * has one) and drop the record. The removal is destructive and confirmed
   * before this runs, but it is also long, because every thread crosses one IPC
   * and the checkout removal runs Git in the project root. So it runs as a dock
   * job the user can background instead of a dialog they have to sit through.
   */
  remove(
    projectId: string,
    input: ScopeRemoveJobInput,
    options: ScopeRemoveJobOptions = {}
  ): string {
    const job = this.#push({
      projectId,
      scopeBucketId: input.bucketId,
      kind: 'remove',
      title: input.title,
      isolated: input.isolated,
      steps: removalSteps(input.isolated, input.deleteThreads),
      setupCommandCount: 0
    })
    void this.#runRemove(job.id, projectId, input, options)
    return job.id
  }

  /** Whether a removal is already running for one scope, so a second is refused. */
  isRemoving(projectId: string, bucketId: string): boolean {
    return this.jobs.some(
      (job) =>
        job.kind === 'remove' &&
        job.status === 'running' &&
        job.projectId === projectId &&
        job.scopeBucketId === bucketId
    )
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

  async #runRemove(
    id: string,
    projectId: string,
    input: ScopeRemoveJobInput,
    options: ScopeRemoveJobOptions
  ): Promise<void> {
    try {
      // Threads go first: a scope's threads hold the checkout, and main refuses
      // a destructive lifecycle step while a process is still live in it.
      this.#advance(id, 'threads')
      await this.#settleThreads(projectId, input.bucketId, input.deleteThreads)
      if (input.isolated) {
        this.#advance(id, 'worktree')
        // The token is minted here rather than reusing the dialog's display
        // preflight, so it is fresh at the moment of confirmation.
        const preflight = await scopeState.preflightWorktree(
          projectId,
          input.bucketId,
          'delete-scope'
        )
        await scopeState.confirmDeleteScope(
          projectId,
          input.bucketId,
          preflight.confirmationId,
          true
        )
      } else {
        await scopeState.removeBucket(input.bucketId)
      }
      this.#advance(id, 'scope')
      this.#finish(id, 'succeeded')
      // Pointing the scoped sidebar away from a scope that no longer exists is
      // navigation, not removal: it runs after the job is settled and can never
      // flip it back to failed.
      try {
        options.onRemoved?.(input.bucketId)
      } catch {
        // The scope is gone; a failed handoff only leaves the sidebar stale.
      }
    } catch (cause) {
      this.#fail(id, cause, 'The scope could not be deleted.')
    }
  }

  /**
   * Delete a scope's threads, or return them to Default, exactly as the
   * confirmation chose. Threads of the target project that the board cannot
   * resolve (their bucket is already gone) are left alone.
   */
  async #settleThreads(projectId: string, bucketId: string, deleteThreads: boolean): Promise<void> {
    const affected = scopeState.allScopeThreads.filter(
      (thread) =>
        thread.projectId === projectId &&
        !thread.archived &&
        scopeState.bucketForThread(thread) === bucketId
    )
    if (affected.length === 0) return
    if (deleteThreads) {
      await Promise.all(
        affected.map((thread) => invoke('thread:delete', thread.projectId, thread.id))
      )
      for (const thread of affected) {
        scopeState.removeThread(thread.id)
        if (workspaceState.selectedThread?.id === thread.id) workspaceState.clearThread()
      }
      return
    }
    const reassigned = await Promise.all(
      affected.map((thread) =>
        invoke('thread:update', thread.projectId, thread.id, {
          scopeBucketId: DEFAULT_SCOPE_BUCKET_ID
        })
      )
    )
    for (const thread of reassigned) {
      scopeState.updateThread(thread)
      workspaceState.updateThread(thread)
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
    origin?: ScopeJobOrigin
    title: string
    isolated: boolean
    steps: readonly ScopeJobStep[]
    setupCommandCount: number
    minimized?: boolean
  }): ScopeJob {
    const job: ScopeJob = {
      id: crypto.randomUUID(),
      projectId: input.projectId,
      scopeBucketId: input.scopeBucketId,
      kind: input.kind,
      origin: input.origin ?? 'user',
      title: input.title,
      isolated: input.isolated,
      steps: input.steps,
      stage: null,
      // A run starts on its first step, so the checklist reads "in progress" from
      // the moment the panel appears instead of waiting for the first event.
      activeStepId: input.steps[0]?.id ?? null,
      failedStepId: null,
      status: 'running',
      error: null,
      setupCommandCount: input.setupCommandCount,
      result: null,
      minimized: input.minimized ?? false,
      startedAt: Date.now(),
      finishedAt: null
    }
    this.jobs = [...this.jobs, job]
    return job
  }

  /** Mark one renderer-driven step as the one the run is on now. */
  #advance(id: string, step: ScopeJobStepId): void {
    this.#patch(id, { activeStepId: step })
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

  #applyProgress(event: ScopeWorktreeProgressEvent): void {
    const running = this.jobs.filter(
      (job) =>
        job.status === 'running' &&
        job.projectId === event.projectId &&
        // A removal never streams worktree stages, so it must never absorb them.
        job.kind !== 'remove'
    )
    // Exact bucket match first: the worktree service serialises one job per
    // project, so a queued sibling job must never steal the live stages.
    const job =
      running.find((candidate) => candidate.scopeBucketId === event.scopeBucketId) ??
      running.find((candidate) => candidate.scopeBucketId === null) ??
      this.#mintAgentJob(event)
    if (!job) return
    const stage: ScopeWorktreeProgress = {
      stage: event.stage,
      ...(event.detail === undefined ? {} : { detail: event.detail })
    }
    if (event.stage === 'failed') {
      // `failed` names no step of its own; keep the step it interrupted so the
      // checklist can mark where the run stopped.
      this.#patch(job.id, { stage, failedStepId: scopeJobActiveStepId(job) })
      return
    }
    if (event.stage === 'done') {
      this.#patch(job.id, { stage })
      return
    }
    this.#patch(job.id, {
      stage,
      activeStepId: isWorktreeStage(event.stage) ? event.stage : job.activeStepId,
      failedStepId: null
    })
  }

  /**
   * A worktree run an agent started has no job record in this window, so its
   * first progress event mints one: the run is app-owned work and must be
   * visible (and pinnable from the dock) while it runs, exactly like a run the
   * user started here. It lands minimized because an agent run is news, not a
   * panel the user just opened.
   */
  #mintAgentJob(event: ScopeWorktreeProgressEvent): ScopeJob | null {
    if (event.origin !== 'agent') return null
    return this.#push({
      projectId: event.projectId,
      scopeBucketId: event.scopeBucketId,
      kind: 'agent',
      origin: 'agent',
      title: event.title?.trim() || 'Worktree run',
      isolated: true,
      steps: worktreeSteps(true),
      setupCommandCount: 0,
      minimized: true
    })
  }
}

export const scopeJobs = new ScopeJobStore()
