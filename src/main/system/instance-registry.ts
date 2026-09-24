import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  watch,
  writeFileSync,
  type FSWatcher
} from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent } from '../../lib/types'
import { getConfigRoot } from '../../lib/utils'

const HEARTBEAT_MS = 30_000
const CHECKPOINT_EVENT_STALE_MS = 120_000
/**
 * An entry whose heartbeat is older than this is dead regardless of what
 * `process.kill(pid, 0)` says. PIDs get reused by unrelated processes, so a
 * stale file must never make a fresh instance believe a phantom instance is
 * still running (which would silently bypass the working-thread close gate).
 */
const HEARTBEAT_STALE_MS = HEARTBEAT_MS * 3

type CheckpointUpdatedEvent = Extract<AgentEvent, { type: 'checkpoint.updated' }>

interface CrossInstanceCheckpointEvent {
  id: string
  emittedAt: number
  event: CheckpointUpdatedEvent
}

interface InstanceEntry {
  pid: number
  startedAt: number
  lastHeartbeat: number
  /** Latest durable-state invalidation emitted by this process. */
  checkpointEvent?: CrossInstanceCheckpointEvent
}

/**
 * A filesystem registry of the CodeInOven processes currently running against
 * the same config root. Every instance writes a small PID + heartbeat file, so
 * any instance can ask "are other instances alive?" without a single-instance
 * lock. This powers the multi-instance close behaviour: when another live
 * instance exists it can keep a project's thread running, so the closing
 * instance skips destroying harness connections and just lets its window go.
 */
export class InstanceRegistry {
  private readonly dir: string
  private readonly selfEntry: InstanceEntry
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private watcher: FSWatcher | null = null
  private checkpointEventSequence = 0
  private readonly checkpointListeners = new Set<(event: CheckpointUpdatedEvent) => void>()
  private readonly liveInstanceListeners = new Set<() => void>()
  private readonly liveSetListeners = new Set<() => void>()
  /** Local consumers of this process's turn-activity announcements. */
  private readonly turnActivityListeners = new Set<() => void>()
  private readonly seenCheckpointEvents = new Set<string>()
  /** Live process ids as of the last membership check, to filter heartbeat noise. */
  private liveSetSignature = ''

  constructor() {
    this.dir = join(getConfigRoot(), 'instances')
    this.selfEntry = { pid: process.pid, startedAt: Date.now(), lastHeartbeat: Date.now() }
  }

