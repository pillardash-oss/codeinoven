import { generateId } from '../utils'
import type { CreateThreadInput, Thread } from '../types'
import type { ProjectRepo } from '../../main/database/repositories/project-repo'
import type { ThreadRepo } from '../../main/database/repositories/thread-repo'
import {
  bucketForThread,
  countThreadsInBucket,
  evictableInBucket,
  scopedBucketIdsFromBoard
} from './thread-manager-capacity'
import type { ScopeManager } from './scope-manager'
import type { ThreadScopeBindingService } from './thread-manager-scope-binding'

/**
 * How many eviction candidates one create may try before it gives up for that
 * create. Eviction walks the bucket oldest-first and already tolerates a thread
 * it cannot delete, so this bound only keeps a systemic failure (a database that
 * is refusing writes, a driver that is gone) from turning thread creation into a
 * long loop over every thread the bucket holds.
 */
const EVICTION_CANDIDATES_PER_CREATE = 5

/**
 * What a create's background capacity eviction did.
 *
 * Deletion is best-effort by design: the new thread is already persisted when
 * this runs, and a failure is reported, never thrown. `failedIds` names every
 * candidate whose deletion failed, so an undeletable thread stays visible even
 * when a later candidate made room.
 */
export interface ThreadEvictionOutcome {
  /** Candidate ids whose deletion failed, oldest first. */
  failedIds: string[]
  /** Id of the thread that was deleted, when one was. */
  evictedId?: string
  /** The most recent deletion failure, for the audit log. */
  error?: unknown
}

/**
 * Raised when `createThread` is asked to exceed a project's thread limit while
 * every active thread is protected from automatic cleanup. Deliberately
 * explicit: no thread is silently deleted and no thread is silently created
 * past the bound.
 */
export class AllThreadsProtectedError extends Error {
  constructor(
    readonly projectId: string,
    readonly limit: number,
    readonly activeCount: number
  ) {
    super(
      `Cannot create a thread: every active thread is pinned or in spec status (${activeCount}/${limit}). ` +
        'Move a thread out of spec, unpin it, or delete an existing thread first.'
    )
    this.name = 'AllThreadsProtectedError'
  }
}

/** @deprecated Use `AllThreadsProtectedError`. */
export const AllThreadsPinnedError = AllThreadsProtectedError

/**
 * Owns thread creation: turning a `CreateThreadInput` into the row that is
 * announced, binding it to its scope's authoritative root, and keeping the
 * project's thread bound through one bounded, best-effort eviction.
 *
 * Creation is the one place where capacity is enforced, so the bucket rules and
 * the eviction sweep live together here instead of in the manager, which only
 * exposes the synchronous and split forms to its callers.
 */
export class ThreadCreationService {
  /**
   * @param deleteThread The manager's own deletion path. Eviction must tear a
   * thread down exactly as a user delete does, so it goes through the manager
   * rather than issuing its own cleanup.
   */
  constructor(
    private readonly threadRepo: ThreadRepo,
    private readonly projectRepo: ProjectRepo,
    private readonly scopeManager: ScopeManager,
    private readonly scopeBinding: ThreadScopeBindingService,
    private readonly deleteThread: (projectId: string, threadId: string) => Promise<void>
  ) {}

  async create(input: CreateThreadInput): Promise<Thread> {
    const { thread, finalize } = this.prepare(input)
    await finalize()
    return thread
  }

