import { Logger } from '../system/logger'
import type { StorageEngine } from '../storage/storage-engine'
import { missedRunId, type MissedRun } from '../../lib/types'

/** Persisted shape: one versioned array so the file stays inspectable. */
interface MissedRunStoreFile {
  version: 1
  runs: MissedRun[]
}

const STORE_PATH = 'scheduler/missed-runs.json'

function isValidRun(value: unknown): value is MissedRun {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    typeof record.threadId === 'string' &&
    typeof record.dueAt === 'number' &&
    typeof record.detectedAt === 'number' &&
    typeof record.title === 'string' &&
    (record.reason === undefined ||
      record.reason === 'app-closed' ||
      record.reason === 'delayed') &&
    (record.status === 'pending' ||
      record.status === 'dismissed' ||
      record.status === 'run')
  )
}

/**
 * MissedRunStore   persists scheduled fires the app was not open to run.
 *
 * Records are idempotent by `(threadId, dueAt)`: relaunching the app repeatedly
 * after one missed fire can never double-count or double-badge it. Writes are
 * serialized through a single chain so concurrent scheduler ticks cannot
 * interleave and corrupt the file.
 */
export class MissedRunStore {
  private runs = new Map<string, MissedRun>()
  private loaded = false
  private persistChain: Promise<void> = Promise.resolve()

  constructor(private storage: StorageEngine) {}

  async load(): Promise<void> {
    const raw = await this.storage.read<MissedRunStoreFile>(STORE_PATH)
    this.runs.clear()
    if (raw && Array.isArray(raw.runs)) {
      for (const entry of raw.runs) {
        if (isValidRun(entry)) this.runs.set(entry.id, entry)
      }
    }
    this.loaded = true
  }

  isLoaded(): boolean {
    return this.loaded
  }

  /** Every pending missed run, oldest first. */
  list(): MissedRun[] {
    return [...this.runs.values()]
      .filter((run) => run.status === 'pending')
      .sort((a, b) => a.dueAt - b.dueAt)
  }

  /** Every record (any status), used by the task-scoped surfaces. */
  listAll(): MissedRun[] {
    return [...this.runs.values()].sort((a, b) => a.dueAt - b.dueAt)
  }

  /** Pending missed runs for one task. */
  listForTask(threadId: string): MissedRun[] {
    return this.list().filter((run) => run.threadId === threadId)
  }

  /** Pending missed runs for every task in a routine. */
  listForRoutine(routineId: string): MissedRun[] {
    return this.list().filter((run) => run.routineId === routineId)
  }

  hasAnyPending(): boolean {
    return this.list().length > 0
  }

  /**
   * Record one missed fire. Idempotent: a repeated detection of the same
   * `(threadId, dueAt)` refreshes the snapshot fields but never adds a second
   * record, and a run/dismissed record is left untouched.
   */
  record(input: {
    threadId: string
    routineId?: string
    dueAt: number
    title: string
    reason?: MissedRun['reason']
    detectedAt?: number
  }): MissedRun {
    const id = missedRunId(input.threadId, input.dueAt)
    const existing = this.runs.get(id)
    if (existing && existing.status !== 'pending') return existing
    const run: MissedRun = {
      id,
      threadId: input.threadId,
      routineId: input.routineId,
      dueAt: input.dueAt,
      detectedAt: input.detectedAt ?? Date.now(),
      title: input.title,
      reason: input.reason,
      status: 'pending'
    }
    this.runs.set(id, run)
    this.persist()
    return run
  }

  /** Acknowledge a missed run without running it: the badge and tab clear. */
  dismiss(id: string): void {
    const existing = this.runs.get(id)
    if (!existing) return
    this.runs.set(id, { ...existing, status: 'dismissed' })
    this.persist()
  }

  /**
   * Drop a record outright, for a miss that is no longer real (its slot
   * predates the schedule, or its task is gone). Unlike `dismiss`, no trace is
   * kept, so it can never resurface in a task-scoped list.
   */
  remove(id: string): void {
    if (!this.runs.delete(id)) return
    this.persist()
  }

  /**
   * Drop every record belonging to a routine that is being removed, matched by
   * the record's own routine id and by the ids of that routine's threads.
   *
   * Both are needed: a record keeps the routine id it was detected under, so a
   * task moved into this routine after its miss was recorded is only reachable
   * by thread id. Returns how many records were dropped.
   */
  removeForRoutine(routineId: string, threadIds: readonly string[]): number {
    const threads = new Set(threadIds)
    let removed = 0
    for (const [id, run] of this.runs) {
      if (run.routineId !== routineId && !threads.has(run.threadId)) continue
      this.runs.delete(id)
      removed += 1
    }
    if (removed > 0) this.persist()
    return removed
  }

  /** Mark a missed run as run (Run Now dispatched it successfully). */
  markRun(id: string): void {
    const existing = this.runs.get(id)
    if (!existing) return
    this.runs.set(id, { ...existing, status: 'run' })
    this.persist()
  }

  /** Drop every dismissed/run record so the file cannot grow without bound. */
  pruneSettled(): void {
    for (const [id, run] of this.runs) {
      if (run.status !== 'pending') this.runs.delete(id)
    }
    this.persist()
  }

  /** Await the pending write chain (used by tests and shutdown). */
  async flush(): Promise<void> {
    await this.persistChain
  }

  private persist(): void {
    const snapshot: MissedRunStoreFile = { version: 1, runs: [...this.runs.values()] }
    this.persistChain = this.persistChain
      .then(() => this.storage.write(STORE_PATH, snapshot))
      .catch((error) => {
        Logger.error('Missed-run store could not be written:', error)
      })
  }
}