  /** Register this process and start heartbeating so others can see it. */
  start(): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      try {
        this.pruneStaleEntries()
      } catch {
        // Pruning is hygiene only   never block startup over it.
      }
      this.writeEntry()
      // Seed the membership baseline with our own registration so the first
      // heartbeat cannot report a change that already existed at launch.
      this.liveSetSignature = this.readLiveSetSignature()
      this.startWatcher()
      this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_MS)
      if (this.heartbeatTimer.unref) this.heartbeatTimer.unref()
    } catch {
      // A failure to register must never block startup.
    }
  }

  /** Remove this process's entry and stop heartbeating (called on shutdown). */
  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    this.watcher?.close()
    this.watcher = null
    try {
      rmSync(join(this.dir, `${this.selfEntry.pid}.json`), { force: true })
    } catch {
      // Best effort   the file may already be gone.
    }
  }

  /**
   * Notify every other app process that a persisted turn checkpoint changed.
   * The event rides on this process's existing heartbeat record, so delivery
   * stays event-driven without opening a port, polling SQLite, or growing an
   * unbounded event log.
   */
  publishCheckpointUpdated(event: CheckpointUpdatedEvent): void {
    this.checkpointEventSequence += 1
    this.selfEntry.checkpointEvent = {
      id: `${this.selfEntry.pid}:${this.selfEntry.startedAt}:${this.checkpointEventSequence}`,
      emittedAt: Date.now(),
      event
    }
    try {
      this.writeEntry()
    } catch {
      // The local renderer already received the event; cross-instance delivery
      // is best effort and a later mount still hydrates from the shared DB.
    }
  }

  /** Subscribe to checkpoint invalidations emitted by another app process. */
  onCheckpointUpdated(listener: (event: CheckpointUpdatedEvent) => void): () => void {
    this.checkpointListeners.add(listener)
    return () => this.checkpointListeners.delete(listener)
  }

  /** Wake services that may need to take over after another process exits. */
  onLiveInstancesChanged(listener: () => void): () => void {
    this.liveInstanceListeners.add(listener)
    return () => this.liveInstanceListeners.delete(listener)
  }

  /**
   * Subscribe to a change in the *membership* of live instances (a process
   * appeared, exited, or went stale). Unlike {@link onLiveInstancesChanged},
   * which fires for every registry file write, this fires only when the set of
   * live process ids actually changes, so a sibling's 30s heartbeat is never
   * mistaken for activity. The check runs on our own heartbeat as well as on
   * filesystem events, because a crashed sibling is detected by heartbeat age
   * rather than by a write.
   */
  onLiveInstanceSetChanged(listener: () => void): () => void {
    this.liveSetListeners.add(listener)
    return () => this.liveSetListeners.delete(listener)
  }

  /**
   * Elect the longest-running live process as the incumbent owner of work that
   * must happen exactly once for the whole config root, whoever started it   a
   * scheduled auto-resume today.
   *
   * The election is deterministic: every instance reads the same live entries
   * and sorts them the same way, so two windows never both claim the slot. It
   * fails open, so an unreadable registry (or a process whose own entry could
   * not be written) can never silently stop that work.
   */
  isIncumbentInstance(): boolean {
    try {
      const entries = this.liveEntries()
      if (entries.length <= 1) return true
      // A registry that cannot see our own entry cannot elect anybody.
      if (!entries.some((entry) => entry.pid === this.selfEntry.pid)) return true
      entries.sort((left, right) => left.startedAt - right.startedAt || left.pid - right.pid)
      return entries[0]?.pid === this.selfEntry.pid
    } catch {
      // Registry failures must never disable shared scheduled work.
      return true
    }
  }

  /**
   * Announce that the set of turns this process is running may have changed.
   *
   * The shared `active_turns` ledger is the single source of truth for turn
   * ownership, so no turn data rides in the entry itself: this is the
   * invalidation, and a consumer that reacts to it re-reads that ledger. Local
   * consumers are told at once; siblings notice through the registry file they
   * already watch, which is the only cross-process signal this app delivers
   * without polling. Publishing on every heartbeat regardless also bounds how
   * long a missed announcement can stay stale.
   */
  publishTurnActivity(): void {
    for (const listener of this.turnActivityListeners) {
      try {
        listener()
      } catch {
        // One consumer failing must not prevent the others.
      }
    }
    try {
      this.writeEntry()
    } catch {
      // Best effort: the next heartbeat re-announces it.
    }
  }

  /** Subscribe to this process's own turn-activity announcements. */
  onTurnActivityChanged(listener: () => void): () => void {
    this.turnActivityListeners.add(listener)
    return () => this.turnActivityListeners.delete(listener)
  }

  /**
   * Whether the process that recorded a turn as in flight is still running.
   *
   * A recorded owner is trusted only when its pid is both alive and still
   * registered: a pid recycled by an unrelated process must never make an
   * orphaned turn look owned, or the thread would never be recovered. When the
   * registry itself cannot be read, pid liveness is the only evidence left, so
   * the answer stays conservative ("still alive") and the turn is left alone.
   */
  isRunOwnerAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false
    if (pid === this.selfEntry.pid) return true
    if (!this.isProcessAlive(pid)) return false
    try {
      return this.liveEntries().some((entry) => entry.pid === pid)
    } catch {
      return true
    }
  }

  /**
   * True when at least one other CodeInOven process is registered and alive.
   * Dead entries are ignored, so a crash or force quit doesn't cause a fresh
   * instance to think a phantom still exists.
   */
  hasOtherLiveInstance(): boolean {
    try {
      for (const entry of this.liveEntries()) {
        if (entry.pid === this.selfEntry.pid) continue
        return true
      }
    } catch {
      // Registry unreadable   assume we are the only instance.
    }
    return false
  }

  /**
   * Every process id currently registered and alive, this one included.
   *
   * A consumer that reacts to a sibling *disappearing* needs the whole set, not
   * a boolean: with two siblings, the survivor that notices first must still
   * adopt the departed work even though another sibling remains. `null` means
   * the registry could not be read, which is never evidence that anyone exited.
   */
  liveInstancePids(): number[] | null {
    try {
      return this.liveEntries().map((entry) => entry.pid)
    } catch {
      return null
    }
  }

  private heartbeat(): void {
    try {
      this.writeEntry()
    } finally {
      this.checkLiveInstanceSet()
    }
  }

  /** Notify membership listeners when the live process ids changed. */
  private checkLiveInstanceSet(): void {
    try {
      const signature = this.readLiveSetSignature()
      if (signature === this.liveSetSignature) return
      this.liveSetSignature = signature
      for (const listener of this.liveSetListeners) {
        try {
          listener()
        } catch {
          // One service failing to reconcile must not block the others.
        }
      }
    } catch {
      // Membership is advisory; a later heartbeat re-checks it.
    }
  }

  /** Sorted live process ids, or an empty signature when the registry is unreadable. */
  private readLiveSetSignature(): string {
    try {
      return this.liveEntries()
        .map((entry) => entry.pid)
        .sort((left, right) => left - right)
        .join(',')
    } catch {
      // A missing signature only costs one spurious membership notification.
      return ''
    }
  }

  private liveEntries(): InstanceEntry[] {
    const files = readdirSync(this.dir).filter((name) => name.endsWith('.json'))
    const entries: InstanceEntry[] = []
    for (const file of files) {
      const entry = this.readEntry(file)
      if (!entry) continue
      if (Date.now() - entry.lastHeartbeat > HEARTBEAT_STALE_MS) continue
      if (this.isProcessAlive(entry.pid)) entries.push(entry)
    }
    return entries
  }

  /** Delete entry files whose heartbeat has gone stale (crashed instances). */
  private pruneStaleEntries(): void {
    const now = Date.now()
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith('.json')) continue
      const entry = this.readEntry(file)
      if (!entry) continue
      if (now - entry.lastHeartbeat > HEARTBEAT_STALE_MS) {
        rmSync(join(this.dir, file), { force: true })
      }
    }
  }

  private writeEntry(): void {
    this.selfEntry.lastHeartbeat = Date.now()
    const payload = JSON.stringify(this.selfEntry)
    const tmpPath = join(this.dir, `.${this.selfEntry.pid}.tmp`)
    writeFileSync(tmpPath, payload, 'utf8')
    renameSync(tmpPath, join(this.dir, `${this.selfEntry.pid}.json`))
  }

  private startWatcher(): void {
    if (this.watcher) return
    try {
      this.watcher = watch(this.dir, { persistent: false }, (_eventType, filename) => {
        try {
          const file = filename?.toString()
          const files = file
            ? [file]
            : readdirSync(this.dir).filter((candidate) => candidate.endsWith('.json'))
          for (const candidate of files) {
            if (!candidate.endsWith('.json') || candidate === `${this.selfEntry.pid}.json`) continue
            const entry = this.readEntry(candidate)
            if (entry) this.consumeCheckpointEvent(entry)
          }
          for (const listener of this.liveInstanceListeners) {
            try {
              listener()
            } catch {
              // One service failing to reconcile must not block the others.
            }
          }
          this.checkLiveInstanceSet()
        } catch {
          // The directory can disappear during shutdown between notification
          // delivery and the read. A later heartbeat restores normal delivery.
        }
      })
      this.watcher.on('error', () => {
        this.watcher?.close()
        this.watcher = null
      })
    } catch {
      // Cross-instance invalidation is supplementary. The shared database
      // remains authoritative and thread mount still hydrates from it.
      this.watcher = null
    }
  }

  private consumeCheckpointEvent(entry: InstanceEntry): void {
    const update = entry.checkpointEvent
    if (
      !update ||
      typeof update.id !== 'string' ||
      typeof update.emittedAt !== 'number' ||
      this.seenCheckpointEvents.has(update.id)
    ) {
      return
    }
    if (Date.now() - update.emittedAt > CHECKPOINT_EVENT_STALE_MS) return
    if (!isCheckpointUpdatedEvent(update.event)) return

    this.seenCheckpointEvents.add(update.id)
    if (this.seenCheckpointEvents.size > 1_024) {
      const oldest = this.seenCheckpointEvents.values().next().value
      if (oldest) this.seenCheckpointEvents.delete(oldest)
    }
    for (const listener of this.checkpointListeners) {
      try {
        listener(update.event)
      } catch {
        // One consumer must not prevent another renderer invalidation.
      }
    }
  }

  private readEntry(file: string): InstanceEntry | null {
    try {
      const raw = readFileSync(join(this.dir, file), 'utf8')
      const value = JSON.parse(raw) as Partial<InstanceEntry>
      if (
        typeof value.pid !== 'number' ||
        typeof value.startedAt !== 'number' ||
        typeof value.lastHeartbeat !== 'number'
      ) {
        return null
      }
      return value as InstanceEntry
    } catch {
      return null
    }
  }

  private isProcessAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try {
      // Signal 0 probes existence without sending a signal.
      process.kill(pid, 0)
      return true
    } catch (error) {
      // ESRCH: no such process. EPERM: exists but owned by another user   alive.
      return error instanceof Error && 'code' in error && error.code === 'EPERM'
    }
  }
}

/** Singleton shared by the main process lifecycle. */
export const instanceRegistry = new InstanceRegistry()

function isCheckpointUpdatedEvent(value: unknown): value is CheckpointUpdatedEvent {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<CheckpointUpdatedEvent>
  return (
    candidate.type === 'checkpoint.updated' &&
    typeof candidate.sessionId === 'string' &&
    typeof candidate.projectId === 'string' &&
    typeof candidate.threadId === 'string' &&
    typeof candidate.checkpointId === 'string'
  )
}
