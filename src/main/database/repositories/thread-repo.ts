import type { Database } from '../database'
import type {
  AgentRateLimitWindow,
  AgentTokenUsage,
  Thread,
  ThreadContextUsage,
  ThreadSearchResult,
  ThreadStatus,
  ThreadSettings,
  ThreadTitleSource
} from '../../../lib/types'

interface ThreadRow {
  id: string
  project_id: string
  provider_id: string
  title: string
  title_source: string
  status: string
  pinned: number
  pinned_at: number | null
  sort_order: number | null
  scope_sort_order: number | null
  archived: number
  read: number
  branch: string | null
  feature_slug: string | null
  scope_bucket_id: string | null
  settings: string | null
  context_usage: string | null
  session_id: string | null
  session_harness_id: string | null
  dismissed_spec_id: string | null
  dismissed_spec_version: number | null
  audit_state: string | null
  loop_iteration: number | null
  active_audit_id: string | null
  active_audit_version: number | null
  assignment_id: string | null
  assignment_role: string | null
  assignment_task_id: string | null
  coordinator_thread_id: string | null
  achievement_role: string | null
  auditor_thread_id: string | null
  user_input_locked: number
  created_at: number
  updated_at: number
  last_activity: number
  working_directory: string
}

/** Safe JSON read for optional blob columns — a corrupt row must not break a thread list. */
function parseStoredJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * Validate a raw context-usage snapshot with integrity checks so a corrupt or
 * corrupt blob can never crash a thread list or render a bogus meter. Returns
 * null when the shape is unusable.
 */
export function parseThreadContextUsage(value: unknown): ThreadContextUsage | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.harnessId !== 'string' || typeof record.providerId !== 'string') return null
  if (typeof record.costUsd !== 'number') return null
  const contextUsed = typeof record.contextUsed === 'number' ? record.contextUsed : undefined
  const tokenRecord = record.tokens
  if (tokenRecord !== undefined && (!tokenRecord || typeof tokenRecord !== 'object')) return null
  const tokenFields: Array<keyof AgentTokenUsage> = [
    'input',
    'output',
    'reasoning',
    'cacheRead',
    'cacheWrite',
    'total'
  ]
  const tokens = tokenRecord as Record<string, unknown> | undefined
  if (tokens) {
    for (const field of tokenFields) {
      if (typeof tokens[field] !== 'number') return null
    }
  }
  const rateLimits = Array.isArray(record.rateLimits)
    ? (record.rateLimits as AgentRateLimitWindow[])
    : []
  const creditsRecord = record.credits
  const credits =
    creditsRecord && typeof creditsRecord === 'object'
      ? (() => {
          const raw = creditsRecord as Record<string, unknown>
          return {
            ...(typeof raw.balance === 'number' ? { balance: raw.balance } : {}),
            ...(typeof raw.hasCredits === 'boolean' ? { hasCredits: raw.hasCredits } : {}),
            ...(typeof raw.unlimited === 'boolean' ? { unlimited: raw.unlimited } : {}),
            ...(typeof raw.planType === 'string' ? { planType: raw.planType } : {})
          }
        })()
      : undefined
  return {
    harnessId: record.harnessId,
    providerId: record.providerId,
    ...(contextUsed === undefined ? {} : { contextUsed }),
    contextPercent: typeof record.contextPercent === 'number' ? record.contextPercent : undefined,
    contextWindow: typeof record.contextWindow === 'number' ? record.contextWindow : undefined,
    costUsd: record.costUsd,
    ...(tokens ? { tokens: tokens as unknown as AgentTokenUsage } : {}),
    rateLimits,
    ...(credits && Object.keys(credits).length > 0 ? { credits } : {})
  }
}

