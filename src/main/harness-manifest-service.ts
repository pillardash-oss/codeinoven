import { trustedIpcMain as ipcMain } from './trusted-ipc-main'
import type {
  ConfirmedHarnessBehavior,
  HarnessConfirmationSource,
  HarnessManifestEntry
} from '../lib/types'
import { harnessLoadsAgentsMd } from './harness-registry'
import type { HarnessManifestBehavior } from './harness-registry'
import { Logger } from './logger'
import type { StorageEngine } from './storage-engine'

const MANIFEST_STORE_PATH = 'harness-manifest.json'

export type { HarnessManifestBehavior }

/** Persisted shape: declared manifests stay in code; only confirmations are stored. */
interface PersistedHarnessManifest {
  schemaVersion: 1
  confirmed: Record<string, Partial<Record<HarnessManifestBehavior, ConfirmedHarnessBehavior>>>
  /** Epoch ms of the last time each harness actually ran a turn. */
  inUse: Record<string, number>
}

const EMPTY: PersistedHarnessManifest = { schemaVersion: 1, confirmed: {}, inUse: {} }

/**
 * Layered behavior resolution for coding harnesses.
 *
 * Every harness declares its behavior in a versioned manifest (`HarnessManifest`
 * in `harness-registry.ts`). That declaration is the reliable baseline. When a
 * harness is actually used — and its real behavior is confirmed by the user or
 * observed at runtime — the confirmed value is persisted here and takes
 * precedence over the declaration, giving flexibility without mutating the
 * shipped manifest.
 */
export class HarnessManifestService {
  private state: PersistedHarnessManifest = EMPTY
  private loaded = false
  private loadPromise: Promise<void> | null = null

  constructor(private readonly storage: StorageEngine) {}

  /** Load persisted confirmations once; safe to call concurrently. */
  load(): Promise<void> {
    if (this.loaded) return Promise.resolve()
    this.loadPromise ??= this.loadFromStorage()
    return this.loadPromise
  }

  private async loadFromStorage(): Promise<void> {
    try {
      const stored = await this.storage.read<Partial<PersistedHarnessManifest>>(MANIFEST_STORE_PATH)
      if (stored) {
        this.state = {
          schemaVersion: 1,
          confirmed: stored.confirmed ?? {},
          inUse: stored.inUse ?? {}
        }
      }
    } catch (error) {
      Logger.info('Harness manifest store could not be loaded; starting fresh', {
        detail: error instanceof Error ? error.message : String(error)
      })
    }
    this.loaded = true
  }

  private async persist(): Promise<void> {
    await this.storage.write(MANIFEST_STORE_PATH, this.state)
  }

  /**
   * Effective `loadsAgentsMd` for a harness: a confirmed override (user or
   * runtime) wins; otherwise the declared manifest baseline applies.
   */
  async resolveLoadsAgentsMd(harnessId: string): Promise<boolean> {
    await this.load()
    return (
      this.state.confirmed[harnessId]?.['loadsAgentsMd']?.value ?? harnessLoadsAgentsMd(harnessId)
    )
  }

  /**
   * Record that a harness actually ran a turn. Without an explicit user
   * override, the declared behavior becomes a `runtime` confirmation — the
   * harness has been validated in practice. A user override always wins.
   */
  async recordInUse(harnessId: string): Promise<void> {
    await this.load()
    const now = Date.now()
    const existing = this.state.confirmed[harnessId]
    const declared = harnessLoadsAgentsMd(harnessId)
    if (!existing?.['loadsAgentsMd'] || existing['loadsAgentsMd'].source === 'runtime') {
      this.state.confirmed[harnessId] = {
        ...existing,
        loadsAgentsMd: { value: declared, source: 'runtime', confirmedAt: now }
      }
    }
    this.state.inUse[harnessId] = now
    await this.persist()
  }

  /** Explicitly confirm (override) a behavior for a harness. */
  async confirmBehavior(
    harnessId: string,
    behavior: HarnessManifestBehavior,
    value: boolean,
    source: HarnessConfirmationSource = 'user'
  ): Promise<void> {
    await this.load()
    const existing = this.state.confirmed[harnessId] ?? {}
    this.state.confirmed[harnessId] = {
      ...existing,
      [behavior]: { value, source, confirmedAt: Date.now() }
    }
    await this.persist()
  }

  /** Drop a confirmed override so the harness falls back to its declared manifest. */
  async resetBehavior(harnessId: string, behavior: HarnessManifestBehavior): Promise<void> {
    await this.load()
    const existing = this.state.confirmed[harnessId]
    if (!existing || !(behavior in existing)) return
    const remaining: Partial<Record<HarnessManifestBehavior, ConfirmedHarnessBehavior>> = {}
    for (const [key, entry] of Object.entries(existing)) {
      if (key === behavior) continue
      remaining[key as HarnessManifestBehavior] = entry as ConfirmedHarnessBehavior
    }
    this.state.confirmed[harnessId] = remaining
    await this.persist()
  }

  /** Effective behavior views for every known harness (Settings surface). */
  async list(): Promise<HarnessManifestEntry[]> {
    await this.load()
    const harnessIds = new Set<string>([
      ...Object.keys(this.state.confirmed),
      ...Object.keys(this.state.inUse)
    ])
    const entries: HarnessManifestEntry[] = []
    for (const harnessId of harnessIds) {
      const declared = harnessLoadsAgentsMd(harnessId)
      const confirmed = this.state.confirmed[harnessId]?.['loadsAgentsMd']
      entries.push({
        harnessId,
        declared,
        ...(confirmed ? { confirmed } : {}),
        effective: confirmed?.value ?? declared,
        ...(this.state.inUse[harnessId] ? { lastUsedAt: this.state.inUse[harnessId] } : {})
      })
    }
    return entries.sort((a, b) => a.harnessId.localeCompare(b.harnessId))
  }

  /** Register IPC handlers used by the Settings surface. */
  register(): void {
    ipcMain.handle('harnessManifest:list', () => this.list())
    ipcMain.handle('harnessManifest:confirm', (_, raw: unknown) => {
      const input = raw as { harnessId: string; behavior: string; value: boolean } | null
      if (!input || typeof input.harnessId !== 'string' || !input.harnessId.trim()) {
        throw new TypeError('Harness ID is required')
      }
      if (input.behavior !== 'loadsAgentsMd') {
        throw new TypeError(`Unknown manifest behavior: ${String(input.behavior)}`)
      }
      if (typeof input.value !== 'boolean') {
        throw new TypeError('Manifest confirmation value must be a boolean')
      }
      return this.confirmBehavior(input.harnessId, input.behavior, input.value)
    })
    ipcMain.handle('harnessManifest:reset', (_, raw: unknown) => {
      const input = raw as { harnessId: string; behavior: string } | null
      if (!input || typeof input.harnessId !== 'string' || !input.harnessId.trim()) {
        throw new TypeError('Harness ID is required')
      }
      if (input.behavior !== 'loadsAgentsMd') {
        throw new TypeError(`Unknown manifest behavior: ${String(input.behavior)}`)
      }
      return this.resetBehavior(input.harnessId, input.behavior)
    })
  }
}
