/**
 * Typed database worker boundary   the single owner of SQLite maintenance and
 * FTS maintenance.
 *
 * The `DatabaseWorker` spawns a dedicated `worker_threads` Worker
 * (`database-worker-thread.ts`) that opens a second WAL connection to the same
 * database file and runs every O(database-size) operation   passive WAL
 * checkpoints, integrity checks, size telemetry, online backup/restore,
 * VACUUM, FTS optimize/integrity/rebuild, bounded retention, and
 * corruption/full-disk detection and recovery   so that no maintenance work
 * ever blocks the Electron main process. The primary read/write connection
 * stays in the main process; WAL locking coordinates the two connections.
 *
 * All requests and responses are strongly typed discriminated unions, so the
 * boundary is auditable and cannot silently drift from the worker's contract.
 */

/// <reference types="electron-vite/node" />
import createDatabaseWorkerThread from './database-worker-thread.ts?nodeWorker'
import type { Worker, WorkerOptions } from 'worker_threads'
import { dirname, join } from 'path'
import { Logger } from '../system/logger'
import type { AgentMessage, TurnCheckpointSummary, UserMessageSummary } from '../../lib/types'
import type { ProviderDeltaSyncResult } from './repositories/agent-message-repo'

/** Spawns the worker thread. Production uses the electron-vite `?nodeWorker` factory. */
export type DatabaseWorkerFactory = (options: WorkerOptions) => Worker

export interface DatabaseWorkerConfig {
  /** Path to the SQLite database file the worker connects to. */
  dbPath: string
  /** Directory where atomic backup/restore artifacts are written. */
  backupDir: string
  /** High-volume event rows older than this many days are deleted. */
  retentionDays: number
  /** Whether the periodic maintenance loop is enabled. */
  maintenanceEnabled: boolean
  /** Base interval between maintenance passes (ms). */
  maintenanceIntervalMs: number
  /**
   * Open the connection read-only.
   *
   * The interactive slot and the deferrable slot share one connection, and a
   * statement on it cannot be preempted. The async slot is a second worker with a
   * connection of its own, so a long read there cannot occupy the connection a
   * click is waiting on; opening it read-only is what guarantees that lane can
   * never become a second writer, which SQLite serialises anyway.
   */
  readOnly?: boolean
}

export const DATABASE_WORKER_DEFAULTS = {
  retentionDays: 90,
  maintenanceIntervalMs: 30 * 60 * 1000
} as const

// ─── Typed protocol ───────────────────────────────────────────────────────

/**
 * Which queue a worker request joins.
 *
 * `interactive` is anything a person is waiting on inside a click: a thread
 * open, a board, a send. `background` is work nobody is looking at: maintenance
 * passes and the whole-project scans they run. The worker still executes one
 * request at a time (one thread, one connection), so the lane changes only the
 * ORDER: an interactive read never waits behind queued background work.
 */
export type WorkerLane = 'interactive' | 'background'

/**
 * Where a read runs, from the caller's side.
 *
 * `interactive` and `background` are two queues on one worker, so they differ
 * only in order: an interactive read is drained first, and a statement already
 * running cannot be preempted. `async` is a lane of its own — a second worker with
 * its own read-only connection — for reads that are neither deferrable nor
 * click-blocking: a thread search, a usage rollup, a whole-project scan whose
 * answer the surface can wait for but whose duration a click must never sit in.
 */
export type QueryLane = WorkerLane | 'async'

