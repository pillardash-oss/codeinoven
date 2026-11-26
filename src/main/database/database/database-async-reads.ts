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
 *
 * That last sentence is why the daily `PRAGMA quick_check` is gated below: the
 * probe reads every page of the file, so its ten seconds of CPU and disk are a
 * cost the machine pays whatever thread it runs on. Being off the click path is
 * not the same as being free, so it waits for a moment nobody is working.
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
/**
 * How long the database must have seen no read and no write before a probe may
 * start. A checkpoint, a turn streaming its rows, a board refresh and a click all
 * land inside one of these windows, so a minute of silence is a real pause rather
 * than a gap between two requests.
 */
const INTEGRITY_QUIET_MS = 60 * 1000
/**
 * How long a due probe waits for that pause before it runs anyway.
 *
 * Corruption is found by the probe and by nothing else, so a machine that never
 * goes quiet must still be checked: the budget bounds the wait, and the probe
 * then runs next to whatever the user is doing. Two hours keeps it inside the
 * day the probe came due on, so the schedule's meaning is unchanged.
 */
const INTEGRITY_MAX_WAIT_MS = 2 * 60 * 60 * 1000
/** How often the foreground signal is re-read while a probe waits. */
const ACTIVITY_POLL_MS = 5 * 1000

/**
 * What this lane needs to know about the app around it to stay out of a person's
 * way. Deliberately two narrow facts rather than a service, so nothing heavier
 * than a predicate is imported into the database layer.
 */
export interface DatabaseActivitySignal {
  /**
   * Whether a person is working in the app right now (a window on screen and
   * holding focus). There is no window to be in when nothing is supplied — a
   * test, a headless run, a backgrounded process with no window — so the safe
   * answer is "nobody is here" and the wait is bounded by `maxWaitMs` anyway.
   */
  isUserActive?: () => boolean
  /**
   * Resolve once no read or write has run on the database for `quietMs`, or once
   * `deadlineMs` has passed whatever the traffic. Absent falls back to this
   * lane's own worker, whose queue is the async traffic the probe would queue
   * behind.
   */
  waitForDatabaseQuiet?: (quietMs: number, deadlineMs: number) => Promise<void>
}

/** The probe schedule, as data so a test can run it in milliseconds. */
export interface DatabaseAsyncReadsOptions extends DatabaseActivitySignal {
  /** First probe after the lane starts (ms). */
  firstDelayMs?: number
  /** Re-arm delay after a probe has run (ms). */
  intervalMs?: number
  /** How long the database must be silent before a probe may start (ms). */
  quietMs?: number
  /** How long a due probe waits for that silence before running anyway (ms). */
  maxWaitMs?: number
  /** How often the foreground signal is re-read while a probe waits (ms). */
  pollMs?: number
}

export class DatabaseAsyncReads {
  private worker: DatabaseWorker | null = null
  private integrityTimer: ReturnType<typeof setTimeout> | null = null
  private readonly path: string
  private readonly workerFactory: DatabaseWorkerFactory | undefined
  private readonly firstDelayMs: number
  private readonly intervalMs: number
  private readonly quietMs: number
  private readonly maxWaitMs: number
  private readonly pollMs: number
  private activity: DatabaseActivitySignal = {}

  constructor(
    path: string,
    workerFactory?: DatabaseWorkerFactory,
    options: DatabaseAsyncReadsOptions = {}
  ) {
    this.path = path
    this.workerFactory = workerFactory
    this.firstDelayMs = options.firstDelayMs ?? INTEGRITY_FIRST_DELAY_MS
    this.intervalMs = options.intervalMs ?? INTEGRITY_INTERVAL_MS
    this.quietMs = options.quietMs ?? INTEGRITY_QUIET_MS
    this.maxWaitMs = options.maxWaitMs ?? INTEGRITY_MAX_WAIT_MS
    this.pollMs = options.pollMs ?? ACTIVITY_POLL_MS
    this.setActivitySignal(options)
  }

