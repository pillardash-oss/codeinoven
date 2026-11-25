import type { Statement } from 'better-sqlite3'
import type { Database } from '../database/database'
import { AgentMessageRepo } from '../database/repositories/agent-message-repo'
import { AssistantRepo } from '../database/repositories/assistant-repo'
import { ProjectRepo } from '../database/repositories/project-repo'
import {
  ThreadRepo,
  threadMatchesSearchScope,
  type ThreadSearchOptions
} from '../database/repositories/thread-repo'
import {
  ASSISTANT_SPACE_ID,
  DEFAULT_SCOPE_BUCKET_ID,
  GLOBAL_BROWSER_PROJECT_ID,
  INBOX_PROJECT_ID,
  type AgentMessage,
  type Thread,
  type ThreadMessageCursor
} from '../../lib/types'
import { patternActionPhrase, resolveToolCall } from '../../lib/tool-action-label'
import {
  summarizeToolInput,
  truncateToolResult
} from '../chat/chat-engine/chat-engine-message-text'
import {
  ERROR_LOG_FILE,
  LOGS_DIRECTORY,
  MAIN_LOG_FILE,
  PERMISSION_EVENTS_LOG_FILE,
  flatLogRelativePath,
  logDayName,
  logRelativePathInDay,
  parseLogFilePath
} from '../system/log-paths'
import {
  MAX_LOG_READ_BYTES,
  listLogDayFolders,
  logPathKind,
  readLogFileTail
} from '../system/log-reader'

/** Bounded, redacted, read-only app diagnostics, granted on every gateway turn. */

const MAX_MESSAGE_TEXT_LENGTH = 4_000
const MAX_LOG_ENTRY_LENGTH = 2_000
const MAX_LOG_ENTRIES = 200
const MAX_MESSAGES = 120
const MAX_THREAD_LIST_RESULTS = 20
const MAX_QUERY_ROWS = 200
const MAX_QUERY_VALUE_LENGTH = 2_000
const MAX_QUERY_SQL_LENGTH = 4_000
const MAX_QUERY_PARAMS = 32
const MAX_SCHEMA_TABLES = 80
/** Tool calls one message may report, and the length one of them may take. */
const MAX_ACTION_LINES = 12
const MAX_ACTION_LINE_LENGTH = 400

/** Log files an agent may inspect through the diagnostics capability. */
const READABLE_LOG_FILES = [MAIN_LOG_FILE, ERROR_LOG_FILE, PERMISSION_EVENTS_LOG_FILE]

/** Schema PRAGMA statements an agent may run to learn the app schema. */
const READABLE_PRAGMAS = new Set([
  'collation_list',
  'compile_options',
  'database_list',
  'foreign_key_list',
  'function_list',
  'index_info',
  'index_list',
  'index_xinfo',
  'table_info',
  'table_list',
  'table_xinfo'
])

/** SQL functions that SQLite still classifies as read-only but that touch the host. */
const DENIED_SQL_FUNCTIONS = /\b(load_extension|readfile|writefile|fts3_tokenizer)\s*\(/iu

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Mirrors the redaction policy of DiagnosticsService. */
export function redactSensitiveText(value: string): string {
  return value
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/giu, '$1 [REDACTED]')
    .replace(
      /\b(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|private[_-]?key)(["']?\s*[:=]\s*["']?)(?:Bearer\s+)?([^"',;\s}]+)/giu,
      '$1$2[REDACTED]'
    )
    .replace(
      /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)=)[^&#\s]+/giu,
      '$1[REDACTED]'
    )
}

export interface DiagnosticThreadSummary {
  id: string
  projectId: string
  projectName: string
  title: string
  status: Thread['status']
  providerId: string
  harnessIds: string[]
  createdAt: number
  lastActivity: number
  /** The scope bucket (sidebar group) the thread sits in, when it has one. */
  scopeId?: string
  /** The assistant that owns a scheduled thread, when it has one. */
  assistantId?: string
  /** The matching passage, when the thread was found by its conversation. */
  snippet?: string
  /** How it matched: a title, a message, or meaning rather than words. */
  matchedIn?: 'title' | 'message' | 'intent'
}

/** One scope bucket (sidebar group) a search can be narrowed to. */
export interface DiagnosticScopeGroup {
  id: string
  name: string
  threadCount: number
  archived?: boolean
}