export type DatabaseWorkerRequest =
  | { kind: 'checkpoint'; mode: 'passive' | 'truncate' }
  | { kind: 'integrity'; quick: boolean }
  | { kind: 'size-telemetry' }
  | { kind: 'backup'; targetPath: string }
  | { kind: 'restore'; sourcePath: string }
  | { kind: 'vacuum'; mode: 'incremental' | 'full'; pages: number }
  | { kind: 'fts'; action: 'optimize' | 'rebuild' | 'integrity-check' }
  | { kind: 'retention' }
  | { kind: 'recover-to'; targetPath: string }
  | { kind: 'health' }
  | { kind: 'query'; sql: string; params: unknown[]; maxRows: number; lane?: WorkerLane }
  | {
      kind: 'query-messages'
      sql: string
      params: unknown[]
      maxRows: number
      includeTransport: boolean
      lane?: WorkerLane
    }
  | {
      kind: 'query-user-messages'
      sql: string
      params: unknown[]
      maxRows: number
      lane?: WorkerLane
    }
  | {
      kind: 'checkpoint-summaries'
      sql: string
      params: unknown[]
      maxRows: number
      lane?: WorkerLane
    }
  | { kind: 'execute'; sql: string; params: unknown[]; lane?: WorkerLane }
  | {
      kind: 'transaction'
      statements: Array<{ sql: string; params: unknown[] }>
      lane?: WorkerLane
    }
  | {
      kind: 'history-append'
      id: string
      threadId: string
      role: string
      content: string
      metadata?: Record<string, unknown> | null
      timestamp: number
    }
  | { kind: 'stats' }
  | { kind: 'sync-provider-deltas'; threadId: string; sessionId: string; messages: AgentMessage[] }
  | {
      kind: 'export-transcript'
      threadId: string
      includeTrace: boolean
      destinationPath: string
    }
  | { kind: 'shutdown' }
  | { kind: 'ping' }

export interface WorkerCheckpointResult {
  ok: boolean
  /** 1 when a concurrent writer prevented the checkpoint from finishing. */
  busy?: number
  walLogPages?: number
  checkpointedPages?: number
  error?: string
}

export interface WorkerIntegrityResult {
  ok: boolean
  text: string
  error?: string
}

export interface WorkerSizeTelemetry {
  ok: boolean
  dbBytes: number
  walBytes: number
  shmBytes: number
  pageSize: number
  pageCount: number
  freelistPages: number
  journalMode: string
  schemaVersion: string
  error?: string
}

export interface WorkerBackupResult {
  ok: boolean
  path?: string
  sizeBytes?: number
  error?: string
}

export interface WorkerRestoreResult {
  ok: boolean
  integrityText?: string
  reason?: 'source_invalid' | 'verify_failed' | 'io'
  error?: string
}

export interface WorkerVacuumResult {
  ok: boolean
  freedPages?: number
  error?: string
}

export interface WorkerFtsResult {
  ok: boolean
  action: 'optimize' | 'rebuild' | 'integrity-check'
  details: string
  error?: string
}

export interface WorkerRetentionResult {
  ok: boolean
  deleted: number
  error?: string
}

export interface WorkerRecoverResult {
  ok: boolean
  path?: string
  integrityText?: string
  reason?: 'unrecoverable' | 'verify_failed' | 'io'
  error?: string
}

export type WorkerHealthStatus = 'ok' | 'corrupt' | 'full_disk' | 'error'

export interface WorkerHealthResult {
  ok: boolean
  status: WorkerHealthStatus
  quickCheck: string
  details: WorkerSizeTelemetry
  message: string
}

export type DatabaseWorkerResult =
  | ({ kind: 'checkpoint' } & WorkerCheckpointResult)
  | ({ kind: 'integrity' } & WorkerIntegrityResult)
  | ({ kind: 'size-telemetry' } & WorkerSizeTelemetry)
  | ({ kind: 'backup' } & WorkerBackupResult)
  | ({ kind: 'restore' } & WorkerRestoreResult)
  | ({ kind: 'vacuum' } & WorkerVacuumResult)
  | ({ kind: 'fts' } & WorkerFtsResult)
  | ({ kind: 'retention' } & WorkerRetentionResult)
  | ({ kind: 'recover-to' } & WorkerRecoverResult)
  | ({ kind: 'health' } & WorkerHealthResult)
  | {
      kind: 'query'
      ok: boolean
      rows?: Record<string, unknown>[]
      truncated?: boolean
      error?: string
    }
  | {
      kind: 'query-messages'
      ok: boolean
      messages?: AgentMessage[]
      truncated?: boolean
      error?: string
    }
  | {
      kind: 'query-user-messages'
      ok: boolean
      messages?: UserMessageSummary[]
      truncated?: boolean
      error?: string
    }
  | {
      kind: 'checkpoint-summaries'
      ok: boolean
      summaries?: TurnCheckpointSummary[]
      failed?: string[]
      error?: string
    }
  | { kind: 'execute'; ok: boolean; error?: string }
  | { kind: 'transaction'; ok: boolean; error?: string }
  | { kind: 'history-append'; ok: boolean; sequence?: number; error?: string }
  | {
      kind: 'stats'
      ok: boolean
      activeOps: number
      totalOps: number
      maxObservedConcurrency: number
      maintenanceEnabled: boolean
      error?: string
    }
  | { kind: 'sync-provider-deltas'; ok: boolean; result?: ProviderDeltaSyncResult; error?: string }
  | {
      kind: 'export-transcript'
      ok: boolean
      path?: string
      error?: string
    }
  | ({ kind: 'shutdown' } & { ok: boolean })
  | ({ kind: 'ping' } & { ok: boolean })

