import { unarchivedThreadSql } from '../../../../lib/archives'
import { queryConcepts } from '../../../../lib/search/query-evidence'
import {
  ASSISTANT_SPACE_ID,
  GLOBAL_BROWSER_PROJECT_ID,
  INBOX_PROJECT_ID,
  type Thread,
  type ThreadSearchResult
} from '../../../../lib/types'
import { rowToThread, type ThreadRow } from './thread-row'

/**
 * Full-text thread search: the SQL both the main and worker connections run,
 * the family scope both share, and the merge that ranks their rows.
 *
 * The thread repository composes these; this unit owns no database handle.
 */

const FTS_QUERY_TOKEN_LIMIT = 32
const SNIPPET_BEFORE = 60
const SNIPPET_AFTER = 120

/**
 * Build a safe FTS5 MATCH expression from free-form input (prefix per word).
 *
 * Filler words are dropped first: requiring "the" next to the words that carry
 * the question is what made an all-term query match long messages that happened
 * to contain every word somewhere. The concepts still have to appear together,
 * so precision is unchanged for the words that mean something.
 */
function toFtsQuery(raw: string): string {
  const tokens = queryConcepts(raw).slice(0, FTS_QUERY_TOKEN_LIMIT)
  if (tokens.length === 0) return ''
  return tokens.map((token) => `"${token}"*`).join(' ')
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

/**
 * Which thread family a search is scoped to.
 *
 * `projects` searches every engineering project thread, `chats` the standalone
 * conversations in the inbox, and `assistant` the assistant space (optionally
 * narrowed to one assistant). Omitted, a search spans every family except the
 * hidden browser-chat container, which is how the in-view thread searches have
 * always behaved.
 */
export type ThreadSearchFamily = 'projects' | 'chats' | 'assistant'

export interface ThreadSearchOptions {
  projectId?: string
  limit?: number
  family?: ThreadSearchFamily
  /**
   * Narrow the search to the threads one assistant scheduled or runs. It
   * narrows whichever family the caller asked for instead of replacing it, so a
   * search never accepts this id and silently ignores it.
   */
  assistantId?: string
  /**
   * Narrow the search to one scope bucket (a sidebar group) inside the searched
   * project(s). Omitted, a search reads every scope of the family it covers.
   */
  scopeBucketId?: string
}

/** A row carrying the FTS excerpt and rank alongside its thread columns. */
export interface MessageMatchRow {
  match_role: string
  snippet_text: string
  snippet_timestamp: number
  /** How many of the thread's messages matched the query at all. */
  match_count: number
}

// ── Search SQL and result mapping (main + worker) ─────────────────────────

export interface ThreadSearchSql {
  /** Title-substring query (no LIMIT; caller bounds the result). */
  title: { sql: string; params: unknown[] }
  /** FTS5 message query (bounded internally; null when the raw query has no tokens). */
  fts: { sql: string; params: unknown[] } | null
  /** Effective result cap. */
  limit: number
}

/** How many message rows the FTS query ranks/returns per search. */
export function threadSearchMessageLimit(limit: number): number {
  return Math.min(limit * 4, 200)
}

/**
 * Build the title + FTS search SQL from free-form input.
 *
 * `useSearchMeta` selects the fast message query: it ranks and filters against
 * the narrow `agent_message_search_meta` mirror and extracts matching excerpts
 * through FTS. Without it (the mirror is still
 * being backfilled, or the database predates it) the legacy query joins
 * `agent_messages` directly, which is correct but reads the whole messages
 * table in FTS index order. See schema.ts for the mirror's rationale.
 */
export function buildThreadSearchSql(
  raw: string,
  options: ThreadSearchOptions = {},
  useSearchMeta = false,
  messageQuery?: string,
  snippetTokens = 64
): ThreadSearchSql {
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100))
  const trimmed = raw.trim()
  const titleScope = threadSearchScopeClause('t', options)
  const title = {
    sql: `SELECT t.* FROM threads t
      WHERE ${titleScope.sql}
        AND (t.title LIKE ? ESCAPE '\\' OR t.id = ?)
      ORDER BY t.last_activity DESC`,
    params: [...titleScope.params, `%${escapeLike(trimmed)}%`, trimmed]
  }
  const ftsQuery = messageQuery ?? toFtsQuery(trimmed)
  const messageLimit = threadSearchMessageLimit(limit)
  const metaScope = threadSearchScopeClause('st', options)
  const legacyScope = threadSearchScopeClause('t', options)
  // bm25() cannot be combined with a window function in one query, so each
  // thread's matching-message count comes from its own grouped FTS pass over the
  // same MATCH set. The join is cheap because both halves are already narrowed
  // by MATCH, and `counts` only carries one row per matched thread.
  const countScope = threadSearchScopeClause('sc', options)
  const fts = ftsQuery
    ? useSearchMeta
      ? {
          sql: `SELECT t.*, meta.role AS match_role,
              meta.snippet_text AS snippet_text,
              meta.created_at AS snippet_timestamp, meta.fts_rank AS fts_rank,
              counts.match_count AS match_count
        FROM (
          SELECT m.rowid AS msg_rowid, m.thread_id AS msg_thread_id, m.role AS role,
                 m.created_at AS created_at, bm25(agent_messages_fts) AS fts_rank,
                 snippet(agent_messages_fts, 0, '', '', ' … ', ?) AS snippet_text
          FROM agent_messages_fts
          JOIN agent_message_search_meta m ON m.rowid = agent_messages_fts.rowid
          JOIN threads st ON st.id = m.thread_id
          WHERE agent_messages_fts MATCH ?
            AND m.session_id IS NULL
            AND m.visibility = 'conversation'
            AND ${metaScope.sql}
          ORDER BY bm25(agent_messages_fts), m.created_at DESC
          LIMIT ?
        ) meta
        JOIN threads t ON t.id = meta.msg_thread_id
        JOIN (
          SELECT m.thread_id AS count_thread_id, COUNT(*) AS match_count
          FROM agent_messages_fts
          JOIN agent_message_search_meta m ON m.rowid = agent_messages_fts.rowid
          JOIN threads sc ON sc.id = m.thread_id
          WHERE agent_messages_fts MATCH ?
            AND m.session_id IS NULL
            AND m.visibility = 'conversation'
            AND ${countScope.sql}
          GROUP BY m.thread_id
        ) counts ON counts.count_thread_id = meta.msg_thread_id
        ORDER BY meta.fts_rank, meta.created_at DESC`,
          params: [
            snippetTokens,
            ftsQuery,
            ...metaScope.params,
            messageLimit,
            ftsQuery,
            ...countScope.params
          ]
        }
      : {
          sql: `SELECT t.*, am.role AS match_role,
              snippet(agent_messages_fts, 0, '', '', ' … ', ?) AS snippet_text,
              am.created_at AS snippet_timestamp, bm25(agent_messages_fts) AS fts_rank,
              counts.match_count AS match_count
        FROM agent_messages_fts
        JOIN agent_messages am ON am.rowid = agent_messages_fts.rowid
        JOIN threads t ON t.id = am.thread_id
        JOIN (
          SELECT matched.thread_id AS count_thread_id, COUNT(*) AS match_count
          FROM agent_messages_fts
          JOIN agent_messages matched ON matched.rowid = agent_messages_fts.rowid
          JOIN threads sc ON sc.id = matched.thread_id
          WHERE agent_messages_fts MATCH ?
            AND matched.session_id IS NULL
            AND matched.visibility = 'conversation'
            AND ${countScope.sql}
          GROUP BY matched.thread_id
        ) counts ON counts.count_thread_id = am.thread_id
        WHERE agent_messages_fts MATCH ?
          AND am.session_id IS NULL
          AND am.visibility = 'conversation'
          AND ${legacyScope.sql}
        ORDER BY bm25(agent_messages_fts), am.created_at DESC`,
          params: [snippetTokens, ftsQuery, ...countScope.params, ftsQuery, ...legacyScope.params]
        }
    : null
  return { title, fts, limit }
}

