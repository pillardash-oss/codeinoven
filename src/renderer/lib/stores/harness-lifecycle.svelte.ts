import type {
  HarnessInstallHandoff,
  HarnessRuntimeRestartResult,
  HarnessUninstallHandoff,
  HarnessUpdateHandoff,
  HarnessUpdateStatus
} from '$shared/types'
import { invoke } from '$lib/ipc.svelte'
import { reportError } from './app-errors.svelte'
import { providerStore } from '$lib/stores/providers.svelte'

/** Reuse recent update results when Settings remounts or startup checks overlap. */
const LOCAL_UPDATE_TTL_MS = 5 * 60_000

/** What the embedded terminal is doing for this harness. */
export type HarnessRunKind = 'install' | 'update' | 'uninstall'

export interface HarnessRun {
  kind: HarnessRunKind
  harnessId: string
  harnessName: string
  terminalId: string
  handoff: HarnessInstallHandoff | HarnessUpdateHandoff | HarnessUninstallHandoff
  /** Set once the process exits. */
  exitCode?: number
}

/**
 * App-wide harness lifecycle orchestration: update/install badge statuses,
 * running update + uninstall terminal sessions, and dock/panel visibility.
 * Owned here — not by the Harnesses settings page — so the panel floats above
 * every view and keeps running (its PTY sessions alive) while the user
 * navigates the app.
 */
class HarnessLifecycleStore {
  statuses = $state<Record<string, HarnessUpdateStatus>>({})
  runs = $state<HarnessRun[]>([])
  minimized = $state(false)
  focusedHarnessId = $state<string | null>(null)
  private lastCheckedAt = 0
  private checkAllInFlight: Promise<void> | null = null

  get activeCount(): number {
    return this.runs.filter((run) => run.exitCode === undefined).length
  }

  get finishedCount(): number {
    return this.runs.filter((run) => run.exitCode !== undefined).length
  }

  /** All started runs have exited — the panel may now be closed. */
  get hasFinished(): boolean {
    return this.runs.length > 0 && this.activeCount === 0
  }

  updateAvailableFor(harnessId: string): HarnessUpdateStatus | undefined {
    const status = this.statuses[harnessId]
    return status?.state === 'update_available' ? status : undefined
  }

  isRunning(harnessId: string): boolean {
    return this.runs.some((run) => run.harnessId === harnessId && run.exitCode === undefined)
  }

  /** Fire the async update check for every harness. */
  async checkAll(force = false): Promise<void> {
    if (!force && Date.now() - this.lastCheckedAt < LOCAL_UPDATE_TTL_MS) return
    if (this.checkAllInFlight) return this.checkAllInFlight

    const check = this.runCheckAll(force)
    this.checkAllInFlight = check
    try {
      await check
    } finally {
      this.checkAllInFlight = null
    }
  }

  private async runCheckAll(force: boolean): Promise<void> {
    try {
      const statuses = await invoke('harnessUpdates:checkAll', force)
      const next: Record<string, HarnessUpdateStatus> = {}
      for (const status of statuses) next[status.harnessId] = status
      this.statuses = next
      this.lastCheckedAt = Date.now()
    } catch {
      // Offline or IPC failure — existing results stay visible.
    }
  }

  async checkOne(harnessId: string): Promise<void> {
    try {
      const status = await invoke('harnessUpdates:check', harnessId)
      this.statuses = { ...this.statuses, [harnessId]: status }
    } catch {
      // Leave the current badge state untouched.
    }
  }

  /** Launch a harness's own self-update command in an embedded terminal. */
  async startUpdate(
    harnessId: string,
    harnessName: string,
    options?: { docked?: boolean }
  ): Promise<void> {
    if (this.isRunning(harnessId)) return
    try {
      const handoff = await invoke('harnessUpdates:handoff', harnessId)
      this.pushRun({ kind: 'update', harnessId, harnessName, handoff }, options?.docked ?? false)
    } catch (updateError) {
      reportError(updateError, 'Update failed to start.')
    }
  }

  /** Launch a harness's documented uninstall command in an embedded terminal. */
  async startUninstall(harnessId: string, harnessName: string): Promise<void> {
    if (this.isRunning(harnessId)) return
    try {
      const handoff = await invoke('harnessUninstall:handoff', harnessId)
      this.pushRun({ kind: 'uninstall', harnessId, harnessName, handoff })
    } catch (uninstallError) {
      reportError(uninstallError, 'Uninstall failed to start.')
    }
  }

  /** Launch a harness's documented install command in an embedded terminal. */
  async startInstall(harnessId: string, harnessName: string): Promise<void> {
    if (this.isRunning(harnessId)) return
    try {
      const handoff = await invoke('harnessInstall:handoff', harnessId)
      this.pushRun({ kind: 'install', harnessId, harnessName, handoff })
    } catch (installError) {
      reportError(installError, 'Install failed to start.')
    }
  }

