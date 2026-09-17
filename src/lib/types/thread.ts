import type { ScopeSlice } from './scope'
import type { ThreadSettings } from './agent'
import type { ThreadContextUsage } from './usage'

/** Placeholder title for threads that have not been auto-titled yet. */
export const DEFAULT_THREAD_TITLE = 'New Thread'

export type ThreadStatus =
  | 'created'
  | 'planning'
  | 'awaiting_approval'
  | 'spec'
  | 'executing'
  | 'working-paused'
  | 'interrupted'
  | 'completed'
  | 'failed'

import {
  isThreadBusyStatus,
  isThreadExecutionActiveStatus,
  isThreadRetryPausedStatus,
  threadStatusPolicy
} from '../thread-status-policy'

export function scopeSliceForStatus(status: ThreadStatus): ScopeSlice {
  return threadStatusPolicy(status).scopeSlice
}

export type ThreadTitleSource = 'default' | 'auto' | 'manual'

export interface Thread {
  id: string
  projectId: string
  providerId: string
  title: string
  /** How the title was set; guards against overwriting manual renames. */
  titleSource: ThreadTitleSource
  status: ThreadStatus
  pinned: boolean
  /** Timestamp (ms) when the thread was pinned; pins are ordered newest-first by this. */
  pinnedAt?: number
  /** Position for manual drag-to-reorder; items without sortOrder fall back to lastActivity. */
  sortOrder?: number
  /** Position within its current scope bucket and slice; independent of project ordering. */
  scopeSortOrder?: number
  archived: boolean
  /** Whether the user has viewed this thread since its last activity. */
  read: boolean
  /** Whether the user is actively composing into this thread: typing in the
   *  composer or dictating a voice recording. Persisted edge-triggered so
   *  bounded DB listings always keep a thread that is being drafted, whatever
   *  its age, and other instances can surface it too. */
  drafting?: boolean
  /** Latest committed composer draft (JSON `ComposerDraftEntry` shape),
   *  written ~10s after the last draft activity. Restores drafts across
   *  restarts and surfaces them to other instances. */
  draftJson?: string | null
  /** Git branch associated with this thread, when known. */
  branch?: string
  /** Stable agent-work directory name shared by forks of the same feature. */
  featureSlug?: string
  /** User-defined feature bucket used by the project's Scope board. */
  scopeBucketId?: string
  /** Per-thread agent configuration (harness, model, thinking, permissions). */
  settings?: ThreadSettings
  /** Distinct agent harnesses used across this thread's session, newest first. */
  usedHarnessIds?: string[]
  /** Last-known context/token usage snapshot, for instant meter restore. */
  contextUsage?: ThreadContextUsage
  /** Harness session id bound to this thread, once a conversation has started. */
  sessionId?: string
  /** Harness that created the bound session. A session never moves across
   *  harnesses: even when `settings.harnessId` changes (mid-run switch), this
   *  field keeps identifying the driver that owns `sessionId` so the old
   *  session is read/synced through the correct driver. */
  sessionHarnessId?: string
  /** Account container that owns the bound native session. */
  sessionAccountId?: string
  /** Diagnostic text of the most recent failure (message plus any raw
   *  detail/stack the engine captured). In-memory only: it is never persisted
   *  and exists so error notifications and panels can show what actually went
   *  wrong instead of a generic "hit an error" label. Cleared whenever the
   *  thread leaves the `failed` status. */
  lastError?: string
  /** Last specification card explicitly dismissed by the user. */
  dismissedSpecId?: string
  dismissedSpecVersion?: number
  /** Audit gate for the latest implementation turn. */
  auditState?: 'offered' | 'running' | 'report_ready' | 'reworking'
  /** Independent (spec-less) audit is enabled for this thread. Excludes
   *  engineering modes for the thread's lifetime and is never inherited by
   *  forks or new threads created from this thread. */
  independentAudit?: boolean
  /** Set permanently once the first independent audit run starts; the
   *  composer switch disappears and the audit coordinator stays for the
   *  thread's lifetime. */
  independentAuditInitialized?: boolean
  /** Persisted count of completed Achievement audit cycles. */
  loopIteration?: number
  /** Latest persisted audit report surfaced by the thread. */
  activeAuditId?: string
  activeAuditVersion?: number
  /** Assignment workflow that owns this thread, when it is a coordinator or worker. */
  assignmentId?: string
  /** Role used to scope Assignment orchestration capabilities. */
  assignmentRole?: 'coordinator' | 'worker'
  /** Stable Assignment task identity for a worker or Sr. Engineer turn. */
  assignmentTaskId?: string
  /** Coordinator thread for a durable Assignment worker. */
  coordinatorThreadId?: string
  /** Durable Achievement role when the workflow does not use an Assignment graph. */
  achievementRole?: 'coordinator' | 'auditor'
  /** Durable Auditor owned by this Achievement coordinator. */
  auditorThreadId?: string
  /** Reject renderer-originated prompts while permitting internal orchestration turns. */
  userInputLocked?: boolean