export type DatabaseWorkerMessage =
  | { type: 'response'; id: number; result: DatabaseWorkerResult }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }

export type DatabaseWorkerOutbound = { type: 'request'; id: number; request: DatabaseWorkerRequest }

type ResultForRequest<K extends DatabaseWorkerRequest['kind']> = Extract<
  DatabaseWorkerResult,
  { kind: K }
>

// ─── Client ───────────────────────────────────────────────────────────────

const UNAVAILABLE =
  'Database maintenance worker is not available on this connection (in-memory test database)'

/** A worker job at or above this many milliseconds is reported as slow. */
const SLOW_WORKER_JOB_MS = 500

/** How often a background job re-checks whether the queue has gone quiet. */
const QUIET_POLL_MS = 250

/** Bounded forced-termination window for a shutdown that does not exit cleanly. */
export const WORKER_SHUTDOWN_TIMEOUT_MS = 2000

/**
 * Maintenance kinds nobody is waiting on inside an interaction.
 *
 * These are O(database-size) jobs: a WAL checkpoint, an integrity check, an FTS
 * rebuild, a vacuum. A person's read queued behind one of them is exactly the
 * stall this queue exists to prevent, so they always take the background lane
 * whatever the caller says. A SQL read is interactive unless its caller names
 * itself background, because only the caller knows whether a click is waiting.
 */
const ALWAYS_BACKGROUND_KINDS: ReadonlySet<DatabaseWorkerRequest['kind']> = new Set([
  'checkpoint',
  'integrity',
  'size-telemetry',
  'backup',
  'restore',
  'vacuum',
  'fts',
  'retention',
  'recover-to',
  'health'
])

/** A request waiting for the worker, with the promise it will answer. */
interface QueuedWorkerRequest {
  id: number
  request: DatabaseWorkerRequest
  /** The lane this request joined when it arrived, fixed for its whole life. */
  lane: WorkerLane
  resolve: (result: DatabaseWorkerResult) => void
}

/**
 * The lane a request joins.
 *
 * `shutdown` is interactive on purpose: it is the last thing a quit does, and
 * parking it behind a queued vacuum would hold the process open. A request that
 * names a lane explicitly is honoured, `background` included.
 */
function laneFor(request: DatabaseWorkerRequest): WorkerLane {
  if (ALWAYS_BACKGROUND_KINDS.has(request.kind)) return 'background'
  if (
    request.kind === 'query' ||
    request.kind === 'query-messages' ||
    request.kind === 'query-user-messages' ||
    request.kind === 'checkpoint-summaries' ||
    request.kind === 'execute' ||
    request.kind === 'transaction'
  ) {
    return request.lane ?? 'interactive'
  }
  return 'interactive'
}

export class DatabaseWorker {
  private worker: Worker | null = null
  private nextId = 1
  /** Requests a person is waiting on. Always drained before the background lane. */
  private readonly interactive: QueuedWorkerRequest[] = []
  /** Maintenance and whole-project scans, run only when nothing interactive waits. */
  private readonly background: QueuedWorkerRequest[] = []
  /** The request the worker is executing right now, if any. */
  private inFlight: QueuedWorkerRequest | null = null
  /**
   * When an interactive request last arrived or answered.
   *
   * Background work uses this to stay out of a person's way: a one-time index
   * build that holds the worker for seconds should start while nothing is
   * waiting on it, not between a click and the read that answers it. Seeded at
   * start so a launch counts as activity too.
   */
  private lastInteractiveActivityAt = 0
  private readonly pending = new Map<
    number,
    { kind: DatabaseWorkerRequest['kind']; resolve: (result: DatabaseWorkerResult) => void }
  >()