/** One project and the scopes inside it, as container ids to narrow a search. */
export interface DiagnosticProjectGroup {
  id: string
  name: string
  /** The hidden container a project id resolves to, when it is not a project. */
  kind: 'project' | 'inbox' | 'assistant' | 'browser'
  threadCount: number
  scopes: DiagnosticScopeGroup[]
}

/** One assistant, the container a scheduled thread search can be narrowed to. */
export interface DiagnosticAssistantGroup {
  id: string
  name: string
  paused: boolean
  threadCount: number
}

export interface DiagnosticGroupsResult {
  projects: DiagnosticProjectGroup[]
  assistants: DiagnosticAssistantGroup[]
}

export interface DiagnosticMessage {
  id: string
  role: AgentMessage['role']
  createdAt: number
  text: string
  /** What the turn did, in order: one bounded line per tool call, with its
   *  argument and a redacted preview of its result. This is the evidence a
   *  resumed agent needs (what was run, what was edited, what failed); the
   *  conversation text alone never carries it. */
  actions?: string[]
  error?: string
  modelId?: string
  providerId?: string
}

/**
 * One bounded page of a thread's mirrored conversation.
 *
 * A resumed agent starts from a thread id, not from the messages, so the page
 * has to name the way further back: `nextBeforeId` is the message id to pass as
 * `before_id` for the page older than this one.
 */
export interface DiagnosticMessagePage {
  threadId: string
  /** The thread's title, so the agent recognizes the work it is resuming. */
  title: string
  messages: DiagnosticMessage[]
  /** Message id to pass as `before_id` for the next older page. */
  nextBeforeId?: string
  /** Whether messages older than this page exist. */
  hasOlder: boolean
  note?: string
}

export interface DiagnosticLogEntry {
  file: string
  timestamp?: string
  level?: string
  message: string
}

export interface ThreadLookupResult {
  matchedThread: DiagnosticThreadSummary | null
  candidates: DiagnosticThreadSummary[]
}

export interface DiagnosticLogResult {
  file: string
  entries: DiagnosticLogEntry[]
  truncated: boolean
}

/** One column of a table returned by the `list_schema` action. */
export interface DiagnosticSchemaColumn {
  name: string
  type: string
  notNull: boolean
  primaryKey: boolean
}

export interface DiagnosticTableSchema {
  name: string
  schema: string
  type: string
  columns: DiagnosticSchemaColumn[]
}

/** Column name → redacted, bounded value. */
export type DiagnosticQueryRow = Record<string, string | number | null>

export interface DiagnosticQueryResult {
  /** The statement actually executed, including the enforced row cap. */
  sql: string
  columns: string[]
  rows: DiagnosticQueryRow[]
  rowCount: number
  /** More rows existed than the cap allows. */
  truncated: boolean
  /** Guidance when the row cap or a value cap was hit. */
  note?: string
}

/** Statement classes accepted by `query_sql`. */
type ReadOnlySqlKind = 'select' | 'explain' | 'pragma'

/** Quote an identifier for interpolation into a PRAGMA statement. */
function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

