import { BrowserWindow } from 'electron'
import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import type { ProviderConnectionInfo } from '../../lib/types'
import {
  findHarness,
  harnessSupportsManualCompaction,
  listHarnesses,
  type HarnessDescriptor
} from '../agents/harness-registry'
import { sendToRenderer } from '../ipc/renderer-delivery'
import {
  discoverHarnessRuntimes,
  probeHarnessRuntime,
  type HarnessRuntime
} from '../drivers/harness-runtime'

/** Reopening Settings inside this window reuses the last completed probe pass. */
const PROBE_CACHE_TTL_MS = 60_000
/** Give Electron's main loop time between child processes on low-end machines. */
const PROBE_YIELD_MS = 50
/** Coalesce renderer work while still reporting progress during a full pass. */
const PROBE_BROADCAST_BATCH_SIZE = 2

/**
 * The `opencode` command resolved to an OpenCode V2 binary. That entry's driver
 * speaks the v1 API only, so the install is reported as installed-but-not-
 * drivable here; the `opencode2` entry owns V2. The Harnesses page surfaces
 * this as a notice rather than treating it as a working install.
 */
export const OPENCODE_V2_UNSUPPORTED_DETAIL =
  'This binary reports OpenCode V2. Use the OpenCode V2 entry for this harness.'

/** True when a `--version` line reports a major version >= 2 (OpenCode V2). */
function isOpenCodeV2(version: string): boolean {
  const match = /(\d+)/u.exec(version)
  const major = match ? Number.parseInt(match[1], 10) : Number.NaN
  return Number.isFinite(major) && major >= 2
}

/**
 * ProviderConnectionService   detects local AI harnesses by resolving their
 * binaries on an augmented PATH and verifying they respond to a version probe.
 * Broadcasts live status to all renderer windows over IPC. The harness list is
 * sourced from the harness registry   the single source of truth.
 */
export class ProviderConnectionService {
  private statuses = new Map<string, ProviderConnectionInfo>()
  private lastCheckedAt = 0
  private checkAllInFlight: Promise<ProviderConnectionInfo[]> | null = null
  private checkOneInFlight = new Map<string, Promise<ProviderConnectionInfo>>()
  private probeQueueTail: Promise<void> = Promise.resolve()
  /** Last settled (non-probing) result per harness, for change detection. */
  private lastSettled = new Map<string, ProviderConnectionInfo>()
  /** Fired when a probe changes a harness's install state (status/version). */
  private readonly onStatusesChanged?: () => void

  constructor(onStatusesChanged?: () => void) {
    this.onStatusesChanged = onStatusesChanged
    for (const harness of listHarnesses()) {
      this.statuses.set(harness.id, {
        id: harness.id,
        name: harness.name,
        command: harness.command,
        integration: harness.integration,
        supportsCustomProviders: harness.supportsCustomProviders,
        supportsManualCompaction: harnessSupportsManualCompaction(harness.id),
        status: 'idle'
      })
    }
  }

  register(): void {
    ipcMain.handle('providers:getStatus', () => this.getAll())
    ipcMain.handle('providers:check', (_, id: string) => this.checkOne(id))
    ipcMain.handle('providers:checkAll', (_, force?: unknown) => this.checkAll(force === true))
  }

  getAll(): ProviderConnectionInfo[] {
    return Array.from(this.statuses.values())
  }

  async checkOne(id: string): Promise<ProviderConnectionInfo> {
    const active = this.checkOneInFlight.get(id)
    if (active) return active

    const check = this.runCheckOne(id)
    this.checkOneInFlight.set(id, check)
    try {
      return await check
    } finally {
      this.checkOneInFlight.delete(id)
    }
  }

  private async runCheckOne(id: string): Promise<ProviderConnectionInfo> {
    const def = findHarness(id)
    const current = this.statuses.get(id)
    if (!def || !current) {
      return (
        current ?? {
          id,
          name: id,
          command: id,
          integration: 'planned',
          supportsCustomProviders: false,
          supportsManualCompaction: false,
          status: 'error',
          detail: 'Unknown provider'
        }
      )
    }

    this.update({ ...current, status: 'checking', detail: undefined })
    const runtime = (await discoverHarnessRuntimes([def.command], { force: true })).get(def.command)
    const result = await this.enqueueProbe(() => this.probe(def, runtime ?? null))
    this.update(result)
    return result
  }

  async checkAll(force = false): Promise<ProviderConnectionInfo[]> {
    if (!force && Date.now() - this.lastCheckedAt < PROBE_CACHE_TTL_MS) return this.getAll()
    if (this.checkAllInFlight) return this.checkAllInFlight

    const check = this.runCheckAll(force)
    this.checkAllInFlight = check
    try {
      return await check
    } finally {
      this.checkAllInFlight = null
    }
  }

