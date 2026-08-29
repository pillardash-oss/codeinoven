import { Logger } from './logger'
import type { StorageEngine } from '../storage/storage-engine'
import type { HeartbeatConfig } from '../../lib/types'
import { generateId } from '../../lib/utils'

/** How often the ticker checks whether any configured time-of-day has passed. */
const HEARTBEAT_TICK_MS = 30_000

/** The most recent HH:mm occurrence (today, or yesterday if today's hasn't happened yet) at or before `now`. */
function mostRecentScheduledMoment(times: string[], now: number): number | null {
  let latest: number | null = null
  const nowDate = new Date(now)
  for (const time of times) {
    const match = /^(\d{2}):(\d{2})$/.exec(time)
    if (!match) continue
    const hours = Number(match[1])
    const minutes = Number(match[2])
    if (hours > 23 || minutes > 59) continue
    const candidate = new Date(nowDate)
    candidate.setHours(hours, minutes, 0, 0)
    let candidateMs = candidate.getTime()
    if (candidateMs > now) candidateMs -= 24 * 60 * 60 * 1000
    if (latest === null || candidateMs > latest) latest = candidateMs
  }
  return latest
}

/**
 * HeartbeatSchedulerService — fires a disposable "ping" completion against a
 * user-selected model at each configured time of day, keeping that provider's
 * usage window warm. Each config's `lastRun.at` marks the most recent slot
 * already fired; a slot whose scheduled moment is newer than `lastRun.at`
 * fires exactly once, including catch-up for times missed while the app was
 * closed.
 */
export class HeartbeatSchedulerService {
  private heartbeats: HeartbeatConfig[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private pingCallback: ((config: HeartbeatConfig) => Promise<boolean>) | null = null
  private changeListener: (() => void) | null = null
  private persistChain: Promise<void> = Promise.resolve()

  constructor(private storage: StorageEngine) {}

  /** Load persisted heartbeats, arm the ticker, and fire any slot missed while closed. */
  async start(): Promise<void> {
    this.heartbeats = await this.storage.getHeartbeats()
    this.refreshTimer()
    this.tick()
  }

  /** The chat engine supplies the actual ping dispatch once registered. */
  attachPing(callback: (config: HeartbeatConfig) => Promise<boolean>): void {
    this.pingCallback = callback
  }

  /** Register a callback fired whenever the heartbeat list changes. */
  attachChangeListener(callback: () => void): void {
    this.changeListener = callback
  }

  list(): HeartbeatConfig[] {
    return [...this.heartbeats]
  }

  async create(input: Omit<HeartbeatConfig, 'id' | 'lastRun'>): Promise<HeartbeatConfig> {
    const config: HeartbeatConfig = { ...input, id: generateId() }
    this.heartbeats.push(config)
    await this.persist()
    this.refreshTimer()
    this.notifyChange()
    return config
  }

  async update(id: string, patch: Partial<Omit<HeartbeatConfig, 'id'>>): Promise<HeartbeatConfig> {
    const index = this.heartbeats.findIndex((entry) => entry.id === id)
    if (index === -1) throw new Error(`Heartbeat not found: ${id}`)
    this.heartbeats[index] = { ...this.heartbeats[index], ...patch }
    await this.persist()
    this.refreshTimer()
    this.notifyChange()
    return this.heartbeats[index]
  }

  async remove(id: string): Promise<boolean> {
    const before = this.heartbeats.length
    this.heartbeats = this.heartbeats.filter((entry) => entry.id !== id)
    if (this.heartbeats.length === before) return false
    await this.persist()
    this.refreshTimer()
    this.notifyChange()
    return true
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  dispose(): void {
    this.stop()
    this.pingCallback = null
  }

  private persist(): Promise<void> {
    const snapshot = [...this.heartbeats]
    this.persistChain = this.persistChain
      .then(() => this.storage.saveHeartbeats(snapshot))
      .catch((error) => {
        Logger.error('Heartbeat config could not be written:', error)
      })
    return this.persistChain
  }

  private refreshTimer(): void {
    const shouldRun = this.heartbeats.some((entry) => entry.enabled && entry.times.length > 0)
    if (shouldRun && this.timer === null) {
      this.timer = setInterval(() => this.tick(), HEARTBEAT_TICK_MS)
    } else if (!shouldRun && this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private tick(): void {
    const now = Date.now()
    for (const config of this.heartbeats) {
      if (!config.enabled || config.times.length === 0) continue
      const due = mostRecentScheduledMoment(config.times, now)
      if (due === null) continue
      if (config.lastRun !== undefined && config.lastRun.at >= due) continue
      void this.fire(config)
    }
  }

  private async fire(config: HeartbeatConfig): Promise<void> {
    const callback = this.pingCallback
    if (!callback) {
      Logger.info('Heartbeat ping skipped — chat engine not attached', { id: config.id })
      return
    }
    Logger.info('Sending heartbeat ping', {
      id: config.id,
      name: config.name,
      harnessId: config.harnessId,
      providerId: config.providerId,
      modelId: config.modelId
    })
    let success = false
    let error: string | undefined
    try {
      success = await callback(config)
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown)
      Logger.error('Heartbeat ping failed', thrown)
    }
    const index = this.heartbeats.findIndex((entry) => entry.id === config.id)
    if (index !== -1) {
      this.heartbeats[index] = {
        ...this.heartbeats[index],
        lastRun: { at: Date.now(), success, ...(error ? { error } : {}) }
      }
      await this.persist()
      this.notifyChange()
    }
  }

  private notifyChange(): void {
    this.changeListener?.()
  }
}
