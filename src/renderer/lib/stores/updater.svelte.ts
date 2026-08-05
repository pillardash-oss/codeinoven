import { invoke, subscribe } from '$lib/ipc.svelte'
import type { UpdaterStatus } from '$shared/ipc-contract'

class UpdaterState {
  status = $state<UpdaterStatus>({
    canAutoUpdate: false,
    state: 'idle'
  })
  waitingForThreads = $state(0)

  private cleanups: Array<() => void> = []

  init(): void {
    void this.refresh()

    const unsubStatus = subscribe('updater:status', (status) => {
      this.status = status
    })
    this.cleanups.push(unsubStatus)

    const unsubWaiting = subscribe('updater:waiting-for-threads', (count) => {
      this.waitingForThreads = count
    })
    this.cleanups.push(unsubWaiting)
  }

  destroy(): void {
    for (const cleanup of this.cleanups) cleanup()
    this.cleanups = []
  }

  async refresh(): Promise<void> {
    try {
      this.status = await invoke('updater:getStatus')
    } catch {
      // Updater not available — use default idle state
    }
  }

  async checkForUpdates(): Promise<void> {
    try {
      this.status = await invoke('updater:check')
    } catch (error: unknown) {
      this.status = {
        canAutoUpdate: false,
        state: 'error',
        errorMessage: error instanceof Error ? error.message : 'Failed to check for updates'
      }
    }
  }

  async downloadUpdate(): Promise<void> {
    try {
      await invoke('updater:download')
    } catch (error: unknown) {
      this.status = {
        canAutoUpdate: false,
        state: 'error',
        errorMessage: error instanceof Error ? error.message : 'Failed to download update'
      }
    }
  }

  async installUpdate(): Promise<void> {
    try {
      await invoke('updater:install')
    } catch {
      // Install is fire-and-forget — app may quit
    }
  }
}

export const updaterState = new UpdaterState()
