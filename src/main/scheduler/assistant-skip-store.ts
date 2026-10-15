import { Logger } from '../system/logger'
import type { StorageEngine } from '../storage/storage-engine'
import { skippedAssistantRunId, type SkippedRun } from '../../lib/types'

interface AssistantSkipStoreFile {
  version: 1
  runs: SkippedRun[]
}

const STORE_PATH = 'scheduler/skipped-runs.json'
const EMPTY_DUE_TIMES: ReadonlySet<number> = new Set<number>()

function isValidRun(value: unknown): value is SkippedRun {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    typeof record.taskId === 'string' &&
    typeof record.assistantId === 'string' &&
    typeof record.dueAt === 'number' &&
    record.id === skippedAssistantRunId(record.taskId, record.dueAt)
  )
}

/** Durable, idempotent ledger for user-skipped schedule slots. */
export class AssistantSkipStore {
  private readonly runs = new Map<string, SkippedRun>()
  private readonly runsByTask = new Map<string, Set<number>>()
  private persistChain: Promise<void> = Promise.resolve()

  constructor(private readonly storage: StorageEngine) {}

  async load(): Promise<void> {
    const raw = await this.storage.read<AssistantSkipStoreFile>(STORE_PATH)
    this.runs.clear()
    this.runsByTask.clear()
    if (!raw || !Array.isArray(raw.runs)) return
    for (const entry of raw.runs) {
      if (isValidRun(entry)) this.insert(entry)
    }
  }

  list(): SkippedRun[] {
    return [...this.runs.values()].sort((a, b) => a.dueAt - b.dueAt)
  }

  listForAssistant(assistantId: string): SkippedRun[] {
    return this.list().filter((run) => run.assistantId === assistantId)
  }

  has(taskId: string, dueAt: number): boolean {
    return this.runs.has(skippedAssistantRunId(taskId, dueAt))
  }

  timesForTask(taskId: string): ReadonlySet<number> {
    return this.runsByTask.get(taskId) ?? EMPTY_DUE_TIMES
  }

  async recordMany(inputs: readonly Omit<SkippedRun, 'id'>[]): Promise<SkippedRun[]> {
    const inserted: SkippedRun[] = []
    for (const input of inputs) {
      const run: SkippedRun = {
        ...input,
        id: skippedAssistantRunId(input.taskId, input.dueAt)
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

  removeForAssistant(assistantId: string, taskIds: readonly string[]): number {
    const tasks = new Set(taskIds)
    let removed = 0
    for (const [id, run] of this.runs) {
      if (run.assistantId !== assistantId && !tasks.has(run.taskId)) continue
      this.removeFromMemory(id)
      removed += 1
    }
    if (removed > 0) this.persistBestEffort()
    return removed
  }

  prune(shouldRemove: (run: SkippedRun) => boolean): number {
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

  private insert(run: SkippedRun): void {
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
    const snapshot: AssistantSkipStoreFile = { version: 1, runs: this.list() }
    const write = this.persistChain.then(() => this.storage.write(STORE_PATH, snapshot))
    this.persistChain = write.catch((error) => {
      Logger.error('Skipped-run store could not be written:', error)
    })
    return write
  }
}
