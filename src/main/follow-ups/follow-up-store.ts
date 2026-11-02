import { randomUUID } from 'node:crypto'
import {
  FOLLOW_UP_MAX_PENDING_PER_THREAD,
  type FollowUp,
  type FollowUpRequest
} from '../../lib/follow-up'
import { Logger } from '../system/logger'
import type { StorageEngine } from '../storage/storage-engine'

/** Persisted shape: one versioned array so the file stays inspectable. */
interface FollowUpStoreFile {
  version: 1
  followUps: FollowUp[]
}

/** Pending wakes live beside the scheduler's own records, in the app config root. */
const STORE_PATH = 'scheduler/follow-ups.json'

function isFollowUp(value: unknown): value is FollowUp {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record['id'] === 'string' &&
    typeof record['projectId'] === 'string' &&
    typeof record['threadId'] === 'string' &&
    typeof record['dueAt'] === 'number' &&
    Number.isFinite(record['dueAt']) &&
    typeof record['createdAt'] === 'number' &&
    typeof record['prompt'] === 'string' &&
    typeof record['note'] === 'string' &&
    typeof record['deferred'] === 'number'
  )
}

/**
 * FollowUpStore   the durable half of an agent-scheduled wake.
 *
 * The scheduler keeps its pending wakes in a versioned JSON file rather than a
 * table for the same reason the missed-run store does: the records are few, they
 * are read on a clock, and a file survives a crash between an agent's decision
 * and the wake without needing a migration. Writes are serialized through one
 * chain so two turns scheduling at once cannot interleave and corrupt it.
 */
export class FollowUpStore {
  private followUps = new Map<string, FollowUp>()
  private loaded = false
  private persistChain: Promise<void> = Promise.resolve()

  constructor(private readonly storage: StorageEngine) {}

  async load(): Promise<void> {
    const raw = await this.storage.read<FollowUpStoreFile>(STORE_PATH)
    this.followUps.clear()
    if (raw && Array.isArray(raw.followUps)) {
      for (const entry of raw.followUps) {
        if (isFollowUp(entry)) this.followUps.set(entry.id, entry)
      }
    }
    this.loaded = true
  }

  /** Every pending wake, soonest first. */
  list(): FollowUp[] {
    return [...this.followUps.values()].sort((a, b) => a.dueAt - b.dueAt)
  }

  /** The wakes armed on one thread, soonest first. */
  listForThread(threadId: string): FollowUp[] {
    return this.list().filter((followUp) => followUp.threadId === threadId)
  }

  get(id: string): FollowUp | null {
    return this.followUps.get(id) ?? null
  }

  hasAnyPending(): boolean {
    return this.followUps.size > 0
  }

  /** When the next wake is due, or null when nothing is armed. */
  nextDueAt(): number | null {
    let soonest: number | null = null
    for (const followUp of this.followUps.values()) {
      if (soonest === null || followUp.dueAt < soonest) soonest = followUp.dueAt
    }
    return soonest
  }

  /**
   * Arm one wake. A thread holds a bounded number of them, because a loop that
   * schedules on every pass would otherwise pile up wakes nobody asked for.
   */
  add(input: FollowUpRequest & { id?: string }): FollowUp {
    const pending = this.listForThread(input.threadId)
    if (pending.length >= FOLLOW_UP_MAX_PENDING_PER_THREAD) {
      throw new Error(
        `This thread already has ${pending.length} scheduled follow-ups, which is the limit. Cancel one with cancel_followup, or let the earliest fire.`
      )
    }
    const followUp: FollowUp = {
      id: input.id ?? randomUUID(),
      projectId: input.projectId,
      threadId: input.threadId,
      dueAt: input.dueAt,
      createdAt: Date.now(),
      prompt: input.prompt,
      note: input.note,
      deferred: 0
    }
    this.followUps.set(followUp.id, followUp)
    this.persist()
    return followUp
  }

  /** Move one wake later after it came due on a busy thread. */
  defer(id: string, dueAt: number): FollowUp | null {
    const existing = this.followUps.get(id)
    if (!existing) return null
    const deferred: FollowUp = { ...existing, dueAt, deferred: existing.deferred + 1 }
    this.followUps.set(id, deferred)
    this.persist()
    return deferred
  }

  /** Remove one wake. Returns whether it existed. */
  remove(id: string): boolean {
    if (!this.followUps.delete(id)) return false
    this.persist()
    return true
  }

  /** Remove every wake armed on a thread, which is what deleting it does. */
  removeForThread(threadId: string): number {
    let removed = 0
    for (const [id, followUp] of this.followUps) {
      if (followUp.threadId !== threadId) continue
      this.followUps.delete(id)
      removed += 1
    }
    if (removed > 0) this.persist()
    return removed
  }

  /** Remove every wake of a project whose threads are gone. */
  removeForProject(projectId: string): number {
    let removed = 0
    for (const [id, followUp] of this.followUps) {
      if (followUp.projectId !== projectId) continue
      this.followUps.delete(id)
      removed += 1
    }
    if (removed > 0) this.persist()
    return removed
  }

  isLoaded(): boolean {
    return this.loaded
  }

  /** Await the pending write chain (used by shutdown and tests). */
  async flush(): Promise<void> {
    await this.persistChain
  }

  private persist(): void {
    const snapshot: FollowUpStoreFile = { version: 1, followUps: [...this.followUps.values()] }
    this.persistChain = this.persistChain
      .then(() => this.storage.write(STORE_PATH, snapshot))
      .catch((error) => {
        Logger.error('Follow-up store could not be written:', error)
      })
  }
}
