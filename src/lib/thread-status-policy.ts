import type { ScopeSlice, ThreadStatus } from './types'
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