/** Trim an SQL string to one statement and classify it for read-only execution. */
function classifyReadOnlySql(rawSql: string): { sql: string; kind: ReadOnlySqlKind } {
  let sql = rawSql.trim()
  if (!sql) throw new TypeError('sql is required for query_sql')
  if (sql.length > MAX_QUERY_SQL_LENGTH) {
    throw new TypeError(`sql must be at most ${MAX_QUERY_SQL_LENGTH} characters`)
  }
  sql = sql.replace(/;+\s*$/u, '').trim()
  if (!sql || sql.includes(';')) {
    throw new TypeError('query_sql accepts exactly one statement   remove the extra ";"')
  }
  if (sql.includes('\0')) throw new TypeError('sql must not contain a null byte')
  if (DENIED_SQL_FUNCTIONS.test(sql)) {
    throw new Error('That SQL function is not allowed in read-only diagnostics')
  }
  const lead = (sql.match(/^[A-Za-z_]+/iu)?.[0] ?? '').toLocaleLowerCase()
  if (lead === 'select' || lead === 'with') return { sql, kind: 'select' }
  if (lead === 'explain') return { sql, kind: 'explain' }
  if (lead === 'pragma') {
    // `PRAGMA [schema.]name[= value]` and `PRAGMA name(args)`   read the name
    // before any argument list, then drop an optional schema qualifier, so a
    // quoted table name can never be mistaken for the PRAGMA name.
    const remainder = sql.slice(lead.length).trim()
    const head = remainder.split(/[\s(=]/u, 1)[0] ?? ''
    const name = (head.split('.').at(-1) ?? '')
      .match(/^"?([A-Za-z_][A-Za-z0-9_]*)/u)?.[1]
      ?.toLocaleLowerCase()
    if (!name || !READABLE_PRAGMAS.has(name)) {
      throw new Error(
        `PRAGMA ${name || '(unknown)'} is not allowed. Allowed: ${[...READABLE_PRAGMAS].join(', ')}`
      )
    }
    return { sql, kind: 'pragma' }
  }
  throw new TypeError(
    'query_sql accepts read-only SELECT, WITH, EXPLAIN, or schema PRAGMA statements only'
  )
}

/** Bind values must be scalars; anything else is rejected before SQLite sees it. */
function normalizeQueryParams(params: readonly unknown[]): Array<string | number | null> {
  if (params.length > MAX_QUERY_PARAMS) {
    throw new TypeError(`query_sql accepts at most ${MAX_QUERY_PARAMS} parameters`)
  }
  return params.map((value, index) => {
    if (value === null || value === undefined) return null
    if (typeof value === 'string') return value
    if (typeof value === 'number') return Number.isFinite(value) ? value : null
    if (typeof value === 'boolean') return value ? 1 : 0
    throw new TypeError(`Query parameter ${index + 1} must be a string, number, boolean, or null`)
  })
}

/** Redact and bound one cell so secrets and large blobs never stream back raw. */
function formatQueryValue(value: unknown): string | number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Uint8Array) return `<blob:${value.byteLength} bytes>`
  const text =
    typeof value === 'string'
      ? value
      : (() => {
          try {
            return JSON.stringify(value)
          } catch {
            return String(value)
          }
        })()
  if (text.length <= MAX_QUERY_VALUE_LENGTH) return redactSensitiveText(text)
  return `${redactSensitiveText(text.slice(0, MAX_QUERY_VALUE_LENGTH))}... [truncated]`
}

/** Collapse whitespace so one tool call stays one line. */
function collapseLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/**
 * What a message did, as bounded one-line records of its tool calls.
 *
 * The mirror stores a turn's work as tool parts: the call's arguments and its
 * result. That evidence is what a resumed agent cannot get from the assistant's
 * prose ("I fixed it" versus the edit that fixed it), so a diagnostics read
 * surfaces it, capped per line and per message so one huge turn cannot flood
 * the result.
 */
function diagnosticActions(parts: AgentMessage['parts']): string[] {
  const calls = parts.filter(
    (part): part is Extract<AgentMessage['parts'][number], { type: 'tool' }> => part.type === 'tool'
  )
  const lines = calls.slice(0, MAX_ACTION_LINES).map((part) => {
    const call = resolveToolCall(part.tool, part.state.input ?? {})
    const action = patternActionPhrase(call.tool) ?? call.tool
    const subject = summarizeToolInput(call.input)
    const failed = part.state.status === 'error' || part.state.error
    const output = failed ? part.state.error : part.state.output
    const preview = output?.trim() ? collapseLine(truncateToolResult(output)) : ''
    const head = [failed ? '[failed]' : '', action, subject].filter(Boolean).join(' ')
    return redactSensitiveText(preview ? `${head} → ${preview}` : head).slice(
      0,
      MAX_ACTION_LINE_LENGTH
    )
  })
  if (calls.length > lines.length) {
    lines.push(`… ${calls.length - lines.length} more tool calls in this turn`)
  }
  return lines
}

function summarizeDiagnosticThread(
  thread: Thread,
  projectName: string,
  harnessIds: string[],
  matchedIn?: DiagnosticThreadSummary['matchedIn'],
  snippet?: string
): DiagnosticThreadSummary {
  const summary: DiagnosticThreadSummary = {
    id: thread.id,
    projectId: thread.projectId,
    projectName: redactSensitiveText(projectName),
    title: redactSensitiveText(thread.title),
    status: thread.status,
    providerId: thread.providerId,
    harnessIds,
    createdAt: thread.createdAt,
    lastActivity: thread.lastActivity
  }
  if (matchedIn) summary.matchedIn = matchedIn
  if (thread.scopeBucketId) summary.scopeId = thread.scopeBucketId
  if (thread.assistantId) summary.assistantId = thread.assistantId
  if (snippet) summary.snippet = redactSensitiveText(snippet).slice(0, MAX_MESSAGE_TEXT_LENGTH)
  return summary
}

