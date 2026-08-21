import type {
  HarnessUninstallHandoff,
  HarnessUpdateHandoff,
  HarnessUpdateStatus
} from '$shared/types'
import { invoke } from '$lib/ipc.svelte'
import { toast } from 'svelte-sonner'
import { providerStore } from '$lib/stores/providers.svelte'

/** Reuse recent update results when Settings remounts or startup checks overlap. */
const LOCAL_UPDATE_TTL_MS = 5 * 60_000

/** What the embedded terminal is doing for this harness. */
export type HarnessRunKind = 'update' | 'uninstall'

export interface HarnessRun {
  kind: HarnessRunKind
  harnessId: string
  harnessName: string
  terminalId: string
  handoff: HarnessUpdateHandoff | HarnessUninstallHandoff
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
  async startUpdate(harnessId: string, harnessName: string): Promise<void> {
    if (this.isRunning(harnessId)) return
    try {
      const handoff = await invoke('harnessUpdates:handoff', harnessId)
      this.pushRun({ kind: 'update', harnessId, harnessName, handoff })
    } catch (updateError) {
      const message = updateError instanceof Error ? updateError.message : 'Update failed to start.'
      toast.error(message)
    }
  }

  /** Launch a harness's documented uninstall command in an embedded terminal. */
  async startUninstall(harnessId: string, harnessName: string): Promise<void> {
    if (this.isRunning(harnessId)) return
    try {
      const handoff = await invoke('harnessUninstall:handoff', harnessId)
      this.pushRun({ kind: 'uninstall', harnessId, harnessName, handoff })
    } catch (uninstallError) {
      const message =
        uninstallError instanceof Error ? uninstallError.message : 'Uninstall failed to start.'
      toast.error(message)
    }
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

      for (const provider of providerStore.providers) {
        if (enabledIds.includes(provider.id) && this.updateAvailableFor(provider.id)) {
          await this.startUpdate(provider.id, provider.name)
        }
      }
    } catch {
      // Auto-update is best-effort on startup.
    }
  }

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
    this.runs = this.runs.map((run) =>
      run.harnessId === harnessId && run.exitCode === undefined ? { ...run, exitCode } : run
    )
    try {
      await invoke('providers:check', harnessId)
    } catch {
      // Version re-probe is best-effort after a lifecycle run.
    }
    await this.checkOne(harnessId)
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
  }

  private pushRun(run: Omit<HarnessRun, 'terminalId'>): void {
    this.runs = [
      ...this.runs,
      {
        ...run,
        terminalId: `harness-${run.kind}-${crypto.randomUUID()}`
      }
    ]
    this.minimized = false
    this.focusedHarnessId = null
  }
}

export const harnessLifecycleStore = new HarnessLifecycleStore()
