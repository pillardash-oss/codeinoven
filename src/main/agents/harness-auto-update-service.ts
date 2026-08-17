import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import { Logger } from '../system/logger'
import type { StorageEngine } from '../storage/storage-engine'

const AUTO_UPDATE_STORE_PATH = 'harness-auto-update.json'

/**
 * Per-harness "update automatically on launch" preference. Only the set of
 * harnesses the user opted into auto-updating is persisted (an absent id means
 * off). Main never runs an update on its own — the renderer reads these
 * preferences at startup, checks for available updates, and launches the
 * harness's own self-update command in an embedded terminal.
 */
export class HarnessAutoUpdateService {
  private enabled = new Map<string, boolean>()
  private loaded = false
  private loadPromise: Promise<void> | null = null

  constructor(private readonly storage: StorageEngine) {}

  /** Load persisted preferences once; safe to call concurrently. */
  load(): Promise<void> {
    if (this.loaded) return Promise.resolve()
    this.loadPromise ??= this.loadFromStorage()
    return this.loadPromise
  }

  private async loadFromStorage(): Promise<void> {
    try {
      const stored = await this.storage.read<Record<string, boolean>>(AUTO_UPDATE_STORE_PATH)
      if (stored) {
        for (const [harnessId, value] of Object.entries(stored)) {
          if (typeof value === 'boolean') this.enabled.set(harnessId, value)
        }
      }
    } catch (error) {
      Logger.info('Harness auto-update store could not be loaded; starting fresh', {
        detail: error instanceof Error ? error.message : String(error)
      })
    }
    this.loaded = true
  }

  private async persist(): Promise<void> {
    await this.storage.write(AUTO_UPDATE_STORE_PATH, Object.fromEntries(this.enabled))
  }

  /** Whether a harness should be auto-updated on launch. */
  async enabledFor(harnessId: string): Promise<boolean> {
    await this.load()
    return this.enabled.get(harnessId) ?? false
  }

  /** The full preference snapshot keyed by harness id (renderer surface). */
  async list(): Promise<Record<string, boolean>> {
    await this.load()
    return Object.fromEntries(this.enabled)
  }

  /** Set (or clear, when `false`) the auto-update preference for a harness. */
  async set(harnessId: string, value: boolean): Promise<void> {
    await this.load()
    if (value) {
      this.enabled.set(harnessId, true)
    } else {
      this.enabled.delete(harnessId)
    }
    await this.persist()
  }

  register(): void {
    ipcMain.handle('harnessAutoUpdate:list', () => this.list())
    ipcMain.handle('harnessAutoUpdate:set', (_, raw: unknown) => {
      const input = raw as { harnessId: string; value: boolean } | null
      if (!input || typeof input.harnessId !== 'string' || input.harnessId.trim().length === 0) {
        throw new TypeError('Harness ID is required')
      }
      if (input.harnessId.trim().length > 256) {
        throw new TypeError('Harness ID is too long')
      }
      if (typeof input.value !== 'boolean') {
        throw new TypeError('Auto-update value must be a boolean')
      }
      return this.set(input.harnessId.trim(), input.value)
    })
  }
}
