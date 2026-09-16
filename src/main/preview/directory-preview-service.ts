import { realpath } from 'node:fs/promises'
import { DirectoryPreviewServer, type DirectoryPreviewEndpoint } from './directory-preview-server'
import { Logger } from '../system/logger'

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
    const server = new DirectoryPreviewServer(root)
    const endpoint = await server.start()
    this.live.set(root, { server, endpoint, touchedAt: Date.now() })
    await this.evictBeyondCapacity(root)
    return { ...endpoint, root, started: true }
  }

  /** Live preview count, used by diagnostics and tests. */
  get size(): number {
    return this.live.size
  }

  async dispose(): Promise<void> {
    const servers = [...this.live.values()].map((entry) => entry.server)
    this.live.clear()
    await Promise.all(servers.map((server) => server.dispose().catch(() => undefined)))
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
      evicted.push(entry.server)
    }
    if (evicted.length === 0) return
    Logger.dev('Directory preview servers evicted', { evicted: evicted.length })
    await Promise.all(evicted.map((server) => server.dispose().catch(() => undefined)))
  }
}