/**
 * The WHERE fragment that scopes a thread search to its family.
 *
 * The table alias is a parameter because the FTS query joins `threads` twice
 * (`st` inside the ranking subquery, `t` outside it) and both need the same
 * restriction. Params are positional and must be spread in the same order the
 * fragment declares them.
 */
function threadSearchScopeClause(
  alias: string,
  options: ThreadSearchOptions
): { sql: string; params: unknown[] } {
  const projectId = options.projectId ?? null
  const assistantId = options.assistantId ?? null
  const scopeBucketId = options.scopeBucketId ?? null
  // A scope bucket is a sidebar group inside a project, so it narrows whichever
  // family the caller asked for instead of replacing it.
  const withScopeBucket = (sql: string, params: unknown[]): { sql: string; params: unknown[] } =>
    scopeBucketId
      ? { sql: `${sql} AND ${alias}.scope_bucket_id = ?`, params: [...params, scopeBucketId] }
      : { sql, params }
  // An assistant id narrows every family, exactly like a scope bucket does: a
  // project thread an assistant scheduled carries the same column.
  const narrowed = (sql: string, params: unknown[]): { sql: string; params: unknown[] } => {
    const scoped = withScopeBucket(sql, params)
    return assistantId
      ? {
          sql: `${scoped.sql} AND ${alias}.assistant_id = ?`,
          params: [...scoped.params, assistantId]
        }
      : scoped
  }
  switch (options.family) {
    case 'chats':
      return narrowed(`${alias}.project_id = ? AND ${unarchivedThreadSql(alias)}`, [
        INBOX_PROJECT_ID
      ])
    case 'assistant':
      return narrowed(`${alias}.project_id = ? AND ${unarchivedThreadSql(alias)}`, [
        ASSISTANT_SPACE_ID
      ])
    case 'projects': {
      // Every engineering project, never the hidden inbox/assistant/browser
      // containers that share the same table.
      const clauses = [
        unarchivedThreadSql(alias),
        `${alias}.project_id != ?`,
        `${alias}.project_id != ?`,
        `${alias}.project_id != ?`
      ]
      const params: unknown[] = [GLOBAL_BROWSER_PROJECT_ID, ASSISTANT_SPACE_ID, INBOX_PROJECT_ID]
      if (projectId) {
        clauses.push(`${alias}.project_id = ?`)
        params.push(projectId)
      }
      return narrowed(clauses.join(' AND '), params)
    }
    default: {
      // Unscoped/global: every family except the hidden browser-chat container,
      // optionally narrowed to one project.
      const clauses = [`${alias}.project_id != ?`, unarchivedThreadSql(alias)]
      const params: unknown[] = [GLOBAL_BROWSER_PROJECT_ID]
      if (projectId) {
        clauses.push(`${alias}.project_id = ?`)
        params.push(projectId)
      }
      return narrowed(clauses.join(' AND '), params)
    }
  }
}

