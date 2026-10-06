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
  /**
   * Stable identity of the app this process belongs to, so an explicit choice
   * of main instance survives that process restarting. Two launches of the same
   * app share it; a packaged app and a development launch do not.
   */
  instanceKey?: string
  /** Latest durable-state invalidation emitted by this process. */
  checkpointEvent?: CrossInstanceCheckpointEvent
}

/**
 * The durable designation of the instance that owns shared scheduled work.
 *
 * `instanceKey` names the app the user chose, so the choice is remembered when
 * that process restarts: a later launch of the same app reclaims the schedule
 * instead of losing it to whichever process happens to have started first.
 * `pid` only disambiguates between several live launches of that same app; it
 * is not what makes the choice durable. A record written before this field
 * existed carries no key, and is honoured as a plain live-pid preference so an
 * upgrade never ignores an existing transfer.
 */
interface OwnerOverride {
  pid: number
  instanceKey?: string
  assignedAt: number
}

/**
 * Stable identity of this installation, used to make an explicit main-instance
 * choice outlive the process that made it. The executable path is the same
 * across restarts and upgrades of one app and differs between a packaged app
 * and a development launch, so the choice is remembered by the app rather than
 * by a process id that a restart would invalidate.
 */
function instanceIdentityKey(): string {
  return process.execPath || 'unknown'
}

