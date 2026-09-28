import { Logger } from '../system/logger'
import type { StorageEngine } from '../storage/storage-engine'
import type { BackgroundRun, BackgroundRunOutcome } from '../../lib/types'

/** Persisted shape: one versioned array so the file stays inspectable. */
interface BackgroundRunLedgerFile {
  version: 1
  runs: BackgroundRun[]
}

const STORE_PATH = 'scheduler/background-runs.json'

/**
 * Hard cap on the ledger. Settled entries are evicted before pending ones, and
 * the oldest of each group first, so the "While you were away" list keeps the
 * recent past and can never grow without bound.
 */
const MAX_ENTRIES = 200

function isValidBackgroundRun(value: unknown): value is BackgroundRun {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  const reason = record.reason
  const outcome = record.outcome
  return (
    typeof record.taskId === 'string' &&
    typeof record.runThreadId === 'string' &&
    (reason === 'scheduled' || reason === 'caught-up') &&
    typeof record.startedAt === 'number' &&
    (record.routineId === undefined || typeof record.routineId === 'string') &&
    (record.settledAt === undefined || typeof record.settledAt === 'number') &&
    (outcome === undefined ||
      outcome === 'completed' ||
      outcome === 'failed' ||
      outcome === 'parked') &&
    (record.errorSummary === undefined || typeof record.errorSummary === 'string') &&
    typeof record.autoAnswered === 'number'
  )
}

/**
 * BackgroundRunLedger   the durable record of unattended runs.
 *
 * An unattended dispatch is recorded when it starts and settled when it ends,
 * so a run that finished (or failed) while no window was open leaves evidence
 * the user finds on the next launch. The ledger is deliberately independent of
 * the thread table: it stores its own snapshot of each run, so deleting the run
 * thread later can never erase the fact that the run happened.
 *
 * Like `MissedRunStore`, the file is a single versioned array and every write
 * is serialized through one promise chain, so concurrent scheduler ticks cannot
 * interleave and corrupt the file. The array is capped, with settled entries
 * pruned first.
 */
export class BackgroundRunLedger {
  private runs = new Map<string, BackgroundRun>()
  private loaded = false
  private persistChain: Promise<void> = Promise.resolve()

  constructor(private storage: StorageEngine) {}

  async load(): Promise<void> {
    const raw = await this.storage.read<BackgroundRunLedgerFile>(STORE_PATH)
    this.runs.clear()
    if (raw && Array.isArray(raw.runs)) {
      for (const entry of raw.runs) {
        if (isValidBackgroundRun(entry)) this.runs.set(entry.runThreadId, entry)
      }
    }
    // A ledger written by a newer build (or a hand-edited file) is trimmed to
    // the current cap before it is ever read back.
    if (this.runs.size > MAX_ENTRIES) this.prune()
    this.loaded = true
  }

  isLoaded(): boolean {
    return this.loaded
  }

  /**
   * Record the start of an unattended dispatch. Idempotent by `runThreadId`: a
   * repeated start for the same run returns the existing entry untouched, so a
   * scheduler retry can never lose the original start time or duplicate a run.
   */
  recordStart(input: {
    taskId: string
    routineId?: string
    runThreadId: string
    reason: BackgroundRun['reason']
    startedAt?: number
    autoAnswered?: number
  }): BackgroundRun {
    const existing = this.runs.get(input.runThreadId)
    if (existing) return existing
    const entry: BackgroundRun = {
      taskId: input.taskId,
      ...(input.routineId !== undefined ? { routineId: input.routineId } : {}),
      runThreadId: input.runThreadId,
      reason: input.reason,
      startedAt: input.startedAt ?? Date.now(),
      autoAnswered: input.autoAnswered ?? 0
    }
    this.runs.set(entry.runThreadId, entry)
    this.trimToCap()
    this.persist()
    return entry
  }

  /**
   * Settle a recorded run by its `runThreadId`. Unknown ids are ignored: a
   * settle arriving after the entry was pruned must never resurrect it or throw
   * inside the run teardown path.
   */
  settle(
    runThreadId: string,
    input: {
      outcome: BackgroundRunOutcome
      errorSummary?: string
      autoAnswered?: number
      settledAt?: number
    }
  ): void {
    const existing = this.runs.get(runThreadId)
    if (!existing) return
    const entry: BackgroundRun = {
      ...existing,
      settledAt: input.settledAt ?? Date.now(),
      outcome: input.outcome,
      autoAnswered: input.autoAnswered ?? existing.autoAnswered,
      ...(input.errorSummary !== undefined ? { errorSummary: input.errorSummary } : {})
    }
    this.runs.set(runThreadId, entry)
    this.persist()
  }

  /** Every recorded run, newest first. */
  list(): BackgroundRun[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt)
  }

  /** Runs that started but have not settled yet. */
  listPending(): BackgroundRun[] {
    return this.list().filter((run) => run.settledAt === undefined)
  }

  /** One recorded run by its thread id, or undefined when it is not in the ledger. */
  get(runThreadId: string): BackgroundRun | undefined {
    return this.runs.get(runThreadId)
  }

  /**
   * Drop entries until the ledger is back under its cap, evicting settled
   * entries before pending ones and the oldest of each group first. No-op when
   * the ledger is already within the cap.
   */
  prune(): void {
    if (this.trimToCap()) this.persist()
  }

  /** Await the pending write chain (used by tests and shutdown). */
  async flush(): Promise<void> {
    await this.persistChain
  }

  private trimToCap(): boolean {
    if (this.runs.size <= MAX_ENTRIES) return false
    const candidates = [...this.runs.values()].sort((a, b) => {
      const aSettled = a.settledAt !== undefined ? 0 : 1
      const bSettled = b.settledAt !== undefined ? 0 : 1
      if (aSettled !== bSettled) return aSettled - bSettled
      return a.startedAt - b.startedAt
    })
    const evicted = candidates.slice(0, this.runs.size - MAX_ENTRIES)
    for (const entry of evicted) this.runs.delete(entry.runThreadId)
    return evicted.length > 0
  }

  private persist(): void {
    const snapshot: BackgroundRunLedgerFile = { version: 1, runs: [...this.runs.values()] }
    this.persistChain = this.persistChain
      .then(() => this.storage.write(STORE_PATH, snapshot))
      .catch((error) => {
        Logger.error('Background-run ledger could not be written:', error)
      })
  }
}
