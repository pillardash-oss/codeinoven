/// <reference types="vite/client" />

import type { AgentEvent, BaseUrlProvider, ProviderCatalog } from '$shared/types'
import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { invoke, subscribe } from '$lib/ipc.svelte'
import { APP_SLUG } from '$shared/brand'

/**
 * Per-project provider catalog cache (stale-while-revalidate) with optional
 * start-up hydration controls.
 *
 * `agent:refreshProviderCatalog` pings every harness driver, which can take
 * seconds on a cold project and (for Cline) hits the network. At app start
 * every attached project is seeded from its persisted snapshot (instant render)
 * and then force-hydrated in the background so live harness data replaces the
 * snapshot before the picker is ever opened. Pickers consume `cached()` — the
 * sole consumer — instantly; `refresh()` reuses fresh copies within a TTL and
 * revalidates when the copy is stale or a previous attempt failed. Failures
 * keep the stale entry and are retried in the background with backoff, and a
 * background staleness sweep re-hydrates caches on their own once they outlive
 * the TTL — the picker is never the first contact with the harnesses. Any
 * number of concurrent refreshes for the same project share one request.
 *
 * A synchronous localStorage mirror of each project's last-known catalog is
 * also kept so the model picker and context meter render the selected model
 * the moment a thread mounts — before the async snapshot IPC resolves. Mirror
 * entries never count as fresh, so live revalidation is never suppressed.
 */
/** Fresh catalog is reused within this window instead of re-fetching drivers. */
const CATALOG_FRESH_TTL_MS = 24 * 60 * 60 * 1000
/**
 * Picker-interaction freshness window. Model pickers revalidate on every open;
 * within this short window the cached copy is reused so opening the picker
 * never pings harnesses, but after 5 minutes the open triggers a background
 * revalidation — keeping the visible list from going stale for long sessions.
 */
const CATALOG_PICKER_TTL_MS = 5 * 60 * 1000
/** Base backoff for background retries of a failed hydration (doubles per try). */
const RETRY_BASE_DELAY_MS = 20 * 1000
/** Cap for the exponential retry backoff. */
const RETRY_MAX_DELAY_MS = 5 * 60 * 1000
/** Minimum pause before a picker-open revalidation can re-probe a failing harness. */
const RETRY_MIN_INTERVAL_MS = 20 * 1000
/** localStorage key under which the last-known catalogs are mirrored. */
const CATALOG_MIRROR_KEY = `${APP_SLUG}.providerCatalog.mirror.v2`

/**
 * Merge catalog snapshots without allowing a partial/stale model record to
 * erase optional capability metadata discovered by another snapshot.
 *
 * Provider catalogs arrive from several places during startup: the local
 * mirror, the main-process snapshot, the component prop, and a live driver
 * refresh. Thinking presets are optional, so an older record that omits them
 * must not hide presets already reported by another record.
 */
export function mergeProviderCatalogEntries(catalogs: ProviderCatalog[]): ProviderCatalog[] {
  // This is a local computation, not application state. Using SvelteMap here
  // makes every merge write reactive signals while ModelPicker/ChatComposer
  // are evaluating their derived values, which can cascade into a long flush.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local-only merge state; it must not notify Svelte while derived values are evaluated
  const merged = new Map<string, ProviderCatalog>()
  for (const catalog of catalogs) {
    const key = `${catalog.harnessId}:${catalog.id}`
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, { ...catalog, models: [...catalog.models] })
      continue
    }

    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local-only merge state; it must not notify Svelte while derived values are evaluated
    const models = new Map(
      existing.models.map((model) => [`${model.providerId}:${model.id}`, model])
    )
    for (const model of catalog.models) {
      const modelKey = `${model.providerId}:${model.id}`
      const prior = models.get(modelKey)
      const mergedModel = { ...prior, ...model }
      if (model.thinkingPresets === undefined && prior?.thinkingPresets !== undefined) {
        mergedModel.thinkingPresets = prior.thinkingPresets
      }
      models.set(modelKey, mergedModel)
    }
    existing.models = [...models.values()]
  }
  return [...merged.values()]
}

