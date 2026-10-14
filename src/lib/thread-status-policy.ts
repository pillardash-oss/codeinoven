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
 * Whether a settled thread may be pushed back to unread from a thread actions
 * menu. Only the two outcomes that end a run qualify: `completed` and `failed`.
 * A live status still has work in flight, and `spec` or `awaiting_approval`
 * ("Needs attention") are states the app keeps and never evicts, so unread is
 * not the same thing and neither may be flipped. `interrupted` is likewise out:
 * the user stopped that run on purpose, which unread would only obscure.
 *
 * This mirrors the terminal-outcome split the assistant reports use; see
 * `assistantReportIsTerminal` in `src/lib/assistant-reports.ts`.
 */
export function canMarkThreadUnread(status: ThreadStatus): boolean {
  return status === 'completed' || status === 'failed'
}

/**
 * Whether a settled thread reads as unread until the user opens it.
 *
 * A `completed` or `failed` thread the user has not read shows the unread dot
 * and sits in the Unread slice, exactly as it did the moment the run settled.
 * A run that failed while the user was away and a thread they pushed back to
 * unread from its actions menu are therefore the same, and neither hides behind
 * a Done or Error badge until it is actually opened.
 *
 * `read` is the caller's resolved read state, so a surface that folds in
 * orchestration children passes its own `effectiveRead`.
 */
export function settledThreadReadsUnread(thread: Thread, read: boolean): boolean {
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
