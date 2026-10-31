import { createHash } from 'node:crypto'
import type { AgentEvent, AgentRateLimitWindow, AgentUsageCredits } from '../../../lib/types'
import { Logger } from '../../system/logger'
import type { StorageEngine } from '../../storage/storage-engine'
import type { PersistentCliSession } from '../persistent-cli-driver'
import type { PiRpcClient } from '../pi-rpc-client'
import { fetchPiProviderUsage } from '../pi-provider-usage'
import {
  isUsagelessAssistantStatsError,
  mapPiRateLimitHeaders,
  piUsageProviderId,
  refreshSessionUsageFromStats
} from './pi-usage'
import { numberValue, record, stringValue } from './pi-values'

/** Minimum spacing between mid-turn session-stats refreshes, so a turn that
 *  completes many requests cannot stack `get_session_stats` calls. */
const PI_LIVE_USAGE_REFRESH_INTERVAL_MS = 3_000

const USAGE_WINDOWS_PATH = 'runtime/pi-usage/windows.json'
const USAGE_WINDOWS_MAX_PROVIDERS = 50

/** Everything the usage tracker needs from the driver. */
export interface PiUsageHost {
  readonly storage: StorageEngine
  readonly accountEnvironment: NodeJS.ProcessEnv
  rpcClient(sessionId: string): PiRpcClient | undefined
  projectSessionId(projectPath: string): string | undefined
  hasActiveTurn(sessionId: string): boolean
  applySessionEvent(session: PersistentCliSession, event: AgentEvent): void
  emitEvent(event: AgentEvent): void
}

/**
 * Pi token, cost, context, and provider rate-limit accounting: the usage
 * extension's captured windows, their persisted per-provider copy, the
 * mid-turn session-stats refresh, and the account usage read behind the
 * battery popover.
 */
export class PiUsageTracker {
  /**
   * Sessions whose native `get_session_stats` RPC is known to crash. Pi's
   * `AgentSession.getSessionStats` reads `usage.input` unguarded on assistant
   * history entries that carry no `usage` (pi 0.85.1 and earlier), so legacy
   * or interrupted transcripts make the RPC fail with "Cannot read properties
   * of undefined (reading 'input')" on every call. After the first failure the
   * driver stops calling it for that session and falls back to accounting
   * mirrored from per-message usage events.
   */
  private readonly sessionStatsBroken = new Set<string>()
  /**
   * Throttle stamps for the mid-turn session-stats refresh, keyed by session.
   * Pi reports a request's token totals while a turn streams, but its context
   * occupancy, cumulative cost, and rate-limit windows only arrive through the
   * session-stats RPC, which the driver otherwise calls once when the turn
   * settles   leaving the context meter without a provider reading for the
   * whole run.
   */
  private readonly liveUsageRefreshAt = new Map<string, number>()
  /** Sessions with a mid-turn stats refresh in flight, so a burst of completed
   *  requests cannot stack concurrent `get_session_stats` requests. */
  private readonly liveUsageRefreshing = new Set<string>()
  /** Latest provider rate-limit windows reported by the usage extension,
   *  per session, with the pi provider id the response came from. */
  private readonly latestRateLimits = new Map<
    string,
    { providerId?: string; windows: AgentRateLimitWindow[] }
  >()
  /** Latest windows per pi provider id, persisted to storage so hovers after
   *  an app restart (no live RPC session, no in-memory cache) still show bars
   *    and so the same provider used across multiple projects shares them. */
  private persistedRateLimits: Map<string, AgentRateLimitWindow[]> | null = null
  private persistedRateLimitsWrite: Promise<void> | null = null

  constructor(private readonly host: PiUsageHost) {}

