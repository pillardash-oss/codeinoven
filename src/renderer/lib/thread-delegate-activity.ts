import {
  isOrchestrationChildThread,
  isPawnWorkerThread,
  isThreadWorking,
  isWorkflowCoordinatorThread,
  type Thread
} from '$shared/types'

/**
 * "Does this thread own work that is running right now?", answered from an index.
 *
 * The rule itself is `coordinatorHasActiveDelegates`, and it is the right rule:
 * a coordinator's own harness turn is idle between hand-offs, so its row has to
 * pulse while its workers run. The cost was in how it answered. It asked
 * "is any thread working for me?" by scanning the scope's whole thread list, and
 * every row of every sidebar asks it, on every render, for every status count
 * too. On a real account that is a scan of roughly eight hundred threads
 * repeated a hundred times per update, and it measured 14-29 ms per pass inside
 * a click that only had 130 ms to spare.
 *
 * So the scope's thread list is read once into the few facts the rule needs, and
 * each row then answers in constant time. Nothing about the answer changes: the
 * index is built from the same predicates, and a guard test proves it agrees with
 * the reference implementation thread for thread.
 */

interface DelegateActivity {
  /** Threads producing work, by id. */
  workingIds: Set<string>
  /** Owners holding a working pawn: every thread may own one. */
  pawnOwners: Set<string>
  /** Coordinators a working child points at. */
  childOwners: Set<string>
  /** Assignment ids with at least one working child. */
  workingAssignmentIds: Set<string>
}

function buildDelegateActivity(threads: readonly Thread[]): DelegateActivity {
  const activity: DelegateActivity = {
    workingIds: new Set<string>(),
    pawnOwners: new Set<string>(),
    childOwners: new Set<string>(),
    workingAssignmentIds: new Set<string>()
  }
  for (const thread of threads) {
    if (!isThreadWorking(thread)) continue
    activity.workingIds.add(thread.id)
    const owner = thread.coordinatorThreadId
    // A thread is never its own delegate: the reference rule excludes the
    // coordinator from its own scan, and a self-parented row would otherwise
    // read as permanently working.
    if (owner !== undefined && owner !== thread.id) {
      activity.childOwners.add(owner)
      if (isPawnWorkerThread(thread, owner)) activity.pawnOwners.add(owner)
    }
    if (isOrchestrationChildThread(thread) && thread.assignmentId !== undefined) {
      activity.workingAssignmentIds.add(thread.assignmentId)
    }
  }
  return activity
}

let cachedThreads: readonly Thread[] | null = null
let cachedActivity: DelegateActivity | null = null

/**
 * The index for one scope thread list.
 *
 * Keyed by array identity on purpose: the scope store publishes a new array
 * whenever a thread changes, and reusing the same array means nothing in it
 * changed. The list is replaced far more often than it is read across scopes, so
 * one slot is both smaller and faster than a map keyed by list.
 */
export function delegateActivityFor(threads: readonly Thread[]): DelegateActivity {
  if (cachedThreads === threads && cachedActivity !== null) return cachedActivity
  cachedThreads = threads
  cachedActivity = buildDelegateActivity(threads)
  return cachedActivity
}

/**
 * `coordinatorHasActiveDelegates`, answered from the shared index.
 *
 * Same answer as the scan, one pass instead of one scan per row.
 */
export function delegatesWorking(coordinator: Thread, threads: readonly Thread[]): boolean {
  const activity = delegateActivityFor(threads)
  const isCoordinator = isWorkflowCoordinatorThread(coordinator)
  // An Independent Audit runs on a dedicated (hidden) auditor thread even
  // though its parent is a plain thread without a coordinator role: the parent
  // row must still pulse while that auditor works.
  const isAuditParent = coordinator.independentAudit === true
  if ((isCoordinator || isAuditParent) && coordinator.auditState === 'running') return true
  // A pawn is a thread of its own, and any thread may own one.
  if (activity.pawnOwners.has(coordinator.id)) return true
  if (!isCoordinator && !isAuditParent) return false
  if (activity.childOwners.has(coordinator.id)) return true
  const auditorId = coordinator.auditorThreadId
  if (
    auditorId !== undefined &&
    auditorId !== coordinator.id &&
    activity.workingIds.has(auditorId)
  ) {
    return true
  }
  const assignmentId = coordinator.assignmentId
  return assignmentId !== undefined && activity.workingAssignmentIds.has(assignmentId)
}