  /**
   * Restart a harness's resident transports so the next turn runs the build
   * currently on disk.
   *
   * CodeInOven keeps long-lived harness processes (OpenCode's server, Codex's
   * app-server daemon, Pi's per-session RPC client) that were spawned from the
   * install present at the time. A harness self-update only replaces the CLI on
   * disk, so without a restart the app keeps talking to the old build   and the
   * version badge, which re-reads the new binary, reports the update as applied
   * while sessions still run the old one.
   *
   * Main never takes a transport away from a thread that is still running
   * unless `force` is set, and remembers the request so it is applied as soon
   * as the harness goes quiet. Returns undefined when the call itself failed.
   */
  async restartHarness(
    harnessId: string,
    options?: { force?: boolean }
  ): Promise<HarnessRuntimeRestartResult | undefined> {
    try {
      return await invoke('harnessRuntime:restart', harnessId, { force: options?.force === true })
    } catch (restartError) {
      reportError(restartError, 'Harness restart failed.')
      return undefined
    }
  }

  /**
   * Restart a harness now, even while threads are mid-turn. Only for the manual
   * action, whose confirmation has already told the user that in-session
   * threads may stop working. Re-probes afterwards so the version badge reflects
   * whatever is on disk now.
   */
  async restartHarnessNow(harnessId: string): Promise<boolean> {
    const result = await this.restartHarness(harnessId, { force: true })
    if (!result) return false
    if (!result.restarted) {
      if (result.detail) reportError(new Error(result.detail), 'Harness restart skipped.')
      return false
    }
    await this.checkOne(harnessId)
    return true
  }

  /**
   * Fire-and-forget auto-update on app open: probe installed harnesses, then
   * start the self-update terminal for every harness that opted in to auto-update
   * and has an update available. Runs asynchronously so it never blocks first
   * paint. Best-effort — failures are swallowed (the dock still shows any runs).
   */
  async autoUpdateOnStartup(): Promise<void> {
    try {
      // Wait for the optional harness/provider services to be registered after
      // first paint (they resolve after `app:waitForFeatures`), then read prefs.
      const prefs = await this.waitForReady()
      if (!prefs) return
      const enabledIds = Object.keys(prefs).filter((harnessId) => prefs[harnessId])
      if (enabledIds.length === 0) return

      await providerStore.init()
      // Probe installed versions first — update availability compares the
      // freshly detected installed version against the published latest.
      await providerStore.checkAll()
      await this.checkAll()

      this.autoManagedBatch = true

      for (const provider of providerStore.providers) {
        if (enabledIds.includes(provider.id) && this.updateAvailableFor(provider.id)) {
          // Docked: the panel stays collapsed to its dock chip so a
          // quiet background update never opens a modal over the workspace.
          await this.startUpdate(provider.id, provider.name, { docked: true })
        }
      }
    } catch {
      // Auto-update is best-effort on startup.
    }
  }

  /** Whether the current run set came from the startup auto-update batch. */
  private autoManagedBatch = false

  /** Poll the persisted auto-update prefs until the service is ready. */
  private async waitForReady(): Promise<Record<string, boolean> | undefined> {
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        return await invoke('harnessAutoUpdate:list')
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
    return undefined
  }

  /** One process exited: record it, then re-probe so version/badge refresh. */
  async handleRunExit(harnessId: string, exitCode: number): Promise<void> {
    const finished = this.runs.find(
      (run) => run.harnessId === harnessId && run.exitCode === undefined
    )
    this.runs = this.runs.map((run) =>
      run.harnessId === harnessId && run.exitCode === undefined ? { ...run, exitCode } : run
    )
    try {
      await invoke('providers:check', harnessId)
    } catch {
      // Version re-probe is best-effort after a lifecycle run.
    }
    await this.checkOne(harnessId)

    // An update (or install) only replaced the CLI on disk. The harness's
    // resident process still runs the previous build, so ask for a restart now:
    // main skips it while a thread is using the harness and applies it as soon
    // as the harness goes quiet.
    if (exitCode === 0 && (finished?.kind === 'update' || finished?.kind === 'install')) {
      await this.restartHarness(harnessId)
    }

    // Auto-managed batches close themselves once every run has finished so the
    // user is never left with a stale panel after a quiet startup update.
    if (this.autoManagedBatch && this.hasFinished) {
      this.autoManagedBatch = false
      this.close()
    }
  }

  minimize = (): void => {
    this.minimized = true
  }

  expandAll = (): void => {
    this.focusedHarnessId = null
    this.minimized = false
  }

  focusRun = (harnessId: string): void => {
    this.focusedHarnessId = harnessId
    this.minimized = false
  }

  close = (): void => {
    this.runs = []
    this.minimized = false
    this.focusedHarnessId = null
    this.autoManagedBatch = false
  }

  private pushRun(run: Omit<HarnessRun, 'terminalId'>, docked = false): void {
    this.runs = [
      ...this.runs,
      {
        ...run,
        terminalId: `harness-${run.kind}-${crypto.randomUUID()}`
      }
    ]
    // Auto-managed batches stay docked (chip only, no opened modal) unless the
    // user explicitly expands the panel; user-initiated runs open the panel.
    this.minimized = docked
    this.focusedHarnessId = null
  }
}

export const harnessLifecycleStore = new HarnessLifecycleStore()
