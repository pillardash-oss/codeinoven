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
  /** Live app-utility gateway owned by this process, when one has been started. */
  mcpHost?: string
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
  private readonly seenCheckpointEvents = new Set<string>()

  constructor() {
    this.dir = join(getConfigRoot(), 'instances')
    this.selfEntry = { pid: process.pid, startedAt: Date.now(), lastHeartbeat: Date.now() }
  }

  /** Register this process and start heartbeating so others can see it. */
  start(): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      this.writeEntry()
      this.startWatcher()
      this.heartbeatTimer = setInterval(() => this.writeEntry(), HEARTBEAT_MS)
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
      // Best effort — the file may already be gone.
    }
  }

  /**
   * Publish the utility gateway owned by this process. Recovery helpers read
   * every live instance entry instead of assuming the port from one app window.
   */
  setMcpHost(mcpHost: string | null): void {
    if (mcpHost) this.selfEntry.mcpHost = mcpHost
    else delete this.selfEntry.mcpHost
    try {
      this.writeEntry()
    } catch {
      // Recovery metadata is best effort; the gateway remains usable directly.
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

  /**
   * Elect the oldest live process as the sole owner of shared remote
   * transports. A later process stays cold until the owner exits.
   */
  isPreferredRemoteOwner(): boolean {
    try {
      const entries = this.liveEntries()
      if (entries.length === 0) return true
      entries.sort((left, right) => left.startedAt - right.startedAt || left.pid - right.pid)
      return entries[0]?.pid === this.selfEntry.pid
    } catch {
      // Registry failures must not make remote mode unavailable.
      return true
    }
  }

  /** Wake services that may need to take over after another process exits. */
  onLiveInstancesChanged(listener: () => void): () => void {
    this.liveInstanceListeners.add(listener)
    return () => this.liveInstanceListeners.delete(listener)
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
      // Registry unreadable — assume we are the only instance.
    }
    return false
  }

  private liveEntries(): InstanceEntry[] {
    const files = readdirSync(this.dir).filter((name) => name.endsWith('.json'))
    const entries: InstanceEntry[] = []
    for (const file of files) {
      const entry = this.readEntry(file)
      if (!entry) continue
      if (this.isProcessAlive(entry.pid)) entries.push(entry)
    }
    return entries
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
      // ESRCH: no such process. EPERM: exists but owned by another user — alive.
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