/** The live entry that has been running longest; ties broken by lowest pid. */
function oldestEntry(entries: InstanceEntry[]): InstanceEntry | undefined {
  return [...entries].sort(
    (left, right) => left.startedAt - right.startedAt || left.pid - right.pid
  )[0]
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
  private readonly ownerFilePath: string
  private readonly ownershipListeners = new Set<() => void>()
  /** Last effective owner announced, so only a real hand-off notifies. */
  private ownerSignature = ''

  constructor() {
    this.dir = join(getConfigRoot(), 'instances')
    this.ownerFilePath = join(this.dir, 'owner.json')
    this.selfEntry = {
      pid: process.pid,
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
      instanceKey: instanceIdentityKey()
    }
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
      this.ownerSignature = this.ownerSignatureOf(this.effectiveOwnerPid())
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
   * Subscribe to a change in *which* live process owns scheduled work. Fires
   * when an explicit {@link transferOwnership} lands, and when the process that
   * override named disappears, so the previous owner can reclaim the schedule.
   */
  onOwnershipChanged(listener: () => void): () => void {
    this.ownershipListeners.add(listener)
    return () => this.ownershipListeners.delete(listener)
  }

  /**
   * Whether this process owns the work that must happen exactly once for the
   * whole config root   a scheduled auto-resume today.
   *
   * Ownership is explicit and durable first: a designated main instance owns the
   * schedule whenever it is running, even if another process started earlier, and
   * it reclaims the schedule after it restarts. Only when no designated instance
   * is live does the deterministic election apply, so scheduled work is never
   * stranded. The election is computed the same way by every instance, so two
   * windows never both claim the slot. It fails open, so an unreadable registry
   * (or a process whose own entry could not be written) can never silently stop
   * that work.
   */
  isIncumbentInstance(): boolean {
    try {
      const owner = this.effectiveOwnerPid()
      const entries = this.liveEntries()
      if (entries.length <= 1) return true
      // A registry that cannot see our own entry cannot elect anybody.
      if (!entries.some((entry) => entry.pid === this.selfEntry.pid)) return true
      return owner === this.selfEntry.pid
    } catch {
      // Registry failures must never disable shared scheduled work.
      return true
    }
  }

  /**
   * The process id that owns scheduled work, or null when it cannot be
   * resolved. A secondary instance uses this to address the owner ("bring your
   * window forward", "show the user its process id"), so it must answer with
   * the same resolution {@link isIncumbentInstance} uses rather than a second
   * derivation.
   */
  incumbentPid(): number | null {
    try {
      return this.effectiveOwnerPid()
    } catch {
      return null
    }
  }

  /**
   * Make a live process the explicit main instance that owns shared scheduled
   * work. The user asks for this when the elected owner is a stale window, or a
   * crashed process still in the registry, and they want the schedule to run in
   * the instance they are actually working in.
   *
   * The choice is durable: it records the target's app identity, not only its
   * pid, so a later launch of the same app reclaims the schedule after a
   * restart. It is honoured whenever the designated app is running; while it is
   * not, the election resumes instead, so sharing the schedule is never stranded
   * on a dead process.
   */
  transferOwnership(pid: number = this.selfEntry.pid): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try {
      mkdirSync(this.dir, { recursive: true })
      const instanceKey =
        pid === this.selfEntry.pid
          ? this.selfEntry.instanceKey
          : this.liveEntries().find((entry) => entry.pid === pid)?.instanceKey
      const payload: OwnerOverride = {
        pid,
        ...(instanceKey ? { instanceKey } : {}),
        assignedAt: Date.now()
      }
      writeFileSync(this.ownerFilePath, JSON.stringify(payload), 'utf8')
      this.maybeNotifyOwnershipChanged()
      return true
    } catch {
      return false
    }
  }

  /** Drop any override so the deterministic election applies again. */
  clearOwnershipOverride(): void {
    try {
      rmSync(this.ownerFilePath, { force: true })
      this.maybeNotifyOwnershipChanged()
    } catch {
      // Best effort   a missing file is the desired state anyway.
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
      // A transfer target that died is detected by heartbeat age, not by a file
      // write, so ownership is re-checked on our own heartbeat too.
      this.maybeNotifyOwnershipChanged()
    }
  }

  /**
   * The process that owns scheduled work: the designated main instance when it
   * is running, otherwise the longest-running election. Every instance reads the
   * same designation and the same live entries, so they cannot disagree about
   * who owns the schedule.
   */
  private effectiveOwnerPid(): number | null {
    const entries = this.liveEntries()
    const designation = this.readOwnerOverride()
    if (designation) {
      if (designation.instanceKey) {
        const group = entries.filter((entry) => entry.instanceKey === designation.instanceKey)
        if (group.length > 0) {
          // The chosen app is running: its preferred process wins, else the
          // longest-running of its launches, so a restart still reclaims it.
          const preferred = group.find((entry) => entry.pid === designation.pid)
          return (preferred ?? oldestEntry(group))?.pid ?? null
        }
        // The chosen app is not running. Keep the durable choice so it reclaims
        // the schedule when it returns, and elect another instance meanwhile
        // so scheduled work is never stranded.
      } else if (this.isLiveRegistered(designation.pid)) {
        // A designation written before the durable key existed: honour its pid
        // while it lives, exactly as it did then.
        return designation.pid
      } else {
        this.removeStaleOwnerOverride()
      }
    }
    return oldestEntry(entries)?.pid ?? null
  }

  private isLiveRegistered(pid: number): boolean {
    if (pid === this.selfEntry.pid) return true
    try {
      return this.liveEntries().some((entry) => entry.pid === pid)
    } catch {
      return false
    }
  }

  private ownerSignatureOf(ownerPid: number | null): string {
    return ownerPid === null ? 'none' : String(ownerPid)
  }

  private readOwnerOverride(): OwnerOverride | null {
    try {
      const raw = readFileSync(this.ownerFilePath, 'utf8')
      const value = JSON.parse(raw) as Partial<OwnerOverride>
      if (typeof value.pid !== 'number' || typeof value.assignedAt !== 'number') return null
      return {
        pid: value.pid,
        ...(typeof value.instanceKey === 'string' && value.instanceKey
          ? { instanceKey: value.instanceKey }
          : {}),
        assignedAt: value.assignedAt
      }
    } catch {
      return null
    }
  }

  private removeStaleOwnerOverride(): void {
    try {
      rmSync(this.ownerFilePath, { force: true })
    } catch {
      // Best effort.
    }
  }

  /** Notify ownership listeners only when the effective owner actually changed. */
  private maybeNotifyOwnershipChanged(): void {
    let signature: string
    try {
      signature = this.ownerSignatureOf(this.effectiveOwnerPid())
    } catch {
      return
    }
    if (signature === this.ownerSignature) return
    this.ownerSignature = signature
    for (const listener of this.ownershipListeners) {
      try {
        listener()
      } catch {
        // One service failing to reconcile must not block the others.
      }
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
          this.maybeNotifyOwnershipChanged()
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