  constructor(
    private readonly config: DatabaseWorkerConfig,
    private readonly logger: typeof Logger = Logger,
    private readonly factory: DatabaseWorkerFactory = createDatabaseWorkerThread
  ) {}

  isRunning(): boolean {
    return this.worker !== null
  }

  /** Spawn the maintenance worker. Failure is logged but never throws. */
  start(): void {
    if (this.worker) return
    try {
      const worker = this.factory({ workerData: this.config })
      worker.on('message', (message: DatabaseWorkerMessage) => this.handleMessage(message))
      worker.on('error', (error) => {
        this.logger.error('Database maintenance worker failed', error)
        this.rejectAll()
      })
      worker.on('exit', (code) => {
        if (code !== 0) {
          this.logger.error('Database maintenance worker exited unexpectedly', { code })
        }
        this.worker = null
        this.rejectAll()
      })
      this.worker = worker
      this.lastInteractiveActivityAt = Date.now()
      this.logger.dev('Database maintenance worker started', { path: this.config.dbPath })
    } catch (error) {
      this.worker = null
      this.logger.error('Failed to start database maintenance worker', error)
    }
  }

  /**
   * Graceful shutdown. Requests are single-flight, so the typed `shutdown`
   * request is sent and awaited AFTER any in-flight request completes; the
   * worker clears its maintenance timer, closes the connection, acknowledges,
   * and closes its port for a clean exit. This side awaits the clean exit and
   * only force-terminates (bounded) if the worker fails to exit on its own.
   * A subsequent `start()` spawns a fresh worker.
   */
  async shutdown(): Promise<void> {
    const worker = this.worker
    if (!worker) return

    // Register the exit listener BEFORE sending the shutdown request so a fast
    // worker exit (ack + port close) can never fire before the listener is
    // attached   otherwise the clean exit is missed and we would force-terminate.
    let exitedCleanly = false
    const cleanExit = new Promise<void>((resolve) => {
      const onExit = () => {
        exitedCleanly = true
        resolve()
      }
      worker.once('exit', onExit)
      const timer = setTimeout(() => {
        worker.removeListener('exit', onExit)
        resolve()
      }, WORKER_SHUTDOWN_TIMEOUT_MS)
      timer.unref?.()
    })

    const response = this.request({ kind: 'shutdown' })
    const timeout = new Promise<never>((resolve) => {
      setTimeout(resolve, WORKER_SHUTDOWN_TIMEOUT_MS)
    })
    await Promise.race([response, timeout])
    await cleanExit

    if (!exitedCleanly) {
      // Bounded forced termination   only when the worker did not exit cleanly.
      this.logger.dev('Database maintenance worker did not exit cleanly; force-terminating')
      await worker.terminate().catch(() => undefined)
    }
    this.worker = null
    this.rejectAll()
  }

  // ── Typed maintenance operations ────────────────────────────────────────

  async passiveCheckpoint(): Promise<ResultForRequest<'checkpoint'>> {
    return this.request({ kind: 'checkpoint', mode: 'passive' })
  }

  async truncateCheckpoint(): Promise<ResultForRequest<'checkpoint'>> {
    return this.request({ kind: 'checkpoint', mode: 'truncate' })
  }

  async integrityCheck(quick = true): Promise<ResultForRequest<'integrity'>> {
    return this.request({ kind: 'integrity', quick })
  }

  async sizeTelemetry(): Promise<ResultForRequest<'size-telemetry'>> {
    return this.request({ kind: 'size-telemetry' })
  }

  /** Atomic online backup: writes `<target>.tmp`, verifies, then renames. */
  async backup(targetPath: string): Promise<ResultForRequest<'backup'>> {
    return this.request({ kind: 'backup', targetPath })
  }

