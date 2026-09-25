import { realpath } from 'node:fs/promises'
import { basename } from 'node:path'
import {
  DirectoryPreviewServer,
  type DirectoryPreviewChangeListener,
  type DirectoryPreviewEndpoint
} from './directory-preview-server'
import { appServiceRegistry } from '../system/app-service-registry'
import { Logger } from '../system/logger'

/** Registry id for one served directory, stable across re-registration. */
function previewServiceId(root: string): string {
  return `directory-preview:${root}`
}

/**
 * Lifecycle owner for directory preview servers.
 *
 * Each previewed directory keeps its own loopback origin (see
 * `DirectoryPreviewServer` for why), so this service is what stops an operator
 * who opens many folders from accumulating listeners and ports indefinitely:
 * registrations are reused per directory and the least recently used server is
 * torn down past {@link MAX_LIVE_SERVERS}. Closing a server drops its
 * keep-alive connections immediately, so nothing lingers behind the cap.
 */
export const MAX_LIVE_SERVERS = 8

interface LivePreview {
  server: DirectoryPreviewServer
  endpoint: DirectoryPreviewEndpoint
  touchedAt: number
}

export interface DirectoryPreviewRegistration {
  url: string
  port: number
  /** Canonical directory that is being served. */
  root: string
  /** True when this call started a new server instead of reusing one. */
  started: boolean
}

export class DirectoryPreviewService {
  private readonly live = new Map<string, LivePreview>()
  private changeListener: DirectoryPreviewChangeListener | null = null

  /**
   * Register who refreshes a preview when its files change. The app supplies the
   * browser side of this, because refreshing means finding the tab that is
   * showing the origin and reloading it, and this service knows nothing about
   * browsers.
   */
  setChangeListener(listener: DirectoryPreviewChangeListener | null): void {
    this.changeListener = listener
  }

  /**
   * Serve one directory over its own loopback origin and return its URL.
   * `directory` is resolved through `realpath` so the same folder always maps
   * to one registration, however it was spelled by the caller.
   */
  async open(directory: string): Promise<DirectoryPreviewRegistration> {
    const root = await realpath(directory)
    const existing = this.live.get(root)
    if (existing) {
      existing.touchedAt = Date.now()
      return { ...existing.endpoint, root, started: false }
    }
    const server = new DirectoryPreviewServer(root, (change) => this.changeListener?.(change))
    const endpoint = await server.start()
    this.live.set(root, { server, endpoint, touchedAt: Date.now() })
    // Announce the served folder so the task manager shows the design or file
    // preview server the app opened, not only the OS processes it spawned.
    appServiceRegistry.register({
      id: previewServiceId(root),
      kind: 'server',
      name: `Preview server: ${basename(root) || root}`,
      detail: root,
      scope: 'app',
      port: endpoint.port,
      url: endpoint.url,
      stop: () => this.close(root)
    })
    await this.evictBeyondCapacity(root)
    return { ...endpoint, root, started: true }
  }

  /** Close one served directory and drop it from the task manager. */
  async close(root: string): Promise<void> {
    const entry = this.live.get(root)
    if (!entry) return
    this.live.delete(root)
    appServiceRegistry.unregister(previewServiceId(root))
    await entry.server.dispose().catch(() => undefined)
  }

  /** Live preview count, used by diagnostics and tests. */
  get size(): number {
    return this.live.size
  }

  async dispose(): Promise<void> {
    const entries = [...this.live.entries()]
    this.live.clear()
    for (const [root] of entries) appServiceRegistry.unregister(previewServiceId(root))
    await Promise.all(entries.map(([, entry]) => entry.server.dispose().catch(() => undefined)))
  }

  private async evictBeyondCapacity(keep: string): Promise<void> {
    if (this.live.size <= MAX_LIVE_SERVERS) return
    const candidates = [...this.live.entries()]
      .filter(([root]) => root !== keep)
      .sort((left, right) => left[1].touchedAt - right[1].touchedAt)
    const evicted: DirectoryPreviewServer[] = []
    while (this.live.size > MAX_LIVE_SERVERS && candidates.length > 0) {
      const oldest = candidates.shift()
      if (!oldest) break
      const [root, entry] = oldest
      if (this.live.get(root) !== entry) continue
      this.live.delete(root)
      appServiceRegistry.unregister(previewServiceId(root))
      evicted.push(entry.server)
    }
    if (evicted.length === 0) return
    Logger.dev('Directory preview servers evicted', { evicted: evicted.length })
    await Promise.all(evicted.map((server) => server.dispose().catch(() => undefined)))
  }
}
