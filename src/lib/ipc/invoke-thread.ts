import type {
  Checklist,
  ChecklistItem,
  CreateThreadInput,
  ForeignRunNotice,
  HarnessUsage,
  HistoryEntry,
  HistoryRole,
  Plan,
  ScopeSlice,
  TaskManagerSnapshot,
  Thread,
  ThreadContextUsage,
  ThreadMessageCursor,
  ThreadMessagePage,
  ThreadSettings,
  ThreadStatus,
  ThreadTransferResult,
  TurnCheckpointFileDiff,
  TurnCheckpointSummary,
  UsageEfficiencyKpis,
  UserMessageSummary
} from '../types'
import type { Contract } from './contract-helpers'

export const invokeThreadContract = {
  'taskManager:list': {} as Contract<[], TaskManagerSnapshot>,
  'taskManager:killProcess': {} as Contract<[pid: number, force: boolean], void>,
  'temporary-chat:convertToThread': {} as Contract<
    [
      projectId: string,
      threadId: string,
      temporaryChatId: string,
      settings: ThreadSettings,
      title?: string
    ],
    Thread
  >,
  'checklist:generate': {} as Contract<
    [projectId: string, threadId: string, planContent: string],
    Checklist
  >,
  'checklist:get': {} as Contract<[projectId: string, threadId: string], Checklist | null>,
  'checklist:updateItem': {} as Contract<
    [
      projectId: string,
      threadId: string,
      itemId: string,
      status: ChecklistItem['status'],
      evidence?: string
    ],
    Checklist | null
  >,
  'checkpoint:list': {} as Contract<[projectId: string, threadId: string], TurnCheckpointSummary[]>,
  'checkpoint:activeSummary': {} as Contract<
    [projectId: string, threadId: string],
    TurnCheckpointSummary | null
  >,
  'checkpoint:liveDiff': {} as Contract<
    [projectId: string, threadId: string, checkpointId: string, path: string],
    TurnCheckpointFileDiff
  >,
  'checkpoint:diff': {} as Contract<
    [projectId: string, threadId: string, checkpointId: string, path: string],
    TurnCheckpointFileDiff
  >,
  'checkpoint:rollback': {} as Contract<
    [projectId: string, threadId: string, checkpointId: string],
    TurnCheckpointSummary[]
  >,
  'checkpoint:rollbackPaths': {} as Contract<
    [projectId: string, threadId: string, checkpointId: string, paths: string[]],
    TurnCheckpointSummary[]
  >,
  'checkpoint:redoPaths': {} as Contract<
    [projectId: string, threadId: string, checkpointId: string, paths: string[]],
    TurnCheckpointSummary[]
  >,
  'history:search': {} as Contract<
    [query: string, projectId?: string, limit?: number],
    HistoryEntry[]
  >,
  'threads:search': {} as Contract<
    [query: string, options?: { projectId?: string; limit?: number }],
    import('../types').ThreadSearchResult[]
  >,
  'history:append': {} as Contract<
    [
      projectId: string,
      threadId: string,
      role: HistoryRole,
      content: string,
      metadata?: HistoryEntry['metadata']
    ],
    HistoryEntry
  >,
  'history:load': {} as Contract<
    [projectId: string, threadId: string, limit?: number],
    HistoryEntry[]
  >,
  'plan:approve': {} as Contract<[projectId: string, threadId: string], Plan | null>,
  'plan:get': {} as Contract<[projectId: string, threadId: string], Plan | null>,
  'plan:save': {} as Contract<[projectId: string, threadId: string, content: string], Plan>,
  'thread:create': {} as Contract<[input: CreateThreadInput], Thread>,
  'thread:delete': {} as Contract<[projectId: string, threadId: string], void>,
  'thread:dismissSpecReview': {} as Contract<
    [projectId: string, threadId: string, specId: string, specVersion: number],
    Thread
  >,
  'thread:fork': {} as Contract<
    [
      projectId: string,
      threadId: string,
      title: string,
      checkpointId?: string,
      messageId?: string,
      targetProjectId?: string
    ],
    Thread
  >,
  'thread:get': {} as Contract<[projectId: string, threadId: string], Thread | null>,
  'thread:list': {} as Contract<[projectId: string], Thread[]>,
  'thread:listAll': {} as Contract<[], Thread[]>,
  /**
   * Bounded task listing for startup hydration. Never crosses the full task
   * history over IPC.
   * `projectId` (when given) is ordered first so the selected project's recent
   * active threads render before anything else.
   */
  'thread:listRecent': {} as Contract<
    [options: { projectId?: string; limit?: number; offset?: number }],
    Thread[]
  >,
  /** Paged history for an explicit older-task request. */
  'thread:listHistoryPage': {} as Contract<
    [options: { projectId?: string; limit?: number; offset?: number }],
    Thread[]
  >,
  /**
   * Bounded per-project recent threads for first-paint hydration: at most
   * `RECENT_THREADS_PER_PROJECT` per project, with the inbox (Chats) project
   * capped at its configured thread_limit instead.
   */
  'thread:listRecentPerProject': {} as Contract<[], Thread[]>,
  /**
   * Paged threads for one project; the project filter is applied in SQL
   * before the limit so "load more" reaches older rows reliably.
   */
  'thread:listProjectPage': {} as Contract<
    [options: { projectId: string; limit?: number; offset?: number }],
    Thread[]
  >,
  'thread:reorder': {} as Contract<[projectId: string, orderedIds: string[]], Thread[]>,
  'thread:setSortOrder': {} as Contract<
    [projectId: string, threadId: string, sortOrder: number],
    Thread
  >,
  'thread:reorderPinned': {} as Contract<[projectId: string, orderedPinnedIds: string[]], Thread[]>,
  'thread:reorderPinnedGlobal': {} as Contract<[orderedPinnedIds: string[]], Thread[]>,
  'thread:reorderScope': {} as Contract<
    [projectId: string, bucketId: string, slice: ScopeSlice, orderedIds: string[]],
    Thread[]
  >,
  'thread:loadMessages': {} as Contract<
    [projectId: string, threadId: string, before?: ThreadMessageCursor, limit?: number],
    ThreadMessagePage
  >,
  'thread:exportTranscript': {} as Contract<
    [projectId: string, threadId: string, options: import('../types').TranscriptExportOptions],
    import('../types').TranscriptExportResult | null
  >,
  'thread:loadMessagesAround': {} as Contract<
    [projectId: string, threadId: string, anchorId: string, limit: number],
    ThreadMessagePage
  >,
  'thread:loadUserMessages': {} as Contract<
    [projectId: string, threadId: string],
    UserMessageSummary[]
  >,
  'thread:loadStreamParts': {} as Contract<
    [projectId: string, threadId: string, query?: import('../types').TurnStreamPartsQuery],
    import('../types').TurnStreamPartsPage | import('../types').TurnStreamPartsChange
  >,
  'thread:markRead': {} as Contract<[projectId: string, threadId: string], Thread>,
  /** Renderer → main composer draft transitions feeding the turn-grading timers. */
  'thread:draftActivity': {} as Contract<
    [projectId: string, threadId: string, drafting: boolean],
    void
  >,
  /** Persist a thread's draft state: edge-triggered drafting flag plus the
   *  debounced (10s-inactive) committed draft content. `draftJson` is null
   *  when the draft was cleared/sent. */
  'thread:setDraftState': {} as Contract<
    [projectId: string, threadId: string, drafting: boolean, draftJson: string | null],
    void
  >,
  /** Every thread currently flagged as drafting in the DB, quota-independent. */
  'thread:listDrafting': {} as Contract<[], Thread[]>,
  'thread:setPinned': {} as Contract<
    [projectId: string, threadId: string, pinned: boolean],
    Thread
  >,
  'thread:setContextUsage': {} as Contract<
    [projectId: string, threadId: string, usage: ThreadContextUsage],
    void
  >,
  'thread:harnessUsage': {} as Contract<[projectId: string, threadId: string], HarnessUsage[]>,
  'thread:efficiencyKpis': {} as Contract<
    [projectId: string, threadId: string],
    UsageEfficiencyKpis
  >,
  'thread:setStatus': {} as Contract<
    [projectId: string, threadId: string, status: ThreadStatus],
    Thread
  >,
  'thread:update': {} as Contract<
    [
      projectId: string,
      threadId: string,
      input: Partial<
        Pick<
          Thread,
          | 'title'
          | 'titleSource'
          | 'providerId'
          | 'workingDirectory'
          | 'scopeBucketId'
          | 'lastActivity'
          | 'read'
          | 'assistantGettingStarted'
        >
      >
    ],
    Thread
  >,
  'thread:updateSettings': {} as Contract<
    [projectId: string, threadId: string, settings: ThreadSettings],
    Thread
  >,
  /** Enable/disable the independent (spec-less) audit; never inherited by forks. */
  'thread:setIndependentAudit': {} as Contract<
    [projectId: string, threadId: string, enabled: boolean],
    Thread
  >,
  /**
   * Threads another live CodeInOven instance is running right now. Hydration for
   * the push stream: a window that mounts after the last change still learns the
   * current set without polling.
   */
  'thread:listForeignRuns': {} as Contract<[], ForeignRunNotice[]>,
  /**
   * Ask the instance currently running this thread to hand the run over, then
   * resume it here. Resolves once this window owns the turn (or with the reason
   * it could not be moved).
   */
  'thread:transferRun': {} as Contract<[projectId: string, threadId: string], ThreadTransferResult>
}
