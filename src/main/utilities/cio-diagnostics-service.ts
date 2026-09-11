import { readFile } from 'fs/promises'
import { join } from 'path'
import type { Statement } from 'better-sqlite3'
import type { Database } from '../database/database'
import { AgentMessageRepo } from '../database/repositories/agent-message-repo'
import { ProjectRepo } from '../database/repositories/project-repo'
import { ThreadRepo } from '../database/repositories/thread-repo'
import type { AgentMessage, Thread } from '../../lib/types'
import { getConfigRoot } from '../../lib/utils'

/** Bounded, redacted, read-only app diagnostics for an explicit @cio-utility turn. */

const MAX_MESSAGE_TEXT_LENGTH = 4_000
const MAX_LOG_ENTRY_LENGTH = 2_000
const MAX_LOG_ENTRIES = 200
const MAX_MESSAGES = 120
const MAX_THREAD_LIST_RESULTS = 20
const MAX_LOG_BYTES = 1_000_000
const MAX_QUERY_ROWS = 200
const MAX_QUERY_VALUE_LENGTH = 2_000
const MAX_QUERY_SQL_LENGTH = 4_000
const MAX_QUERY_PARAMS = 32
const MAX_SCHEMA_TABLES = 80

/** Log files an agent may inspect during an explicit diagnostics turn. */
const READABLE_LOG_FILES = ['logs/main.jsonl', 'logs/error.log', 'logs/permission-events.jsonl']

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
}

export interface DiagnosticMessage {
  id: string
  role: AgentMessage['role']
  createdAt: number
  text: string
  error?: string
  modelId?: string
  providerId?: string
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

function summarizeDiagnosticThread(
  thread: Thread,
  projectName: string,
  harnessIds: string[]
): DiagnosticThreadSummary {
  return {
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

  constructor(
    private readonly db: Database,
    private readonly projectNameById: () => Map<string, string>
  ) {
    this.threadRepo = new ThreadRepo(db)
    this.messageRepo = new AgentMessageRepo(db)
    this.projects = new ProjectRepo(db)
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

  /** Search thread titles across every project for a case-insensitive substring. */
  async searchThreads(query: string): Promise<DiagnosticThreadSummary[]> {
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return []
    const all = await this.threadRepo.listAllForHydrationViaWorker({ limit: 500 })
    const names = this.projectNameById()
    return all
      .filter((thread) => thread.title.toLocaleLowerCase().includes(needle))
      .slice(0, MAX_THREAD_LIST_RESULTS)
      .map((thread) => this.summarize(thread, names.get(thread.projectId) ?? ''))
  }

  /**
   * Load a bounded newest page of mirrored conversation messages for a thread.
   * `loadPageByThread` already returns the page oldest-to-newest.
   */
  async loadThreadMessages(threadId: string, limit: number): Promise<DiagnosticMessage[]> {
    const boundedLimit = Math.max(1, Math.min(MAX_MESSAGES, Math.trunc(limit) || 40))
    const thread = await this.threadRepo.getViaWorker(threadId)
    if (!thread) return []
    const page = this.messageRepo.loadPageByThread(threadId, undefined, boundedLimit)
    return page.messages
      .map((message) => this.toDiagnosticMessage(message))
      .filter((message): message is DiagnosticMessage => message !== null)
  }

  /** Read recent entries from one allow-listed log file. */
  async readLog(
    file: string,
    options: { level?: string; limit?: number } = {}
  ): Promise<DiagnosticLogResult> {
    const normalized = `logs/${file.replace(/^logs\//u, '').replace(/^\/+/u, '')}`
    if (!READABLE_LOG_FILES.includes(normalized)) {
      throw new Error(`Log file not readable: ${file}. Allowed: ${READABLE_LOG_FILES.join(', ')}`)
    }
    const boundedLimit = Math.max(1, Math.min(MAX_LOG_ENTRIES, Math.trunc(options.limit ?? 100)))
    let raw: string
    try {
      raw = await readFile(join(getConfigRoot(), normalized), 'utf-8')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return { file: normalized, entries: [], truncated: false }
      }
      throw error
    }
    // Only the tail is ever needed for debugging; cap the parse window.
    const tail = raw.length > MAX_LOG_BYTES ? raw.slice(-MAX_LOG_BYTES) : raw
    if (normalized.endsWith('.jsonl')) {
      let entries: DiagnosticLogEntry[] = []
      for (const line of tail.split(/\r?\n/u)) {
        if (!line.trim()) continue
        try {
          const parsed: unknown = JSON.parse(line)
          const entry = summarizeJsonLogRecord(normalized, parsed)
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
        file: normalized,
        entries: entries.slice(-boundedLimit),
        truncated: raw.length > MAX_LOG_BYTES
      }
    }
    let lines = summarizePlainTextLog(normalized, tail)
    if (options.level) {
      const level = options.level.toLocaleLowerCase()
      lines = lines.filter((line) => (line.message.match(/\[(\w+)\]/u)?.[1] ?? '') === level)
    }
    return {
      file: normalized,
      entries: lines.slice(-boundedLimit),
      truncated: raw.length > MAX_LOG_BYTES
    }
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

  private summarize(thread: Thread, projectNameOverride?: string): DiagnosticThreadSummary {
    const names = this.projectNameById()
    return summarizeDiagnosticThread(
      thread,
      projectNameOverride ?? names.get(thread.projectId) ?? '',
      thread.usedHarnessIds ?? []
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
    if (!text.trim() && !message.error) return null
    const result: DiagnosticMessage = {
      id: message.id,
      role: message.role,
      createdAt: message.createdAt,
      text: redactSensitiveText(text)
    }
    if (message.error) result.error = redactSensitiveText(message.error).slice(0, 500)
    if (message.modelId) result.modelId = message.modelId
    if (message.providerId) result.providerId = message.providerId
    return result
  }
}