/** Which hidden container a project id resolves to, for the group listing. */ function projectGroupKind(
  projectId: string
): DiagnosticProjectGroup['kind'] {
  if (projectId === INBOX_PROJECT_ID) return 'inbox'
  if (projectId === ASSISTANT_SPACE_ID) return 'assistant'
  if (projectId === GLOBAL_BROWSER_PROJECT_ID) return 'browser'
  return 'project'
}

/**
 * Read one project's scope board (a JSON document) into boundable group ids.
 * A project that never used the board still has its Default scope, which is
 * where every one of its threads lives until the user creates another.
 */
function summarizeScopeGroups(
  data: unknown,
  projectId: string,
  scopeCounts: Map<string, number>
): DiagnosticScopeGroup[] {
  const scopes: DiagnosticScopeGroup[] = []
  let parsed: unknown = null
  if (typeof data === 'string') {
    try {
      parsed = JSON.parse(data)
    } catch {
      parsed = null
    }
  }
  const buckets = isRecord(parsed) && Array.isArray(parsed['buckets']) ? parsed['buckets'] : []
  for (const raw of buckets) {
    if (!isRecord(raw)) continue
    const id = typeof raw['id'] === 'string' ? raw['id'] : ''
    if (!id) continue
    const scope: DiagnosticScopeGroup = {
      id,
      name: redactSensitiveText(typeof raw['name'] === 'string' ? raw['name'] : id),
      threadCount: scopeCounts.get(`${projectId}\u0000${id}`) ?? 0
    }
    if (typeof raw['archivedAt'] === 'number') scope.archived = true
    scopes.push(scope)
  }
  if (scopes.length === 0) {
    scopes.push({
      id: DEFAULT_SCOPE_BUCKET_ID,
      name: 'Default',
      threadCount: scopeCounts.get(`${projectId}\u0000${DEFAULT_SCOPE_BUCKET_ID}`) ?? 0
    })
  }
  return scopes.sort((left, right) => left.name.localeCompare(right.name))
}

/** Parse a main.jsonl-style JSONL record into a bounded, redacted log entry. */
function summarizeJsonLogRecord(file: string, value: unknown): DiagnosticLogEntry | null {
  if (!isRecord(value) || typeof value['message'] !== 'string') return null
  const entry: DiagnosticLogEntry = {
    file,
    message: redactSensitiveText(value['message']).slice(0, MAX_LOG_ENTRY_LENGTH)
  }
  if (typeof value['timestamp'] === 'string') entry.timestamp = value['timestamp']
  if (typeof value['level'] === 'string') entry.level = value['level']
  return entry
}

/** Read the tail of a plain-text log (debug.log / error.log). */
function summarizePlainTextLog(file: string, raw: string): DiagnosticLogEntry[] {
  const lines = raw.split(/\r?\n/u).filter((line) => line.trim().length > 0)
  const relevant = lines.filter(
    (line) => !line.includes('durable log write failed') || line.startsWith('[')
  )
  return relevant.slice(-MAX_LOG_ENTRIES).map((line) => ({
    file,
    message: redactSensitiveText(line).slice(0, MAX_LOG_ENTRY_LENGTH)
  }))
}

/**
 * Read-only, bounded, redacted diagnostics across every project: thread lookup
 * (by id or exact title), a bounded message page, and recent log entries.
 * Constructed per turn from the shared Database; never writes.
 */
export class CioDiagnosticsService {
  private readonly threadRepo: ThreadRepo
  private readonly messageRepo: AgentMessageRepo
  private readonly projects: ProjectRepo
  private readonly assistants: AssistantRepo

