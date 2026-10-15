/**
 * A cross-process mutex for moving one thread between CodeInOven instances.
 *
 * The hand-off has two sides   an instance asks a sibling to release a run, then
 * the sibling stops and settles it and the asker adopts it   and a thread may
 * only have one of each in flight. Without that rule two windows can ask at the
 * same moment, both siblings pass the "is this still my turn" check before
 * either stops anything, both ack, and both adopt, which puts two harness
 * writers on one session and interleaves their output.
 *
 * The lock has to be cross-process, and the two instances already share exactly
 * one thing that can carry it: the config root's SQLite database. So the lock is
 * a row, keyed by the transferred thread and the role being played   `adopt` on
 * the receiving instance, `release` on the sending one   and the primary key is
 * the mutex. A write that inserts the row wins; every other claimant is told so
 * by the constraint, never by a read-then-write race.
 *
 * A row is a lease, never a permanent record. It is held only for the length of
 * one hand-off and is ignored once its holder stops being live   either the
 * lease ran out or the process died   so a crash mid-transfer cannot strand a
 * thread forever. Re-acquiring a lock this process already holds refreshes the
 * lease and mints a new token, so a slow hand-off does not expire underneath
 * itself.
 */

import type { Database } from '../database/database'
import { instanceRegistry } from './instance-registry'
import { Logger } from './logger'

/** Which side of a hand-off a lock belongs to. */
export type ThreadTransferLockRole = 'release' | 'adopt'

/**
 * How long one acquisition is good for. Comfortably above the hand-off bus
 * timeout (30s) plus the settle and resume that follow, so a live holder is
 * never taken over mid-flight, while a dead one frees the thread quickly.
 */
export const TRANSFER_LOCK_TTL_MS = 90_000

export interface ThreadTransferLockOptions {
  /**
   * The process this lock speaks for. Defaults to the real pid; a test can stand
   * up two claimants in one process by giving each its own id.
   */
  localPid?: number
  /** Whether the process holding a lock is still running. */
  isRunOwnerAlive?: (pid: number) => boolean
  /** The lease length. Defaults to {@link TRANSFER_LOCK_TTL_MS}. */
  ttlMs?: number
  /** Injectable clock, so lease expiry is exercised without waiting. */
  now?: () => number
}

interface LockRow {
  holder_pid: number
  token: string
  acquired_at: number
  expires_at: number
}

export class ThreadTransferLock {
  readonly localPid: number
  private readonly isRunOwnerAlive: (pid: number) => boolean
  private readonly ttlMs: number
  private readonly now: () => number
  private sequence = 0