  private async runCheckAll(force: boolean): Promise<ProviderConnectionInfo[]> {
    const harnesses = listHarnesses()
    for (const definition of harnesses) {
      const current = this.statuses.get(definition.id)
      if (current) {
        this.statuses.set(definition.id, {
          ...current,
          status: 'checking',
          detail: undefined
        })
      }
    }
    this.broadcast()
    const runtimes = await discoverHarnessRuntimes(
      harnesses.map((harness) => harness.command),
      { force }
    )

    for (const [index, definition] of harnesses.entries()) {
      const result = await this.enqueueProbe(() =>
        this.probe(definition, runtimes.get(definition.command) ?? null)
      )
      this.statuses.set(result.id, result)
      this.noteSettled(result)
      if ((index + 1) % PROBE_BROADCAST_BATCH_SIZE === 0 || index === harnesses.length - 1) {
        this.broadcast()
      }
      if (index < harnesses.length - 1) await this.yieldToMainLoop()
    }

    this.lastCheckedAt = Date.now()
    return this.getAll()
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  private update(info: ProviderConnectionInfo): void {
    this.statuses.set(info.id, info)
    this.broadcast()
    this.noteSettled(info)
  }

  /**
   * Record a settled (non-probing) result and fire `onStatusesChanged` when the
   * harness's install state or version differs from the last settled probe  
   * e.g. pi was just installed or upgraded while the app is running.
   */
  private noteSettled(info: ProviderConnectionInfo): void {
    if (info.status === 'checking' || info.status === 'idle') return
    const settled = this.lastSettled.get(info.id)
    this.lastSettled.set(info.id, info)
    if (
      settled &&
      (settled.status !== info.status || (settled.version ?? '') !== (info.version ?? ''))
    ) {
      this.onStatusesChanged?.()
    }
  }

  private broadcast(): void {
    const payload = this.getAll()
    for (const win of BrowserWindow.getAllWindows()) {
      sendToRenderer(win.webContents, 'providers:status', payload)
    }
  }

  /** Resolve the binary, then verify it actually responds to a version probe. */
  private async probe(
    def: HarnessDescriptor,
    runtime: HarnessRuntime | null
  ): Promise<ProviderConnectionInfo> {
    const base: ProviderConnectionInfo = {
      id: def.id,
      name: def.name,
      command: def.command,
      integration: def.integration,
      supportsCustomProviders: def.supportsCustomProviders,
      supportsManualCompaction: harnessSupportsManualCompaction(def.id),
      status: 'idle'
    }

    if (!runtime) {
      return {
        ...base,
        status: 'not_found',
        detail:
          process.platform === 'win32'
            ? `"${def.command}" not found on Windows PATH or in WSL`
            : `"${def.command}" not found on PATH`
      }
    }

    const versionResult = await probeHarnessRuntime(runtime, def.versionArgs)
    if (versionResult.ok) {
      const version =
        (versionResult.stdout || versionResult.stderr).split(/\r?\n/u)[0]?.trim() ?? ''
      // The v1 `opencode` entry cannot drive a v2 binary: the API moved to
      // `/api/*` with Basic auth. Report it as installed-but-not-drivable here
      // and let the dedicated `opencode2` entry own V2.
      if (def.id === 'opencode' && isOpenCodeV2(version)) {
        return {
          ...base,
          status: 'error',
          resolvedPath: runtime.resolvedPath,
          executionTarget: runtime.target,
          version,
          unsupportedReason: 'opencode-v2',
          detail: OPENCODE_V2_UNSUPPORTED_DETAIL
        }
      }
      // The `opencode2` entry must actually be the v2 binary. A v1 binary on
      // that command (e.g. a stale alias) would otherwise be reported as a
      // working V2 install and fail later.
      if (def.id === 'opencode2' && !isOpenCodeV2(version)) {
        return {
          ...base,
          status: 'error',
          resolvedPath: runtime.resolvedPath,
          executionTarget: runtime.target,
          version,
          detail: `"opencode2" reported a non-V2 version (${version || 'unknown'}).`
        }
      }
      return {
        ...base,
        status: 'available',
        resolvedPath: runtime.resolvedPath,
        executionTarget: runtime.target,
        version
      }
    }

    return {
      ...base,
      status: 'error',
      resolvedPath: runtime.resolvedPath,
      executionTarget: runtime.target,
      detail: versionResult.reason
    }
  }

  private yieldToMainLoop(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, PROBE_YIELD_MS))
  }

  /** Serialize every version process, including overlapping windows and row clicks. */
  private enqueueProbe<T>(task: () => Promise<T>): Promise<T> {
    const preceding = this.probeQueueTail
    let release: () => void = () => undefined
    this.probeQueueTail = new Promise<void>((resolve) => {
      release = resolve
    })
    return preceding.then(task).finally(release)
  }
}
