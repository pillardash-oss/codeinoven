import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import type { OpenCodeV2DiscoveryResult } from '../../lib/types'
import { resolvedOpenCodeCommand } from '../agents/opencode-installation'
import { Logger } from '../system/logger'
import { discoverOpenCodeV2Catalog } from './opencode-v2-discovery'

/** How long a completed catalog read is reused before a fresh server spawn. */
const CATALOG_CACHE_TTL_MS = 120_000

/**
 * Read-only OpenCode V2 catalog discovery.
 *
 * The V2 server is a large native binary, so a discovery run is only ever
 * started on an explicit user action, is coalesced into a single in-flight
 * spawn, and is cached briefly. Nothing here streams or mutates V2 state   this
 * is the read-only catalog half of the one `opencode` harness.
 */
export class OpenCodeV2Service {
  private cached: { result: OpenCodeV2DiscoveryResult; at: number } | null = null
  private inFlight: Promise<OpenCodeV2DiscoveryResult> | null = null

  register(): void {
    ipcMain.handle('opencode:discoverCatalog', (_, force?: unknown) =>
      this.discover(force === true)
    )
  }

  /** Discover (or reuse a recent) V2 catalog. `force` bypasses the cache. */
  async discover(force = false): Promise<OpenCodeV2DiscoveryResult> {
    const cached = this.cached
    if (!force && cached && Date.now() - cached.at < CATALOG_CACHE_TTL_MS) {
      return cached.result
    }
    // Coalesce overlapping callers (a dialog reopening, a user double-click)
    // onto one server spawn instead of queuing several hundreds of MB of RAM.
    if (this.inFlight) return this.inFlight

    const run = this.runDiscovery()
    this.inFlight = run
    try {
      return await run
    } finally {
      this.inFlight = null
    }
  }

  private async runDiscovery(): Promise<OpenCodeV2DiscoveryResult> {
    const result = await discoverOpenCodeV2Catalog({ command: resolvedOpenCodeCommand() })
    this.cached = { result, at: Date.now() }
    if (!result.ok) {
      Logger.dev(`OpenCode V2 catalog discovery failed (${result.reason}):`, result.detail)
    }
    return result
  }
}
