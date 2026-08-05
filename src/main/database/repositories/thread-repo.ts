import type { Database } from '../database'
import type {
  Thread,
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
  sort_order: number | null
  scope_sort_order: number | null
  archived: number
  read: number
  branch: string | null
  feature_slug: string | null
  scope_bucket_id: string | null
  settings: string | null
  session_id: string | null
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

function rowToThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    projectId: row.project_id,
    providerId: row.provider_id,
    title: row.title,
    titleSource: (row.title_source || 'default') as ThreadTitleSource,
    status: row.status as ThreadStatus,
    pinned: row.pinned === 1,
    sortOrder: row.sort_order ?? undefined,
    scopeSortOrder: row.scope_sort_order ?? undefined,
    archived: row.archived === 1,
    read: row.read === 1,
    branch: row.branch ?? undefined,
    featureSlug: row.feature_slug ?? undefined,
    scopeBucketId: row.scope_bucket_id ?? undefined,
    settings: row.settings ? (JSON.parse(row.settings) as ThreadSettings) : undefined,
    sessionId: row.session_id ?? undefined,
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

interface MessageMatchRow {
  match_role: string
  snippet_text: string
  snippet_timestamp: number
}

export class ThreadRepo {
  constructor(private db: Database) {}

  upsert(thread: Thread): void {
    this.db.run(
      `INSERT INTO threads(
        id, project_id, provider_id, title, title_source, status,
        pinned, sort_order, scope_sort_order, archived, read,
        branch, feature_slug, scope_bucket_id, settings,
        session_id, dismissed_spec_id, dismissed_spec_version,
        audit_state, loop_iteration, active_audit_id, active_audit_version,
        assignment_id, assignment_role, assignment_task_id,
        coordinator_thread_id, achievement_role, auditor_thread_id, user_input_locked,
        created_at, updated_at, last_activity, working_directory
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
        session_id=excluded.session_id,
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
        working_directory=excluded.working_directory`,
      thread.id,
      thread.projectId,
      thread.providerId,
      thread.title,
      thread.titleSource ?? 'default',
      thread.status,
      thread.pinned ? 1 : 0,
      thread.sortOrder ?? null,
      thread.scopeSortOrder ?? null,
      thread.archived ? 1 : 0,
      thread.read ? 1 : 0,
      thread.branch ?? null,
      thread.featureSlug ?? null,
      thread.scopeBucketId ?? null,
      thread.settings ? JSON.stringify(thread.settings) : null,
      thread.sessionId ?? null,
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
    )
  }

  get(id: string): Thread | null {
    const row = this.db.get<ThreadRow>('SELECT * FROM threads WHERE id = ?', id)
    return row ? rowToThread(row) : null
  }

  listByProject(projectId: string): Thread[] {
    const rows = this.db.all<ThreadRow>(
      `SELECT * FROM threads WHERE project_id = ?
       ORDER BY pinned DESC, sort_order ASC, last_activity DESC`,
      projectId
    )
    return rows.map(rowToThread)
  }

  listAll(): Thread[] {
    const rows = this.db.all<ThreadRow>(
      'SELECT * FROM threads ORDER BY pinned DESC, sort_order ASC, last_activity DESC'
    )
    return rows.map(rowToThread)
  }

  delete(id: string): void {
    this.db.run('DELETE FROM threads WHERE id = ?', id)
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

  setPinned(id: string, pinned: boolean): void {
    this.db.run(
      'UPDATE threads SET pinned = ?, updated_at = ? WHERE id = ?',
      pinned ? 1 : 0,
      Date.now(),
      id
    )
  }

  setArchived(id: string, archived: boolean): void {
    this.db.run(
      'UPDATE threads SET archived = ?, updated_at = ? WHERE id = ?',
      archived ? 1 : 0,
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
    const limit = Math.max(1, Math.min(options.limit ?? 20, 100))
    const projectId = options.projectId ?? null
    const results: ThreadSearchResult[] = []
    const seen = new Set<string>()

    const raw = query.trim()
    if (!raw) return results

    const titleRows = this.db.all<ThreadRow>(
      `SELECT t.* FROM threads t
       WHERE (? IS NULL OR t.project_id = ?)
         AND t.title LIKE ? ESCAPE '\\'
       ORDER BY t.last_activity DESC
       LIMIT ?`,
      projectId,
      projectId,
      `%${escapeLike(raw)}%`,
      limit
    )
    for (const row of titleRows) {
      if (seen.has(row.id)) continue
      seen.add(row.id)
      results.push({ thread: rowToThread(row), kind: 'title' })
      if (results.length >= limit) return results
    }

    const ftsQuery = toFtsQuery(raw)
    if (ftsQuery) {
      const messageRows = this.db.all<ThreadRow & MessageMatchRow>(
        `SELECT t.*, am.role AS match_role, substr(am.search_text, 1, 2000) AS snippet_text,
                am.created_at AS snippet_timestamp, bm25(agent_messages_fts) AS fts_rank
         FROM agent_messages_fts
         JOIN agent_messages am ON am.rowid = agent_messages_fts.rowid
         JOIN threads t ON t.id = am.thread_id
         WHERE agent_messages_fts MATCH ?
           AND am.session_id IS NULL
           AND am.visibility = 'conversation'
           AND (? IS NULL OR t.project_id = ?)
         ORDER BY bm25(agent_messages_fts), am.created_at DESC
         LIMIT ?`,
        ftsQuery,
        projectId,
        projectId,
        Math.min(limit * 4, 200)
      )
      for (const row of messageRows) {
        if (seen.has(row.id)) continue
        if (results.length >= limit) break
        seen.add(row.id)
        results.push({
          thread: rowToThread(row),
          kind: 'message',
          role: row.match_role === 'assistant' ? 'assistant' : 'user',
          snippet: buildSnippet(row.snippet_text, raw),
          timestamp: row.snippet_timestamp
        })
      }
    }

    return results
  }
}