/** Parse a raw thread row into a display-facing Thread. */
function rowToThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    projectId: row.project_id,
    providerId: row.provider_id,
    title: row.title,
    titleSource: (row.title_source || 'default') as ThreadTitleSource,
    status: row.status as ThreadStatus,
    pinned: row.pinned === 1,
    pinnedAt: row.pinned_at ?? undefined,
    sortOrder: row.sort_order ?? undefined,
    scopeSortOrder: row.scope_sort_order ?? undefined,
    archived: row.archived === 1,
    read: row.read === 1,
    branch: row.branch ?? undefined,
    featureSlug: row.feature_slug ?? undefined,
    scopeBucketId: row.scope_bucket_id ?? undefined,
    settings: row.settings ? (JSON.parse(row.settings) as ThreadSettings) : undefined,
    contextUsage: row.context_usage
      ? (parseThreadContextUsage(parseStoredJson(row.context_usage)) ?? undefined)
      : undefined,
    sessionId: row.session_id ?? undefined,
    sessionHarnessId: row.session_harness_id ?? undefined,
    dismissedSpecId: row.dismissed_spec_id ?? undefined,
    dismissedSpecVersion: row.dismissed_spec_version ?? undefined,
    auditState: (row.audit_state as Thread['auditState']) ?? undefined,
    loopIteration: row.loop_iteration ?? undefined,
    activeAuditId: row.active_audit_id ?? undefined,
    activeAuditVersion: row.active_audit_version ?? undefined,
    assignmentId: row.assignment_id ?? undefined,
    assignmentRole: (row.assignment_role as Thread['assignmentRole']) ?? undefined,
    assignmentTaskId: row.assignment_task_id ?? undefined,
    coordinatorThreadId: row.coordinator_thread_id ?? undefined,
    achievementRole: (row.achievement_role as Thread['achievementRole']) ?? undefined,
    auditorThreadId: row.auditor_thread_id ?? undefined,
    userInputLocked: row.user_input_locked === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivity: row.last_activity,
    workingDirectory: row.working_directory
  }
}

const FTS_QUERY_TOKEN_LIMIT = 32
const SNIPPET_BEFORE = 60
const SNIPPET_AFTER = 120

/** Build a safe FTS5 MATCH expression from free-form input (prefix per word). */
function toFtsQuery(raw: string): string {
  const tokens = raw.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  if (tokens.length === 0) return ''
  return tokens
    .slice(0, FTS_QUERY_TOKEN_LIMIT)
    .map((token) => `"${token}"*`)
    .join(' ')
}

/** Escape LIKE wildcards so user input matches literally. */
function escapeLike(raw: string): string {
  return raw.replace(/[\\%_]/g, (char) => `\\${char}`)
}