  constructor(
    private readonly db: Database,
    private readonly projectNameById: () => Map<string, string>,
    /**
     * Hybrid thread search (keyword plus semantic), supplied by the turn's
     * thread manager. It takes the same narrowing options a caller passes, so a
     * search can be scoped to a project, a scope, or an assistant. Absent in a
     * session without one, and the title search below is then the whole answer.
     */
    private readonly threadSearch?: (
      query: string,
      options: ThreadSearchOptions
    ) => Promise<import('../../lib/types').ThreadSearchResult[]>
  ) {
    this.threadRepo = new ThreadRepo(db)
    this.messageRepo = new AgentMessageRepo(db)
    this.projects = new ProjectRepo(db)
    this.assistants = new AssistantRepo(db)
  }

  /** Find a thread by id, falling back to an exact (case-insensitive) title match. */
  async lookupThread(query: string): Promise<ThreadLookupResult> {
    const needle = query.trim()
    if (!needle) return { matchedThread: null, candidates: [] }
    const direct = await this.threadRepo.getViaWorker(needle)
    if (direct) {
      return {
        matchedThread: this.summarize(direct),
        candidates: []
      }
    }
    const all = await this.threadRepo.listAllForHydrationViaWorker({ limit: 500 })
    const lowered = needle.toLocaleLowerCase()
    const byTitle = all
      .filter((thread) => thread.title.toLocaleLowerCase() === lowered)
      .slice(0, MAX_THREAD_LIST_RESULTS)
    const candidates = byTitle.map((thread) =>
      this.summarize(thread, this.projectNameById().get(thread.projectId) ?? '')
    )
    return { matchedThread: candidates[0] ?? null, candidates }
  }

  /**
   * Find the threads a question is about, across every project.
   *
   * Hybrid search reads titles and conversation content, and ranks by meaning
   * when the local embedding model answers, so an agent gathering context can
   * find a conversation it shares no words with. Each hit carries its matching
   * passage; `read_messages` then reads the thread itself. A session without a
   * search provider, or a search that found nothing, falls back to matching
   * titles, which is what this action answered before.
   */
  async searchThreads(
    query: string,
    options: ThreadSearchOptions = {}
  ): Promise<DiagnosticThreadSummary[]> {
    const needle = query.trim()
    if (!needle) return []
    if (this.threadSearch) {
      const results = await this.threadSearch(needle, options).catch(() => [])
      if (results.length > 0) {
        return results
          .filter((result) => threadMatchesSearchScope(result.thread, options))
          .slice(0, MAX_THREAD_LIST_RESULTS)
          .map((result) =>
            this.summarize(
              result.thread,
              this.projectNameById().get(result.thread.projectId) ?? '',
              result.kind === 'intent' ? 'intent' : result.kind,
              result.snippet
            )
          )
      }
    }
    const lowered = needle.toLocaleLowerCase()
    const all = await this.threadRepo.listAllForHydrationViaWorker({ limit: 500 })
    const names = this.projectNameById()
    return all
      .filter(
        (thread) =>
          threadMatchesSearchScope(thread, options) &&
          thread.title.toLocaleLowerCase().includes(lowered)
      )
      .slice(0, MAX_THREAD_LIST_RESULTS)
      .map((thread) => this.summarize(thread, names.get(thread.projectId) ?? '', 'title'))
  }

