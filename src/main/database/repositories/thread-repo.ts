import { unarchivedSubtreeSql, unarchivedThreadSql } from '../../../lib/archives'
import { ledgerContextUsageSql } from '../thread-context-usage-sql'
import type { Database } from '../database'
import type { AuthoredWorkKind } from '../../../lib/ipc/design'
import {
  orderAuthoredWorkKinds,
  parseAuthoredWorkKinds,
  serializeAuthoredWorkKinds
} from '../../../lib/design/authored-work-kinds'
import { canMarkThreadUnread, DONE_THREAD_STATUSES } from '../../../lib/thread-status-policy'
import {
  ASSISTANT_SPACE_ID,
  GLOBAL_BROWSER_PROJECT_ID,
  INBOX_PROJECT_ID,
  type Thread,
  type ThreadContextUsage,
  type ThreadSearchResult,
  type ThreadStatus
} from '../../../lib/types'
import { rowToThread, serializeGroupParticipants } from './thread-repo/thread-row'
import type { ThreadRow } from './thread-repo/thread-row'
import {
  buildThreadSearchSql,
  mergeThreadSearchResults,
  threadSearchMessageLimit,
  type MessageMatchRow,
  type ThreadSearchOptions
} from './thread-repo/thread-search'

export { parseThreadContextUsage } from './thread-repo/thread-row'
export {
  buildThreadSearchSql,
  mergeThreadSearchResults,
  threadMatchesSearchScope,
  threadSearchMessageLimit,
  type ThreadSearchFamily,
  type ThreadSearchOptions,
  type ThreadSearchSql
} from './thread-repo/thread-search'

/** Paging/visibility controls for thread listings. */
export interface ThreadListOptions {
  /** Maximum number of threads to return. */
  limit?: number
  /** Rows to skip before returning (offset paging). */
  offset?: number
  /** Exclude archived rows when false. */
  includeArchived?: boolean
  /**
   * Ordering for the returned rows.
   * - `default`: pinned (newest pinned first), then manual `sort_order`, then
   *   `last_activity`. Manual reordering can push an active thread beyond a
   *   bounded `limit`, so a "recent" hydration query must use `activity` instead.
   * - `activity`: pinned (newest pinned first), then `last_activity` descending  
   *   guarantees the most recently active threads are always loaded regardless
   *   of `sort_order`.
   */
  order?: 'default' | 'activity'
}

export interface ThreadCapacityCandidate {
  id: string
  pinned: boolean
  status: ThreadStatus
  /** Unread threads are immune to automatic cleanup, so the flag travels here. */
  read: boolean
  lastActivity: number
  /** Owning scope bucket; `undefined` resolves to the Default scope. */
  scopeBucketId?: string
  /** Assignment role, so an orchestration coordinator stays protected. */
  assignmentRole?: Thread['assignmentRole']
  /** Achievement role, so a coordinator stays protected without a pin. */
  achievementRole?: Thread['achievementRole']
}

/**
 * Per-project recent-thread quotas for first-paint hydration. One busy project
 * must never crowd the other projects' threads out of the initial sidebar
 * slice, so the cap is applied per project instead of globally.
 */
export const RECENT_THREADS_PER_PROJECT = 10

function buildOrderBy(options: ThreadListOptions): string {
  return options.order === 'activity'
    ? 'ORDER BY pinned DESC, pinned_at DESC, last_activity DESC'
    : 'ORDER BY pinned DESC, pinned_at DESC, COALESCE(sort_order, last_activity) DESC, id ASC'
}

/**
 * The reserved hidden containers that hold conversations rather than projects:
 * the chats inbox, the assistant space, and the global browser. No project-thread
 * query may ever return one of their rows; the surfaces that need them read them
 * through their own container-scoped queries.
 */
const HIDDEN_CONTAINER_PROJECT_IDS: readonly string[] = [
  INBOX_PROJECT_ID,
  ASSISTANT_SPACE_ID,
  GLOBAL_BROWSER_PROJECT_ID
]

/**
 * WHERE fragment and params keeping only real project threads, across every
 * project. This is the load boundary for a threads view, so the list never has
 * to filter another container's rows out after the fact.
 */
function projectThreadsOnlyClause(): { where: string; params: string[] } {
  return {
    where: `project_id NOT IN (${HIDDEN_CONTAINER_PROJECT_IDS.map(() => '?').join(', ')})`,
    params: [...HIDDEN_CONTAINER_PROJECT_IDS]
  }
}

/**
 * The WHERE clause for every thread a Threads view must carry whatever the
 * recency window is: pinned rows, rows in a status that a Threads view ranks
 * above done, and every row of a pinned-like scope. The non-done and scoped
 * parts are bounded by the user's own choices, never by thread history.
 */
function buildAlwaysVisibleClauses(scopedBucketIds: ReadonlySet<string>): {
  where: string
  params: unknown[]
} {
  const only = projectThreadsOnlyClause()
  const params: unknown[] = [...only.params]
  const statusPlaceholders = DONE_THREAD_STATUSES.map(() => '?').join(', ')
  params.push(...DONE_THREAD_STATUSES)
  let visibility = `(pinned = 1 OR status NOT IN (${statusPlaceholders}))`
  const bucketIds = [...scopedBucketIds]
  if (bucketIds.length > 0) {
    visibility = `(pinned = 1 OR status NOT IN (${statusPlaceholders}) OR scope_bucket_id IN (${bucketIds
      .map(() => '?')
      .join(', ')}))`
    params.push(...bucketIds)
  }
  return {
    where: `WHERE ${unarchivedThreadSql()} AND ${only.where} AND ${visibility}`,
    params
  }
}