  constructor(
    private readonly db: Database,
    options: ThreadTransferLockOptions = {}
  ) {
    this.localPid = options.localPid ?? process.pid
    this.isRunOwnerAlive =
      options.isRunOwnerAlive ??
      ((pid) => (pid === process.pid ? true : instanceRegistry.isRunOwnerAlive(pid)))
    this.ttlMs = options.ttlMs ?? TRANSFER_LOCK_TTL_MS
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * Take the lock for one thread and role, or return `null` when another live
   * claim holds it. The returned token is the proof to hand to the other side and
   * the handle to release with; taking a lock this process already holds refreshes
   * it and mints a fresh token.
   */
  async acquire(
    projectId: string,
    threadId: string,
    role: ThreadTransferLockRole
  ): Promise<string | null> {
    const now = this.now()
    const token = `${this.localPid}-${now}-${(this.sequence += 1)}`
    const expiresAt = now + this.ttlMs

    const inserted = this.db
      .prepare(
        `INSERT OR IGNORE INTO thread_transfer_locks
           (project_id, thread_id, role, holder_pid, token, acquired_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(projectId, threadId, role, this.localPid, token, now, expiresAt)
    if (inserted.changes === 1) return token

    const row = await this.read(projectId, threadId, role)
    if (!row) {
      // The row was released between the insert and the read   one more try, and
      // if it is taken again by then we simply lose the claim.
      const retry = this.db
        .prepare(
          `INSERT OR IGNORE INTO thread_transfer_locks
             (project_id, thread_id, role, holder_pid, token, acquired_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(projectId, threadId, role, this.localPid, token, now, expiresAt)
      return retry.changes === 1 ? token : null
    }

    if (row.holder_pid === this.localPid) {
      // Re-entrant: refresh the lease and replace the token, so the caller always
      // holds the current one.
      const refreshed = this.db
        .prepare(
          `UPDATE thread_transfer_locks SET token = ?, acquired_at = ?, expires_at = ?
           WHERE project_id = ? AND thread_id = ? AND role = ? AND holder_pid = ?`
        )
        .run(token, now, expiresAt, projectId, threadId, role, this.localPid)
      return refreshed.changes === 1 ? token : null
    }

    // Another process holds it   only a lease that ran out or a holder that died
    // may be taken over.
    if (row.expires_at >= now && this.isRunOwnerAlive(row.holder_pid)) return null

    const taken = this.db
      .prepare(
        `UPDATE thread_transfer_locks SET holder_pid = ?, token = ?, acquired_at = ?, expires_at = ?
         WHERE project_id = ? AND thread_id = ? AND role = ? AND holder_pid = ? AND token = ?`
      )
      .run(
        this.localPid,
        token,
        now,
        expiresAt,
        projectId,
        threadId,
        role,
        row.holder_pid,
        row.token
      )
    return taken.changes === 1 ? token : null
  }

  /**
   * Whether a given process still holds the lock, and   when a token is supplied
   * with the request   still holds the exact claim that request was made against.
   * This is what lets the sending side refuse to act for a transfer that is not
   * actually held.
   */
  async holds(
    projectId: string,
    threadId: string,
    role: ThreadTransferLockRole,
    holderPid: number,
    token?: string
  ): Promise<boolean> {
    const row = await this.read(projectId, threadId, role)
    if (!row) return false
    if (row.holder_pid !== holderPid) return false
    if (token !== undefined && row.token !== token) return false
    if (row.expires_at < this.now() && !this.isRunOwnerAlive(row.holder_pid)) return false
    return true
  }

  /** Drop the lock, but only the exact claim the token names. */
  async release(
    projectId: string,
    threadId: string,
    role: ThreadTransferLockRole,
    token: string
  ): Promise<void> {
    this.db
      .prepare(
        'DELETE FROM thread_transfer_locks WHERE project_id = ? AND thread_id = ? AND role = ? AND token = ?'
      )
      .run(projectId, threadId, role, token)
  }

  /**
   * The lease row, read on the database worker.
   *
   * Every acquire and every token check reads it, and both sit on an interaction
   * path   a hand-off is what the user just asked for   so the read never runs
   * SQLite on the main thread. A read that fails is a read that did not find a
   * live claim: the caller is told the thread is elsewhere, which is the answer
   * that keeps two writers off one session.
   */
  private async read(
    projectId: string,
    threadId: string,
    role: ThreadTransferLockRole
  ): Promise<LockRow | null> {
    const result = await this.db.queryViaWorker(
      `SELECT holder_pid, token, acquired_at, expires_at
         FROM thread_transfer_locks
         WHERE project_id = ? AND thread_id = ? AND role = ?`,
      [projectId, threadId, role],
      1
    )
    if (!result.ok) {
      Logger.error('Thread transfer lock read failed', result.error ?? 'unknown error')
      return null
    }
    return toLockRow(result.rows[0])
  }
}

/** Shape one worker row into the lease record this lock reasons about. */
function toLockRow(row: Record<string, unknown> | undefined): LockRow | null {
  if (!row) return null
  return {
    holder_pid: Number(row.holder_pid),
    token: String(row.token),
    acquired_at: Number(row.acquired_at),
    expires_at: Number(row.expires_at)
  }
}