  /**
   * List the containers a thread search can be narrowed to: every project with
   * its scope buckets (the sidebar groups), and every assistant.
   *
   * These are exactly the ids `search_threads` accepts as `project_id`,
   * `scope_id`, and `assistant_id`, so an agent looks them up here instead of
   * guessing an id or reading every project. Counts are live, unarchived rows.
   */
  async listGroups(projectId?: string): Promise<DiagnosticGroupsResult> {
    const wanted = projectId?.trim() || null
    const [projects, assistants] = await Promise.all([
      this.projects.listViaWorker(),
      this.assistants.listViaWorker()
    ])
    const [boards, counts] = await Promise.all([
      this.db.queryViaWorker('SELECT project_id, data FROM scope_boards', [], 0),
      this.db.queryViaWorker(
        `SELECT project_id, scope_bucket_id, assistant_id, COUNT(*) AS thread_count
           FROM threads WHERE archived = 0
          GROUP BY project_id, scope_bucket_id, assistant_id`,
        [],
        0
      )
    ])
    const projectCounts = new Map<string, number>()
    const scopeCounts = new Map<string, number>()
    const assistantCounts = new Map<string, number>()
    for (const row of counts.ok ? counts.rows : []) {
      const rowProjectId = typeof row['project_id'] === 'string' ? row['project_id'] : ''
      const rowScopeId = typeof row['scope_bucket_id'] === 'string' ? row['scope_bucket_id'] : ''
      const rowAssistantId = typeof row['assistant_id'] === 'string' ? row['assistant_id'] : ''
      const count = typeof row['thread_count'] === 'number' ? row['thread_count'] : 0
      if (!rowProjectId) continue
      projectCounts.set(rowProjectId, (projectCounts.get(rowProjectId) ?? 0) + count)
      if (rowScopeId) {
        const scopeKey = `${rowProjectId}\u0000${rowScopeId}`
        scopeCounts.set(scopeKey, (scopeCounts.get(scopeKey) ?? 0) + count)
      }
      if (rowAssistantId) {
        assistantCounts.set(rowAssistantId, (assistantCounts.get(rowAssistantId) ?? 0) + count)
      }
    }
    const boardData = new Map<string, unknown>()
    for (const row of boards.ok ? boards.rows : []) {
      const boardProjectId = typeof row['project_id'] === 'string' ? row['project_id'] : ''
      if (boardProjectId) boardData.set(boardProjectId, row['data'])
    }
    return {
      projects: projects
        .filter((project) => !wanted || project.id === wanted)
        .map((project) => ({
          id: project.id,
          name: redactSensitiveText(project.name),
          kind: projectGroupKind(project.id),
          threadCount: projectCounts.get(project.id) ?? 0,
          scopes: summarizeScopeGroups(boardData.get(project.id), project.id, scopeCounts)
        })),
      assistants: assistants.map((assistant) => ({
        id: assistant.id,
        name: redactSensitiveText(assistant.name),
        paused: assistant.paused === true,
        threadCount: assistantCounts.get(assistant.id) ?? 0
      }))
    }
  }

  /**
   * Load a bounded page of mirrored conversation messages for a thread.
   *
   * Without `beforeId` the page is the newest one. With it, the page is the one
   * older than that message, which is how an agent handed only a thread id walks
   * a long conversation back to its beginning. `loadPageByThread` already
   * returns its page oldest-to-newest and says whether more history exists.
   */
  async loadThreadMessages(
    threadId: string,
    limit: number,
    beforeId?: string
  ): Promise<DiagnosticMessagePage> {
    const boundedLimit = Math.max(1, Math.min(MAX_MESSAGES, Math.trunc(limit) || 40))
    const thread = await this.threadRepo.getViaWorker(threadId)
    if (!thread) return { threadId, title: '', messages: [], hasOlder: false }
    const before = beforeId ? this.messageCursor(threadId, beforeId) : undefined
    const page = this.messageRepo.loadPageByThread(threadId, before, boundedLimit)
    const messages = page.messages
      .map((message) => this.toDiagnosticMessage(message))
      .filter((message): message is DiagnosticMessage => message !== null)
    const result: DiagnosticMessagePage = {
      threadId,
      title: redactSensitiveText(thread.title),
      messages,
      hasOlder: page.hasOlder
    }
    const oldest = page.messages[0]
    if (page.hasOlder && oldest) {
      result.nextBeforeId = oldest.id
      result.note = `This is the newest page of the thread. Older messages exist: call read_messages again with thread_id "${threadId}" and before_id "${oldest.id}" for the page before it, and repeat with each page's nextBeforeId.`
    }
    return result
  }

  /**
   * The ordering key of one message in one thread, from a message id an agent
   * was handed. An id that is not in this thread is refused by name: silently
   * returning the newest page would tell a reader it had reached the beginning.
   */
  private messageCursor(threadId: string, messageId: string): ThreadMessageCursor {
    const row = this.db.get<{ created_at: number }>(
      'SELECT created_at FROM agent_messages WHERE thread_id = ? AND id = ?',
      threadId,
      messageId
    )
    if (!row) {
      throw new Error(
        `No message ${messageId} in thread ${threadId}. Pass a message id from this thread as before_id, or omit before_id for the newest page.`
      )
    }
    return { createdAt: row.created_at, id: messageId }
  }

