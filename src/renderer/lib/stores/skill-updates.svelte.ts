import { invoke, subscribe } from '$lib/ipc.svelte'
import type { SkillUpdateStatus } from '$shared/types'

const IDLE: SkillUpdateStatus = {
  running: false,
  tracked: 0,
  lastCheckedAt: null,
  lastFinishedAt: null,
  updated: 0,
  results: []
}

/**
 * Background skill-update state.
 *
 * The pass itself belongs to main: it rides the app-update check cycle and only
 * ever touches skills CodeInOven installed. This store reads the current state
 * once and then follows the push channel, so the Utilities page never polls.
 */
class SkillUpdateStore {
  status = $state<SkillUpdateStatus>({ ...IDLE })

  private cleanups: Array<() => void> = []

  init(): void {
    void this.refresh()
    this.cleanups.push(
      subscribe('utilities:skillUpdates', (status) => {
        this.status = status
      })
    )
  }

  destroy(): void {
    for (const cleanup of this.cleanups) cleanup()
    this.cleanups = []
  }

  async refresh(): Promise<void> {
    try {
      this.status = await invoke('utilities:skillUpdateStatus')
    } catch {
      // Updater unavailable in this runtime   stay idle rather than showing an error.
    }
  }

  /** Explicit pass from the Utilities page; resolves when it has finished. */
  async checkNow(): Promise<void> {
    this.status = { ...this.status, running: true }
    try {
      this.status = await invoke('utilities:checkSkillUpdates')
    } catch (error: unknown) {
      this.status = {
        ...this.status,
        running: false,
        error: error instanceof Error ? error.message : 'The skill check failed'
      }
    }
  }
}

export const skillUpdateState = new SkillUpdateStore()
