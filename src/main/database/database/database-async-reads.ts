/**
 * The async lane: a second worker thread with its own read-only connection.
 *
 * The database has two lanes today, and both live on ONE worker thread with ONE
 * connection. A lane there decides only the ORDER of the queue — a statement
 * already running cannot be preempted — so a long read that is neither deferrable
 * nor click-blocking still made the next click wait for the whole of it. The
 * app's own log carries the receipts: a thread search at 5,960 ms, a usage rollup
 * at 2,152 ms, and a single-row thread read at 7,928 ms behind them.
 *
 * This is that third class with its own execution context rather than its own
 * queue position. Its connection is read-only and separate, so:
 *
 * - an async read physically cannot occupy the connection a click is waiting on;
 * - it can never become a second writer, which SQLite would serialise anyway;
 * - WAL means readers never block each other, so both run at once, and a read
 *   here still sees every committed write.
 *
 * What this buys is latency, not throughput: three threads still share the same
 * cores, so a long async read still costs CPU. It just cannot hold a click.
 */

import { dirname, join } from 'path'
import { Logger } from '../../system/logger'
import {
  DATABASE_WORKER_DEFAULTS,
  DatabaseWorker,
  type DatabaseWorkerFactory
} from '../database-worker'

/** First integrity probe after the lane starts: well clear of startup. */
const INTEGRITY_FIRST_DELAY_MS = 30 * 60 * 1000
/** One full-file quick_check per day of uptime is enough to notice corruption. */
const INTEGRITY_INTERVAL_MS = 24 * 60 * 60 * 1000

export class DatabaseAsyncReads {
  private worker: DatabaseWorker | null = null
  private integrityTimer: ReturnType<typeof setTimeout> | null = null
  private readonly path: string
  private readonly workerFactory: DatabaseWorkerFactory | undefined

  constructor(path: string, workerFactory?: DatabaseWorkerFactory) {
    this.path = path
    this.workerFactory = workerFactory
  }

  /**
   * Start the lane once.
   *
   * An in-memory database has no file for a second connection to open, and a
   * lane that cannot exist must degrade to the shared worker rather than fail, so
   * this simply does not start there.
   */
  start(): void {
    if (this.path === ':memory:' || this.worker) return
    const worker = new DatabaseWorker(
      {
        dbPath: this.path,
        backupDir: join(dirname(this.path), 'backups'),
        // No maintenance passes: this lane reads, and its whole point is to never
        // be busy with anything but the reads routed to it.
        maintenanceEnabled: false,
        ...DATABASE_WORKER_DEFAULTS,
        readOnly: true
      },
      Logger,
      this.workerFactory
    )
    this.worker = worker
    worker.start()
    this.scheduleIntegrityProbe(INTEGRITY_FIRST_DELAY_MS)
  }

  /**
   * The daily `PRAGMA quick_check`, on this lane's read-only connection.
   *
   * It reads every page of the file, so on the shared worker it held the
   * interactive queue for as long as the disk took (18 s on a 1.2 GB file).
   * Here it is a WAL reader on its own thread: nothing can queue behind it
   * except other async reads, which are already deadline-bounded.
   */
  private scheduleIntegrityProbe(delayMs: number): void {
    this.integrityTimer = setTimeout(() => {
      this.integrityTimer = null
      const worker = this.worker
      if (!worker?.isRunning()) return
      void worker
        .integrityCheck(true)
        .then((result) => {
          if (result.ok) Logger.info(`Database maintenance: quick_check: ${result.text}`)
          else Logger.error('Database maintenance: quick_check failed', result.error ?? result.text)
        })
        .catch((error: unknown) => Logger.error('Database maintenance: quick_check failed', error))
        .finally(() => {
          if (this.worker === worker) this.scheduleIntegrityProbe(INTEGRITY_INTERVAL_MS)
        })
    }, delayMs)
    this.integrityTimer.unref?.()
  }

  /** The live worker, or null when this database runs without one. */
  getWorker(): DatabaseWorker | null {
    return this.worker
  }

  isRunning(): boolean {
    return this.worker?.isRunning() ?? false
  }

  /**
   * Stop the lane.
   *
   * The handle is cleared before the shutdown is queued for the same reason the
   * maintenance worker does it: a read that arrives while this is closing must
   * not queue onto a worker that is going away. A read-only connection has no
   * write-ahead log of its own to hand back, so there is no checkpoint here.
   */
  async stop(): Promise<void> {
    if (this.integrityTimer) clearTimeout(this.integrityTimer)
    this.integrityTimer = null
    const worker = this.worker
    if (!worker?.isRunning()) {
      this.worker = null
      return
    }
    this.worker = null
    await worker.shutdown()
  }
}