  /**
   * Read recent entries from one allow-listed log file of one day folder.
   *
   * `file` may be a bare name (the current day), a day-qualified name
   * (`logs/2026-09-23/error.log`), or the pre-split flat path of an install
   * that predates the day layout. Reading outside today is explicit on purpose:
   * when the requested day has no folder the error names the days that exist,
   * so an agent never has to guess what is on disk.
   */
  async readLog(
    file: string,
    options: { level?: string; limit?: number } = {}
  ): Promise<DiagnosticLogResult> {
    const parsed = parseLogFilePath(file)
    if (!parsed || !READABLE_LOG_FILES.includes(parsed.fileName)) {
      throw new Error(
        `Log file not readable: ${file}. Allowed: ${READABLE_LOG_FILES.map((name) => `logs/<YYYY-MM-DD>/${name}`).join(', ')}`
      )
    }
    const boundedLimit = Math.max(1, Math.min(MAX_LOG_ENTRIES, Math.trunc(options.limit ?? 100)))
    const relativePath = await this.resolveReadableLogPath(parsed.day, parsed.fileName)
    const read = await readLogFileTail(relativePath)
    if (!read) return { file: relativePath, entries: [], truncated: false }
    // Only the tail is ever needed for debugging; cap the parse window.
    const tail = read.content
    if (relativePath.endsWith('.jsonl')) {
      let entries: DiagnosticLogEntry[] = []
      for (const line of tail.split(/\r?\n/u)) {
        if (!line.trim()) continue
        try {
          const parsedLine: unknown = JSON.parse(line)
          const entry = summarizeJsonLogRecord(relativePath, parsedLine)
          if (entry) entries.push(entry)
        } catch {
          // A partial final append must not break the remaining entries.
        }
      }
      if (options.level) {
        const level = options.level.toLocaleLowerCase()
        entries = entries.filter((entry) => entry.level === level)
      }
      return {
        file: relativePath,
        entries: entries.slice(-boundedLimit),
        truncated: read.bytes > MAX_LOG_READ_BYTES
      }
    }
    let lines = summarizePlainTextLog(relativePath, tail)
    if (options.level) {
      const level = options.level.toLocaleLowerCase()
      lines = lines.filter((line) => (line.message.match(/\[(\w+)\]/u)?.[1] ?? '') === level)
    }
    return {
      file: relativePath,
      entries: lines.slice(-boundedLimit),
      truncated: read.bytes > MAX_LOG_READ_BYTES
    }
  }

  /**
   * Turn a requested day (or none, meaning today) into a path that exists.
   * A bare file name falls back to the pre-split flat file when today's folder
   * has not been written yet; an explicit day that has no folder fails loudly
   * with the days that do exist. A day folder that exists without this sink in
   * it is a legitimate empty result, not an error.
   */
  private async resolveReadableLogPath(day: string | null, fileName: string): Promise<string> {
    if (day === null) {
      const today = logRelativePathInDay(logDayName(), fileName)
      if ((await logPathKind(today)) === 'file') return today
      const legacy = flatLogRelativePath(fileName)
      return (await logPathKind(legacy)) === 'file' ? legacy : today
    }
    const requested = logRelativePathInDay(day, fileName)
    if ((await logPathKind(requested)) === 'file') return requested
    if ((await logPathKind(`${LOGS_DIRECTORY}/${day}`)) === 'directory') return requested
    const days = await listLogDayFolders()
    throw new Error(
      days.length === 0
        ? `No logs for ${day}: no day folders exist under logs/ yet.`
        : `No logs for ${day}. Days on disk: ${days.join(', ')}`
    )
  }

  /**
   * List the app database tables (and optionally one table's columns) so an
   * agent can write informed SQL instead of guessing the schema.
   */
  listSchema(table?: string): { tables: DiagnosticTableSchema[] } {
    const listed = this.runReadOnly('PRAGMA table_list') as Array<Record<string, unknown>>
    const needle = table?.trim().toLocaleLowerCase() ?? ''
    const matches = listed
      .filter((entry) => typeof entry['name'] === 'string')
      .filter((entry) => !String(entry['name']).startsWith('sqlite_'))
      .filter((entry) => {
        if (!needle) return true
        const name = String(entry['name']).toLocaleLowerCase()
        return name === needle || name.includes(needle)
      })
      .slice(0, MAX_SCHEMA_TABLES)
    return {
      tables: matches.map((entry) => {
        const name = String(entry['name'])
        const schema = typeof entry['schema'] === 'string' ? entry['schema'] : 'main'
        // SQLite accepts `PRAGMA schema.table_info(table)`   the schema is the
        // PRAGMA qualifier, not an argument, so it cannot go inside the parens.
        const columns = this.runReadOnly(
          `PRAGMA ${quoteIdentifier(schema)}.table_info(${quoteIdentifier(name)})`
        ) as Array<Record<string, unknown>>
        return {
          name,
          schema,
          type: typeof entry['type'] === 'string' ? entry['type'] : 'table',
          columns: columns.map((column) => ({
            name: String(column['name'] ?? ''),
            type: String(column['type'] ?? ''),
            notNull: column['notnull'] === 1,
            primaryKey: Number(column['pk'] ?? 0) > 0
          }))
        }
      })
    }
  }