  /** Restore an atomic backup over the live database, verifying first. */
  async restore(sourcePath: string): Promise<ResultForRequest<'restore'>> {
    return this.request({ kind: 'restore', sourcePath })
  }

  async incrementalVacuum(pages = 128): Promise<ResultForRequest<'vacuum'>> {
    return this.request({ kind: 'vacuum', mode: 'incremental', pages })
  }

  async fullVacuum(): Promise<ResultForRequest<'vacuum'>> {
    return this.request({ kind: 'vacuum', mode: 'full', pages: 0 })
  }

  async optimizeFts(): Promise<ResultForRequest<'fts'>> {
    return this.request({ kind: 'fts', action: 'optimize' })
  }

  async rebuildFts(): Promise<ResultForRequest<'fts'>> {
    return this.request({ kind: 'fts', action: 'rebuild' })
  }

  async ftsIntegrityCheck(): Promise<ResultForRequest<'fts'>> {
    return this.request({ kind: 'fts', action: 'integrity-check' })
  }

  async runRetention(): Promise<ResultForRequest<'retention'>> {
    return this.request({ kind: 'retention' })
  }

  /** Rebuild a clean, verified copy of a corrupt database at `targetPath`. */
  async recoverTo(targetPath: string): Promise<ResultForRequest<'recover-to'>> {
    return this.request({ kind: 'recover-to', targetPath })
  }

  async healthCheck(): Promise<ResultForRequest<'health'>> {
    return this.request({ kind: 'health' })
  }

  /**
   * Bounded read on the worker's connection. `maxRows` (>0) bounds the
   * response and reports truncation; caller-owned LIMIT clauses are preserved
   * inside an outer safety bound. Serialized with every other request and the
   * maintenance loop.
   *
   * `lane: 'background'` is for a scan that nobody is waiting on (the
   * whole-project passes): it runs only when no interactive read is queued, so
   * it can never sit in front of a click.
   */
  async query(
    sql: string,
    params: unknown[],
    maxRows: number,
    lane?: WorkerLane
  ): Promise<ResultForRequest<'query'>> {
    return this.request({
      kind: 'query',
      sql,
      params,
      maxRows,
      ...(lane ? { lane } : {})
    })
  }

  /**
   * Bounded read decoded straight to `AgentMessage[]` on the worker thread  
   * the `parts` JSON (and its legacy oversized tool outputs) is parsed and
   * capped there, so a multi-megabyte string never crosses the worker port.
   */
  async queryMessages(
    sql: string,
    params: unknown[],
    maxRows: number,
    includeTransport = false,
    lane?: WorkerLane
  ): Promise<ResultForRequest<'query-messages'>> {
    return this.request({
      kind: 'query-messages',
      sql,
      params,
      maxRows,
      includeTransport,
      ...(lane ? { lane } : {})
    })
  }

  /** Bounded read decoded straight to `UserMessageSummary[]` on the worker thread. */
  async queryUserMessages(
    sql: string,
    params: unknown[],
    maxRows: number,
    lane?: WorkerLane
  ): Promise<ResultForRequest<'query-user-messages'>> {
    return this.request({
      kind: 'query-user-messages',
      sql,
      params,
      maxRows,
      ...(lane ? { lane } : {})
    })
  }

  /**
   * Bounded read of turn checkpoints decoded, repaired and summarized on the
   * worker thread. Those rows carry whole-project snapshots, so parsing them and
   * recomputing a missing diff is the expensive half of reading them, and it must
   * not run on the process that answers IPC.
   */
  async queryCheckpointSummaries(
    sql: string,
    params: unknown[],
    maxRows: number,
    lane?: WorkerLane
  ): Promise<ResultForRequest<'checkpoint-summaries'>> {
    return this.request({
      kind: 'checkpoint-summaries',
      sql,
      params,
      maxRows,
      ...(lane ? { lane } : {})
    })
  }

  /** Single write statement on the worker's connection (serialized). */
  async execute(
    sql: string,
    params: unknown[],
    lane?: WorkerLane
  ): Promise<ResultForRequest<'execute'>> {
    return this.request({ kind: 'execute', sql, params, ...(lane ? { lane } : {}) })
  }

