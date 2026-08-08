/**
 * Typed database worker boundary — the single owner of SQLite maintenance and
 * FTS maintenance.
 *
 * The `DatabaseWorker` spawns a dedicated `worker_threads` Worker
 * (`database-worker-thread.ts`) that opens a second WAL connection to the same
 * database file and runs every O(database-size) operation — passive WAL
 * checkpoints, integrity checks, size telemetry, online backup/restore,
 * VACUUM, FTS optimize/integrity/rebuild, bounded retention, and
 * corruption/full-disk detection and recovery — so that no maintenance work
 * ever blocks the Electron main process. The primary read/write connection
 * stays in the main process; WAL locking coordinates the two connections.
 *
 * All requests and responses are strongly typed discriminated unions, so the
 * boundary is auditable and cannot silently drift from the worker's contract.
 */

/// <reference types="electron-vite/node" />
import createDatabaseWorkerThread from './database-worker-thread.ts?nodeWorker'
import type { Worker } from 'worker_threads'
import { dirname, join } from 'path'
import { Logger } from '../logger'

export interface DatabaseWorkerConfig {
  /** Path to the SQLite database file the worker connects to. */
  dbPath: string
  /** Directory where atomic backup/restore artifacts are written. */
  backupDir: string
  /** High-volume event rows older than this many days are archived. */
  retentionDays: number
  /** Maximum retained rows in the retention archive. */
  retentionArchiveCap: number
  /** Whether the periodic maintenance loop is enabled. */
  maintenanceEnabled: boolean
  /** Base interval between maintenance passes (ms). */
  maintenanceIntervalMs: number
}

export const DATABASE_WORKER_DEFAULTS = {
  retentionDays: 90,
  retentionArchiveCap: 5000,
  maintenanceIntervalMs: 30 * 60 * 1000
} as const

// ─── Typed protocol ───────────────────────────────────────────────────────

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
  archived: number
  pruned: number
  archiveRows: number
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
  | ({ kind: 'shutdown' } & { ok: boolean })
  | ({ kind: 'ping' } & { ok: boolean })

export type DatabaseWorkerMessage =
  | { type: 'response'; id: number; result: DatabaseWorkerResult }
  | { type: 'telemetry'; telemetry: WorkerSizeTelemetry }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }

export type DatabaseWorkerOutbound = { type: 'request'; id: number; request: DatabaseWorkerRequest }

type ResultForRequest<K extends DatabaseWorkerRequest['kind']> = Extract<DatabaseWorkerResult, { kind: K }>

// ─── Client ───────────────────────────────────────────────────────────────

const UNAVAILABLE =
  'Database maintenance worker is not available on this connection (in-memory test database)'

export class DatabaseWorker {
  private worker: Worker | null = null
  private nextId = 1
  private readonly pending = new Map<number, (result: DatabaseWorkerResult) => void>()

  constructor(
    private readonly config: DatabaseWorkerConfig,
    private readonly logger: typeof Logger = Logger
  ) {}

  isRunning(): boolean {
    return this.worker !== null
  }

  /** Spawn the maintenance worker. Failure is logged but never throws. */
  start(): void {
    if (this.worker) return
    try {
      const worker = createDatabaseWorkerThread({ workerData: this.config })
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
      this.logger.dev('Database maintenance worker started', { path: this.config.dbPath })
    } catch (error) {
      this.worker = null
      this.logger.error('Failed to start database maintenance worker', error)
    }
  }

  async shutdown(): Promise<void> {
    const worker = this.worker
    if (!worker) return
    this.worker = null
    const response = this.request({ kind: 'shutdown' })
    const timeout = new Promise<never>((resolve) => {
      setTimeout(resolve, 1000)
    })
    await Promise.race([response, timeout])
    await worker.terminate().catch(() => undefined)
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
      const resolve = this.pending.get(message.id)
      if (resolve) {
        this.pending.delete(message.id)
        resolve(message.result)
      }
      return
    }
    if (message.type === 'telemetry') {
      if (message.telemetry.ok) {
        this.logger.info('SQLite database size telemetry', {
          dbBytes: message.telemetry.dbBytes,
          walBytes: message.telemetry.walBytes,
          pageCount: message.telemetry.pageCount,
          schemaVersion: message.telemetry.schemaVersion
        })
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

  private request<K extends DatabaseWorkerRequest['kind']>(
    request: Extract<DatabaseWorkerRequest, { kind: K }>
  ): Promise<ResultForRequest<K>> {
    const worker = this.worker
    if (!worker) {
      return Promise.resolve({ kind: request.kind, ok: false, error: UNAVAILABLE } as ResultForRequest<K>)
    }
    const id = this.nextId++
    return new Promise((resolve) => {
      this.pending.set(id, (result) => resolve(result as ResultForRequest<K>))
      worker.postMessage({ type: 'request', id, request } satisfies DatabaseWorkerOutbound)
    })
  }

  private rejectAll(): void {
    for (const resolve of this.pending.values()) {
      resolve({ kind: 'ping', ok: false, error: 'Database maintenance worker unavailable' } as DatabaseWorkerResult)
    }
    this.pending.clear()
  }
}