  /**
   * Quota telemetry for the battery popover: the latest provider rate-limit
   * windows (keyed by pi provider id, shared across projects) plus prepaid
   * credits for known gateways, and live context stats when a session for
   * the project is running. Provider-scoped data answers even without a live
   * session, mirroring the cached-bars contract of the other drivers.
   */
  async readAccountUsage(
    projectPath: string,
    providerId?: string
  ): Promise<{
    rateLimits: AgentRateLimitWindow[]
    credits?: AgentUsageCredits
    contextWindow?: number
    contextUsed?: number
  } | null> {
    const sessionId = this.host.projectSessionId(projectPath)
    const client = sessionId ? this.host.rpcClient(sessionId) : undefined
    const persisted = await this.loadPersistedRateLimits()
    const sessionCache = sessionId !== undefined ? this.latestRateLimits.get(sessionId) : undefined
    // Account/provider-keyed windows win; the live session's latest capture answers
    // only when it matches the requested provider (or no provider was given).
    const providerWindows = providerId
      ? (persisted.get(this.rateLimitStorageKey(providerId)) ??
        (sessionCache && (sessionCache.providerId === providerId || !sessionCache.providerId)
          ? sessionCache.windows
          : undefined))
      : (sessionCache?.windows ?? [...persisted.values()].at(-1))
    const providerUsage = providerId
      ? await fetchPiProviderUsage(providerId, this.host.accountEnvironment)
      : null
    const windows = providerWindows?.length ? providerWindows : (providerUsage?.rateLimits ?? [])
    const credits = providerUsage?.credits
    if (!client || (sessionId !== undefined && this.sessionStatsBroken.has(sessionId))) {
      return windows.length > 0 || credits ? { rateLimits: windows, credits } : null
    }
    try {
      const stats = record(await client.getSessionStats())
      const contextUsage = record(stats?.['contextUsage'])
      const contextWindow = numberValue(contextUsage?.['contextWindow'])
      const contextUsed = numberValue(contextUsage?.['tokens'])
      if (
        contextWindow === undefined &&
        contextUsed === undefined &&
        windows.length === 0 &&
        !credits
      )
        return null
      return {
        ...(windows.length > 0 ? { rateLimits: windows } : { rateLimits: [] }),
        ...(credits ? { credits } : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(contextUsed !== undefined ? { contextUsed } : {})
      }
    } catch (error) {
      if (sessionId !== undefined && isUsagelessAssistantStatsError(error)) {
        this.sessionStatsBroken.add(sessionId)
      }
      Logger.dev('Pi account usage read failed:', error)
      return windows.length > 0 || credits ? { rateLimits: windows, credits } : null
    }
  }

  /**
   * Consume the usage extension's `setStatus` records: a JSON payload of the
   * provider response's rate-limit headers. Mapped into display windows and
   * cached per session until the next provider response refreshes them.
   */
  async handleUsageStatus(record: Record<string, unknown>, sessionId: string): Promise<void> {
    const text = stringValue(record['statusText'])
    if (!text) return
    let payload: unknown
    try {
      payload = JSON.parse(text) as unknown
    } catch {
      return
    }
    const windows = mapPiRateLimitHeaders(payload)
    if (windows.length === 0) return
    const providerId = piUsageProviderId(payload)
    this.latestRateLimits.set(sessionId, { providerId, windows })
    if (providerId) await this.rememberPersistedRateLimits(providerId, windows)
  }

  /**
   * Refresh provider usage while a turn is still running.
   *
   * The session-stats refresh used to run only at turn end, so a long turn
   * showed the last completed request's tokens as its only live signal and no
   * provider context reading   no context window, no cumulative cost, no quota
   * windows   until it settled. Refreshing after each completed request, at
   * most once per interval and with one request in flight per session, keeps
   * those readings live while pi works. Pi serves the call from its own stats
   * walk, which is a single linear pass it caches on (session, leaf, entry
   * count), so the added load is one cheap request per interval.
   */
  scheduleLiveUsageRefresh(session: PersistentCliSession): void {
    if (!this.host.hasActiveTurn(session.id)) return
    if (this.liveUsageRefreshing.has(session.id)) return
    const now = Date.now()
    if (now - (this.liveUsageRefreshAt.get(session.id) ?? 0) < PI_LIVE_USAGE_REFRESH_INTERVAL_MS) {
      return
    }
    this.liveUsageRefreshAt.set(session.id, now)
    this.liveUsageRefreshing.add(session.id)
    void this.refreshSessionUsage(session)
      .catch((error) => Logger.dev('Pi live usage refresh failed:', error))
      .finally(() => this.liveUsageRefreshing.delete(session.id))
  }

  /** Attach the final session-stats context usage to the last assistant message. */
  async refreshSessionUsage(session: PersistentCliSession): Promise<void> {
    await refreshSessionUsageFromStats(session, {
      client: this.host.rpcClient(session.id) ?? null,
      sessionStatsBroken: this.sessionStatsBroken,
      rateLimits: this.latestRateLimits.get(session.id)?.windows ?? [],
      applyEvent: (target, event) => this.host.applySessionEvent(target, event),
      emit: (event) => this.host.emitEvent(event)
    })
  }

  /** Clear the turn's live-refresh throttle so the next turn refreshes at once. */
  endTurn(sessionId: string): void {
    this.liveUsageRefreshAt.delete(sessionId)
    this.liveUsageRefreshing.delete(sessionId)
  }

  /** Drop the session's latest provider windows (its process is gone). */
  forgetSession(sessionId: string): void {
    this.latestRateLimits.delete(sessionId)
  }

  /** Load the persisted per-project windows map once per driver lifetime. */
  private async loadPersistedRateLimits(): Promise<Map<string, AgentRateLimitWindow[]>> {
    if (this.persistedRateLimits) return this.persistedRateLimits
    const map = new Map<string, AgentRateLimitWindow[]>()
    try {
      const raw = await this.host.storage.readRaw(USAGE_WINDOWS_PATH)
      if (raw) {
        const parsed: unknown = JSON.parse(raw)
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [key, value] of Object.entries(parsed)) {
            if (Array.isArray(value)) {
              map.set(
                key,
                value.filter(
                  (entry): entry is AgentRateLimitWindow =>
                    entry !== null && typeof entry === 'object' && !Array.isArray(entry)
                )
              )
            }
          }
        }
      }
    } catch (error) {
      Logger.dev('Pi usage windows read failed:', error)
    }
    this.persistedRateLimits = map
    return map
  }

  /** Store the latest windows for a pi provider; writes are serialized and
   *  bounded so a long-lived driver never grows the file without bound. */
  private async rememberPersistedRateLimits(
    providerId: string,
    windows: AgentRateLimitWindow[]
  ): Promise<void> {
    const map = await this.loadPersistedRateLimits()
    const storageKey = this.rateLimitStorageKey(providerId)
    map.delete(storageKey)
    map.set(storageKey, windows)
    while (map.size > USAGE_WINDOWS_MAX_PROVIDERS) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
    if (this.persistedRateLimitsWrite) return
    const snapshot = JSON.stringify(Object.fromEntries(map))
    this.persistedRateLimitsWrite = this.host.storage
      .writeRaw(USAGE_WINDOWS_PATH, snapshot)
      .catch((error: unknown) => Logger.dev('Pi usage windows write failed:', error))
      .finally(() => {
        this.persistedRateLimitsWrite = null
      })
    await this.persistedRateLimitsWrite
  }

  /**
   * Managed Pi accounts share CodeInOven's runtime storage, so provider-only
   * keys would let one account's captured windows appear for another account.
   * The legacy account keeps the historical provider key for compatibility.
   */
  private rateLimitStorageKey(providerId: string): string {
    const agentDirectory = this.host.accountEnvironment['PI_CODING_AGENT_DIR']?.trim()
    if (!agentDirectory) return providerId
    const accountKey = createHash('sha256').update(agentDirectory).digest('hex').slice(0, 16)
    return `account:${accountKey}:${providerId}`
  }
}
