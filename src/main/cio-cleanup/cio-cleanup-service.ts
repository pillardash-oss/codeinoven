import { Logger } from '../system/logger'
import type { StorageEngine } from '../storage/storage-engine'
import type { Database } from '../database/database'
import type { ScopeBoard } from '../../lib/types'
import { ASSISTANT_SPACE_ID, GLOBAL_BROWSER_PROJECT_ID, INBOX_PROJECT_ID } from '../../lib/types'
import {
  DEFAULT_CIO_CLEANUP_RETENTION_DAYS,
  MAX_CIO_CLEANUP_RETENTION_DAYS,
  MIN_CIO_CLEANUP_RETENTION_DAYS
} from '../../lib/types/settings'
import type {
  CioCleanupExclusion,
  CioCleanupExclusionToggleInput,
  CioCleanupExclusionToggleResult,
  CioCleanupMount,
  CioCleanupOrigin,
  CioCleanupProgress,
  CioCleanupRunSummary,
  CioCleanupState
} from '../../lib/types/cio-cleanup'
import {
  cioCleanupProtectedPaths,
  cioScratchRelativePath,
  findCioCleanupExclusion
} from '../../lib/cio-cleanup'
import { currentWorkRoots } from '../design/work-roots-state'
import { instanceRegistry } from '../system/instance-registry'
import { ProjectRepo } from '../database/repositories/project-repo'
import { CioCleanupRepo } from '../database/repositories/cio-cleanup-repo'
import { listCioCleanupTargets, type CioCleanupScopeResolver } from './cio-cleanup-targets'
import { sweepCioScratchRoot } from './cio-cleanup-sweeper'

/** How often the service checks whether a day has passed since the last sweep. */
const TICK_MS = 15 * 60_000

/** One cleanup per day. */
const INTERVAL_MS = 24 * 60 * 60_000

/**
 * Delay before the first scheduled check after launch, so the sweep never
 * competes with the work a fresh start is already doing.
 */
const START_DELAY_MS = 2 * 60_000

/**
 * Most entries one pass removes. A machine whose scratch grew for months could
 * hold hundreds of thousands of stale files; a pass stops here and the rest
 * waits for the next one, so a cleanup never turns into a long disk storm.
 */
const MAX_ENTRIES_PER_RUN = 20_000

/** Shortest gap between two progress deliveries, so IPC is never flooded. */
const PROGRESS_THROTTLE_MS = 250

/** Most removal records one progress payload carries. Counts stay exact. */
const MAX_PROGRESS_RECORDS = 200

/** Where the last run is remembered, so a day is measured across restarts. */
const STATE_FILE = 'cio-cleanup/state.json'

interface PersistedCleanupState {
  version: 1
  lastRunAt: number | null
  lastRun: CioCleanupRunSummary | null
}

/** One run in flight: its identity, its counters, and how to stop it. */
interface LiveRun {
  runId: string
  origin: CioCleanupOrigin
  startedAt: number
  cancelled: boolean
  /** Set once the run settles, so the last payload carries its real outcome. */
  finalPhase?: 'completed' | 'cancelled' | 'failed'
  currentTarget: string | null
  targetsTotal: number
  targetsDone: number
  entriesRemoved: number
  bytesRemoved: number
  removed: CioCleanupProgress['removed']
  lastPublishedAt: number
}

export interface CioCleanupServiceDeps {
  database: Database
  storage: StorageEngine
  boards: { getBoard(projectId: string): ScopeBoard }
  scopeRoots: CioCleanupScopeResolver
  /** Leave a scope alone while an agent works in it. */
  hasActiveProcesses?: (projectId: string, scopeBucketId: string) => Promise<boolean>
  /** Deliver one live stage of a manual run to every window. */
  onProgress?: (progress: CioCleanupProgress) => void
  /** Tell every window the state moved (a run finished, a path was excluded). */
  onStateChanged?: (state: CioCleanupState) => void
}

/** One run's identity, and whether this call started it or surfaced a live one. */
export interface CioCleanupRunStart {
  runId: string
  started: boolean
}

