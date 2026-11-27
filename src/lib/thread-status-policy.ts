import { isGroupDispatchedRun } from './types/thread'
import type { ScopeSlice, Thread, ThreadStatus } from './types'
import { harnessSupportsManualCompaction } from '../main/agents/harness-registry'

export type ThreadStatusTone =
  'todo' | 'working' | 'working-paused' | 'attention' | 'spec' | 'done' | 'error' | 'missed'

export type ThreadStatusNotificationKind = 'completed' | 'attention' | 'spec' | 'error'

export interface ThreadStatusPolicy {
  readonly label: string
  readonly scopeSlice: ScopeSlice
  readonly tone: ThreadStatusTone
  /** True only while a harness is actively producing work. */
  readonly executionActive: boolean
  /** True when the UI should continue showing a loading indicator. */
  readonly busy: boolean
  /** True when a provider retry is pending and no harness work is running. */
  readonly retryPaused: boolean
  /**
   * True while the thread is parked on the user: a permission, question, or
   * secret card is on screen, or a reviewable artifact is waiting on them.
   *
   * No work is being produced in this state, and no activity indicator may
   * claim otherwise. The harness session stays bound (and reports `waiting`)
   * for as long as the gate is open, so a live run flag cannot answer that
   * question while a card waits   this status is the authority, and it stays
   * the authority until the user answers, which is the change that leaves the
   * state.
   */
  readonly awaitingUser: boolean
  /** How power management should account for this state. */
  readonly powerWake: 'active' | 'retry-window' | 'none'
  readonly notificationKind?: ThreadStatusNotificationKind
}

export const THREAD_STATUSES: readonly ThreadStatus[] = [
  'created',
  'planning',
  'awaiting_approval',
  'spec',
  'executing',
  'working-paused',
  'interrupted',
  'completed',
  'failed'
]

export const THREAD_STATUS_POLICY: Readonly<Record<ThreadStatus, ThreadStatusPolicy>> = {
  created: {
    label: 'New',
    scopeSlice: 'todo',
    tone: 'todo',
    executionActive: false,
    busy: false,
    retryPaused: false,
    awaitingUser: false,
    powerWake: 'none'
  },
  planning: {
    label: 'Planning',
    scopeSlice: 'working',
    tone: 'working',
    executionActive: true,
    busy: true,
    retryPaused: false,
    awaitingUser: false,
    powerWake: 'active'
  },
  awaiting_approval: {
    label: 'Needs attention',
    scopeSlice: 'working',
    tone: 'attention',
    executionActive: false,
    busy: false,
    retryPaused: false,
    awaitingUser: true,
    powerWake: 'none',
    notificationKind: 'attention'
  },
  spec: {
    label: 'Spec ready',
    scopeSlice: 'spec',
    tone: 'spec',
    executionActive: false,
    busy: false,
    retryPaused: false,
    awaitingUser: false,
    powerWake: 'none',
    notificationKind: 'spec'
  },
  executing: {
    label: 'Working',
    scopeSlice: 'working',
    tone: 'working',
    executionActive: true,
    busy: true,
    retryPaused: false,
    awaitingUser: false,
    powerWake: 'active'
  },
  'working-paused': {
    label: 'Waiting to retry',
    scopeSlice: 'working',
    tone: 'working-paused',
    executionActive: false,
    busy: true,
    retryPaused: true,
    awaitingUser: false,
    powerWake: 'retry-window'
  },
  interrupted: {
    label: 'Interrupted',
    scopeSlice: 'done',
    tone: 'done',
    executionActive: false,
    busy: false,
    retryPaused: false,
    awaitingUser: false,
    powerWake: 'none'
  },
  completed: {
    label: 'Done',
    scopeSlice: 'done',
    tone: 'done',
    executionActive: false,
    busy: false,
    retryPaused: false,
    awaitingUser: false,
    powerWake: 'none',
    notificationKind: 'completed'
  },
  failed: {
    label: 'Needs attention',
    scopeSlice: 'issue',
    tone: 'error',
    executionActive: false,
    busy: false,
    retryPaused: false,
    awaitingUser: false,
    powerWake: 'none',
    notificationKind: 'error'
  }
}

/**
 * Every status whose scope slice is `done`: the statuses a bounded thread
 * listing is allowed to leave out, because a Threads view always ranks them
 * below the todo and middle buckets.
 */
export const DONE_THREAD_STATUSES: readonly ThreadStatus[] = THREAD_STATUSES.filter(
  (status) => THREAD_STATUS_POLICY[status].scopeSlice === 'done'
)

/**
 * The statuses a coordinator can settle into, after which the threads it
 * spawned are finished business: nothing can resume them (a retry only ever
 * admits a `working-paused` row) and nobody is waiting on their result.
 *
 * `failed` is here rather than in {@link DONE_THREAD_STATUSES} because a failed
 * coordinator is not *done*   it is an issue of its own that the user still has
 * to read   but it settles its children exactly the same way, and the child rows
 * must not outlive it as invisible work.
 */
export const SETTLED_THREAD_STATUSES: readonly ThreadStatus[] = [
  'interrupted',
  'completed',
  'failed'
]

/**
 * Whether a thread may read as unread at all.
 *
 * Unread is reserved for a run that *finished* (`completed`) and that the user
 * has not opened yet: the work is over, the result is waiting, and nothing else
 * is asked of them. A failure is not unread. It is a needs-attention state, and
 * it says so with its own mark, its own group and its own rail pill whether or
 * not the thread was ever opened, so a red row can never hide behind the green
 * unread dot. `interrupted` is out for the same reason (the user stopped that
 * run on purpose), and the live, parked, retrying and spec states are not
 * settled at all.
 *
 * This is the one rule. The view rail's unread count, a project row's state
 * strip, the sidebar's rows and status groups, the scope board's Unread slice,
 * and the "Mark as unread" action all read it, so no surface can call a thread
 * unread while another calls it failed.
 */