  /** Atomic batch: all statements run in one transaction (serialized). */
  async transaction(
    statements: Array<{ sql: string; params: unknown[] }>,
    lane?: WorkerLane
  ): Promise<ResultForRequest<'transaction'>> {
    return this.request({ kind: 'transaction', statements, ...(lane ? { lane } : {}) })
  }

  /**
   * Atomic history append: the next sequence is allocated and the row inserted
   * in one serialized worker transaction, so concurrent appends can never
   * allocate the same sequence.
   */
  async appendHistory(
    id: string,
    threadId: string,
    role: string,
    content: string,
    metadata: Record<string, unknown> | undefined,
    timestamp: number
  ): Promise<ResultForRequest<'history-append'>> {
    return this.request({
      kind: 'history-append',
      id,
      threadId,
      role,
      content,
      metadata: metadata ?? null,
      timestamp
    })
  }

  /** Worker-side serialization counters (for the concurrency proof). */
  async stats(): Promise<ResultForRequest<'stats'>> {
    return this.request({ kind: 'stats' })
  }

  /**
   * Delta-only transcript sync executed on the worker's connection, so the
   * reconciliation work never blocks the main process. See
   * `runProviderDeltaSync` for the edit-detection / true-noop semantics.
   */
  async syncProviderDeltas(
    threadId: string,
    sessionId: string,
    messages: AgentMessage[]
  ): Promise<ResultForRequest<'sync-provider-deltas'>> {
    return this.request({ kind: 'sync-provider-deltas', threadId, sessionId, messages })
  }

  /**
   * Serialize a thread's conversation into a Markdown transcript on the worker
   * thread and write it atomically to `destinationPath`   the heavy read/build
   * never touches the main process. Returns the written path on success.
   */
  async exportTranscript(
    threadId: string,
    includeTrace: boolean,
    destinationPath: string
  ): Promise<ResultForRequest<'export-transcript'>> {
    return this.request({ kind: 'export-transcript', threadId, includeTrace, destinationPath })
  }

  async ping(): Promise<ResultForRequest<'ping'>> {
    return this.request({ kind: 'ping' })
  }

