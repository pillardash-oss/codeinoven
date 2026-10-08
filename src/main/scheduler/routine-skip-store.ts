import { Logger } from '../system/logger'
import type { StorageEngine } from '../storage/storage-engine'
import { skippedRoutineRunId, type SkippedRoutineRun } from '../../lib/types'

interface RoutineSkipStoreFile {
  version: 1
  runs: SkippedRoutineRun[]
}

const STORE_PATH = 'scheduler/skipped-runs.json'
const EMPTY_DUE_TIMES: ReadonlySet<number> = new Set<number>()

function isValidRun(value: unknown): value is SkippedRoutineRun {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    typeof record.taskId === 'string' &&
    typeof record.routineId === 'string' &&
    typeof record.dueAt === 'number' &&
    record.id === skippedRoutineRunId(record.taskId, record.dueAt)
  )
}

/** Durable, idempotent ledger for user-skipped schedule slots. */
export class RoutineSkipStore {
  private readonly runs = new Map<string, SkippedRoutineRun>()
  private readonly runsByTask = new Map<string, Set<number>>()
  private persistChain: Promise<void> = Promise.resolve()

  constructor(private readonly storage: StorageEngine) {}

  async load(): Promise<void> {
    const raw = await this.storage.read<RoutineSkipStoreFile>(STORE_PATH)
    this.runs.clear()
    this.runsByTask.clear()
    if (!raw || !Array.isArray(raw.runs)) return
    for (const entry of raw.runs) {
      if (isValidRun(entry)) this.insert(entry)
    }
  }

  list(): SkippedRoutineRun[] {
    return [...this.runs.values()].sort((a, b) => a.dueAt - b.dueAt)
  }

  listForRoutine(routineId: string): SkippedRoutineRun[] {
    return this.list().filter((run) => run.routineId === routineId)
  }

  has(taskId: string, dueAt: number): boolean {
    return this.runs.has(skippedRoutineRunId(taskId, dueAt))
  }

  timesForTask(taskId: string): ReadonlySet<number> {
    return this.runsByTask.get(taskId) ?? EMPTY_DUE_TIMES
  }

  async recordMany(inputs: readonly Omit<SkippedRoutineRun, 'id'>[]): Promise<SkippedRoutineRun[]> {
    const inserted: SkippedRoutineRun[] = []
    for (const input of inputs) {
      const run: SkippedRoutineRun = {
        ...input,
        id: skippedRoutineRunId(input.taskId, input.dueAt)
      }
      if (this.runs.has(run.id)) continue
      this.insert(run)
      inserted.push(run)
    }
    if (inserted.length === 0) return []
    try {
      await this.persist()
      return inserted
    } catch (error) {
      for (const run of inserted) this.removeFromMemory(run.id)
      void this.persist().catch(() => undefined)
      throw error
    }
  }

  removeForRoutine(routineId: string, taskIds: readonly string[]): number {
    const tasks = new Set(taskIds)
    let removed = 0
    for (const [id, run] of this.runs) {
      if (run.routineId !== routineId && !tasks.has(run.taskId)) continue
      this.removeFromMemory(id)
      removed += 1
    }
    if (removed > 0) this.persistBestEffort()
    return removed
  }

  prune(shouldRemove: (run: SkippedRoutineRun) => boolean): number {
    let removed = 0
    for (const [id, run] of this.runs) {
      if (!shouldRemove(run)) continue
      this.removeFromMemory(id)
      removed += 1
    }
    if (removed > 0) this.persistBestEffort()
    return removed
  }

  async flush(): Promise<void> {
    await this.persistChain
  }

  private insert(run: SkippedRoutineRun): void {
    this.runs.set(run.id, run)
    const taskRuns = this.runsByTask.get(run.taskId) ?? new Set<number>()
    taskRuns.add(run.dueAt)
    this.runsByTask.set(run.taskId, taskRuns)
  }

  private removeFromMemory(id: string): void {
    const run = this.runs.get(id)
    if (!run) return
    this.runs.delete(id)
    const taskRuns = this.runsByTask.get(run.taskId)
    taskRuns?.delete(run.dueAt)
    if (taskRuns?.size === 0) this.runsByTask.delete(run.taskId)
  }

  private persistBestEffort(): void {
    void this.persist().catch(() => undefined)
  }

  private persist(): Promise<void> {
    const snapshot: RoutineSkipStoreFile = { version: 1, runs: this.list() }
    const write = this.persistChain.then(() => this.storage.write(STORE_PATH, snapshot))
    this.persistChain = write.catch((error) => {
      Logger.error('Skipped-run store could not be written:', error)
    })
    return write
  }
}
