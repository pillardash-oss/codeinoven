import { dirname, join } from 'path'
import { ensureDir, getConfigRoot, readJson, writeJson } from '../../../lib/utils'
import { Logger } from '../../system/logger'

/**
 * Verdict for one auxiliary candidate (`providerId/modelId`): the earliest
 * moment it may be probed again, and the provider text that retired it.
 *
 * Deliberately structural rather than a class, because the same record is held
 * in memory, written to disk, and handed to the attempt ledger.
 */
export interface AuxiliaryCandidateVerdict {
  /** Epoch ms this candidate may be probed again. */
  resetAt: number
  /** Why it was retired, kept for the attempt ledger and diagnostics. */
  reason: string
}

/**
 * The verdict memory a one-shot run reads and writes.
 *
 * A plain `Map` satisfies this, so a run without durable verdicts keeps working
 * unchanged; {@link AuxiliaryVerdictStore} adds the disk round-trip behind the
 * same three calls.
 */
export interface AuxiliaryVerdictBlockMap {
  get(key: string): AuxiliaryCandidateVerdict | undefined
  set(key: string, verdict: AuxiliaryCandidateVerdict): void
  delete(key: string): boolean
  /**
   * Resolve once restored verdicts are in the map. Absent for a plain map that
   * was never persisted, so callers must treat a missing `ready` as "loaded".
   */
  ready?(): Promise<void>
}

/** Where verdicts are kept under the config root, next to other launch-durable state. */
export const AUXILIARY_VERDICT_FILE = 'auxiliary/verdicts.json'

/**
 * Most candidates one file may remember.
 *
 * Every candidate a provider ever rejected would otherwise be kept forever, and
 * the file is read on the probe path of every launch. The cap is far above the
 * handful of provider/model pairs one account can offer, drops the verdicts that
 * expire soonest first, and therefore keeps the long-lived ones that matter
 * (a withdrawn model, a region lock) while bounding both file and memory.
 */
const MAX_VERDICT_ENTRIES = 200

/**
 * On-disk shape of the verdict file.
 *
 * Versioned like every other durable app record (`cio-cleanup/state.json`): a
 * version this build does not know is ignored rather than trusted, because a
 * verdict only ever saves work and misreading one could hide a working model.
 */
interface PersistedAuxiliaryVerdicts {
  version: 1
  blocks: Record<string, AuxiliaryCandidateVerdict>
}

export interface AuxiliaryVerdictStoreOptions {
  /** Absolute path of the verdict file. Defaults under the config root. */
  filePath?: string
  /** Most candidates to remember; defaults to {@link MAX_VERDICT_ENTRIES}. */
  maxEntries?: number
}

/**
 * Auxiliary candidate verdicts that survive an app restart.
 *
 * The driver used to remember rejections in a plain in-memory map, so quitting
 * the app erased them: every launch re-probed the same region-locked and
 * withdrawn models serially, at roughly ten seconds of harness process each,
 * before an auxiliary job could run. Restoring the map from disk means a
 * provider's own rejection is paid once instead of once per launch.
 *
 * The file is only ever an optimisation: every failure here is swallowed and
 * logged, because losing the memory costs one extra probe while throwing on the
 * probe path would cost the auxiliary job itself.
 */
export class AuxiliaryVerdictStore implements AuxiliaryVerdictBlockMap {
  private readonly verdicts = new Map<string, AuxiliaryCandidateVerdict>()
  private readonly filePath: string
  private readonly maxEntries: number
  /** The one restore attempt; repeated reads must not re-parse the file. */
  private loadPromise: Promise<void> | null = null
  /** Serializes writes so two runs can never interleave partial file states. */
  private writeChain: Promise<void> = Promise.resolve()
  /** Whether a write is already queued, so a burst of verdicts costs one write. */
  private writeQueued = false

  constructor(options: AuxiliaryVerdictStoreOptions = {}) {
    this.filePath = options.filePath ?? join(getConfigRoot(), AUXILIARY_VERDICT_FILE)
    this.maxEntries = Math.max(1, options.maxEntries ?? MAX_VERDICT_ENTRIES)
  }

  /**
   * The live verdicts, read-only.
   *
   * Touching it also starts the restore in the background, so a synchronous
   * caller (a route check that asks whether a whole auxiliary route is closed)
   * sees restored verdicts on its next call without waiting on the disk.
   */
  get blocks(): ReadonlyMap<string, AuxiliaryCandidateVerdict> {
    void this.ready()
    return this.verdicts
  }