class ProviderCatalogStore {
  private cache = new SvelteMap<string, ProviderCatalog[]>()
  private customOverrides = new SvelteMap<string, BaseUrlProvider | null>()
  private refreshedAt = new Map<string, number>()
  /** When the last hydration attempt for a project failed. */
  private failedAt = new Map<string, number>()
  /** Consecutive failed attempts per project, for exponential backoff. */
  private retryAttempts = new Map<string, number>()
  private inflight = new Map<string, Promise<ProviderCatalog[]>>()
  /** Projects with a driver probe currently in flight, for picker spinners. */
  private refreshingProjects = new SvelteSet<string>()
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retrySweeping = false
  /** Timer for the background staleness sweep (re-hydrates stale caches alone). */
  private stalenessTimer: ReturnType<typeof setTimeout> | null = null
  private stalenessSweeping = false

  constructor() {
    // Seed from the last-known catalog mirror so a thread's selected model and
    // context window render immediately on restart, before the snapshot IPC.
    this.loadMirror()
    // A driver enriched its catalog in the background (e.g. Cline's remote
    // list landed) — absorb the pushed catalogs so open pickers refresh live
    // instead of waiting for a re-open or the next fetch.
    subscribe('agent:event', (...args: unknown[]) => {
      const event = args[0] as AgentEvent | undefined
      if (event?.type === 'providerCatalog.updated') {
        this.cache.set(event.projectId, event.catalogs)
        this.refreshedAt.set(event.projectId, Date.now())
        this.failedAt.delete(event.projectId)
        this.retryAttempts.delete(event.projectId)
        this.persistMirror()
        this.scheduleStalenessSweep()
      }
    })
  }

  /**
   * Seed every project's catalog from disk. Startup never contacts harnesses.
   */
  async init(projectIds: string[], options: { refresh?: boolean } = {}): Promise<void> {
    const refresh = options.refresh ?? true
    const targets = [...new Set(projectIds)]
    await Promise.all(
      targets.map(async (projectId) => {
        try {
          const persisted = await invoke('agent:listProviderSnapshot', projectId)
          if (persisted.length > 0) {
            this.cache.set(projectId, persisted)
            this.refreshedAt.set(projectId, Date.now())
          } else {
            this.cache.delete(projectId)
            this.refreshedAt.delete(projectId)
          }
        } catch {
          // Snapshot unavailable — leave the cache empty; the eager warm
          // refresh below populates it.
        }
      })
    )
    // Keep the local mirror current so the next launch renders instantly.
    this.persistMirror()
    if (refresh) {
      // Hydrate every project in the background so live harness data replaces
      // the snapshot — and projects with no snapshot are populated — before the
      // model picker is ever opened. Forced so a fresh snapshot is never trusted
      // over a driver probe. Concurrent projects share one main-side discovery.
      for (const projectId of targets) void this.refresh(projectId, true)
    }
    // Re-arm the staleness sweep so caches never outlive their TTL silently.
    this.scheduleStalenessSweep()
  }

