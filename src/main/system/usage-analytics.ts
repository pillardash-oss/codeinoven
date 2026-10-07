import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rm, stat } from 'node:fs/promises'
import { getCanonicalConfigRoot, getConfigRoot } from '../../lib/utils'
import type { StorageEngine } from '../storage/storage-engine'
import { Logger } from './logger'

declare const __CODEINOVEN_POSTHOG_TOKEN__: string
const STATE_PATH = 'analytics/usage.json'
const MAX_PENDING_DAYS = 30
const MAX_QUEUE = MAX_PENDING_DAYS + 1
const RETRY_MS = 60_000
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

type UsageEventName = 'first_open' | 'app_active'
interface UsageEvent {
  event: UsageEventName
  timestamp: string
  uuid: string
  version: string
  platform: string
  architecture: string
}
interface UsageState {
  installationId: string
  firstOpenRecorded: boolean
  lastActiveDay: string
  queue: UsageEvent[]
}

/** Explicit, anonymous events only. No renderer payload, replay, or SDK. */
export class UsageAnalytics {
  private storage: StorageEngine | null = null
  private version = ''
  private enabled = false
  private available = false
  private stopping = false
  private nextActivityCheck = 0
  private nextFlush = 0
  private failures = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private request: AbortController | null = null
  private work: Promise<void> = Promise.resolve()

  start(storage: StorageEngine, version: string): void {
    this.storage = storage
    this.version = version
    this.available =
      app.isPackaged &&
      getConfigRoot() === getCanonicalConfigRoot() &&
      typeof __CODEINOVEN_POSTHOG_TOKEN__ === 'string' &&
      __CODEINOVEN_POSTHOG_TOKEN__.length > 0
    if (!this.available) return
    this.schedule(async () => {
      const config = await storage.getConfig()
      this.enabled = config.shareAnonymousUsage === true
    })
    this.timer = setInterval(() => {
      if (this.enabled) this.schedule(() => this.withState((state) => this.flush(state)))
    }, RETRY_MS)
    this.timer.unref()
  }

  async setConsent(consent: boolean): Promise<void> {
    // Revocation takes effect immediately, including an in-flight request.
    if (!this.available) return
    this.enabled = consent
    this.nextActivityCheck = 0
    if (!consent) this.request?.abort()
    const pending = this.schedule(() =>
      this.withState(async (state) => {
        if (!this.enabled) state.queue = []
      })
    )
    if (consent) this.activity()
    await pending
  }

  activity(): void {
    if (!this.enabled || this.stopping || Date.now() < this.nextActivityCheck) return
    this.nextActivityCheck = Date.now() + RETRY_MS
    this.schedule(() =>
      this.withState(async (state) => {
        if (!this.enabled || this.stopping) return
        const now = new Date().toISOString()
        const day = now.slice(0, 10)
        if (!state.firstOpenRecorded) {
          state.queue.push(this.event('first_open', now, state.installationId))
          state.firstOpenRecorded = true
        }
        if (state.lastActiveDay !== day) {
          state.queue.push(this.event('app_active', now, state.installationId))
          state.lastActiveDay = day
        }
        state.queue = state.queue.slice(-MAX_QUEUE)
        // Persist before sending so a crash or offline exit does not lose events.
        await this.storage?.write(STATE_PATH, state)
        await this.flush(state)
      })
    )
  }

  stop(): void {
    this.stopping = true
    if (this.timer) clearInterval(this.timer)
    this.request?.abort()
    // Queue writes are atomic; shutdown never waits for a network request.
  }

  private schedule(operation: () => Promise<void>): Promise<void> {
    this.work = this.work.then(operation).catch(() => {
      Logger.dev('Anonymous usage operation deferred')
    })
    return this.work
  }

