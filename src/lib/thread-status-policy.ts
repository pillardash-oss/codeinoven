import type { ScopeSlice, ThreadStatus } from './types'

export type ThreadStatusTone =
  'todo' | 'working' | 'working-paused' | 'attention' | 'spec' | 'done' | 'error'

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
    powerWake: 'none'
  },
  planning: {
    label: 'Planning',
    scopeSlice: 'working',
    tone: 'working',
    executionActive: true,
    busy: true,
    retryPaused: false,
    powerWake: 'active'
  },
  awaiting_approval: {
    label: 'Needs attention',
    scopeSlice: 'working',
    tone: 'attention',
    executionActive: false,
    busy: false,
    retryPaused: false,
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
    powerWake: 'active'
  },
  'working-paused': {
    label: 'Waiting to retry',
    scopeSlice: 'working',
    tone: 'working-paused',
    executionActive: false,
    busy: true,
    retryPaused: true,
    powerWake: 'retry-window'
  },
  interrupted: {
    label: 'Interrupted',
    scopeSlice: 'done',
    tone: 'done',
    executionActive: false,
    busy: false,
    retryPaused: false,
    powerWake: 'none'
  },
  completed: {
    label: 'Done',
    scopeSlice: 'done',
    tone: 'done',
    executionActive: false,
    busy: false,
    retryPaused: false,
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

export function isThreadBusyStatus(status: ThreadStatus): boolean {
  return threadStatusPolicy(status).busy
}

export function isThreadRetryPausedStatus(status: ThreadStatus): boolean {
  return threadStatusPolicy(status).retryPaused
}
