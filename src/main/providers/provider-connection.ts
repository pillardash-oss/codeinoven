import { BrowserWindow } from 'electron'
import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import type { ProviderConnectionInfo } from '../../lib/types'
import { parseOpenCodeMajor } from '../../lib/opencode-version'
import { selectNewestCandidate } from '../../lib/version-compare'
import {
  findHarness,
  harnessSupportsManualCompaction,
  listHarnesses,
  type HarnessDescriptor
} from '../agents/harness-registry'
import { rememberOpenCodeInstallation } from '../agents/opencode-installation'
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

/** Every command that can satisfy a harness: its canonical name plus aliases. */
function commandCandidates(definition: HarnessDescriptor): string[] {
  return [definition.command, ...(definition.commandAliases ?? [])]
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
    const runtimes = await discoverHarnessRuntimes(commandCandidates(def), { force: true })
    const result = await this.enqueueProbe(() => this.probe(def, runtimes))
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
      harnesses.flatMap((harness) => commandCandidates(harness)),
      { force }
    )

    for (const [index, definition] of harnesses.entries()) {
      const result = await this.enqueueProbe(() => this.probe(definition, runtimes))
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
    runtimes: Map<string, HarnessRuntime | null>
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

    // Probe every command that can satisfy this harness (canonical + aliases).
    // The newest answering command wins, so a v2 install always supersedes a v1
    // one   and a v1 binary squatting on an alias never masks the real install.
    const candidates: Array<{ version: string; value: HarnessRuntime }> = []
    const failures: string[] = []
    let resolved: HarnessRuntime | null = null
    for (const command of commandCandidates(def)) {
      const runtime = runtimes.get(command)
      if (!runtime) continue
      resolved ??= runtime
      const versionResult = await probeHarnessRuntime(runtime, def.versionArgs)
      if (!versionResult.ok) {
        failures.push(`${command}: ${versionResult.reason}`)
        continue
      }
      const version =
        (versionResult.stdout || versionResult.stderr).split(/\r?\n/u)[0]?.trim() ?? ''
      candidates.push({ version, value: runtime })
    }

    const best = selectNewestCandidate(candidates)
    if (def.id === 'opencode') {
      rememberOpenCodeInstallation(
        best
          ? {
              command: best.value.command,
              version: best.version,
              major: parseOpenCodeMajor(best.version)
            }
          : null
      )
    }

    if (best) {
      return {
        ...base,
        status: 'available',
        resolvedPath: best.value.resolvedPath,
        executionTarget: best.value.target,
        version: best.version,
        ...(best.value.command === def.command ? {} : { activeCommand: best.value.command })
      }
    }

    if (!resolved) {
      return {
        ...base,
        status: 'not_found',
        detail:
          process.platform === 'win32'
            ? `"${def.command}" not found on Windows PATH or in WSL`
            : `"${def.command}" not found on PATH`
      }
    }

    return {
      ...base,
      status: 'error',
      resolvedPath: resolved.resolvedPath,
      executionTarget: resolved.target,
      detail: failures[0] ?? `"${def.command}" did not answer its version probe.`
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