  createdAt: number
  updatedAt: number
  lastActivity: number
  workingDirectory: string
}

/**
 * A private, user-only note attached to a thread. Notes are never included in
 * agent context or prompts   they exist so the user can remind themselves what
 * they intended to do on a thread and return to it later. Deleting the thread
 * deletes its note (ON DELETE CASCADE).
 */
export interface ThreadNote {
  threadId: string
  /** Markdown body of the note. */
  body: string
  createdAt: number
  updatedAt: number
}

/**
 * A worker or auditor thread owned by an Achievement/Assignment coordinator
 * (the Sr. Engineer). These threads are orchestration internals: they never
 * notify on their own, are hidden from the regular projects/threads surfaces,
 * and surface only inside their scoped container (scope board) and the
 * coordinator panels. The coordinator thread itself is always a normal,
 * user-facing thread and never matches this predicate.
 */
export function isOrchestrationChildThread(thread: Thread): boolean {
  if (thread.achievementRole === 'coordinator' || thread.assignmentRole === 'coordinator') {
    return false
  }
  return (
    thread.achievementRole === 'auditor' ||
    thread.assignmentRole === 'worker' ||
    thread.assignmentId !== undefined ||
    thread.coordinatorThreadId !== undefined
  )
}

/** A harness is actively producing work for this persisted thread. */
export function isThreadWorking(thread: Thread): boolean {
  return isThreadExecutionActiveStatus(thread.status)
}

/** True while the row should continue presenting an in-progress indicator. */
export function isThreadBusy(thread: Thread): boolean {
  return isThreadBusyStatus(thread.status)
}

/** True when the provider is paused until an automatic retry deadline. */
export function isThreadRetryPaused(thread: Thread): boolean {
  return isThreadRetryPausedStatus(thread.status)
}

/**
 * The Sr. Engineer is the public source of truth for delegated work. Its row
 * remains active while any owned worker/auditor is active, even though the
 * coordinator's own harness turn is intentionally idle between handoffs.
 */
export function coordinatorHasActiveDelegates(
  coordinator: Thread,
  threads: readonly Thread[]
): boolean {
  const isOrchestrationCoordinator =
    coordinator.assignmentRole === 'coordinator' || coordinator.achievementRole === 'coordinator'
  // An Independent Audit runs on a dedicated (hidden) auditor thread even
  // though its parent is a plain thread without a coordinator role: the parent
  // row must still pulse while that auditor works.
  const isIndependentAuditParent = coordinator.independentAudit === true
  if (!isOrchestrationCoordinator && !isIndependentAuditParent) {
    return false
  }
  if (coordinator.auditState === 'running') return true
  return threads.some(
    (candidate) =>
      candidate.id !== coordinator.id &&
      isThreadWorking(candidate) &&
      (candidate.coordinatorThreadId === coordinator.id ||
        coordinator.auditorThreadId === candidate.id ||
        (coordinator.assignmentId !== undefined &&
          candidate.assignmentId === coordinator.assignmentId &&
          isOrchestrationChildThread(candidate)))
  )
}

export interface CreateThreadInput {
  id?: string
  projectId: string
  providerId: string
  title: string
  workingDirectory?: string
  settings?: ThreadSettings
  titleSource?: ThreadTitleSource
  featureSlug?: string
  scopeBucketId?: string
  assignmentId?: string
  assignmentRole?: Thread['assignmentRole']
  assignmentTaskId?: string
  coordinatorThreadId?: string
  achievementRole?: Thread['achievementRole']
  auditorThreadId?: string
  userInputLocked?: boolean
}

/** Where a thread search match was found. */
export type ThreadSearchMatchKind = 'title' | 'message'

/** One thread surfaced by full-text search, with the strongest match context. */
export interface ThreadSearchResult {
  thread: Thread
  kind: ThreadSearchMatchKind
  /** Role of the best matching message, present for message matches. */
  role?: 'user' | 'assistant'
  /** Excerpt of the matching conversation content around the match. */
  snippet?: string
  /** Timestamp of the best matching message. */
  timestamp?: number
}

/**
 * A thread whose in-flight turn belongs to a different CodeInOven instance.
 *
 * Two instances share one config root, and therefore one thread table and one
 * `active_turns` ledger, while each process owns only its own harness processes
 * and event stream. A thread can therefore be genuinely working while a window
 * receives none of its output: this notice is that fact, projected for the
 * window that does not own the run.
 */
export interface ForeignRunNotice {
  projectId: string
  threadId: string
}

export type HistoryRole = 'user' | 'assistant' | 'system' | 'tool'

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  result?: string
}

export interface HistoryEntry {
  id: string
  role: HistoryRole
  content: string
  metadata?: {
    toolCalls?: ToolCall[]
    fileRefs?: string[]
    checkpointId?: string
  }
  timestamp: number
}