export function canMarkThreadUnread(status: ThreadStatus): boolean {
  return status === 'completed'
}

/**
 * How a settled thread reads to the user, as the "Update status" submenu offers
 * it. `unread` is the finished-but-unopened state, `done` the finished-and-read
 * one, and `error` the needs-attention one. Only settled rows have an outcome;
 * live, parked, retrying and spec threads report `null` (see
 * {@link threadSettledOutcome}).
 */
export type ThreadSettledOutcome = 'unread' | 'done' | 'error'

export const THREAD_SETTLED_OUTCOMES: readonly ThreadSettledOutcome[] = ['unread', 'done', 'error']

/**
 * Whether the user may rewrite this thread's outcome from the thread menu.
 *
 * Only a settled row has an outcome to rewrite: a finished run (`completed` or a
 * run the user stopped, `interrupted`) reads done, and a `failed` run reads
 * error. Work still in flight, a run parked on the user, a retry window and a
 * ready spec are all states the app is still driving, so the menu leaves them
 * alone instead of letting a click claim work ended when it has not.
 */
export function canUpdateThreadStatus(status: ThreadStatus): boolean {
  return status === 'completed' || status === 'interrupted' || status === 'failed'
}

/**
 * The outcome a thread currently reads as, or `null` when it has none.
 *
 * Shared by the "Update status" submenu (to mark the current entry) and the
 * status service (to decide which writes change anything), so the checkmark the
 * user sees and the rule the write follows can never disagree.
 */
export function threadSettledOutcome(
  thread: Pick<Thread, 'status' | 'read'>
): ThreadSettledOutcome | null {
  if (thread.status === 'failed') return 'error'
  if (thread.status === 'interrupted') return 'done'
  if (thread.status !== 'completed') return null
  return thread.read ? 'done' : 'unread'
}

/**
 * Whether this thread is parked on `spec` for an independent-audit report rather
 * than for a specification.
 *
 * A ready report parks its thread on `spec`, exactly as a ready specification
 * does, because both are finished artifacts waiting on the user. The audit's own
 * card is the announcement for that landing ("Independent audit ready", naming
 * the auditor's finding), so every surface that would announce "a spec is ready"
 * for the status stands down for this one: two notices for one moment read as
 * two events. The spec-based implementation audit keeps the generic notice   it
 * has no card of its own.
 *
 * `auditState` is part of the test on purpose: dismissing the report clears it
 * while the status stays `spec`, and from that moment the audit card no longer
 * speaks for the thread.
 */
export function threadAwaitsIndependentAuditReview(
  thread: Pick<Thread, 'status' | 'independentAudit' | 'auditState'>
): boolean {
  return (
    thread.status === 'spec' &&
    thread.independentAudit === true &&
    thread.auditState === 'report_ready'
  )
}

/**
 * Whether a settled thread reads as unread until the user opens it.
 *
 * A `completed` thread the user has not read shows the unread dot and sits in
 * the Unread slice, exactly as it did the moment the run settled. A run that
 * failed never does: it reads as an error from the moment it settles, and stays
 * one until the user answers it (see `canMarkThreadUnread`).
 *
 * `read` is the caller's resolved read state, so a surface that folds in
 * orchestration children passes its own `effectiveRead`.
 */
export function settledThreadReadsUnread(
  thread: Pick<Thread, 'status'> & Partial<Pick<Thread, 'dispatchOrigin'>>,
  read: boolean
): boolean {
  // A run a group conversation dispatched reports its answer into that group,
  // which is the row that carries the unread mark. Its own row never claims one:
  // the reader meets the answer where it was asked for, not in the run.
  if (isGroupDispatchedRun(thread)) return false
  return !read && canMarkThreadUnread(thread.status)
}

export function threadStatusPolicy(status: ThreadStatus): ThreadStatusPolicy {
  return THREAD_STATUS_POLICY[status]
}

export function isThreadExecutionActiveStatus(status: ThreadStatus): boolean {
  return threadStatusPolicy(status).executionActive
}

/**
 * Whether a harness supports manual context compaction, straight from its
 * declared harness manifest (`manualCompaction` behavior in the harness
 * registry)   mirrored onto every `ProviderConnectionInfo` by the main
 * process. Unknown harnesses (no manifest entry, no connection info) get the
 * behavior-safe default of `false`.
 */
export function supportsManualCompaction(
  harnessId: string | undefined,
  providers: readonly { id: string; supportsManualCompaction?: boolean }[] = []
): boolean {
  if (harnessId === undefined) return false
  const fromConnection = providers.find((provider) => provider.id === harnessId)
  if (fromConnection) return fromConnection.supportsManualCompaction === true
  return harnessSupportsManualCompaction(harnessId)
}

export function isThreadBusyStatus(status: ThreadStatus): boolean {
  return threadStatusPolicy(status).busy
}

export function isThreadRetryPausedStatus(status: ThreadStatus): boolean {
  return threadStatusPolicy(status).retryPaused
}

/** True while the thread is parked on the user and produces no work. */
export function isThreadAwaitingUserStatus(status: ThreadStatus): boolean {
  return threadStatusPolicy(status).awaitingUser
}