/** Build a readable excerpt around the first occurrence of a query term. */
function buildSnippet(rawText: string, rawQuery: string): string {
  const text = rawText.replace(/\s+/g, ' ').trim()
  if (!text) return ''
  const tokens = (rawQuery.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(
    0,
    FTS_QUERY_TOKEN_LIMIT
  )
  if (tokens.length === 0) return text.slice(0, 160)
  const lower = text.toLowerCase()
  let bestIndex = -1
  for (const token of tokens) {
    const index = lower.indexOf(token)
    if (index >= 0 && (bestIndex === -1 || index < bestIndex)) bestIndex = index
  }
  if (bestIndex === -1) return text.slice(0, 160)
  const start = Math.max(0, bestIndex - SNIPPET_BEFORE)
  const end = Math.min(text.length, bestIndex + SNIPPET_AFTER)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

export interface ThreadSearchOptions {
  projectId?: string
  limit?: number
}

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
   * - `activity`: pinned (newest pinned first), then `last_activity` descending —
   *   guarantees the most recently active threads are always loaded regardless
   *   of `sort_order`.
   */
  order?: 'default' | 'activity'
}

function buildOrderBy(options: ThreadListOptions): string {
  return options.order === 'activity'
    ? 'ORDER BY pinned DESC, pinned_at DESC, last_activity DESC'
    : 'ORDER BY pinned DESC, pinned_at DESC, sort_order ASC, last_activity DESC'
}

function buildListClauses(
  filters: string[],
  params: unknown[],
  options: ThreadListOptions
): { where: string; params: unknown[]; limit: string } {
  const clauses = [...filters]
  if (options.includeArchived === false) {
    clauses.push('archived = 0')
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const limitClause =
    options.limit !== undefined
      ? ` LIMIT ${Math.max(0, Math.floor(options.limit))} OFFSET ${Math.max(0, Math.floor(options.offset ?? 0))}`
      : ''
  return { where, params, limit: limitClause }
}

interface MessageMatchRow {
  match_role: string
  snippet_text: string
  snippet_timestamp: number
}

const THREAD_UPSERT_SQL = `INSERT INTO threads(
  id, project_id, provider_id, title, title_source, status,
  pinned, pinned_at, sort_order, scope_sort_order, archived, read,
  branch, feature_slug, scope_bucket_id, settings, context_usage,
  session_id, session_harness_id, dismissed_spec_id, dismissed_spec_version,
  audit_state, loop_iteration, active_audit_id, active_audit_version,
  assignment_id, assignment_role, assignment_task_id,
  coordinator_thread_id, achievement_role, auditor_thread_id, user_input_locked,
  created_at, updated_at, last_activity, working_directory
) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET
  project_id=excluded.project_id,
  provider_id=excluded.provider_id,
  title=excluded.title,
  title_source=excluded.title_source,
  status=excluded.status,
  pinned=excluded.pinned,
  sort_order=excluded.sort_order,
  scope_sort_order=excluded.scope_sort_order,
  archived=excluded.archived,
  read=excluded.read,
  branch=excluded.branch,
  feature_slug=excluded.feature_slug,
  scope_bucket_id=excluded.scope_bucket_id,
  settings=excluded.settings,
  context_usage=excluded.context_usage,
  session_id=excluded.session_id,
  session_harness_id=excluded.session_harness_id,
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
  auditor_thread_id=excluded.auditor_thread_id,
  user_input_locked=excluded.user_input_locked,
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
    thread.sortOrder ?? null,
    thread.scopeSortOrder ?? null,
    thread.archived ? 1 : 0,
    thread.read ? 1 : 0,
    thread.branch ?? null,
    thread.featureSlug ?? null,
    thread.scopeBucketId ?? null,
    thread.settings ? JSON.stringify(thread.settings) : null,
    thread.contextUsage ? JSON.stringify(thread.contextUsage) : null,
    thread.sessionId ?? null,
    thread.sessionHarnessId ?? null,
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
    thread.auditorThreadId ?? null,
    thread.userInputLocked ? 1 : 0,
    thread.createdAt,
    thread.updatedAt,
    thread.lastActivity,
    thread.workingDirectory
  ]
}

export class ThreadRepo {
  constructor(private db: Database) {}

  upsert(thread: Thread): void {
    this.db.run(THREAD_UPSERT_SQL, ...threadUpsertParams(thread))
  }

  async upsertViaWorker(thread: Thread): Promise<void> {
    const result = await this.db.executeViaWorker(THREAD_UPSERT_SQL, threadUpsertParams(thread))
    if (!result.ok) {
      throw new Error(result.error ?? 'Thread upsert failed')
    }
  }

  get(id: string): Thread | null {
    const row = this.db.get<ThreadRow>('SELECT * FROM threads WHERE id = ?', id)
    if (!row) return null
    const thread = rowToThread(row)
    const used = this.usedHarnessesFor([thread.id])
    thread.usedHarnessIds = used.get(thread.id)
    return thread
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
    const { where, params, limit } = buildListClauses(['project_id = ?'], [projectId], options)
    const rows = this.db.all<ThreadRow>(
      `SELECT * FROM threads ${where}
       ${buildOrderBy(options)}${limit}`,
      ...params
    )
    return this.hydrateThreads(rows)
  }

  listAll(options: ThreadListOptions = {}): Thread[] {
    const { where, params, limit } = buildListClauses([], [], options)
    const rows = this.db.all<ThreadRow>(
      `SELECT * FROM threads ${where}
       ${buildOrderBy(options)}${limit}`,
      ...params
    )
    return this.hydrateThreads(rows)
  }

  /** Load every thread on the database worker so unbounded hydration does not block Electron. */
  async listAllViaWorker(options: ThreadListOptions = {}): Promise<Thread[]> {
    const { where, params, limit } = buildListClauses([], [], options)
    const result = await this.db.queryViaWorker(
      `SELECT * FROM threads ${where}
       ${buildOrderBy(options)}${limit}`,
      params,
      0
    )
    if (!result.ok) return this.listAll(options)
    return this.hydrateThreads(result.rows as unknown as ThreadRow[])
  }

  /** Load only non-archived threads that currently hold active agent work. */
  listActive(): Array<Thread & { status: 'planning' | 'executing' }> {
    const rows = this.db.all<ThreadRow>(
      `SELECT * FROM threads
       WHERE archived = 0 AND status IN ('planning', 'executing')
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
         WHERE archived = 0 AND status IN ('planning', 'executing')
         LIMIT 1`
      ) !== undefined
    )
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
      .executeViaWorker('UPDATE threads SET context_usage = ? WHERE id = ? AND project_id = ?', [
        JSON.stringify(contextUsage),
        threadId,
        projectId
      ])
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
      'UPDATE threads SET status = ?, last_activity = ?, updated_at = ? WHERE id = ?',
      status,
      lastActivity,
      lastActivity,
      id
    )
  }

  setPinned(id: string, pinned: boolean, pinnedAt?: number): void {
    this.db.run(
      'UPDATE threads SET pinned = ?, pinned_at = ?, updated_at = ? WHERE id = ?',
      pinned ? 1 : 0,
      pinned ? (pinnedAt ?? Date.now()) : null,
      Date.now(),
      id
    )
  }

  setSortOrder(id: string, sortOrder: number): void {
    this.db.run(
      'UPDATE threads SET sort_order = ?, updated_at = ? WHERE id = ?',
      sortOrder,
      Date.now(),
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

  countByProject(projectId: string): number {
    const row = this.db.get<{ cnt: number }>(
      'SELECT count(*) as cnt FROM threads WHERE project_id = ?',
      projectId
    )
    return row?.cnt ?? 0
  }

  batchUpdateSortOrder(ids: string[]): void {
    const stmt = this.db.prepare('UPDATE threads SET sort_order = ?, updated_at = ? WHERE id = ?')
    const now = Date.now()
    this.db.transaction(() => {
      for (let i = 0; i < ids.length; i++) {
        stmt.run(i, now, ids[i])
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
        stmt.run(i, now, ids[i])
      }
    })
  }

  /**
   * Full-text thread search across titles and conversation content.
   *
   * Title matches (substring, case-insensitive) rank first, then message
   * matches ordered by FTS5 relevance (bm25). Message matches surface user
   * messages and the agent's final output from conversation-scoped records.
   */
  search(query: string, options: ThreadSearchOptions = {}): ThreadSearchResult[] {
    const raw = query.trim()
    if (!raw) return []
    const built = buildThreadSearchSql(raw, options)
    const titleRows = this.db.all<ThreadRow>(
      `${built.title.sql} LIMIT ?`,
      ...built.title.params,
      built.limit
    )
    const messageRows = built.fts
      ? this.db.all<ThreadRow & MessageMatchRow>(
          `${built.fts.sql} LIMIT ?`,
          ...built.fts.params,
          Math.min(built.limit * 4, 200)
        )
      : []
    return mergeThreadSearchResults(titleRows, messageRows, raw, built.limit)
  }
}

// ── Shared search SQL and result mapping (main + worker) ──────────────────

export interface ThreadSearchSql {
  /** Title-substring query (no LIMIT; caller bounds the result). */
  title: { sql: string; params: unknown[] }
  /** FTS5 message query (no LIMIT; null when the raw query has no tokens). */
  fts: { sql: string; params: unknown[] } | null
  /** Effective result cap. */
  limit: number
}

/** Build the title + FTS search SQL from free-form input. */
export function buildThreadSearchSql(
  raw: string,
  options: ThreadSearchOptions = {}
): ThreadSearchSql {
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100))
  const projectId = options.projectId ?? null
  const trimmed = raw.trim()
  const title = {
    sql: `SELECT t.* FROM threads t
      WHERE (? IS NULL OR t.project_id = ?)
        AND t.title LIKE ? ESCAPE '\\'
      ORDER BY t.last_activity DESC`,
    params: [projectId, projectId, `%${escapeLike(trimmed)}%`]
  }
  const ftsQuery = toFtsQuery(trimmed)
  const fts = ftsQuery
    ? {
        sql: `SELECT t.*, am.role AS match_role, substr(am.search_text, 1, 2000) AS snippet_text,
              am.created_at AS snippet_timestamp, bm25(agent_messages_fts) AS fts_rank
        FROM agent_messages_fts
        JOIN agent_messages am ON am.rowid = agent_messages_fts.rowid
        JOIN threads t ON t.id = am.thread_id
        WHERE agent_messages_fts MATCH ?
          AND am.session_id IS NULL
          AND am.visibility = 'conversation'
          AND (? IS NULL OR t.project_id = ?)
        ORDER BY bm25(agent_messages_fts), am.created_at DESC`,
        params: [ftsQuery, projectId, projectId]
      }
    : null
  return { title, fts, limit }
}

/** Merge title + message matches, dedup by thread, and build snippets. */
export function mergeThreadSearchResults(
  titleRows: unknown[],
  messageRows: unknown[],
  raw: string,
  limit: number
): ThreadSearchResult[] {
  const results: ThreadSearchResult[] = []
  const seen = new Set<string>()
  for (const row of titleRows) {
    const threadRow = row as ThreadRow
    if (seen.has(threadRow.id)) continue
    seen.add(threadRow.id)
    results.push({ thread: rowToThread(threadRow), kind: 'title' })
    if (results.length >= limit) return results
  }
  for (const row of messageRows) {
    const threadRow = row as ThreadRow
    if (seen.has(threadRow.id)) continue
    if (results.length >= limit) break
    seen.add(threadRow.id)
    const meta = row as {
      match_role?: unknown
      snippet_text?: unknown
      snippet_timestamp?: unknown
    }
    results.push({
      thread: rowToThread(threadRow),
      kind: 'message',
      role: String(meta.match_role) === 'assistant' ? 'assistant' : 'user',
      snippet: buildSnippet(String(meta.snippet_text ?? ''), raw),
      timestamp: Number(meta.snippet_timestamp)
    })
  }
  return results
}