  /**
   * Split the create so the renderer-facing path can return the thread
   * immediately and finalize persistence in the background:
   *
   * - The synchronous half only builds the thread object and stable id.
   * - The `finalize` half validates the project, enforces capacity, performs
   *   the lazy eviction, and persists the row through the database worker.
   *   Eviction failure never breaks the new thread; it is surfaced through
   *   `onEviction` so the caller can audit it while the create proceeds.
   */
  prepare(
    input: CreateThreadInput,
    options: { onEviction?: (outcome: ThreadEvictionOutcome) => void } = {}
  ): { thread: Thread; finalize: () => Promise<void> } {
    const creatingOrchestrationChild =
      input.assignmentRole === 'worker' ||
      input.achievementRole === 'auditor' ||
      input.coordinatorThreadId !== undefined
    const id = input.id ?? generateId()
    const now = Date.now()

    const thread: Thread = {
      id,
      projectId: input.projectId,
      providerId: input.providerId,
      title: input.title,
      titleSource: input.titleSource ?? 'default',
      status: 'created',
      // An assistant's knowledge ("Getting started") thread is always pinned: pinning is
      // what keeps it out of automatic eviction, and the invariant lives here so
      // no caller can create it unpinned.
      pinned: input.assistantGettingStarted === true,
      archived: false,
      read: true,
      settings: input.settings,
      featureSlug: input.featureSlug,
      scopeBucketId: input.scopeBucketId,
      // A bound scope is part of the created row itself for the same reason the
      // assistant fields are: the creation broadcast carries this object, and a
      // binding written afterwards would be wiped by that payload.
      boundScope: input.boundScope,
      runBase: input.runBase,
      dispatchOrigin: input.dispatchOrigin,
      assignmentId: input.assignmentId,
      assignmentRole: input.assignmentRole,
      assignmentTaskId: input.assignmentTaskId,
      coordinatorThreadId: input.coordinatorThreadId,
      achievementRole: input.achievementRole,
      auditorThreadId: input.auditorThreadId,
      userInputLocked: input.userInputLocked,
      // Always a boolean, matching what a read returns for the column.
      engineering: input.engineering === true,
      // Assistant-space fields must be part of the created row itself: the
      // creation broadcast carries this object, so grouping a task after the
      // fact would be wiped by the very next thread:updated payload.
      assistantId: input.assistantId,
      assistantIconType: input.assistantIconType,
      assistantIcon: input.assistantIcon,
      // A group's participants must be part of the created row for the same
      // reason: the creation broadcast carries this object, and a group that
      // only reached the database would render as a single-assistant thread
      // until the next reload. The orchestrator's conversation is the first
      // group, so without this every Don message reads as a project turn.
      ...(input.groupParticipants && input.groupParticipants.length > 0
        ? { groupParticipants: input.groupParticipants }
        : {}),
      ...(input.groupTitle ? { groupTitle: input.groupTitle } : {}),
      // Kept out of the row when absent: the repository stores only the true
      // case, so the in-memory shape must match what a read returns.
      ...(input.assistantGettingStarted ? { assistantGettingStarted: true } : {}),
      // A run thread carries the task it runs from creation: the creation
      // broadcast is what the sidebar nests rows from.
      ...(input.assistantTaskId ? { assistantTaskId: input.assistantTaskId } : {}),
      // The repository stores an absent override as NULL and reads it back as
      // `undefined`, so the in-memory row must use the same shape.
      scheduleOverride: input.scheduleOverride ?? undefined,
      scheduled: input.scheduled,
      createdAt: now,
      updatedAt: now,
      lastActivity: now,
      workingDirectory: input.workingDirectory ?? ''
    }

    const finalize = async (): Promise<void> => {
      // Project validation and capacity reads are deliberately inside the
      // async half. Renderer-facing creates can return the stable thread id
      // before either SQLite query begins, while internal callers still await
      // this function and receive the same deterministic errors.
      const project = await this.projectRepo.getViaWorker(input.projectId)
      if (!project) {
        throw new Error(`Project not found: ${input.projectId}`)
      }
      // A binding names a checkout, so both halves must still exist: an unknown
      // project or a bucket that has left the board would resolve to nothing and
      // silently point every evidence surface at no repository at all.
      if (input.boundScope) await this.scopeBinding.assertBoundScopeTarget(input.boundScope)
      const scopedBuckets = scopedBucketIdsFromBoard(
        await this.scopeManager.getBoardSnapshot(input.projectId)
      )
      // The new thread lands in its own bucket: either its pinned-like scope's
      // bucket or the shared regular bucket. Capacity is enforced per bucket,
      // so eviction only ever displaces threads from the same bucket.
      const newThreadBucket = bucketForThread({ scopeBucketId: input.scopeBucketId }, scopedBuckets)
      const active = await this.threadRepo.listCapacityCandidatesViaWorker(input.projectId)
      const bucketCount = countThreadsInBucket(active, scopedBuckets, newThreadBucket)
      let evictionCandidateIds: string[] = []
      if (!creatingOrchestrationChild && bucketCount >= project.threadLimit) {
        evictionCandidateIds = evictableInBucket(active, scopedBuckets, newThreadBucket)
          .slice(0, EVICTION_CANDIDATES_PER_CREATE)
          .map((candidate) => candidate.id)
        if (evictionCandidateIds.length === 0) {
          throw new AllThreadsProtectedError(input.projectId, project.threadLimit, bucketCount)
        }
      }

      // The new thread lands first so the optimistic create always yields a
      // persisted row; the bounded bucket delete is best-effort cleanup that
      // must never roll back the creation it is making room for.
      // A bound task's directory is its bound scope's, resolved by the same
      // authority every project thread uses. The home container never wins:
      // falling back to assistant storage is exactly the behaviour the park
      // gate exists to prevent.
      if (input.boundScope) {
        await this.scopeBinding.resolveBoundCompatibilityRoot(input.boundScope, thread)
      }
      await this.scopeBinding.resolveCompatibilityRoot(input.projectId, input.scopeBucketId, thread)
      await this.threadRepo.upsertViaWorker(thread)
      if (evictionCandidateIds.length > 0) {
        // The outcome is evaluated before the optional call. An absent callback
        // skips only the report, never the eviction itself.
        const outcome = await this.evictOldestDeletable(input.projectId, evictionCandidateIds)
        options.onEviction?.(outcome)
      }
    }

    return { thread, finalize }
  }

  /**
   * Delete the oldest candidate that can actually be deleted.
   *
   * Capacity is an invariant of the app (docs/APP-BIBLE.md, "Bounded resources"),
   * so a thread whose deletion fails must not be able to hold the project above
   * its bound forever: eviction keeps the bucket's order and moves on to the
   * next candidate, while every failure is returned to the caller so the
   * undeletable thread is auditable instead of silent. The caller bounds the
   * list, so one sweep is always short and thread creation never waits on it.
   */
  private async evictOldestDeletable(
    projectId: string,
    candidateIds: readonly string[]
  ): Promise<ThreadEvictionOutcome> {
    const failedIds: string[] = []
    let error: unknown
    for (const candidateId of candidateIds) {
      try {
        await this.deleteThread(projectId, candidateId)
        return { failedIds, evictedId: candidateId, ...(error === undefined ? {} : { error }) }
      } catch (failure) {
        failedIds.push(candidateId)
        error = failure
      }
    }
    return { failedIds, ...(error === undefined ? {} : { error }) }
  }
}