/**
 * Whether a thread belongs to the family a search was scoped to. This is the
 * in-memory twin of {@link threadSearchScopeClause}, used by the semantic path
 * after matches are hydrated back into `Thread` rows (which carry `projectId`,
 * `assistantId` and `scopeBucketId` but no SQL to filter against).
 */
export function threadMatchesSearchScope(
  thread: Pick<Thread, 'projectId' | 'assistantId' | 'scopeBucketId'>,
  options: ThreadSearchOptions
): boolean {
  if (options.scopeBucketId && thread.scopeBucketId !== options.scopeBucketId) return false
  if (options.assistantId && thread.assistantId !== options.assistantId) return false
  switch (options.family) {
    case 'chats':
      return thread.projectId === INBOX_PROJECT_ID
    case 'assistant':
      return thread.projectId === ASSISTANT_SPACE_ID
    case 'projects':
      if (
        thread.projectId === GLOBAL_BROWSER_PROJECT_ID ||
        thread.projectId === ASSISTANT_SPACE_ID ||
        thread.projectId === INBOX_PROJECT_ID
      ) {
        return false
      }
      return !options.projectId || thread.projectId === options.projectId
    default:
      if (thread.projectId === GLOBAL_BROWSER_PROJECT_ID) return false
      return !options.projectId || thread.projectId === options.projectId
  }
}

/**
 * Score how strongly a thread title matches the query. All title rows already
 * contain the full query substring (title LIKE), so this only grades closeness:
 * exact title > title starting with the query > query appearing mid-title.
 */
