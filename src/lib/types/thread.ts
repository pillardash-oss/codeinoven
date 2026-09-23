import type { ScopeSlice } from './scope'
import type { ThreadSettings } from './agent'
import { workerReportsToCoordinator } from './agent'
import type { ThreadContextUsage } from './usage'
import type { RoutineSchedule } from './schedule'
import { ASSISTANT_SPACE_ID } from './project'

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

  // ─── Assistant task fields (assistant space only) ────────────────────────
  /** Routine this assistant task belongs to, when it is grouped. */
  routineId?: string
  /** Custom icon key shown in the task row's provider-icon slot. */
  assistantIconType?: string
  /** Custom image filename shown in the task row's provider-icon slot. */
  assistantIcon?: string
  /** Per-task schedule override; falls back to the routine schedule when undefined. */
  scheduleOverride?: RoutineSchedule | null
  /** Epoch ms of the last scheduled run fired on this task. */
  lastRunAt?: number
  /** Epoch ms of the last run that finished successfully (a `completed` turn). */
  lastSuccessAt?: number
  /**
   * The routine's seed task: the "Getting started" conversation where the
   * how-to is authored. It carries a fixed title and runs no auxiliary work
   * (auto-title, memory extraction), so its first exchange stays a pure
   * planning chat rather than a task run.
   */
  assistantGettingStarted?: boolean

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

/** A thread that lives in the assistant space (a routine task). */
export function isAssistantThread(thread: Thread): boolean {
  return thread.projectId === ASSISTANT_SPACE_ID
}

/**
 * Whether a thread is a routine's "Getting started" authoring thread. Auxiliary
 * work   prompt-derived titles and memory extraction   is suppressed on it.
 */
export function isAssistantSetupThread(
  thread: Pick<Thread, 'assistantGettingStarted'>
): boolean {
  return thread.assistantGettingStarted === true
}

/**
 * A worker or auditor thread owned by an Achievement/Assignment coordinator
 * (the Sr. Engineer). These threads are orchestration internals: they never
 * notify on their own, are hidden from the regular projects/threads surfaces,
 * and surface only inside their scoped container (scope board) and the
 * coordinator panels. The coordinator thread itself is always a normal,
 * user-facing thread and never matches this predicate.
 */
/**
 * Whether the thread is the Sr. Engineer of a coordinated workflow   an
 * Assignment coordinator or an Achievement coordinator. Such a thread is the
 * root of a workflow group: it owns its worker/auditor children, and the whole
 * group is one unit of instance ownership (see `workflowGroupThreads`).
 */
export function isWorkflowCoordinatorThread(thread: Thread | null | undefined): boolean {
  return thread?.assignmentRole === 'coordinator' || thread?.achievementRole === 'coordinator'
}

export function isOrchestrationChildThread(thread: Thread): boolean {
  if (isWorkflowCoordinatorThread(thread)) {
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
 * Whether a thread participates in read/unread tracking. Every regular thread
 * does. Among orchestration children only a worker whose reporting the user
 * switched off does: a reporting worker hands its finished task back to the
 * Sr. Engineer, so the Assignment lifecycle (reported, auditing, rework) is its
 * indicator and it never carries a read state. Auditors are silent the same
 * way. The coordinator panel chip and the aggregated coordinator row read a
 * non-reporting worker's read state from here.
 */
export function threadTracksReadStatus(thread: Thread): boolean {
  if (!isOrchestrationChildThread(thread)) return true
  return thread.assignmentRole === 'worker' && !workerReportsToCoordinator(thread.settings)
}

/**
 * Whether the coordinator row must still read as unread because one of its
 * workers has not been read yet. Only non-reporting workers hold the dot open:
 * a reporting worker's progress is visible through the Assignment lifecycle
 * instead. The row clears only once the coordinator itself and every one of
 * its non-reporting workers is read.
 */
export function coordinatorHasUnreadWorkers(
  coordinator: Thread,
  threads: readonly Thread[]
): boolean {
  if (coordinator.assignmentId === undefined && coordinator.assignmentRole !== 'coordinator') {
    return false
  }
  return threads.some(
    (candidate) =>
      candidate.coordinatorThreadId === coordinator.id &&
      threadTracksReadStatus(candidate) &&
      !candidate.read
  )
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
  const isOrchestrationCoordinator = isWorkflowCoordinatorThread(coordinator)
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

/**
 * The thread whose row stands for the open thread. A worker or auditor child
 * never appears in the sidebar, so its coordinator (the Sr. Engineer) row
 * represents it: the parent stays visible and reads as the active row while
 * the user works inside the child.
 */
export function activeThreadRowId(thread: Thread | null | undefined): string | null {
  if (!thread) return null
  if (isOrchestrationChildThread(thread) && thread.coordinatorThreadId) {
    return thread.coordinatorThreadId
  }
  return thread.id
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
  routineId?: string
  assistantIconType?: string
  assistantIcon?: string
  scheduleOverride?: RoutineSchedule | null
  assistantGettingStarted?: boolean
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
  /** Whether this run belongs to a coordinated workflow. A workflow is one unit
   *  of ownership, so transferring it moves the Sr. Engineer and every worker,
   *  never a single thread. */
  workflow: boolean
}

/**
 * Outcome of moving a foreign run to this instance.
 *
 * `ok: false` always carries a user-facing reason, because the only caller is a
 * window asking to take over a run it cannot see, and a silent failure would
 * leave the transfer card stuck with no explanation.
 */
export type ThreadTransferResult = { ok: true } | { ok: false; reason: string }

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