  private event(event: UsageEventName, timestamp: string, installationId: string): UsageEvent {
    // Stable UUIDs make replay after a crash safe for PostHog event deduplication.
    const digest = createHash('sha256')
      .update(`${installationId}:${event}:${event === 'app_active' ? timestamp.slice(0, 10) : ''}`)
      .digest('hex')
      .slice(0, 32)
    const uuid = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20)}`
    return {
      event,
      timestamp,
      uuid,
      version: this.version,
      platform: process.platform,
      architecture: process.arch
    }
  }

  private async withState(operation: (state: UsageState) => Promise<void>): Promise<void> {
    if (!this.storage || this.stopping) return
    // An async filesystem lock shares one installation identity and daily guard
    // across concurrent app instances without blocking Electron's main thread.
    await mkdir(this.storage.resolve('analytics'), { recursive: true })
    const lock = this.storage.resolve('analytics/usage.lock')
    try {
      await mkdir(lock)
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
      // A crashed process cannot leave analytics locked forever. Requests time
      // out after five seconds, well below this stale-lock threshold.
      const info = await stat(lock)
      if (Date.now() - info.mtimeMs > 30_000) await rm(lock, { recursive: true, force: true })
      return
    }
    try {
      // Other instances can revoke consent through the shared config. Recheck
      // before each bounded operation, never on every input event.
      const config = await this.storage.getConfig()
      if (config.shareAnonymousUsage !== true) this.enabled = false
      const raw = await this.storage.read<Partial<UsageState>>(STATE_PATH)
      // TODO(accounts): when accounts return, identify with the stable account
      // ID and merge this anonymous installation history. Reset on logout/account
      // switch so DAU/MAU count people across devices without mixing accounts.
      const state: UsageState = {
        installationId:
          typeof raw?.installationId === 'string' && UUID_PATTERN.test(raw.installationId)
            ? raw.installationId
            : randomUUID(),
        firstOpenRecorded: raw?.firstOpenRecorded === true,
        lastActiveDay: typeof raw?.lastActiveDay === 'string' ? raw.lastActiveDay : '',
        queue: Array.isArray(raw?.queue) ? raw.queue.slice(-MAX_QUEUE).filter(isUsageEvent) : []
      }
      state.queue = state.queue.filter(
        (event) => Date.now() - Date.parse(event.timestamp) < MAX_PENDING_DAYS * 86_400_000
      )
      if (!this.enabled) state.queue = []
      await operation(state)
      await this.storage.write(STATE_PATH, state)
    } finally {
      await rm(lock, { recursive: true, force: true })
    }
  }

  private deferRetry(): void {
    this.failures = Math.min(this.failures + 1, 6)
    this.nextFlush = Date.now() + Math.min(RETRY_MS * 2 ** (this.failures - 1), 3_600_000)
  }

  private async flush(state: UsageState): Promise<void> {
    if (!this.enabled || this.stopping || state.queue.length === 0 || Date.now() < this.nextFlush)
      return
    const controller = new AbortController()
    this.request = controller
    const timeout = setTimeout(() => controller.abort(), 5_000)
    timeout.unref()
    try {
      const response = await fetch('https://us.i.posthog.com/batch/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        redirect: 'error',
        body: JSON.stringify({
          api_key: __CODEINOVEN_POSTHOG_TOKEN__,
          batch: state.queue.map((event) => ({
            event: event.event,
            timestamp: event.timestamp,
            uuid: event.uuid,
            distinct_id: state.installationId,
            properties: {
              $process_person_profile: false,
              $geoip_disable: true,
              $ip: null,
              app_version: event.version,
              platform: event.platform,
              architecture: event.architecture
            }
          }))
        })
      })
      await response.body?.cancel()
      if (response.ok) {
        state.queue = []
        this.failures = 0
        this.nextFlush = 0
      } else {
        this.deferRetry()
      }
    } catch {
      // At most one small retry per minute; original timestamps survive offline use.
      this.deferRetry()
      Logger.dev('Anonymous usage batch deferred')
    } finally {
      clearTimeout(timeout)
      this.request = null
    }
  }
}

function isUsageEvent(value: unknown): value is UsageEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as Partial<UsageEvent>
  return (
    (event.event === 'first_open' || event.event === 'app_active') &&
    typeof event.timestamp === 'string' &&
    Number.isFinite(Date.parse(event.timestamp)) &&
    typeof event.uuid === 'string' &&
    UUID_PATTERN.test(event.uuid) &&
    typeof event.version === 'string' &&
    event.version.length < 100 &&
    typeof event.platform === 'string' &&
    ['darwin', 'win32', 'linux'].includes(event.platform) &&
    typeof event.architecture === 'string' &&
    event.architecture.length < 20
  )
}

export const usageAnalytics = new UsageAnalytics()