  /** Default directory for atomic backup artifacts, derived from the db path. */
  defaultBackupDir(): string {
    return join(dirname(this.config.dbPath), 'backups')
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private handleMessage(message: DatabaseWorkerMessage): void {
    if (message.type === 'response') {
      const pending = this.pending.get(message.id)
      if (pending) {
        this.pending.delete(message.id)
        pending.resolve(message.result)
      }
      return
    }
    if (message.type === 'log') {
      if (message.level === 'error') {
        this.logger.error(`Database maintenance: ${message.message}`)
      } else {
        this.logger.info(`Database maintenance: ${message.message}`)
      }
      return
    }
  }

  /**
   * Queued request: the worker executes one at a time (one thread, one
   * connection), so nothing here runs two jobs at once. The lane only decides
   * the order, and an interactive request is therefore never sent while another
   * interactive one is still in flight, while a queued background job waits for
   * the interactive lane to empty.
   *
   * A failed send or a dead worker resolves with a typed unavailable result of
   * the request's own kind.
   */
  private request<K extends DatabaseWorkerRequest['kind']>(
    request: Extract<DatabaseWorkerRequest, { kind: K }>
  ): Promise<ResultForRequest<K>> {
    if (!this.worker) {
      return Promise.resolve({
        kind: request.kind,
        ok: false,
        error: UNAVAILABLE
      } as ResultForRequest<K>)
    }
    return new Promise<DatabaseWorkerResult>((resolve) => {
      const lane = laneFor(request)
      const queued: QueuedWorkerRequest = { id: this.nextId++, request, lane, resolve }
      if (lane === 'background') this.background.push(queued)
      else {
        this.lastInteractiveActivityAt = Date.now()
        this.interactive.push(queued)
      }
      this.pump()
    }) as Promise<ResultForRequest<K>>
  }

  /**
   * Resolve once no interactive request has arrived or answered for `quietMs`,
   * or once `deadlineMs` has passed whatever the traffic.
   *
   * The deadline is what keeps this honest: a one-time background job that waits
   * for a quiet moment must still happen on a machine that is never quiet, so the
   * wait is bounded and the job runs anyway. Answers immediately when no worker
   * is running, because then there is nothing to protect.
   */
  async waitForInteractiveQuiet(quietMs: number, deadlineMs: number): Promise<void> {
    const startedAt = Date.now()
    for (;;) {
      if (!this.worker) return
      const now = Date.now()
      const busy = this.interactive.length > 0 || this.inFlight?.lane === 'interactive'
      if (!busy && now - this.lastInteractiveActivityAt >= quietMs) return
      if (now - startedAt >= deadlineMs) return
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, QUIET_POLL_MS)
        timer.unref?.()
      })
    }
  }

  /**
   * Send the next queued request, interactive lane first.
   *
   * Called on enqueue and on every completion, so the queue is always either
   * executing one request or empty. A background job runs only when no
   * interactive request is waiting: maintenance is periodic and idempotent, so
   * delaying it costs nothing, while delaying a click is what the user sees.
   */
  private pump(): void {
    if (this.inFlight) return
    let queued = this.interactive.shift()
    if (!queued) queued = this.background.shift()
    if (!queued) return
    const worker = this.worker
    if (!worker) {
      this.answerUnavailable(queued)
      this.pump()
      return
    }
    this.inFlight = queued
    const startedAt = performance.now()
    this.pending.set(queued.id, {
      kind: queued.request.kind,
      resolve: (outcome) => {
        this.reportSlowJob(queued.request, performance.now() - startedAt)
        this.inFlight = null
        if (queued.lane === 'interactive') this.lastInteractiveActivityAt = Date.now()
        queued.resolve(outcome)
        this.pump()
      }
    })
    try {
      worker.postMessage({
        type: 'request',
        id: queued.id,
        request: queued.request
      } satisfies DatabaseWorkerOutbound)
    } catch (error) {
      this.pending.delete(queued.id)
      this.inFlight = null
      queued.resolve({
        kind: queued.request.kind,
        ok: false,
        error: String(error)
      } as DatabaseWorkerResult)
      this.pump()
    }
  }

  /** Answer a request that never reached a worker with its own typed failure. */
  private answerUnavailable(queued: QueuedWorkerRequest): void {
    queued.resolve({
      kind: queued.request.kind,
      ok: false,
      error: UNAVAILABLE
    } as DatabaseWorkerResult)
  }

  /**
   * Name a job that held the worker for long. Requests run one at a time, so a
   * slow job delays every read queued behind it (a board, a thread list); this
   * report is what attributes that wait to the job that caused it. The lane is
   * named too: an interactive job that takes a second is a person waiting, a
   * background one is only a delay the queue already pushes to the back.
   */
  private reportSlowJob(request: DatabaseWorkerRequest, durationMs: number): void {
    if (durationMs < SLOW_WORKER_JOB_MS) return
    const sql = 'sql' in request && typeof request.sql === 'string' ? request.sql : undefined
    this.logger.info('Slow database worker job', {
      kind: request.kind,
      lane: laneFor(request),
      durationMs: Math.round(durationMs),
      queued: this.interactive.length + this.background.length,
      ...(sql ? { sql: sql.replace(/\s+/g, ' ').trim().slice(0, 160) } : {})
    })
  }

  private rejectAll(): void {
    for (const pending of this.pending.values()) {
      // Preserve the expected result kind so callers see a well-typed failure
      // (e.g. a pending restore resolves as a restore result, not a ping).
      pending.resolve({
        kind: pending.kind,
        ok: false,
        error: 'Database maintenance worker unavailable'
      } as DatabaseWorkerResult)
    }
    this.pending.clear()
    this.inFlight = null
    // Queued work never reaches a worker either, and leaving it queued would
    // leave its callers awaiting a promise nothing can ever answer.
    for (const queued of this.interactive.splice(0)) this.answerUnavailable(queued)
    for (const queued of this.background.splice(0)) this.answerUnavailable(queued)
  }
}
