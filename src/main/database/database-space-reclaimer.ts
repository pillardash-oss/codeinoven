import { Logger } from '../system/logger'

/** Pages handed back to the operating system per incremental vacuum call. */
const PAGES_PER_CHUNK = 256
/** Quiet window after the last deletion before any reclaiming starts. */
const SETTLE_MS = 10_000
/** Pause between chunks, so a chunk never lands back-to-back with the next. */
const CHUNK_GAP_MS = 400
/**
 * How many chunks one sweep may run. A 4 KiB page bound puts the ceiling at
 * roughly 128 MiB of reclaimed file space per sweep; anything still free after
 * that is reclaimed by the next one instead of holding a write lock for minutes.
 */
const MAX_CHUNKS = 128

export interface DatabaseSpaceReclaimerDeps {
  /** Bounded, off-main incremental vacuum. Never a full VACUUM. */
  incrementalVacuum(pages: number): Promise<{ ok: boolean; freedPages?: number; error?: string }>
  /** True while another deletion is queued or running; the sweep then waits. */
  isBusy(): boolean
}

/**
 * Reclaim the pages a project deletion freed, in small bounded steps.
 *
 * This replaces the full `VACUUM` that used to run straight after a deletion.
 * A full VACUUM rewrites the entire database file under one exclusive write
 * lock, and the main process also holds its own synchronous connection: every
 * `run()` on the main thread stalled behind that lock for seconds, which froze
 * the whole app (one incident logged a main-thread insert waiting 7.9 s). The
 * same space comes back through `PRAGMA incremental_vacuum`, a few hundred pages
 * at a time, with the sweep pausing whenever a deletion is in flight and
 * stopping for good once there is nothing left to hand back.
 */
export class DatabaseSpaceReclaimer {
  private settleTimer: ReturnType<typeof setTimeout> | null = null
  private chunkTimer: ReturnType<typeof setTimeout> | null = null
  private chunks = 0
  private reclaimed = 0
  private stopped = false

  constructor(private readonly deps: DatabaseSpaceReclaimerDeps) {}

  /** A deletion finished and left free pages behind. Debounced, so a run of deletes is one sweep. */
  noteFreedSpace(): void {
    if (this.stopped) return
    this.clearTimers()
    this.chunks = 0
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null
      void this.runChunk()
    }, SETTLE_MS)
    this.settleTimer.unref?.()
  }

  /** Stop all timers (app shutdown). Nothing scheduled survives this call. */
  stop(): void {
    this.stopped = true
    this.clearTimers()
  }

  private clearTimers(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer)
    if (this.chunkTimer) clearTimeout(this.chunkTimer)
    this.settleTimer = null
    this.chunkTimer = null
  }

  private async runChunk(): Promise<void> {
    if (this.stopped) return
    // A queued deletion always wins: the sweep resumes after it, never during.
    if (this.deps.isBusy()) {
      this.noteFreedSpace()
      return
    }
    this.chunks += 1
    const result = await this.deps.incrementalVacuum(PAGES_PER_CHUNK)
    if (!result.ok) {
      Logger.dev('Reclaiming space after a deletion stopped', { error: result.error ?? '' })
      return
    }
    this.reclaimed += result.freedPages ?? 0
    // No pages handed back means the free list is empty: the sweep is done.
    if ((result.freedPages ?? 0) === 0 || this.chunks >= MAX_CHUNKS) {
      if (this.reclaimed > 0) {
        Logger.info(`Reclaimed ${this.reclaimed} database pages after project deletion`)
      }
      this.reclaimed = 0
      return
    }
    this.chunkTimer = setTimeout(() => {
      this.chunkTimer = null
      void this.runChunk()
    }, CHUNK_GAP_MS)
    this.chunkTimer.unref?.()
  }
}