  /** Restore verdicts once. Never throws: a lost file only costs one re-probe. */
  async ready(): Promise<void> {
    this.loadPromise ??= this.restore()
    await this.loadPromise
  }

  get(key: string): AuxiliaryCandidateVerdict | undefined {
    return this.verdicts.get(key)
  }

  /** Remember one verdict, then persist in the background. */
  set(key: string, verdict: AuxiliaryCandidateVerdict): void {
    this.verdicts.set(key, { resetAt: verdict.resetAt, reason: verdict.reason })
    this.schedulePersist()
  }

  /** Forget one verdict, then persist in the background. */
  delete(key: string): boolean {
    const removed = this.verdicts.delete(key)
    if (removed) this.schedulePersist()
    return removed
  }

  /**
   * Read the persisted verdicts into memory.
   *
   * Verdicts that expired while the app was closed are dropped here rather than
   * kept for the probe loop to delete one by one, so a stale file can never make
   * a model look retired after its window reopened.
   */
  private async restore(): Promise<void> {
    try {
      const persisted = await readJson<PersistedAuxiliaryVerdicts>(this.filePath)
      if (persisted?.version !== 1 || typeof persisted.blocks !== 'object') return
      const now = Date.now()
      for (const [key, verdict] of Object.entries(persisted.blocks ?? {})) {
        if (typeof verdict?.resetAt !== 'number' || !Number.isFinite(verdict.resetAt)) continue
        if (!(verdict.resetAt > now)) continue
        this.verdicts.set(key, {
          resetAt: verdict.resetAt,
          reason: typeof verdict.reason === 'string' ? verdict.reason : ''
        })
      }
      const restored = this.verdicts.size
      const pruned = this.prune(now)
      if (pruned > 0) this.schedulePersist()
      if (restored > 0) {
        Logger.info('Auxiliary candidate verdicts restored', {
          file: this.filePath,
          restored,
          pruned
        })
      }
    } catch (error) {
      // A corrupt or unreadable file is replaced by the next write; probing
      // everything once is the safe reading of "unknown".
      Logger.dev('Auxiliary candidate verdicts could not be restored:', error)
    }
  }

  /**
   * Queue one serialized write without awaiting it.
   *
   * The probe path must never wait on the disk: the verdict is already in memory
   * and does its job for this run, and the file only has to be right for the
   * next launch.
   */
  private schedulePersist(): void {
    if (this.writeQueued) return
    this.writeQueued = true
    this.writeChain = this.writeChain
      .then(async () => {
        // Clear the flag before writing so a verdict remembered during the write
        // queues another one instead of being lost with the file this write wrote.
        this.writeQueued = false
        await this.persist()
      })
      .catch((error: unknown) => {
        // One failed write must not poison the queue: without this the chain
        // stays rejected and no later verdict ever reaches the disk.
        this.writeQueued = false
        Logger.dev('Auxiliary candidate verdict write queue recovered:', error)
      })
  }

  /** Write the current verdicts, bounded and already pruned of expired entries. */
  private async persist(): Promise<void> {
    try {
      this.prune(Date.now())
      const blocks: Record<string, AuxiliaryCandidateVerdict> = {}
      for (const [key, verdict] of this.verdicts) {
        blocks[key] = { resetAt: verdict.resetAt, reason: verdict.reason }
      }
      const payload: PersistedAuxiliaryVerdicts = { version: 1, blocks }
      await ensureDir(dirname(this.filePath))
      await writeJson(this.filePath, payload)
    } catch (error) {
      // Losing a verdict costs one probe next launch; it must never cost the run.
      Logger.dev('Auxiliary candidate verdicts could not be written:', error)
    }
  }

  /**
   * Drop expired verdicts and cap the map, returning how many were removed.
   *
   * Applied to the map itself rather than only the written snapshot, so a long
   * session cannot accumulate verdicts the file is no longer allowed to hold.
   */
  private prune(nowMs: number): number {
    let removed = 0
    for (const [key, verdict] of this.verdicts) {
      if (!(verdict.resetAt > nowMs)) {
        this.verdicts.delete(key)
        removed += 1
      }
    }
    if (this.verdicts.size > this.maxEntries) {
      const bySoonestExpiry = [...this.verdicts.entries()].sort(
        (left, right) => left[1].resetAt - right[1].resetAt
      )
      for (const [key] of bySoonestExpiry.slice(0, this.verdicts.size - this.maxEntries)) {
        this.verdicts.delete(key)
        removed += 1
      }
    }
    return removed
  }
}