function titleMatchScore(title: string, raw: string): number {
  const normalizedTitle = title.toLowerCase()
  const normalizedQuery = raw.toLowerCase()
  if (normalizedTitle === normalizedQuery) return 3
  if (normalizedTitle.startsWith(normalizedQuery)) return 2
  return 1
}

/**
 * Merge title + message matches, dedup by thread, and build snippets.
 *
 * Match quality always outranks recency:
 * 1. Title matches come before message-only matches. Within title matches,
 *    closer titles (exact > prefix > contains) rank first.
 * 2. Message-only matches rank by how many of the thread's messages matched,
 *    then by `last_activity`, then by bm25. Full-text rank grades a single
 *    message, so on its own it put a thread whose one-line notification repeats
 *    the word above the conversation that actually discusses it.
 * 3. The first row seen per thread is its best bm25 match and supplies the
 *    snippet, because rows arrive pre-sorted.
 */
export function mergeThreadSearchResults(
  titleRows: unknown[],
  messageRows: unknown[],
  raw: string,
  limit: number
): ThreadSearchResult[] {
  interface Entry {
    result: ThreadSearchResult
    titleKind: boolean
    titleScore: number
    /** How many of the thread's messages matched; the body of its evidence. */
    matchCount: number
    /** Lower bm25 is better; only meaningful for message matches. */
    bm25: number
    activity: number
  }
  const byThread = new Map<string, Entry>()
  const consume = (row: unknown, titleKind: boolean) => {
    const threadRow = row as ThreadRow
    if (byThread.has(threadRow.id)) {
      const entry = byThread.get(threadRow.id)!
      // An exact title hit beats a message hit for the same thread.
      if (titleKind && !entry.titleKind) {
        entry.titleKind = true
        entry.titleScore = titleMatchScore(threadRow.title, raw)
        entry.result.kind = 'title'
        entry.result.role = undefined
        entry.result.snippet = undefined
        entry.result.timestamp = undefined
      }
      return
    }
    const thread = rowToThread(threadRow)
    if (titleKind) {
      byThread.set(threadRow.id, {
        result: { thread, kind: 'title' },
        titleKind: true,
        titleScore: titleMatchScore(threadRow.title, raw),
        matchCount: 0,
        bm25: 0,
        activity: thread.lastActivity
      })
      return
    }
    const meta = row as {
      match_role?: unknown
      snippet_text?: unknown
      snippet_timestamp?: unknown
      fts_rank?: unknown
      match_count?: unknown
    }
    byThread.set(threadRow.id, {
      result: {
        thread,
        kind: 'message',
        role: String(meta.match_role) === 'assistant' ? 'assistant' : 'user',
        snippet: buildSnippet(String(meta.snippet_text ?? ''), raw),
        timestamp: Number(meta.snippet_timestamp)
      },
      titleKind: false,
      titleScore: 0,
      // Rows arrive bm25-ordered, so the first row per thread is its best.
      matchCount: Number(meta.match_count ?? 1),
      bm25: Number(meta.fts_rank ?? 0),
      activity: thread.lastActivity
    })
  }
  for (const row of messageRows) consume(row, false)
  for (const row of titleRows) consume(row, true)
  return [...byThread.values()]
    .sort((a, b) => {
      if (a.titleKind !== b.titleKind) return a.titleKind ? -1 : 1
      if (a.titleKind && a.titleScore !== b.titleScore) return b.titleScore - a.titleScore
      // bm25 grades one message, which says almost nothing about a thread: a
      // single short message that repeats the word beats a conversation that
      // discusses it twenty times. How many of the thread's messages matched is
      // the thread-level signal, so it leads; recency settles the ties and bm25
      // only ranks the best excerpt of otherwise equal threads.
      if (!a.titleKind && a.matchCount !== b.matchCount) return b.matchCount - a.matchCount
      if (!a.titleKind && a.activity !== b.activity) return b.activity - a.activity
      if (!a.titleKind && a.bm25 !== b.bm25) return a.bm25 - b.bm25
      return b.activity - a.activity
    })
    .slice(0, limit)
    .map((entry) => entry.result)
}
