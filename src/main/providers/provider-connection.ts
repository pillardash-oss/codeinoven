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
import {
  rememberOpenCodeInstallation,
  resolveOpenCodeInstall
} from '../agents/opencode-installation'
import { sendToRenderer } from '../ipc/renderer-delivery'
import {
  discoverHarnessRuntimes,
  probeHarnessRuntime,
  type HarnessRuntime
} from '../drivers/harness-runtime'
import { resolveExecutablePathAsync } from '../drivers/cli-environment'
import { currentAcpAgents, findAcpAgent, isAcpAgentId } from '../drivers/acp/acp-agents-store'

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
  /** Rows for the ACP agents the user added; empty until one exists. */
  private acpRows = new Map<string, ProviderConnectionInfo>()
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
        transport: harness.transport ?? 'native',
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
    this.syncAcpRows()
    return [...this.statuses.values(), ...this.acpRows.values()]
  }

  /**
   * Reconcile the ACP agent rows with the store.
   *
   * ACP agents are the user's, so the row list is derived from what they saved
   * rather than from the harness registry: an agent they removed must lose its
   * row, and one they just added must appear before the next full probe.
   */
  private syncAcpRows(): void {
    for (const agent of currentAcpAgents()) {
      const existing = this.acpRows.get(agent.id)
      if (existing?.name === agent.name && existing.command === agent.command) continue
      this.acpRows.set(agent.id, {
        id: agent.id,
        name: agent.name,
        command: agent.command,
        integration: 'ready',
        supportsCustomProviders: false,
        supportsManualCompaction: false,
        transport: 'acp',
        status: existing?.status ?? 'idle',
        ...(existing?.resolvedPath ? { resolvedPath: existing.resolvedPath } : {})
      })
    }
    const known = new Set(currentAcpAgents().map((agent) => agent.id))
    for (const id of [...this.acpRows.keys()]) {
      if (!known.has(id)) this.acpRows.delete(id)
    }
  }

  /** Probe one ACP agent's command. No version arg: the app never installed it. */
  private async probeAcpAgent(id: string): Promise<ProviderConnectionInfo> {
    this.syncAcpRows()
    const agent = await findAcpAgent(id)
    const row = this.acpRows.get(id) ?? {
      id,
      name: id,
      command: id,
      integration: 'ready' as const,
      supportsCustomProviders: false,
      supportsManualCompaction: false,
      transport: 'acp' as const,
      status: 'error' as const,
      detail: 'This ACP agent is no longer configured.'
    }
    if (!agent) return { ...row, status: 'error', detail: 'This ACP agent is no longer configured.' }
    const resolvedPath = await resolveExecutablePathAsync(agent.command)
    const result: ProviderConnectionInfo = resolvedPath
      ? { ...row, name: agent.name, command: agent.command, status: 'available', resolvedPath }
      : {
          ...row,
          name: agent.name,
          command: agent.command,
          status: 'error',
          resolvedPath: undefined,
          detail: `"${agent.command}" was not found on PATH.`
        }
    this.acpRows.set(id, result)
    this.broadcast()
    this.noteSettled(result)
    return result
  }

  async checkOne(id: string): Promise<ProviderConnectionInfo> {
    const active = this.checkOneInFlight.get(id)
    if (active) return active

    const check = isAcpAgentId(id) ? this.probeAcpAgent(id) : this.runCheckOne(id)
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
          transport: 'native',
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

    for (const agent of currentAcpAgents()) {
      await this.enqueueProbe(() => this.probeAcpAgent(agent.id))
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
      transport: def.transport ?? 'native',
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
      // A bundled runtime already knows its own version from the build that
      // shipped it. Probing it would spawn a whole Electron run-as-node process
      // to parse the harness bundle for one line, which is the single most
      // expensive part of opening Harnesses on a weak machine.
      if (runtime.target.kind === 'bundled' && runtime.version) {
        candidates.push({ version: runtime.version, value: runtime })
        continue
      }
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
      // OpenCode has one authority for which install this is: a machine carries
      // a package manager's copy and the harness's own self-updated copy, and
      // resolving the name here would silently pick whichever PATH answers first
      // and report it as this harness's install. The canonical assessment decides
      // instead, and this pass defers to it.
      const canonical = await resolveOpenCodeInstall()
      if (canonical) {
        return {
          ...base,
          status: 'available',
          resolvedPath: canonical.runtime.resolvedPath,
          executionTarget: canonical.runtime.target,
          version: canonical.version,
          ...(canonical.command === def.command ? {} : { activeCommand: canonical.command })
        }
      }
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