  /** Seed the cache synchronously from the last-known catalog mirror. */
  private loadMirror(): void {
    if (typeof window === 'undefined') return
    try {
      const raw = window.localStorage.getItem(CATALOG_MIRROR_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as Record<string, ProviderCatalog[]>
      for (const [projectId, catalogs] of Object.entries(parsed)) {
        if (!Array.isArray(catalogs) || catalogs.length === 0) continue
        this.cache.set(projectId, catalogs)
        // Deliberately no refreshedAt: the mirror only bridges the async
        // fetch; init() and picker-open revalidation still contact the drivers.
      }
    } catch {
      // Mirror corrupt or storage unavailable — non-fatal.
    }
  }

  /** Mirror the last-known catalogs for an instantly warm next launch. */
  private persistMirror(): void {
    if (typeof window === 'undefined') return
    try {
      const snapshot: Record<string, ProviderCatalog[]> = {}
      for (const [projectId, catalogs] of this.cache) snapshot[projectId] = catalogs
      window.localStorage.setItem(CATALOG_MIRROR_KEY, JSON.stringify(snapshot))
    } catch {
      // Quota exceeded or storage unavailable — the mirror is only a speed
      // bridge; the disk snapshot in main still backs every launch.
    }
  }

  /** Last known catalog for the project, or undefined before the first fetch. */
  cached(projectId: string): ProviderCatalog[] | undefined {
    const catalogs = this.cache.get(projectId)
    return catalogs ? this.applyCustomOverrides(catalogs) : undefined
  }

  /** True while a driver probe for the project is in flight (spinner state). */
  refreshing(projectId: string): boolean {
    return this.refreshingProjects.has(projectId)
  }

  /**
   * Deduped union of every currently cached project catalog. Used to resolve
   * global favorites / recently-used models that may not exist in the current
   * thread's project catalog (cold projects, driver availability differences).
   */
  allCached(): ProviderCatalog[] {
    const catalogs: ProviderCatalog[] = []
    for (const projectCatalogs of this.cache.values()) {
      catalogs.push(...projectCatalogs)
    }
    return this.applyCustomOverrides(mergeProviderCatalogEntries(catalogs))
  }

  /**
   * Fetch the catalog and update the cache; failures keep the stale entry.
   * Contacts the harnesses when the cached copy is missing or stale, or when
   * the previous attempt failed (so the model picker — the sole consumer —
   * reuses fresh data instead of pinging every driver on each open, while a
   * failed hydration is never trusted beyond a short backoff).
   */
  refresh(projectId: string, force = false): Promise<ProviderCatalog[]> {
    const existing = this.cache.get(projectId)
    const lastFetched = this.refreshedAt.get(projectId)
    const lastFailed = this.failedAt.get(projectId)
    if (!force && existing && lastFetched) {
      // A snapshot that failed to hydrate is revalidated on the next picker
      // open once the backoff elapses — never silently served forever.
      const failureFresh =
        lastFailed !== undefined && Date.now() - lastFailed < RETRY_MIN_INTERVAL_MS
      if (failureFresh) return Promise.resolve(this.applyCustomOverrides(existing))
      if (Date.now() - lastFetched < CATALOG_PICKER_TTL_MS) {
        return Promise.resolve(this.applyCustomOverrides(existing))
      }
      // Older than the picker window but inside the long TTL: revalidate in
      // the background and serve the cached copy immediately so the picker
      // opens without waiting on harness probes.
      if (Date.now() - lastFetched < CATALOG_FRESH_TTL_MS) {
        this.revalidateInBackground(projectId)
        return Promise.resolve(this.applyCustomOverrides(existing))
      }
    }
    const pending = this.inflight.get(projectId)
    if (pending) return pending
    const request = this.probe(projectId)
      .then(() => this.cached(projectId) ?? [])
      .finally(() => {
        this.inflight.delete(projectId)
        this.refreshingProjects.delete(projectId)
      })
    this.inflight.set(projectId, request)
    this.refreshingProjects.add(projectId)
    return request
  }

  /**
   * Background revalidation for a cached-but-aging catalog: probe the
   * harnesses without blocking the caller. Deduped by the inflight map, so
   * rapid picker opens share one probe.
   */
  private revalidateInBackground(projectId: string): void {
    void this.refresh(projectId, true).catch(() => {
      // probe() already records the failure and schedules retries.
    })
  }

  /**
   * One driver-probing round-trip. Success replaces the cache and clears the
   * failure state; failure records the timestamp and schedules a background
   * retry so a transient start-up hiccup recovers without user action.
   */
  private async probe(projectId: string): Promise<void> {
    try {
      const catalogs = await invoke('agent:refreshProviderCatalog', projectId)
      this.cache.set(projectId, catalogs)
      this.refreshedAt.set(projectId, Date.now())
      this.failedAt.delete(projectId)
      this.retryAttempts.delete(projectId)
      this.persistMirror()
      this.scheduleStalenessSweep()
    } catch {
      this.failedAt.set(projectId, Date.now())
      this.scheduleRetrySweep()
    }
  }

  /**
   * Retry every project whose last hydration failed, once the exponential
   * backoff for each elapses. Re-arms itself until nothing is left failing.
   */
  private scheduleRetrySweep(): void {
    if (this.retryTimer !== null || this.retrySweeping) return
    const failed = [...this.failedAt.keys()]
    if (failed.length === 0) return
    const nextDue = Math.min(
      ...failed.map((projectId) => {
        const lastFailed = this.failedAt.get(projectId) ?? 0
        const attempts = this.retryAttempts.get(projectId) ?? 0
        return lastFailed + Math.min(RETRY_BASE_DELAY_MS * 2 ** attempts, RETRY_MAX_DELAY_MS)
      })
    )
    const delay = Math.max(0, nextDue - Date.now())
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.runRetrySweep()
    }, delay)
  }

  private async runRetrySweep(): Promise<void> {
    if (this.retrySweeping) return
    this.retrySweeping = true
    try {
      const targets = [...this.failedAt.keys()]
      for (const projectId of targets) {
        const attempts = (this.retryAttempts.get(projectId) ?? 0) + 1
        this.retryAttempts.set(projectId, attempts)
      }
      await Promise.all(targets.map((projectId) => this.refresh(projectId, true)))
    } finally {
      this.retrySweeping = false
      // Re-arm for any project that failed again on this round.
      this.scheduleRetrySweep()
    }
  }

  /**
   * Re-hydrate a project's catalog on its own once its cache outlives the
   * freshness window, so the model list is already fresh the next time the
   * picker opens — no user action required. Arms the timer to the earliest
   * future expiry (new entries always expire later than any currently armed
   * due, so no rescheduling is needed while a timer is pending) and re-arms
   * after each sweep. A failed probe falls through to the failure-retry sweep,
   * and an already-stale entry that stays stale is left for that backoff path
   * rather than looping here.
   */
  private scheduleStalenessSweep(): void {
    if (this.stalenessTimer !== null || this.stalenessSweeping) return
    const now = Date.now()
    let nextDue: number | null = null
    for (const fetchedAt of this.refreshedAt.values()) {
      const due = fetchedAt + CATALOG_FRESH_TTL_MS
      if (due > now && (nextDue === null || due < nextDue)) nextDue = due
    }
    if (nextDue === null) return
    this.stalenessTimer = setTimeout(() => {
      this.stalenessTimer = null
      void this.runStalenessSweep()
    }, nextDue - now)
  }

  private async runStalenessSweep(): Promise<void> {
    if (this.stalenessSweeping) return
    this.stalenessSweeping = true
    try {
      const stale = [...this.refreshedAt.keys()].filter((projectId) => {
        const fetchedAt = this.refreshedAt.get(projectId) ?? 0
        return Date.now() - fetchedAt >= CATALOG_FRESH_TTL_MS
      })
      if (stale.length > 0) {
        await Promise.all(stale.map((projectId) => this.refresh(projectId, true)))
      }
    } finally {
      this.stalenessSweeping = false
      // Re-arm for the next expiry.
      this.scheduleStalenessSweep()
    }
  }

  /** Force-invalidate the cache for all projects. Use when provider availability changes. */
  invalidateAll(): void {
    this.refreshedAt.clear()
  }

  /** Overlay a saved custom provider onto every cached project immediately. */
  upsertCustomProvider(provider: BaseUrlProvider): void {
    this.customOverrides.set(this.customKey(provider.harnessId, provider.id), provider)
    this.invalidateAll()
  }

  /** Remove a deleted custom provider from every cached project immediately. */
  removeCustomProvider(harnessId: string, providerId: string): void {
    this.customOverrides.set(this.customKey(harnessId, providerId), null)
    this.invalidateAll()
  }

  private applyCustomOverrides(catalogs: ProviderCatalog[]): ProviderCatalog[] {
    const overriddenKeys = new Set(this.customOverrides.keys())
    const merged = catalogs.filter(
      (catalog) => !overriddenKeys.has(this.customKey(catalog.harnessId, catalog.id))
    )
    for (const provider of this.customOverrides.values()) {
      if (!provider?.enabled) continue
      merged.push({
        id: provider.id,
        name: provider.name,
        harnessId: provider.harnessId,
        models: provider.models.map((model) => ({
          id: model.id,
          providerId: provider.id,
          name: model.name,
          reasoning: model.reasoning,
          thinkingPresets: model.thinkingPresets,
          attachment: model.vision !== false,
          toolcall: true,
          contextWindow: model.contextWindow,
          fastSupported: false
        }))
      })
    }
    return merged
  }

  private customKey(harnessId: string, providerId: string): string {
    return `${harnessId}:${providerId}`
  }
}

export const providerCatalog = new ProviderCatalogStore()