/**
 * CIO Cleanup   the daily sweep of stale scratch folders.
 *
 * Every workspace the app can stage scratch in keeps it in a `.cio` folder, and
 * content that nobody touched for the configured number of days is removed by
 * this service. It runs once a day, in small batches, and only on the elected
 * owner instance, so two windows never sweep the same disk twice.
 *
 * A scheduled run is silent by design: it publishes state so the settings page
 * can report what it did, but never a progress stream, because it must not open
 * a dockable panel the user did not ask for. A run the user starts reports live
 * progress, can be cancelled, and is the only one that appears in the dock.
 */
export class CioCleanupService {
  private timer: ReturnType<typeof setInterval> | null = null
  private startTimer: ReturnType<typeof setTimeout> | null = null
  private run: LiveRun | null = null
  private lastRunAt: number | null = null
  private lastRun: CioCleanupRunSummary | null = null

  constructor(private deps: CioCleanupServiceDeps) {}

  /** Load the last run, then arm the daily check. Never throws at boot. */
  async start(): Promise<void> {
    try {
      const persisted = await this.deps.storage.read<PersistedCleanupState>(STATE_FILE)
      if (persisted && persisted.version === 1) {
        this.lastRunAt = typeof persisted.lastRunAt === 'number' ? persisted.lastRunAt : null
        this.lastRun = persisted.lastRun ?? null
      }
    } catch (error) {
      Logger.dev('CIO Cleanup state could not be read:', error)
    }
    this.arm()
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.startTimer !== null) {
      clearTimeout(this.startTimer)
      this.startTimer = null
    }
  }

  /** Re-report the state after the retention setting changed. */
  async refresh(): Promise<void> {
    await this.publishState()
  }

  /** Everything the settings page and the dock need to describe the feature. */
  async state(): Promise<CioCleanupState> {
    const config = await this.deps.storage.getConfig()
    return {
      retentionDays: clampRetentionDays(config.cioCleanupRetentionDays),
      nextRunAt: this.nextRunAt(),
      running: this.run !== null,
      lastRun: this.lastRun,
      exclusions: await new CioCleanupRepo(this.deps.database).listViaWorker()
    }
  }

  /**
   * Start a cleanup the user asked for, or surface the one already running so
   * its progress reaches the dock. A manual trigger never starts a second sweep:
   * two passes over the same disk would fight over the same files.
   */
  async runManually(): Promise<CioCleanupRunStart> {
    const live = this.run
    if (live) {
      live.origin = 'manual'
      live.lastPublishedAt = 0
      this.publishProgress(true)
      return { runId: live.runId, started: false }
    }
    const runId = `cio-cleanup-${Date.now().toString(36)}`
    void this.execute(runId, 'manual')
    return { runId, started: true }
  }

  /** Ask the run in flight to stop at its next batch. */
  cancel(runId: string): void {
    const live = this.run
    if (!live || live.runId !== runId) return
    live.cancelled = true
  }

  /**
   * Exclude a path inside a workspace's `.cio` folder, or include it again.
   *
   * The path arrives workspace-relative (as the file tree shows it), so it is
   * resolved to its `.cio`-relative form here: one stored spelling, and the menu
   * can undo exactly the exclusion it shows.
   */
  async toggleExclusion(
    input: CioCleanupExclusionToggleInput
  ): Promise<CioCleanupExclusionToggleResult> {
    const relativePath = cioScratchRelativePath(input.path)
    if (relativePath === null) throw new TypeError('Path is not inside the .cio folder')
    if (relativePath === '') throw new TypeError('The .cio folder itself cannot be excluded')
    const mount: CioCleanupMount = {
      projectId: input.projectId,
      scopeBucketId: input.scopeBucketId,
      ...(input.threadId ? { threadId: input.threadId } : {})
    }
    await this.requireKnownMount(mount)

    const repo = new CioCleanupRepo(this.deps.database)
    const covering = findCioCleanupExclusion(await repo.listViaWorker(), mount, relativePath)
    if (covering) {
      repo.remove({
        projectId: covering.projectId,
        scopeBucketId: covering.scopeBucketId,
        ...(covering.threadId ? { threadId: covering.threadId } : {}),
        path: covering.path
      })
    } else {
      repo.add({ ...mount, path: relativePath, createdAt: Date.now() })
    }

    const state = await this.state()
    this.deps.onStateChanged?.(state)
    Logger.info('CIO Cleanup exclusion changed', {
      projectId: mount.projectId,
      scopeBucketId: mount.scopeBucketId,
      threadId: mount.threadId ?? '',
      path: relativePath,
      excluded: !covering
    })
    return { excluded: !covering, exclusions: state.exclusions }
  }

  /** Timestamp of the next scheduled sweep, or null before the first one. */
  private nextRunAt(): number | null {
    return this.lastRunAt === null ? null : this.lastRunAt + INTERVAL_MS
  }

  private arm(): void {
    this.startTimer = setTimeout(() => {
      this.startTimer = null
      void this.tick('launch')
    }, START_DELAY_MS)
    this.timer = setInterval(() => void this.tick('interval'), TICK_MS)
  }

  private async tick(reason: 'launch' | 'interval'): Promise<void> {
    try {
      // A sweep is shared work over shared folders: only the elected owner runs
      // the scheduled pass, so two live instances never delete the same disk
      // twice. A manual run is exempt   the user asked for it in this window.
      if (!instanceRegistry.isIncumbentInstance()) return
      if (this.run) return
      const lastRunAt = this.lastRunAt
      if (lastRunAt !== null && Date.now() - lastRunAt < INTERVAL_MS) return
      Logger.info('CIO Cleanup sweep due', { reason })
      void this.execute(`cio-cleanup-${Date.now().toString(36)}`, 'scheduled')
    } catch (error) {
      Logger.error('CIO Cleanup scheduled check failed (non-fatal):', error)
    }
  }

  private async execute(runId: string, origin: CioCleanupOrigin): Promise<void> {
    const live: LiveRun = {
      runId,
      origin,
      startedAt: Date.now(),
      cancelled: false,
      currentTarget: null,
      targetsTotal: 0,
      targetsDone: 0,
      entriesRemoved: 0,
      bytesRemoved: 0,
      removed: [],
      lastPublishedAt: 0
    }
    this.run = live
    this.publishProgress(true)

    let phase: CioCleanupProgress['phase'] = 'completed'
    let error: string | undefined
    try {
      const retentionDays = clampRetentionDays(
        (await this.deps.storage.getConfig()).cioCleanupRetentionDays
      )
      const cutoff = Date.now() - retentionDays * 24 * 60 * 60_000
      // Read once per run: the work roots are a setting, and one pass has to
      // judge every workspace by the same list rather than half of it by the
      // value before a settings save and half by the value after.
      const protectedPaths = cioCleanupProtectedPaths(currentWorkRoots())
      const exclusions = await this.pruneAndListExclusions()
      const targets = await listCioCleanupTargets({
        database: this.deps.database,
        boards: this.deps.boards,
        scopeRoots: this.deps.scopeRoots,
        ...(this.deps.hasActiveProcesses
          ? { hasActiveProcesses: this.deps.hasActiveProcesses }
          : {})
      })
      live.targetsTotal = targets.length
      this.publishProgress(true)

      for (const target of targets) {
        if (live.cancelled) break
        live.currentTarget = target.label
        this.publishProgress(true)
        const result = await sweepCioScratchRoot({
          scratchRoot: target.scratchRoot,
          target,
          cutoff,
          exclusions,
          protectedPaths,
          control: {
            isCancelled: () => live.cancelled,
            onScanned: () => this.publishProgress()
          }
        })
        live.entriesRemoved += result.entriesRemoved
        live.bytesRemoved += result.bytesRemoved
        if (result.removed.length > 0) {
          live.removed = [...live.removed, ...result.removed].slice(-MAX_PROGRESS_RECORDS)
        }
        live.targetsDone += 1
        this.publishProgress(true)
        if (live.entriesRemoved >= MAX_ENTRIES_PER_RUN) {
          Logger.info('CIO Cleanup pass reached its entry budget; the rest waits for the next pass')
          break
        }
      }
      if (live.cancelled) phase = 'cancelled'
    } catch (thrown) {
      phase = 'failed'
      error = thrown instanceof Error ? thrown.message : String(thrown)
      Logger.error('CIO Cleanup run failed', thrown)
    }

    const summary: CioCleanupRunSummary = {
      runId,
      origin: live.origin,
      phase,
      startedAt: live.startedAt,
      finishedAt: Date.now(),
      targetsSwept: live.targetsDone,
      entriesRemoved: live.entriesRemoved,
      bytesRemoved: live.bytesRemoved,
      ...(error ? { error } : {})
    }
    this.lastRun = summary
    live.currentTarget = null
    live.finalPhase = phase
    this.publishProgress(true)
    // The run stays marked in flight until its marker is on disk, so a second
    // trigger can never start while the first run is still recording itself.
    await this.persist(summary)
    this.run = null
    await this.publishState()
    Logger.info('CIO Cleanup run finished', {
      runId,
      origin: live.origin,
      phase,
      targets: live.targetsDone,
      removed: live.entriesRemoved,
      bytes: live.bytesRemoved
    })
  }

  /** Drop exclusions whose project is gone, then read the survivors. */
  private async pruneAndListExclusions(): Promise<CioCleanupExclusion[]> {
    const repo = new CioCleanupRepo(this.deps.database)
    const exclusions = await repo.listViaWorker()
    if (exclusions.length === 0) return exclusions
    const known = new Set(await new ProjectRepo(this.deps.database).listIdsViaWorker())
    known.add(INBOX_PROJECT_ID)
    known.add(ASSISTANT_SPACE_ID)
    known.add(GLOBAL_BROWSER_PROJECT_ID)
    const unknownProjects = new Set(
      exclusions.filter((exclusion) => !known.has(exclusion.projectId)).map((e) => e.projectId)
    )
    for (const projectId of unknownProjects) repo.removeForProject(projectId)
    return unknownProjects.size === 0
      ? exclusions
      : exclusions.filter((exclusion) => !unknownProjects.has(exclusion.projectId))
  }

  private async persist(summary: CioCleanupRunSummary): Promise<void> {
    this.lastRunAt = summary.finishedAt
    const payload: PersistedCleanupState = {
      version: 1,
      lastRunAt: this.lastRunAt,
      lastRun: summary
    }
    try {
      await this.deps.storage.write(STATE_FILE, payload)
    } catch (thrown) {
      // Losing the marker costs one extra sweep, never the app's boot.
      Logger.error('CIO Cleanup state could not be written:', thrown)
    }
  }

  private publishProgress(force = false): void {
    const live = this.run
    if (!live) return
    if (live.origin !== 'manual') return
    const now = Date.now()
    if (!force && now - live.lastPublishedAt < PROGRESS_THROTTLE_MS) return
    live.lastPublishedAt = now
    this.deps.onProgress?.({
      runId: live.runId,
      origin: live.origin,
      phase:
        live.finalPhase ??
        (live.cancelled ? 'cancelled' : live.targetsTotal === 0 ? 'preparing' : 'sweeping'),
      currentTarget: live.currentTarget,
      targetsTotal: live.targetsTotal,
      targetsDone: live.targetsDone,
      entriesRemoved: live.entriesRemoved,
      bytesRemoved: live.bytesRemoved,
      removed: live.removed,
      startedAt: live.startedAt
    })
  }

  private async publishState(): Promise<void> {
    try {
      this.deps.onStateChanged?.(await this.state())
    } catch (thrown) {
      Logger.dev('CIO Cleanup state could not be published:', thrown)
    }
  }

  /** Validate the mount an exclusion names: a real project, or one of the app spaces. */
  private async requireKnownMount(mount: CioCleanupMount): Promise<void> {
    if (!mount.scopeBucketId) throw new TypeError('Scope is required for a CIO Cleanup exclusion')
    if (
      mount.projectId === INBOX_PROJECT_ID ||
      mount.projectId === ASSISTANT_SPACE_ID ||
      mount.projectId === GLOBAL_BROWSER_PROJECT_ID
    ) {
      return
    }
    const project = await new ProjectRepo(this.deps.database).getViaWorker(mount.projectId)
    if (!project) throw new TypeError(`Project not found: ${mount.projectId}`)
  }
}

/** The retention the sweep uses, coerced into the allowed range. */
function clampRetentionDays(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_CIO_CLEANUP_RETENTION_DAYS
  }
  return Math.min(
    MAX_CIO_CLEANUP_RETENTION_DAYS,
    Math.max(MIN_CIO_CLEANUP_RETENTION_DAYS, Math.round(value))
  )
}
