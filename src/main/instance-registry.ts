import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getConfigRoot } from '../lib/utils'

const HEARTBEAT_MS = 30_000
/** Instances whose heartbeat is older than this are treated as gone. */
const STALE_MS = 120_000

interface InstanceEntry {
  pid: number
  startedAt: number
  lastHeartbeat: number
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

  constructor() {
    this.dir = join(getConfigRoot(), 'instances')
    this.selfEntry = { pid: process.pid, startedAt: Date.now(), lastHeartbeat: Date.now() }
  }

  /** Register this process and start heartbeating so others can see it. */
  start(): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      this.writeEntry()
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
    try {
      rmSync(join(this.dir, `${this.selfEntry.pid}.json`), { force: true })
    } catch {
      // Best effort — the file may already be gone.
    }
  }

  /**
   * True when at least one other CodeInOven process is registered and alive.
   * A dead-but-stale entry is ignored, so a crash or force quit doesn't cause a
   * fresh instance to think a phantom still exists.
   */
  hasOtherLiveInstance(): boolean {
    try {
      const files = readdirSync(this.dir).filter((name) => name.endsWith('.json'))
      const now = Date.now()
      for (const file of files) {
        const entry = this.readEntry(file)
        if (!entry) continue
        if (entry.pid === this.selfEntry.pid) continue
        if (now - entry.lastHeartbeat > STALE_MS) continue
        if (this.isProcessAlive(entry.pid)) return true
      }
    } catch {
      // Registry unreadable — assume we are the only instance.
    }
    return false
  }

  private writeEntry(): void {
    this.selfEntry.lastHeartbeat = Date.now()
    const payload = JSON.stringify(this.selfEntry)
    const tmpPath = join(this.dir, `.${this.selfEntry.pid}.tmp`)
    writeFileSync(tmpPath, payload, 'utf8')
    writeFileSync(join(this.dir, `${this.selfEntry.pid}.json`), payload, 'utf8')
    rmSync(tmpPath, { force: true })
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