  /**
   * Install (or clear) the app's activity signal.
   *
   * Late-bound on purpose: this lane is constructed with the database, and the
   * window whose focus answers "is the user here?" is created after it. The
   * predicate reads the live window state at call time, so installing it once at
   * boot is enough for the life of the process.
   */
  setActivitySignal(signal: DatabaseActivitySignal | null): void {
    this.activity = {}
    if (!signal) return
    if (signal.isUserActive) this.activity.isUserActive = signal.isUserActive
    if (signal.waitForDatabaseQuiet)
      this.activity.waitForDatabaseQuiet = signal.waitForDatabaseQuiet
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
    this.scheduleIntegrityProbe(this.firstDelayMs)
  }

  /**
   * The daily `PRAGMA quick_check`, on this lane's read-only connection.
   *
   * It reads every page of the file, so on the shared worker it held the
   * interactive queue for as long as the disk took (18 s on a 1.2 GB file).
   * Here it cannot queue a click behind it — but it still spends ten seconds of
   * CPU and disk on a machine the user is working on, which is why it runs only
   * once the app is genuinely quiet (see {@link waitForQuietMoment}).
   */
  private scheduleIntegrityProbe(delayMs: number): void {
    this.integrityTimer = setTimeout(() => {
      this.integrityTimer = null
      void this.runIntegrityProbe()
    }, delayMs)
    this.integrityTimer.unref?.()
  }

  private async runIntegrityProbe(): Promise<void> {
    const worker = this.worker
    if (!worker?.isRunning()) return
    try {
      await this.waitForQuietMoment(worker)
    } catch (error) {
      // The gate is an optimisation, never a reason to skip the check: a signal
      // that fails is treated as silence and the probe runs now.
      Logger.error('Database maintenance: quick_check quiet check failed; probing now', error)
    }
    // The lane may have been stopped while the probe waited for its moment.
    if (this.worker !== worker || !worker.isRunning()) return
    try {
      const result = await worker.integrityCheck(true)
      if (result.ok) Logger.info(`Database maintenance: quick_check: ${result.text}`)
      else Logger.error('Database maintenance: quick_check failed', result.error ?? result.text)
    } catch (error: unknown) {
      Logger.error('Database maintenance: quick_check failed', error)
    } finally {
      if (this.worker === worker) this.scheduleIntegrityProbe(this.intervalMs)
    }
  }

  /**
   * Wait for a moment in which the probe costs nobody anything: no window is in
   * use and the database has seen no read or write for a quiet window.
   *
   * Bounded by `maxWaitMs`. On a machine that is never quiet the budget runs out
   * and the probe runs anyway, because noticing corruption matters more than the
   * ten seconds it costs.
   */
  private async waitForQuietMoment(worker: DatabaseWorker): Promise<void> {
    const deadline = Date.now() + this.maxWaitMs
    for (;;) {
      if (this.worker !== worker || !worker.isRunning()) return
      const remaining = deadline - Date.now()
      if (remaining <= 0) return
      if (this.isUserActive()) {
        await this.sleep(Math.min(this.pollMs, remaining))
        continue
      }
      await this.waitForDatabaseQuiet(worker, Math.min(this.quietMs, remaining), remaining)
      if (this.worker !== worker || !worker.isRunning()) return
      // Quiet on both axes. A user who came back while the database was settling
      // means the moment has passed, so the loop serves a fresh quiet window.
      if (!this.isUserActive()) return
    }
  }

  private isUserActive(): boolean {
    return this.activity.isUserActive?.() ?? false
  }

  private async waitForDatabaseQuiet(
    worker: DatabaseWorker,
    quietMs: number,
    deadlineMs: number
  ): Promise<void> {
    const wait = this.activity.waitForDatabaseQuiet
    if (wait) {
      await wait(quietMs, deadlineMs)
      return
    }
    // Without an injected signal this lane's own queue is the honest one: async
    // reads are the traffic a probe would sit behind, and every one of them is
    // queued as interactive traffic on this worker.
    await worker.waitForInteractiveQuiet(quietMs, deadlineMs)
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      timer.unref?.()
    })
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
   * A probe waiting for a quiet moment sees the cleared handle and gives up
   * instead of running against a closed connection.
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
