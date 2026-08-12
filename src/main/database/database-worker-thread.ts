/**
 * SQLite worker thread.
 *
 * Runs inside a dedicated `worker_threads` Worker spawned by `DatabaseWorker`
 * (`database-worker.ts`). It opens a second WAL connection to the same database
 * file and is the single owner of every O(database-size) operation — passive
 * WAL checkpoints, integrity checks, size telemetry, online backup/restore,
 * VACUUM, FTS optimize/integrity/rebuild, bounded retention, corruption/full-
 * disk recovery, and the latency-critical repository CRUD (delta sync,
 * batched transactions) and normal FTS queries — so that no database work ever
 * blocks the Electron main process.
 *
 * Every request and the scheduled maintenance loop run through a single-flight
 * mutex (`enqueue`), so restore/backup/checkpoint/delta/query can never overlap.
 * Shutdown clears the maintenance timer, closes the connection, acknowledges,
 * then closes the port so the worker exits cleanly.
 */

import { parentPort, workerData } from 'worker_threads'
import DatabaseConstructor from 'better-sqlite3'
import type { Database as DatabaseType } from 'better-sqlite3'
import { mkdirSync, renameSync, rmSync, statSync } from 'fs'
import { dirname } from 'path'
import type {
  DatabaseWorkerConfig,
  DatabaseWorkerOutbound,
  DatabaseWorkerRequest,
  DatabaseWorkerResult,
  WorkerSizeTelemetry
} from './database-worker'
import {
  runProviderDeltaSync,
  type ProviderDeltaSyncExecutor
} from './repositories/agent-message-repo'
import { runHistoryAppend, type HistoryAppendArgs } from './repositories/history-repo'

/** Executor adapter over this worker's own connection. */
function executor(): ProviderDeltaSyncExecutor {
  return {
    all: <T>(sql: string, ...params: unknown[]) =>
      connection()
        .prepare(sql)
        .all(...params) as T[],
    run: (sql, ...params) => {
      connection()
        .prepare(sql)
        .run(...params)
    },
    transaction: <T>(fn: () => T) => connection().transaction(fn)()
  }
}

const config = (workerData ?? {}) as DatabaseWorkerConfig
const port = parentPort
// When this module is evaluated outside a real Worker (e.g. the test runner
// imports it through the ?nodeWorker factory) it must load inertly — no parent
// port means nothing can be requested and no maintenance loop may run.

const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS

let db: DatabaseType | null = null