  /**
   * Run one bounded, read-only SQL statement. This is the escape hatch for
   * questions the structured actions cannot answer; writes, DDL, ATTACH,
   * multi-statement input, and host-touching SQL functions are all rejected,
   * and SELECT/WITH statements are wrapped in a hard row cap so a wide scan
   * can never stream unbounded rows through the main thread.
   */
  runQuery(sql: string, params: readonly unknown[] = []): DiagnosticQueryResult {
    const { statement } = this.prepareReadOnly(sql)
    const boundParams = normalizeQueryParams(params)
    const rows = statement.all(...boundParams) as Array<Record<string, unknown>>
    const truncated = rows.length > MAX_QUERY_ROWS
    const page = truncated ? rows.slice(0, MAX_QUERY_ROWS) : rows
    const columns = statement.columns().map((column) => column.name)
    const result: DiagnosticQueryResult = {
      sql: statement.source,
      columns,
      rows: page.map((row) => {
        const formatted: DiagnosticQueryRow = {}
        for (const name of columns) formatted[name] = formatQueryValue(row[name])
        return formatted
      }),
      rowCount: page.length,
      truncated
    }
    if (truncated) {
      result.note = `Stopped at ${MAX_QUERY_ROWS} rows; narrow the query with WHERE/LIMIT or aggregate to see the rest.`
    }
    return result
  }

  /** Prepare a validated read-only statement; never executes anything but a reader. */
  private prepareReadOnly(rawSql: string): { statement: Statement; kind: ReadOnlySqlKind } {
    const { sql, kind } = classifyReadOnlySql(rawSql)
    const executable =
      kind === 'select' ? `SELECT * FROM (\n${sql}\n) LIMIT ${MAX_QUERY_ROWS + 1}` : sql
    const statement = this.db.prepare(executable)
    if (!statement.reader) {
      throw new Error('Only read-only statements may run through app diagnostics')
    }
    return { statement, kind }
  }

  /** Run an internal read-only statement and return its raw rows. */
  private runReadOnly(sql: string): unknown[] {
    return this.prepareReadOnly(sql).statement.all()
  }

  private summarize(
    thread: Thread,
    projectNameOverride?: string,
    matchedIn?: DiagnosticThreadSummary['matchedIn'],
    snippet?: string
  ): DiagnosticThreadSummary {
    const names = this.projectNameById()
    return summarizeDiagnosticThread(
      thread,
      projectNameOverride ?? names.get(thread.projectId) ?? '',
      thread.usedHarnessIds ?? [],
      matchedIn,
      snippet
    )
  }

  private toDiagnosticMessage(message: AgentMessage): DiagnosticMessage | null {
    const text = message.parts
      .filter(
        (part): part is Extract<AgentMessage['parts'][number], { type: 'text' }> =>
          part.type === 'text'
      )
      .map((part) => part.text)
      .join('\n')
      .slice(0, MAX_MESSAGE_TEXT_LENGTH)
    const actions = diagnosticActions(message.parts)
    if (!text.trim() && !message.error && actions.length === 0) return null
    const result: DiagnosticMessage = {
      id: message.id,
      role: message.role,
      createdAt: message.createdAt,
      text: redactSensitiveText(text)
    }
    if (actions.length > 0) result.actions = actions
    if (message.error) result.error = redactSensitiveText(message.error).slice(0, 500)
    if (message.modelId) result.modelId = message.modelId
    if (message.providerId) result.providerId = message.providerId
    return result
  }
}