function buildListClauses(
  filters: string[],
  params: unknown[],
  options: ThreadListOptions
): { where: string; params: unknown[]; limit: string } {
  const clauses = [...filters]
  if (options.includeArchived !== true) {
    clauses.push(unarchivedThreadSql())
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const limitClause =
    options.limit !== undefined
      ? ` LIMIT ${Math.max(0, Math.floor(options.limit))} OFFSET ${Math.max(0, Math.floor(options.offset ?? 0))}`
      : ''
  return { where, params, limit: limitClause }
}

// Draft state (`drafting`, `draft_json`) is intentionally absent from the
// generic upsert: only the dedicated draft writer below may change it, so
// unrelated thread writes (title, status, settings...) can never clobber a
// draft that is actively being composed in another window.
const THREAD_UPSERT_SQL = `INSERT INTO threads(
  id, project_id, provider_id, title, title_source, status,
  pinned, pinned_at, bookmarked, sort_order, scope_sort_order, archived, read,
  branch, feature_slug, authored_work_kind, authored_work_kinds, scope_bucket_id,
  bound_scope_project_id, bound_scope_scope_id, bound_scope_home_project_id,
  run_base, dispatch_origin, park_reason, settings, context_usage,
  session_id, session_harness_id, session_account_id, dismissed_spec_id, dismissed_spec_version,
  audit_state, loop_iteration, active_audit_id, active_audit_version,
  assignment_id, assignment_role, assignment_task_id,
  coordinator_thread_id, achievement_role, achievement_goal, auditor_thread_id, user_input_locked,
  engineering, independent_audit, independent_audit_initialized,
  assistant_id, assistant_icon_type, assistant_icon, schedule_override, scheduled, last_run_at, last_dispatched_at, last_success_at,
  assistant_getting_started,
  assistant_task_id,
  group_participants, group_title,
  last_error, last_error_at, last_outcome,
  created_at, updated_at, last_activity, working_directory

) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET
  project_id=excluded.project_id,
  provider_id=excluded.provider_id,
  title=excluded.title,
  title_source=excluded.title_source,
  status=excluded.status,
  pinned=excluded.pinned,
  bookmarked=excluded.bookmarked,
  sort_order=CASE WHEN excluded.last_activity > threads.last_activity THEN NULL ELSE excluded.sort_order END,
  scope_sort_order=excluded.scope_sort_order,
  archived=excluded.archived,
  read=excluded.read,
  branch=excluded.branch,
  feature_slug=excluded.feature_slug,
  authored_work_kind=excluded.authored_work_kind,
  authored_work_kinds=excluded.authored_work_kinds,
  scope_bucket_id=excluded.scope_bucket_id,
  bound_scope_project_id=excluded.bound_scope_project_id,
  bound_scope_scope_id=excluded.bound_scope_scope_id,
  bound_scope_home_project_id=excluded.bound_scope_home_project_id,
  run_base=excluded.run_base,
  dispatch_origin=excluded.dispatch_origin,
  park_reason=excluded.park_reason,
  settings=excluded.settings,
  context_usage=COALESCE(threads.context_usage, excluded.context_usage),
  session_id=excluded.session_id,
  session_harness_id=excluded.session_harness_id,
  session_account_id=excluded.session_account_id,
  dismissed_spec_id=excluded.dismissed_spec_id,
  dismissed_spec_version=excluded.dismissed_spec_version,
  audit_state=excluded.audit_state,
  loop_iteration=excluded.loop_iteration,
  active_audit_id=excluded.active_audit_id,
  active_audit_version=excluded.active_audit_version,
  assignment_id=excluded.assignment_id,
  assignment_role=excluded.assignment_role,
  assignment_task_id=excluded.assignment_task_id,
  coordinator_thread_id=excluded.coordinator_thread_id,
  achievement_role=excluded.achievement_role,
  achievement_goal=excluded.achievement_goal,
  auditor_thread_id=excluded.auditor_thread_id,
  user_input_locked=excluded.user_input_locked,
  engineering=excluded.engineering,
  independent_audit=excluded.independent_audit,
  independent_audit_initialized=excluded.independent_audit_initialized,
  assistant_id=excluded.assistant_id,
  assistant_icon_type=excluded.assistant_icon_type,
  assistant_icon=excluded.assistant_icon,
  schedule_override=excluded.schedule_override,
  scheduled=excluded.scheduled,
  last_run_at=excluded.last_run_at,
  last_dispatched_at=excluded.last_dispatched_at,
  last_success_at=excluded.last_success_at,
  assistant_getting_started=excluded.assistant_getting_started,
  assistant_task_id=excluded.assistant_task_id,
  group_participants=excluded.group_participants,
  group_title=excluded.group_title,
  last_error=excluded.last_error,
  last_error_at=excluded.last_error_at,
  last_outcome=excluded.last_outcome,
  created_at=excluded.created_at,
  updated_at=excluded.updated_at,
  last_activity=excluded.last_activity,
  working_directory=excluded.working_directory`

function threadUpsertParams(thread: Thread): unknown[] {
  return [
    thread.id,
    thread.projectId,
    thread.providerId,
    thread.title,
    thread.titleSource ?? 'default',
    thread.status,
    thread.pinned ? 1 : 0,
    thread.pinnedAt ?? null,
    thread.bookmarked ? 1 : 0,
    thread.sortOrder ?? null,
    thread.scopeSortOrder ?? null,
    thread.archived ? 1 : 0,
    thread.read ? 1 : 0,
    thread.branch ?? null,
    thread.featureSlug ?? null,
    thread.authoredWorkKind ?? null,
    serializeAuthoredWorkKinds(thread.authoredWorkKinds),
    thread.scopeBucketId ?? null,
    thread.boundScope?.projectId ?? null,
    thread.boundScope?.scopeBucketId ?? null,
    thread.boundScope?.homeProjectId ?? null,
    thread.runBase ? JSON.stringify(thread.runBase) : null,
    thread.dispatchOrigin ? JSON.stringify(thread.dispatchOrigin) : null,
    thread.parkReason ? JSON.stringify(thread.parkReason) : null,
    thread.settings ? JSON.stringify(thread.settings) : null,
    thread.contextUsage ? JSON.stringify(thread.contextUsage) : null,
    thread.sessionId ?? null,
    thread.sessionHarnessId ?? null,
    thread.sessionAccountId ?? null,
    thread.dismissedSpecId ?? null,
    thread.dismissedSpecVersion ?? null,
    thread.auditState ?? null,
    thread.loopIteration ?? null,
    thread.activeAuditId ?? null,
    thread.activeAuditVersion ?? null,
    thread.assignmentId ?? null,
    thread.assignmentRole ?? null,
    thread.assignmentTaskId ?? null,
    thread.coordinatorThreadId ?? null,
    thread.achievementRole ?? null,
    thread.achievementGoal ?? null,
    thread.auditorThreadId ?? null,
    thread.userInputLocked ? 1 : 0,
    thread.engineering ? 1 : 0,
    thread.independentAudit ? 1 : 0,
    thread.independentAuditInitialized ? 1 : 0,
    thread.assistantId ?? null,
    thread.assistantIconType ?? null,
    thread.assistantIcon ?? null,
    thread.scheduleOverride ? JSON.stringify(thread.scheduleOverride) : null,
    thread.scheduled === undefined ? null : thread.scheduled ? 1 : 0,
    thread.lastRunAt ?? null,
    thread.lastDispatchedAt ?? null,
    thread.lastSuccessAt ?? null,
    thread.assistantGettingStarted ? 1 : 0,
    thread.assistantTaskId ?? null,
    serializeGroupParticipants(thread.groupParticipants),
    thread.groupTitle ?? null,
    thread.lastError ?? null,
    thread.lastErrorAt ?? null,
    thread.lastOutcome ?? null,
    thread.createdAt,
    thread.updatedAt,
    thread.lastActivity,
    thread.workingDirectory
  ]
}

export class ThreadRepo {
  constructor(private db: Database) {}

  private async hydrateThreadsViaWorker(rows: ThreadRow[]): Promise<Thread[]> {
    const threads = rows.map(rowToThread)
    if (threads.length === 0) return threads
    const ids = threads.map((thread) => thread.id)
    const placeholders = ids.map(() => '?').join(',')
    const usage = await this.db.queryViaWorker(
      `SELECT thread_id, harness_id
       FROM harness_usage
       WHERE thread_id IN (${placeholders})
       GROUP BY thread_id, harness_id
       ORDER BY MAX(last_used_at) DESC`,
      ids,
      0
    )
    if (usage.ok) {
      const byThread = new Map<string, string[]>()
      for (const entry of usage.rows) {
        const threadId = String(entry['thread_id'])
        const harnessId = String(entry['harness_id'])
        const harnesses = byThread.get(threadId)
        if (harnesses) harnesses.push(harnessId)
        else byThread.set(threadId, [harnessId])
      }
      for (const thread of threads) thread.usedHarnessIds = byThread.get(thread.id)
    }
    return threads
  }

  upsert(thread: Thread): void {
    this.db.run(THREAD_UPSERT_SQL, ...threadUpsertParams(thread))
  }

  async upsertViaWorker(thread: Thread): Promise<void> {
    const result = await this.db.executeViaWorker(THREAD_UPSERT_SQL, threadUpsertParams(thread))
    if (!result.ok) {
      throw new Error(result.error ?? 'Thread upsert failed')
    }
  }

  /**
   * Record that a thread entered one authored-work session.
   *
   * Two columns, one write: `authored_work_kind` becomes the session the thread
   * is in now (what a preview resolves against) and `authored_work_kinds` gains
   * the kind, because the row draws one marker per kind and a thread that
   * designed something and later cut a video about it has done both.
   *
   * The current row is read first so the set can be unioned rather than
   * replaced, and so a repeat of the kind already recorded writes nothing: this
   * runs on every recognized navigation, and an unconditional UPDATE would bump
   * the WAL for an unchanged value. It reads and writes on the database worker,
   * because a preview navigation must never touch the Electron main thread.
   * Returns the set it stored, or null when the thread row is gone.
   */
  async setAuthoredWorkKindViaWorker(
    id: string,
    kind: AuthoredWorkKind
  ): Promise<AuthoredWorkKind[] | null> {
    const current = await this.db.queryViaWorker(
      'SELECT authored_work_kind, authored_work_kinds FROM threads WHERE id = ?',
      [id],
      1
    )
    if (!current.ok) throw new Error(current.error ?? 'Thread authored-work read failed')
    const row = current.rows[0] as
      { authored_work_kind: unknown; authored_work_kinds: unknown } | undefined
    if (!row) return null
    const stored = parseAuthoredWorkKinds(
      typeof row.authored_work_kinds === 'string' ? row.authored_work_kinds : null
    )
    const kinds = orderAuthoredWorkKinds([...stored, kind])
    if (row.authored_work_kind === kind && kinds.length === stored.length) return kinds
    const result = await this.db.executeViaWorker(
      'UPDATE threads SET authored_work_kind = ?, authored_work_kinds = ? WHERE id = ?',
      [kind, serializeAuthoredWorkKinds(kinds), id]
    )
    if (!result.ok) {
      throw new Error(result.error ?? 'Thread authored-work kind update failed')
    }
    return kinds
  }

  get(id: string): Thread | null {
    const row = this.db.get<ThreadRow>('SELECT * FROM threads WHERE id = ?', id)
    if (!row) return null
    const thread = rowToThread(row)
    const used = this.usedHarnessesFor([thread.id])
    thread.usedHarnessIds = used.get(thread.id)
    return thread
  }

  /** Read a cleanup/display snapshot without blocking main or hydrating usage metadata. */
  async getViaWorker(id: string): Promise<Thread | null> {
    const result = await this.db.queryViaWorker('SELECT * FROM threads WHERE id = ?', [id], 1)
    if (!result.ok) return null
    const row = (result.rows as unknown as ThreadRow[])[0]
    if (!row) return null
    const thread = rowToThread(row)
    const usage = await this.db.queryViaWorker(
      `SELECT harness_id
       FROM harness_usage
       WHERE thread_id = ?
       GROUP BY harness_id
       ORDER BY MAX(last_used_at) DESC`,
      [id],
      0
    )
    if (usage.ok && usage.rows.length > 0) {
      thread.usedHarnessIds = usage.rows.map((entry) => String(entry['harness_id']))
    }
    return thread
  }

  /** Mark a thread read without loading it through the main SQLite connection. */
  async markReadViaWorker(
    projectId: string,
    id: string
  ): Promise<{ thread: Thread; changed: boolean } | null> {
    const result = await this.db.queryViaWorker(
      'SELECT * FROM threads WHERE id = ? AND project_id = ?',
      [id, projectId],
      1
    )
    if (!result.ok) return null
    const row = (result.rows as unknown as ThreadRow[])[0]
    if (!row) return null

    const wasUnread = row.read === 0
    if (wasUnread) {
      const updated = await this.db.executeViaWorker(
        'UPDATE threads SET read = 1 WHERE id = ? AND project_id = ? AND read = 0',
        [id, projectId]
      )
      if (!updated.ok) throw new Error(updated.error ?? 'Could not mark thread read')
    }

    const thread = rowToThread(row)
    thread.read = true
    const usage = await this.db.queryViaWorker(
      `SELECT harness_id
       FROM harness_usage
       WHERE thread_id = ?
       GROUP BY harness_id
       ORDER BY MAX(last_used_at) DESC`,
      [id],
      0
    )
    if (usage.ok && usage.rows.length > 0) {
      thread.usedHarnessIds = usage.rows.map((entry) => String(entry['harness_id']))
    }
    return { thread, changed: wasUnread }
  }

  /**
   * Mark a thread unread without loading it through the main SQLite connection.
   * The counterpart of {@link markReadViaWorker}: a user-requested unread mark
   * from a thread actions menu.
   *
   * The mark is a fresh event, so it stamps `last_activity`/`updated_at` with
   * `now` exactly as a new turn would. Every unread rule then applies to it
   * unchanged: the thread is sorted to the top of its list and grouped as
   * Unread, with no special casing anywhere.
   *
   * Only a settled thread may be flipped (see `canMarkThreadUnread`): a live
   * thread, a ready spec, or a thread parked on the user is left untouched, so
   * the rule holds even for a caller that skips the actions-menu gate.
   */
  async markUnreadViaWorker(
    projectId: string,
    id: string
  ): Promise<{ thread: Thread; changed: boolean } | null> {
    const result = await this.db.queryViaWorker(
      'SELECT * FROM threads WHERE id = ? AND project_id = ?',
      [id, projectId],
      1
    )
    if (!result.ok) return null
    const row = (result.rows as unknown as ThreadRow[])[0]
    if (!row) return null

    const thread = rowToThread(row)
    if (!canMarkThreadUnread(thread.status)) return { thread, changed: false }

    const now = Date.now()
    const wasRead = row.read === 1
    if (wasRead) {
      const updated = await this.db.executeViaWorker(
        'UPDATE threads SET read = 0, sort_order = NULL, last_activity = ?, updated_at = ? WHERE id = ? AND project_id = ? AND read = 1',
        [now, now, id, projectId]
      )
      if (!updated.ok) throw new Error(updated.error ?? 'Could not mark thread unread')
    }

    thread.read = false
    if (wasRead) {
      thread.lastActivity = now
      thread.sortOrder = undefined
      thread.updatedAt = now
    }
    const usage = await this.db.queryViaWorker(
      `SELECT harness_id
       FROM harness_usage
       WHERE thread_id = ?
       GROUP BY harness_id
       ORDER BY MAX(last_used_at) DESC`,
      [id],
      0
    )
    if (usage.ok && usage.rows.length > 0) {
      thread.usedHarnessIds = usage.rows.map((entry) => String(entry['harness_id']))
    }
    return { thread, changed: wasRead }
  }

  /**
   * Persist a thread's draft state on the database worker: the edge-triggered
   * `drafting` flag (immediately, so listings never drop a thread that is
   * being composed or dictated) and the debounce-committed draft content.
   * The generic upsert never touches these columns — see `THREAD_UPSERT_SQL`.
   */
  async setDraftStateViaWorker(
    projectId: string,
    id: string,
    drafting: boolean,
    draftJson: string | null
  ): Promise<Thread | null> {
    const result = await this.db.queryViaWorker(
      'SELECT * FROM threads WHERE id = ? AND project_id = ?',
      [id, projectId],
      1
    )
    if (!result.ok) return null
    const row = (result.rows as unknown as ThreadRow[])[0]
    if (!row) return null
    const updated = await this.db.executeViaWorker(
      'UPDATE threads SET drafting = ?, draft_json = ?, updated_at = ? WHERE id = ? AND project_id = ?',
      [drafting ? 1 : 0, draftJson, Date.now(), id, projectId]
    )
    if (!updated.ok) return null
    const thread = rowToThread(row)
    if (drafting) thread.drafting = true
    else delete thread.drafting
    thread.draftJson = draftJson
    return thread
  }

  /** Every non-archived user-facing thread currently flagged as drafting,
   *  regardless of any listing quota. Used by the workspace to rescue drafting
   *  threads that fell outside a bounded first-paint hydration slice. */
  async listDraftingThreadsViaWorker(): Promise<Thread[]> {
    const result = await this.db.queryViaWorker(
      `SELECT * FROM threads
       WHERE ${unarchivedThreadSql()}
         AND drafting = 1
         AND assignment_role IS NOT 'worker'
         AND achievement_role IS NOT 'auditor'
         AND coordinator_thread_id IS NULL
       ORDER BY last_activity DESC, id ASC`,
      [],
      0
    )
    if (!result.ok) return []
    return (result.rows as unknown as ThreadRow[]).map(rowToThread)
  }

  /** Map of thread id → distinct harness ids used in its session, newest first. */
  private usedHarnessesFor(threadIds: string[]): Map<string, string[]> {
    const result = new Map<string, string[]>()
    if (threadIds.length === 0) return result
    const placeholders = threadIds.map(() => '?').join(',')
    // The PK is (project_id, thread_id, harness_id, provider_id), so one harness
    // can legitimately own several rows across providers. Group by harness to
    // return it once, keeping its most recent activity time.
    const rows = this.db.all<{ thread_id: string; harness_id: string }>(
      `SELECT thread_id, harness_id
       FROM harness_usage
       WHERE thread_id IN (${placeholders})
       GROUP BY thread_id, harness_id
       ORDER BY MAX(last_used_at) DESC`,
      ...threadIds
    )
    for (const row of rows) {
      const list = result.get(row.thread_id)
      if (list) {
        list.push(row.harness_id)
      } else {
        result.set(row.thread_id, [row.harness_id])
      }
    }
    return result
  }

  private hydrateThreads(rows: ThreadRow[]): Thread[] {
    const threads = rows.map(rowToThread)
    const used = this.usedHarnessesFor(threads.map((t) => t.id))
    for (const thread of threads) {
      thread.usedHarnessIds = used.get(thread.id)
    }
    return threads
  }

  listByProject(projectId: string, options: ThreadListOptions = {}): Thread[] {
    const { where, params, limit } = buildListClauses(
      ['project_id = ?', 'project_id != ?'],
      [projectId, GLOBAL_BROWSER_PROJECT_ID],
      options
    )
    const rows = this.db.all<ThreadRow>(
      `SELECT * FROM threads ${where}
       ${buildOrderBy(options)}${limit}`,
      ...params
    )
    return this.hydrateThreads(rows)
  }

  /** Worker-backed per-project list; the project filter precedes the limit so
   *  paging reaches rows a global recent-slice would have evicted. */
  async listByProjectViaWorker(
    projectId: string,
    options: ThreadListOptions = {}
  ): Promise<Thread[]> {
    const { where, params, limit } = buildListClauses(
      ['project_id = ?', 'project_id != ?'],
      [projectId, GLOBAL_BROWSER_PROJECT_ID],
      options
    )
    const result = await this.db.queryViaWorker(
      `SELECT * FROM threads ${where}
       ${buildOrderBy(options)}${limit}`,
      params,
      0
    )
    if (!result.ok) return this.listByProject(projectId, options)
    const rows = result.rows as unknown as ThreadRow[]
    return this.hydrateThreadsViaWorker(rows)
  }

  /**
   * Read only the fields needed to enforce per-project capacity on the worker.
   * Orchestration children do not count toward the user-visible thread bound.
   *
   * A candidate is not the same as an eviction: `read`, `status`, `pinned` and
   * the orchestration roles travel here so the capacity rules can refuse to
   * delete an unread, busy, parked, `spec` or coordinating thread.
   *
   * An archived thread is invincible: it is never a candidate, it never occupies
   * one of the project's slots, and neither is a thread whose subtree holds one,
   * because deleting that thread would take the archived conversation with it.
   */
  async listCapacityCandidatesViaWorker(projectId: string): Promise<ThreadCapacityCandidate[]> {
    const result = await this.db.queryViaWorker(
      `SELECT id, pinned, status, read, last_activity, scope_bucket_id, assignment_role, achievement_role
       FROM threads
       WHERE project_id = ?
         AND ${unarchivedThreadSql()}
         AND ${unarchivedSubtreeSql()}
         AND assignment_role IS NOT 'worker'
         AND achievement_role IS NOT 'auditor'
         AND coordinator_thread_id IS NULL
       ORDER BY last_activity ASC, id ASC`,
      [projectId],
      0
    )
    if (!result.ok) return []
    return result.rows.map((row) => ({
      id: String(row['id']),
      pinned: row['pinned'] === 1,
      status: String(row['status']) as ThreadStatus,
      // Defaulted to read so a row written before the column existed is never
      // shielded from cleanup by a missing value.
      read: row['read'] == null ? true : Number(row['read']) === 1,
      lastActivity: Number(row['last_activity']),
      scopeBucketId: row['scope_bucket_id'] == null ? undefined : String(row['scope_bucket_id']),
      assignmentRole:
        row['assignment_role'] == null
          ? undefined
          : (String(row['assignment_role']) as Thread['assignmentRole']),
      achievementRole:
        row['achievement_role'] == null
          ? undefined
          : (String(row['achievement_role']) as Thread['achievementRole'])
    }))
  }

  /**
   * Every thread id a project owns, read on the database worker.
   *
   * For a caller comparing the rows against thread directories on disk, which
   * must not touch SQLite on the main thread (see `docs/APP-BIBLE.md`).
   */
  async listIdsViaWorker(projectId: string): Promise<string[]> {
    const result = await this.db.queryViaWorker(
      'SELECT id FROM threads WHERE project_id = ?',
      [projectId],
      0
    )
    if (!result.ok) return []
    return result.rows.map((row) => String(row['id']))
  }

  /**
   * Load cleanup snapshots without harness-usage hydration. Deletion needs the
   * thread tree and session metadata, while the extra usage query would be
   * wasted work and would synchronously touch the primary connection.
   */
  async listForDeletionViaWorker(projectId: string): Promise<Thread[]> {
    const result = await this.db.queryViaWorker(
      'SELECT * FROM threads WHERE project_id = ? ORDER BY created_at ASC, id ASC',
      [projectId],
      0
    )
    if (!result.ok) return []
    return (result.rows as unknown as ThreadRow[]).map(rowToThread)
  }

  listAll(options: ThreadListOptions = {}): Thread[] {
    const { where, params, limit } = buildListClauses(
      ['project_id != ?'],
      [GLOBAL_BROWSER_PROJECT_ID],
      options
    )
    const rows = this.db.all<ThreadRow>(
      `SELECT * FROM threads ${where}
       ${buildOrderBy(options)}${limit}`,
      ...params
    )
    return this.hydrateThreads(rows)
  }

  /** Load every thread on the database worker so unbounded hydration does not block Electron. */
  async listAllViaWorker(options: ThreadListOptions = {}, hydrateUsage = true): Promise<Thread[]> {
    const { where, params, limit } = buildListClauses(
      ['project_id != ?'],
      [GLOBAL_BROWSER_PROJECT_ID],
      options
    )
    const result = await this.db.queryViaWorker(
      `SELECT * FROM threads ${where}
       ${buildOrderBy(options)}${limit}`,
      params,
      0
    )
    if (!result.ok) return this.listAll(options)
    const rows = result.rows as unknown as ThreadRow[]
    return hydrateUsage ? this.hydrateThreadsViaWorker(rows) : rows.map(rowToThread)
  }

  /**
   * Real project threads only, across every project, for the Threads view.
   *
   * Unlike {@link listAllViaWorker}, which is the shared list the navigator and
   * the container views read, this never returns a hidden container's row, so a
   * threads view loads exactly what it shows and drops nothing afterwards.
   */
  async listProjectThreadsViaWorker(
    options: ThreadListOptions = {},
    hydrateUsage = true
  ): Promise<Thread[]> {
    const only = projectThreadsOnlyClause()
    const { where, params, limit } = buildListClauses([only.where], only.params, options)
    const result = await this.db.queryViaWorker(
      `SELECT * FROM threads ${where}
       ${buildOrderBy(options)}${limit}`,
      params,
      0
    )
    if (!result.ok) {
      return this.listAll(options).filter(
        (thread) => !HIDDEN_CONTAINER_PROJECT_IDS.includes(thread.projectId)
      )
    }
    const rows = result.rows as unknown as ThreadRow[]
    return hydrateUsage ? this.hydrateThreadsViaWorker(rows) : rows.map(rowToThread)
  }

  /**
   * Every active thread the Threads view must carry whatever the bounded
   * recency window pulls: pinned rows, rows in a non-done status, and every row
   * of a pinned-like scope (see `ScopeManager.scopedBucketIds`). Without this,
   * a spec thread or a pinned scope's older thread falls past the 200-row
   * activity window and never renders, even though the view ranks it above the
   * done rows that did load.
   */
  async listAlwaysVisibleViaWorker(
    scopedBucketIds: ReadonlySet<string>,
    hydrateUsage = true
  ): Promise<Thread[]> {
    const { where, params } = buildAlwaysVisibleClauses(scopedBucketIds)
    const orderBy = buildOrderBy({ order: 'activity' })
    const result = await this.db.queryViaWorker(
      `SELECT * FROM threads ${where} ${orderBy}`,
      params,
      0
    )
    const rows = result.ok
      ? (result.rows as unknown as ThreadRow[])
      : this.db.all<ThreadRow>(`SELECT * FROM threads ${where} ${orderBy}`, ...params)
    return hydrateUsage ? this.hydrateThreadsViaWorker(rows) : rows.map(rowToThread)
  }

  /** Initial workspace rows omit optional usage metadata so first paint stays bounded. */
  listAllForHydrationViaWorker(options: ThreadListOptions = {}): Promise<Thread[]> {
    return this.listAllViaWorker(options, false)
  }

  /**
   * Titles of the given threads, read on the database worker.
   *
   * For a background service that labels a workspace without hydrating whole
   * thread rows, and must not read SQLite on the main thread (see
   * `docs/APP-BIBLE.md`). Ids with no row are simply absent from the map.
   */
  async listTitlesViaWorker(ids: readonly string[]): Promise<Map<string, string>> {
    const titles = new Map<string, string>()
    const unique = [...new Set(ids)].filter((id) => id.length > 0)
    if (unique.length === 0) return titles
    const placeholders = unique.map(() => '?').join(',')
    const result = await this.db.queryViaWorker(
      `SELECT id, title FROM threads WHERE id IN (${placeholders})`,
      unique,
      0
    )
    if (!result.ok) return titles
    for (const row of result.rows) {
      if (typeof row['id'] === 'string' && typeof row['title'] === 'string') {
        titles.set(row['id'], row['title'])
      }
    }
    return titles
  }

  /**
   * Whole thread rows for the given ids, read on the database worker. Used to
   * hydrate semantic search matches, which arrive as ids and scores and must
   * become full `Thread` results without a synchronous read.
   */
  async listByIdsViaWorker(ids: readonly string[]): Promise<Thread[]> {
    const unique = [...new Set(ids)].filter((id) => id.length > 0)
    if (unique.length === 0) return []
    const placeholders = unique.map(() => '?').join(',')
    const result = await this.db.queryViaWorker(
      `SELECT * FROM threads WHERE id IN (${placeholders}) AND ${unarchivedThreadSql()}`,
      unique,
      0
    )
    if (!result.ok) return []
    return result.rows.map((row) => rowToThread(row as unknown as ThreadRow))
  }

  /**
   * Assistant task ids grouped by the assistant they belong to, read on the
   * database worker. Every task of an assistant mounts that assistant's single
   * workspace directory, so a caller that owns the directory needs their ids to
   * recognise the same folder under each task's own identity. Assistant ids with
   * no task are simply absent from the map.
   */
  async listAssistantTaskIdsViaWorker(
    assistantIds: readonly string[]
  ): Promise<Map<string, string[]>> {
    const grouped = new Map<string, string[]>()
    const unique = [...new Set(assistantIds)].filter((id) => id.length > 0)
    if (unique.length === 0) return grouped
    const placeholders = unique.map(() => '?').join(',')
    const result = await this.db.queryViaWorker(
      `SELECT id, assistant_id FROM threads WHERE project_id = ? AND assistant_id IN (${placeholders})`,
      [ASSISTANT_SPACE_ID, ...unique],
      0
    )
    if (!result.ok) return grouped
    for (const row of result.rows) {
      const id = row['id']
      const assistantId = row['assistant_id']
      if (typeof id !== 'string' || typeof assistantId !== 'string') continue
      const tasks = grouped.get(assistantId)
      if (tasks) tasks.push(id)
      else grouped.set(assistantId, [id])
    }
    return grouped
  }

  /**
   * Recent threads per project for bounded sidebar hydration: at most
   * `quotaByProject(projectId)` user-facing rows per project (newest activity
   * first), fetched in a single window-function query so one high-traffic
   * project cannot evict other projects' threads from the slice.
   *
   * Orchestration *children* (workers and auditors) stay out of the slice so a
   * twelve-task Assignment cannot flood it, but an Assignment **coordinator** is
   * a user-facing thread and is listed like any other, exactly as
   * `isOrchestrationChildThread` defines it. Pinning always surfaces a row: a
   * pinned thread is kept even when it is a child, and it never competes for a
   * quota slot, because the Pinned slice must show every pin the user made.
   *
   * A thread parked on the user (`awaiting_approval`) bypasses the quota too,
   * whatever its age and whether or not it was already read. "Who is waiting on
   * me" is the fact the view rail's attention badge reports, and the rail counts
   * the rows the renderer holds (see `ViewRailActivity`): a parked thread that a
   * quota-only slice left out is a thread the app knows needs the user and the
   * rail silently does not, which is exactly the news vanishing that the badge
   * must never lose.
   */
  async listRecentPerProjectViaWorker(
    quotaByProject: (projectId: string) => number,
    hydrateUsage = false
  ): Promise<Thread[]> {
    const quotas = await this.projectQuotasViaWorker()
    // Per-project quotas default to the callback value; the inbox project
    // overrides it with its configured thread_limit (the Chats bucket size).
    // Unread, drafting, and pinned threads bypass the quota entirely: a
    // stale-but-unread or explicitly pinned row must never be hidden from the
    // first-paint slice, whatever its age.
    // Every project's own quota becomes a CASE arm, so the callback alone decides
    // how deep each slice goes: the inbox asks for MAX_SAFE_INTEGER and gets its
    // stored `thread_limit`, every other project asks for its own number. Only
    // building arms for the MAX projects made the callback's other answers
    // unreachable, and every project fell to the default depth instead.
    const cases = [...quotas.entries()]
      .map(([id, limit]) => {
        const requested = quotaByProject(id)
        const quota = requested === Number.MAX_SAFE_INTEGER ? limit : requested
        return { id, quota }
      })
      .filter(({ quota }) => Number.isFinite(quota) && quota > 0)
      .map(({ id, quota }) => `WHEN project_id = '${id.replace(/'/g, "''")}' THEN ${quota}`)
    const quotaExpr =
      cases.length > 0
        ? `CASE ${cases.join(' ')} ELSE ${quotaByProject('')} END`
        : String(quotaByProject(''))
    const result = await this.db.queryViaWorker(
      `SELECT * FROM (
         SELECT *, ROW_NUMBER() OVER (
           PARTITION BY project_id
           ORDER BY pinned DESC, pinned_at DESC, last_activity DESC, id ASC
         ) AS rn
         FROM threads
         WHERE ${unarchivedThreadSql()}
           AND project_id != ?
           AND (
             pinned = 1
             OR (
               assignment_role IS NOT 'worker'
               AND achievement_role IS NOT 'auditor'
               AND coordinator_thread_id IS NULL
             )
           )
       ) WHERE rn <= ${quotaExpr}
         OR read = 0
         OR drafting = 1
         OR pinned = 1
         OR status = 'awaiting_approval'
       ORDER BY pinned DESC, pinned_at DESC, last_activity DESC, id ASC`,
      [GLOBAL_BROWSER_PROJECT_ID],
      0
    )
    if (!result.ok) return this.listAll({ includeArchived: false })
    const rows = result.rows as unknown as ThreadRow[]
    return hydrateUsage ? this.hydrateThreadsViaWorker(rows) : rows.map(rowToThread)
  }

  /** Per-project thread quotas: project rows are few, read them wholesale. */
  private async projectQuotasViaWorker(): Promise<Map<string, number>> {
    const result = await this.db.queryViaWorker('SELECT id, thread_limit FROM projects', [], 0)
    const quotas = new Map<string, number>()
    if (!result.ok) return quotas
    for (const row of result.rows) {
      quotas.set(String(row['id']), Number(row['thread_limit']))
    }
    return quotas
  }

  /** Load only non-archived threads that currently hold active agent work. */
  listActive(): Array<Thread & { status: 'planning' | 'executing' }> {
    const rows = this.db.all<ThreadRow>(
      `SELECT * FROM threads
       WHERE ${unarchivedThreadSql()} AND status IN ('planning', 'executing')
       ORDER BY last_activity DESC, id ASC`
    )
    return rows
      .map(rowToThread)
      .filter(
        (thread): thread is Thread & { status: 'planning' | 'executing' } =>
          thread.status === 'planning' || thread.status === 'executing'
      )
  }

  /** Check for active work without hydrating every thread row or usage metadata. */
  hasActive(): boolean {
    return (
      this.db.get<{ active: number }>(
        `SELECT 1 AS active
         FROM threads
         WHERE ${unarchivedThreadSql()} AND status IN ('planning', 'executing')
         LIMIT 1`
      ) !== undefined
    )
  }

  /**
   * How many non-archived threads hold active agent work right now, read on the
   * database worker.
   *
   * The count the menu bar figure shows. It is the same set {@link hasActive}
   * probes for, counted rather than probed, so the icon and the stay-alive
   * decision can never disagree about what "working" means. It is read on the
   * worker because it is refreshed from thread-update paths, which are
   * interaction paths: a count holds the whole main process for as long as the
   * OS takes to serve it (see `docs/APP-BIBLE.md`).
   */
  async countActiveViaWorker(): Promise<number> {
    const result = await this.db.queryViaWorker(
      `SELECT COUNT(*) AS active
       FROM threads
       WHERE ${unarchivedThreadSql()} AND status IN ('planning', 'executing')`,
      [],
      1
    )
    if (!result.ok) return 0
    return Number(result.rows[0]?.['active'] ?? 0)
  }

  delete(id: string): void {
    this.db.run('DELETE FROM threads WHERE id = ?', id)
  }

  /** Persist a usage snapshot without bumping updated_at/last_activity. */
  updateContextUsage(id: string, contextUsage: ThreadContextUsage): void {
    this.db.run(
      'UPDATE threads SET context_usage = ? WHERE id = ?',
      JSON.stringify(contextUsage),
      id
    )
  }

  /**
   * Off-main, ownership-guarded usage snapshot write. When the project still
   * owns the thread the single statement writes the snapshot; when it does not
   * (thread moved, deleted, or foreign) the guarded WHERE matches no row and
   * the write is a silent no-op. Ownership is validated by SQL, so the caller
   * needs no separate main-thread existence read and the worker stays the only
   * connection touched.
   */
  async updateContextUsageViaWorker(
    projectId: string,
    threadId: string,
    contextUsage: ThreadContextUsage
  ): Promise<boolean> {
    return this.db
      .executeViaWorker(
        `WITH incoming(snapshot) AS (VALUES (?))
        UPDATE threads SET context_usage = (SELECT ${ledgerContextUsageSql('incoming.snapshot')} FROM incoming)
        WHERE id = ? AND project_id = ?`,
        [JSON.stringify(contextUsage), threadId, projectId]
      )
      .then((result) => result.ok)
  }

  updateField(id: string, field: string, value: unknown): void {
    this.db.run(
      `UPDATE threads SET ${field} = ?, updated_at = ? WHERE id = ?`,
      value,
      Date.now(),
      id
    )
  }

  setStatus(id: string, status: ThreadStatus, lastActivity: number): void {
    this.db.run(
      'UPDATE threads SET status = ?, sort_order = NULL, last_activity = ?, updated_at = ? WHERE id = ?',
      status,
      lastActivity,
      lastActivity,
      id
    )
  }

  /**
   * A bookmark is a pin with a glyph, so the two flags always move together and
   * `bookmarked` implies `pinned`: a surface that only knows about pins (the
   * scope board's pin toggle) would otherwise leave a row claiming a bookmark
   * while unpinned, which no view can draw honestly.
   */
  setPinned(id: string, pinned: boolean, pinnedAt?: number, bookmarked = false): void {
    this.db.run(
      'UPDATE threads SET pinned = ?, pinned_at = ?, bookmarked = ?, updated_at = ? WHERE id = ?',
      pinned ? 1 : 0,
      pinned ? (pinnedAt ?? Date.now()) : null,
      pinned && bookmarked ? 1 : 0,
      Date.now(),
      id
    )
  }

  setBookmarked(id: string, bookmarked: boolean): void {
    this.db.run(
      'UPDATE threads SET bookmarked = ?, pinned = ?, pinned_at = ?, updated_at = ? WHERE id = ?',
      bookmarked ? 1 : 0,
      bookmarked ? 1 : 0,
      bookmarked ? Date.now() : null,
      Date.now(),
      id
    )
  }

  /**
   * A project's bookmarked-thread count, read on the database worker.
   *
   * The bookmark toggle is an interaction path, so the cap check that reads this
   * must not touch SQLite on the Electron main thread (see `docs/APP-BIBLE.md`).
   */
  async countBookmarkedByProjectViaWorker(projectId: string): Promise<number> {
    const result = await this.db.queryViaWorker(
      'SELECT COUNT(*) AS count FROM threads WHERE project_id = ? AND bookmarked = 1',
      [projectId],
      1
    )
    if (!result.ok) return 0
    return Number(result.rows[0]?.['count'] ?? 0)
  }

  setSortOrder(id: string, sortOrder: number, now = Date.now()): void {
    this.db.run(
      'UPDATE threads SET sort_order = ?, last_activity = ?, updated_at = ? WHERE id = ?',
      sortOrder,
      now,
      now,
      id
    )
  }

  setScopeSortOrder(id: string, scopeSortOrder: number): void {
    this.db.run(
      'UPDATE threads SET scope_sort_order = ?, updated_at = ? WHERE id = ?',
      scopeSortOrder,
      Date.now(),
      id
    )
  }

  markRead(id: string): void {
    this.db.run('UPDATE threads SET read = 1 WHERE id = ? AND read = 0', id)
  }

  /**
   * Mark a thread unread. Used to surface an unattended assistant run that
   * settled failed while nobody was watching, so the durable failure reaches the
   * badge and the notification panel on the next open instead of reading as
   * already-seen.
   */
  markUnread(id: string): void {
    this.db.run('UPDATE threads SET read = 0 WHERE id = ? AND read = 1', id)
  }

  countByProject(projectId: string): number {
    const row = this.db.get<{ cnt: number }>(
      'SELECT count(*) as cnt FROM threads WHERE project_id = ?',
      projectId
    )
    return row?.cnt ?? 0
  }

  batchUpdateSortOrder(ids: string[]): void {
    const stmt = this.db.prepare(
      'UPDATE threads SET sort_order = ?, last_activity = ?, updated_at = ? WHERE id = ?'
    )
    const now = Date.now()
    this.db.transaction(() => {
      for (let i = 0; i < ids.length; i++) {
        stmt.run(now - i, now, now, ids[i])
      }
    })
  }

  /**
   * Rewrite pin timestamps so the first id is treated as most-recently pinned.
   * `base` is the newest value; each subsequent entry gets base - index, keeping
   * them distinct and ordered (newest/front first) so a newly pinned thread
   * (pinned_at = now) always lands at the top.
   */
  batchUpdatePinnedAt(ids: string[], base: number): void {
    const stmt = this.db.prepare('UPDATE threads SET pinned_at = ? WHERE id = ?')
    this.db.transaction(() => {
      for (let i = 0; i < ids.length; i++) {
        stmt.run(base - i, ids[i])
      }
    })
  }

  batchUpdateScopeSortOrder(bucketId: string, slice: string, ids: string[]): void {
    const stmt = this.db.prepare(
      'UPDATE threads SET scope_sort_order = ?, updated_at = ? WHERE id = ?'
    )
    const now = Date.now()
    this.db.transaction(() => {
      for (let i = 0; i < ids.length; i++) {
        stmt.run(now - i, now, now, ids[i])
      }
    })
  }

  /**
   * Full-text thread search across titles and conversation content.
   *
   * Results are deduped by thread: title matches lead, then the threads with
   * the most matching messages, most recently active first. Message matches
   * surface user messages and the agent's final output from
   * conversation-scoped records.
   */
  search(
    query: string,
    options: ThreadSearchOptions = {},
    useSearchMeta = false
  ): ThreadSearchResult[] {
    const raw = query.trim()
    if (!raw) return []
    const built = buildThreadSearchSql(raw, options, useSearchMeta)
    const titleRows = this.db.all<ThreadRow>(
      `${built.title.sql} LIMIT ?`,
      ...built.title.params,
      built.limit
    )
    const messageRows = built.fts
      ? this.db.all<ThreadRow & MessageMatchRow>(
          `${built.fts.sql} LIMIT ?`,
          ...built.fts.params,
          threadSearchMessageLimit(built.limit)
        )
      : []
    return mergeThreadSearchResults(titleRows, messageRows, raw, built.limit)
  }
}