function connection(): DatabaseType {
  if (!db) {
    db = new DatabaseConstructor(config.dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma('foreign_keys = ON')
    db.pragma('busy_timeout = 5000')
    db.pragma('temp_store = MEMORY')
    db.pragma('cache_size = -32768')
    db.pragma('mmap_size = 268435456')
    db.pragma('wal_autocheckpoint = 1000')
    db.pragma('journal_size_limit = 67108864')
  }
  return db
}

function emit(message: {
  type: 'log'
  level?: 'info' | 'warn' | 'error'
  message?: string
}): void {
  if (!port) return
  port.postMessage({ type: 'log', level: message.level ?? 'info', message: message.message ?? '' })
}

// ─── Single-flight serialization ───────────────────────────────────────────

let activeOps = 0
let totalOps = 0
let maxObservedConcurrency = 0
let tail: Promise<unknown> = Promise.resolve()

/**
 * Serialize a task so only one database operation (request or maintenance
 * pass) is ever executing at a time. Tracks concurrency for the serialization
 * proof (`stats`).
 */
function enqueue<T>(fn: () => Promise<T> | T): Promise<T> {
  const run = tail.then(async () => {
    activeOps++
    totalOps++
    if (activeOps > maxObservedConcurrency) maxObservedConcurrency = activeOps
    try {
      return await fn()
    } finally {
      activeOps--
    }
  })
  tail = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

// ─── Operation handlers ───────────────────────────────────────────────────

function checkpoint(
  request: Extract<DatabaseWorkerRequest, { kind: 'checkpoint' }>
): DatabaseWorkerResult {
  try {
    const mode = request.mode.toUpperCase()
    const row = connection().prepare(`PRAGMA wal_checkpoint(${mode})`).get() as {
      busy: number
      log: number
      checkpointed: number
    }
    return {
      kind: 'checkpoint',
      ok: true,
      busy: Number(row.busy),
      walLogPages: Number(row.log),
      checkpointedPages: Number(row.checkpointed)
    }
  } catch (error) {
    return { kind: 'checkpoint', ok: false, error: String(error) }
  }
}

function integrity(
  request: Extract<DatabaseWorkerRequest, { kind: 'integrity' }>
): DatabaseWorkerResult {
  try {
    const rows = connection()
      .prepare(request.quick ? 'PRAGMA quick_check' : 'PRAGMA integrity_check')
      .all() as Array<{ quick_check?: string; integrity_check?: string }>
    // SQLite names the result column after the pragma that produced it.
    const text = rows
      .map((row) => row.quick_check ?? row.integrity_check ?? String(Object.values(row)[0] ?? ''))
      .join('\n')
    return { kind: 'integrity', ok: text === 'ok', text }
  } catch (error) {
    return { kind: 'integrity', ok: false, text: '', error: String(error) }
  }
}

function fileSizeBytes(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function sizeTelemetry(): WorkerSizeTelemetry {
  try {
    const conn = connection()
    const schemaVersion = conn
      .prepare("SELECT value FROM db_meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined
    return {
      ok: true,
      dbBytes: fileSizeBytes(config.dbPath),
      walBytes: fileSizeBytes(`${config.dbPath}-wal`),
      shmBytes: fileSizeBytes(`${config.dbPath}-shm`),
      pageSize: Number(conn.pragma('page_size', { simple: true })),
      pageCount: Number(conn.pragma('page_count', { simple: true })),
      freelistPages: Number(conn.pragma('freelist_count', { simple: true })),
      journalMode: String(conn.pragma('journal_mode', { simple: true })),
      schemaVersion: schemaVersion?.value ?? ''
    }
  } catch (error) {
    return {
      ok: false,
      dbBytes: 0,
      walBytes: 0,
      shmBytes: 0,
      pageSize: 0,
      pageCount: 0,
      freelistPages: 0,
      journalMode: '',
      schemaVersion: '',
      error: String(error)
    }
  }
}

/** Verify a SQLite file with quick_check; returns its result text. */
function quickCheckOf(path: string): string {
  const probe = new DatabaseConstructor(path, { readonly: true })
  try {
    const rows = probe.prepare('PRAGMA quick_check').all() as Array<{ quick_check: string }>
    return rows.map((row) => row.quick_check).join('\n')
  } finally {
    probe.close()
  }
}

function backup(
  request: Extract<DatabaseWorkerRequest, { kind: 'backup' }>
): Promise<DatabaseWorkerResult> {
  const targetPath = request.targetPath
  const tmp = `${targetPath}.tmp`
  return (async () => {
    try {
      mkdirSync(dirname(targetPath), { recursive: true })
      rmSync(tmp, { force: true })
      await connection().backup(tmp)
      const checkText = quickCheckOf(tmp)
      if (checkText !== 'ok') {
        rmSync(tmp, { force: true })
        return { kind: 'backup', ok: false, error: `backup failed quick_check: ${checkText}` }
      }
      renameSync(tmp, targetPath)
      return { kind: 'backup', ok: true, path: targetPath, sizeBytes: fileSizeBytes(targetPath) }
    } catch (error) {
      rmSync(tmp, { force: true })
      return { kind: 'backup', ok: false, error: String(error) }
    }
  })()
}

function restore(
  request: Extract<DatabaseWorkerRequest, { kind: 'restore' }>
): Promise<DatabaseWorkerResult> {
  const livePath = config.dbPath
  const tmp = `${livePath}.restore-tmp`
  return (async () => {
    try {
      // 1. Validate and verify the source backup before touching the live file.
      if (!fileSizeBytes(request.sourcePath)) {
        return {
          kind: 'restore',
          ok: false,
          reason: 'source_invalid',
          error: 'backup source does not exist'
        }
      }
      const sourceText = quickCheckOf(request.sourcePath)
      if (sourceText !== 'ok') {
        return {
          kind: 'restore',
          ok: false,
          reason: 'source_invalid',
          error: `source quick_check: ${sourceText}`
        }
      }
      // 2. Stream the source into the live path atomically via a temp file.
      rmSync(tmp, { force: true })
      const source = new DatabaseConstructor(request.sourcePath, { readonly: true })
      try {
        await source.backup(tmp)
      } finally {
        source.close()
      }
      // 3. Verify the restored copy before promoting it.
      const restoredText = quickCheckOf(tmp)
      if (restoredText !== 'ok') {
        rmSync(tmp, { force: true })
        return {
          kind: 'restore',
          ok: false,
          reason: 'verify_failed',
          error: `restored quick_check: ${restoredText}`
        }
      }
      // 4. Swap: drop stale WAL/SHM sidecars and close this worker's own live
      //    connection so no handle survives onto the pre-restore inode, then
      //    atomically promote the verified copy. The next operation lazily
      //    reopens against the restored file.
      if (db) {
        try {
          db.close()
        } catch {
          // Best-effort close before the inode swap.
        }
        db = null
      }
      rmSync(`${livePath}-wal`, { force: true })
      rmSync(`${livePath}-shm`, { force: true })
      renameSync(tmp, livePath)
      return { kind: 'restore', ok: true, integrityText: restoredText }
    } catch (error) {
      rmSync(tmp, { force: true })
      return { kind: 'restore', ok: false, reason: 'io', error: String(error) }
    }
  })()
}

function vacuum(request: Extract<DatabaseWorkerRequest, { kind: 'vacuum' }>): DatabaseWorkerResult {
  try {
    const conn = connection()
    const before = Number(conn.pragma('freelist_count', { simple: true }))
    if (request.mode === 'full') {
      conn.exec('VACUUM')
    } else {
      conn.exec(`PRAGMA incremental_vacuum(${Math.max(0, request.pages)})`)
    }
    const after = Number(conn.pragma('freelist_count', { simple: true }))
    return { kind: 'vacuum', ok: true, freedPages: Math.max(0, before - after) }
  } catch (error) {
    return { kind: 'vacuum', ok: false, error: String(error) }
  }
}

const FTS_TABLES = ['agent_messages_fts', 'history_fts', 'project_fts'] as const

function fts(request: Extract<DatabaseWorkerRequest, { kind: 'fts' }>): DatabaseWorkerResult {
  try {
    const conn = connection()
    if (request.action === 'integrity-check') {
      const details: string[] = []
      let allOk = true
      for (const table of FTS_TABLES) {
        try {
          conn.exec(`INSERT INTO ${table}(${table}) VALUES('integrity-check')`)
          details.push(`${table}: ok`)
        } catch (error) {
          allOk = false
          details.push(`${table}: ${String(error)}`)
        }
      }
      return { kind: 'fts', ok: allOk, action: request.action, details: details.join('\n') }
    }
    for (const table of FTS_TABLES) {
      conn.exec(`INSERT INTO ${table}(${table}) VALUES('${request.action}')`)
    }
    return {
      kind: 'fts',
      ok: true,
      action: request.action,
      details: `applied ${request.action} to agent_messages_fts, history_fts, project_fts`
    }
  } catch (error) {
    return { kind: 'fts', ok: false, action: request.action, details: '', error: String(error) }
  }
}

interface RetentionSourceSpec {
  table: string
  timestampColumn: string
}

const RETENTION_SOURCES: RetentionSourceSpec[] = [
  { table: 'history_entries', timestampColumn: 'timestamp' },
  {
    table: 'assignment_operations',
    timestampColumn: 'created_at'
  }
]

function retention(): DatabaseWorkerResult {
  const cutoff = Date.now() - config.retentionDays * DAY_MS
  try {
    const conn = connection()
    const deleted = conn.transaction((): number => {
      let count = 0
      for (const spec of RETENTION_SOURCES) {
        const outcome = conn
          .prepare(`DELETE FROM ${spec.table} WHERE ${spec.timestampColumn} < ?`)
          .run(cutoff)
        count += Number(outcome.changes)
      }
      return count
    })()
    return {
      kind: 'retention',
      ok: true,
      deleted
    }
  } catch (error) {
    return { kind: 'retention', ok: false, deleted: 0, error: String(error) }
  }
}

function recoverTo(
  request: Extract<DatabaseWorkerRequest, { kind: 'recover-to' }>
): DatabaseWorkerResult {
  const tmp = `${request.targetPath}.tmp`
  try {
    rmSync(tmp, { force: true })
    // VACUUM INTO rebuilds a clean, compacted copy when the source is readable.
    connection().exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`)
    const checkText = quickCheckOf(tmp)
    if (checkText !== 'ok') {
      rmSync(tmp, { force: true })
      return {
        kind: 'recover-to',
        ok: false,
        reason: 'verify_failed',
        error: `recovered quick_check: ${checkText}`
      }
    }
    renameSync(tmp, request.targetPath)
    return { kind: 'recover-to', ok: true, path: request.targetPath, integrityText: checkText }
  } catch (error) {
    rmSync(tmp, { force: true })
    return { kind: 'recover-to', ok: false, reason: 'unrecoverable', error: String(error) }
  }
}

function health(): DatabaseWorkerResult {
  const telemetry = sizeTelemetry()
  const quickRows = (() => {
    try {
      return connection().prepare('PRAGMA quick_check').all() as Array<{ quick_check: string }>
    } catch (error) {
      return [{ quick_check: String(error) }]
    }
  })()
  const quickCheck = quickRows.map((row) => row.quick_check).join('\n')
  if (quickCheck !== 'ok') {
    return {
      kind: 'health',
      ok: false,
      status: 'corrupt',
      quickCheck,
      details: telemetry,
      message: `SQLite integrity failure: ${quickCheck.slice(0, 240)}`
    }
  }
  // A full-disk condition surfaces only on write; probe with a tiny write.
  try {
    connection()
      .prepare("INSERT OR REPLACE INTO maintenance_meta(key, value) VALUES('health_probe', ?)")
      .run(String(Date.now()))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? ''
    if (code === 'SQLITE_FULL' || /disk|full/i.test(String(error))) {
      return {
        kind: 'health',
        ok: false,
        status: 'full_disk',
        quickCheck,
        details: telemetry,
        message: `SQLite reported a full disk while probing: ${String(error)}`
      }
    }
    return {
      kind: 'health',
      ok: false,
      status: 'error',
      quickCheck,
      details: telemetry,
      message: `SQLite health probe failed: ${String(error)}`
    }
  }
  return {
    kind: 'health',
    ok: true,
    status: 'ok',
    quickCheck,
    details: telemetry,
    message: 'SQLite database healthy'
  }
}

/**
 * Bounded read: the caller's SQL must not contain LIMIT; `maxRows` (>0) bounds
 * the response and reports `truncated` when more rows matched.
 */
function query(request: Extract<DatabaseWorkerRequest, { kind: 'query' }>): DatabaseWorkerResult {
  try {
    const maxRows = Math.max(0, Math.floor(request.maxRows))
    let sql = request.sql.replace(/;\s*$/u, '')
    const params = [...request.params]
    if (maxRows > 0) {
      sql = `${sql} LIMIT ?`
      params.push(maxRows + 1)
    }
    const rows = connection()
      .prepare(sql)
      .all(...params) as Record<string, unknown>[]
    const truncated = maxRows > 0 && rows.length > maxRows
    return { kind: 'query', ok: true, rows: truncated ? rows.slice(0, maxRows) : rows, truncated }
  } catch (error) {
    return { kind: 'query', ok: false, error: String(error) }
  }
}

function execute(
  request: Extract<DatabaseWorkerRequest, { kind: 'execute' }>
): DatabaseWorkerResult {
  try {
    connection()
      .prepare(request.sql)
      .run(...request.params)
    return { kind: 'execute', ok: true }
  } catch (error) {
    return { kind: 'execute', ok: false, error: String(error) }
  }
}

/** Run a batch of statements atomically in one transaction (rolls back on error). */
function transaction(
  request: Extract<DatabaseWorkerRequest, { kind: 'transaction' }>
): DatabaseWorkerResult {
  try {
    const conn = connection()
    const run = conn.transaction(() => {
      for (const statement of request.statements) {
        conn.prepare(statement.sql).run(...(statement.params ?? []))
      }
    })
    run()
    return { kind: 'transaction', ok: true }
  } catch (error) {
    return { kind: 'transaction', ok: false, error: String(error) }
  }
}

function stats(): DatabaseWorkerResult {
  return {
    kind: 'stats',
    ok: true,
    activeOps,
    totalOps,
    maxObservedConcurrency,
    maintenanceEnabled: config.maintenanceEnabled && !shuttingDown
  }
}

// ─── Request dispatch ─────────────────────────────────────────────────────

function handle(
  request: DatabaseWorkerRequest
): DatabaseWorkerResult | Promise<DatabaseWorkerResult> {
  switch (request.kind) {
    case 'checkpoint':
      return checkpoint(request)
    case 'integrity':
      return integrity(request)
    case 'size-telemetry':
      return { kind: 'size-telemetry', ...sizeTelemetry() }
    case 'backup':
      return backup(request)
    case 'restore':
      return restore(request)
    case 'vacuum':
      return vacuum(request)
    case 'fts':
      return fts(request)
    case 'retention':
      return retention()
    case 'recover-to':
      return recoverTo(request)
    case 'health':
      return health()
    case 'query':
      return query(request)
    case 'execute':
      return execute(request)
    case 'transaction':
      return transaction(request)
    case 'history-append': {
      try {
        const args: HistoryAppendArgs = {
          id: request.id,
          threadId: request.threadId,
          role: request.role as HistoryAppendArgs['role'],
          content: request.content,
          metadata: request.metadata ?? undefined,
          timestamp: request.timestamp
        }
        const { sequence } = runHistoryAppend(executor(), args)
        return { kind: 'history-append', ok: true, sequence }
      } catch (error) {
        return { kind: 'history-append', ok: false, error: String(error) }
      }
    }
    case 'stats':
      return stats()
    case 'sync-provider-deltas': {
      try {
        return {
          kind: 'sync-provider-deltas',
          ok: true,
          result: runProviderDeltaSync(
            executor(),
            request.threadId,
            request.sessionId,
            request.messages
          )
        }
      } catch (error) {
        return { kind: 'sync-provider-deltas', ok: false, error: String(error) }
      }
    }
    case 'shutdown': {
      shuttingDown = true
      clearMaintenanceTimer()
      try {
        db?.close()
      } catch {
        // Best-effort close on shutdown.
      }
      db = null
      return { kind: 'shutdown', ok: true }
    }
    case 'ping':
      return { kind: 'ping', ok: true }
  }
}

if (port) {
  port.on('message', (message: DatabaseWorkerOutbound) => {
    if (message.type !== 'request') return
    void enqueue(async () => {
      let result: DatabaseWorkerResult
      try {
        result = await handle(message.request)
      } catch (error) {
        result = { kind: 'ping', ok: false }
        emit({
          type: 'log',
          level: 'error',
          message: `database worker request failed: ${String(error)}`
        })
      }
      if (port) port.postMessage({ type: 'response', id: message.id, result })
      if (message.request.kind === 'shutdown' && port) {
        // Close the port after the acknowledgement flushes so the worker exits
        // cleanly once no handles remain.
        setImmediate(() => port.close())
      }
    })
  })
}

// ─── Scheduled maintenance (serialized with requests) ─────────────────────

let shuttingDown = false
let maintenanceTimer: ReturnType<typeof setTimeout> | null = null

function clearMaintenanceTimer(): void {
  if (maintenanceTimer) {
    clearTimeout(maintenanceTimer)
    maintenanceTimer = null
  }
}

function lastRun(key: string): number {
  try {
    const row = connection()
      .prepare('SELECT value FROM maintenance_meta WHERE key = ?')
      .get(key) as { value: string } | undefined
    return row ? Number(row.value) : 0
  } catch {
    return 0
  }
}

function markRun(key: string, at: number): void {
  try {
    connection()
      .prepare('INSERT OR REPLACE INTO maintenance_meta(key, value) VALUES(?, ?)')
      .run(key, String(at))
  } catch (error) {
    emit({
      type: 'log',
      level: 'error',
      message: `failed to record maintenance run ${key}: ${String(error)}`
    })
  }
}

function runMaintenancePass(): void {
  const now = Date.now()
  if (now - lastRun('checkpoint_at') >= DAY_MS) {
    const result = checkpoint({ kind: 'checkpoint', mode: 'passive' })
    markRun('checkpoint_at', now)
    emit({
      type: 'log',
      level: 'info',
      message: `maintenance passive checkpoint: ${JSON.stringify(result)}`
    })
  }
  if (now - lastRun('integrity_at') >= DAY_MS) {
    const result = integrity({ kind: 'integrity', quick: true })
    markRun('integrity_at', now)
    const detail =
      result.kind === 'integrity'
        ? result.ok
          ? result.text
          : (result.error ?? 'failed')
        : 'unexpected result'
    emit({
      type: 'log',
      level: result.ok ? 'info' : 'warn',
      message: `maintenance quick_check: ${detail}`
    })
  }
  if (now - lastRun('retention_at') >= DAY_MS) {
    const result = retention()
    markRun('retention_at', now)
    emit({
      type: 'log',
      level: 'info',
      message: `maintenance retention: ${JSON.stringify(result)}`
    })
  }
  if (now - lastRun('fts_optimize_at') >= WEEK_MS) {
    const result = fts({ kind: 'fts', action: 'optimize' })
    markRun('fts_optimize_at', now)
    const detail =
      result.kind === 'fts'
        ? result.ok
          ? result.details
          : (result.error ?? 'failed')
        : 'unexpected result'
    emit({
      type: 'log',
      level: result.ok ? 'info' : 'warn',
      message: `maintenance fts optimize: ${detail}`
    })
  }
}

function scheduleMaintenance(): void {
  clearMaintenanceTimer()
  maintenanceTimer = setTimeout(
    () => {
      void enqueue(runMaintenancePass).finally(() => {
        if (!shuttingDown && config.maintenanceEnabled) scheduleMaintenance()
      })
    },
    Math.max(60_000, config.maintenanceIntervalMs)
  )
  maintenanceTimer.unref?.()
}

if (port && config.maintenanceEnabled) {
  scheduleMaintenance()
}
