import type { DisplayAvailability as DisplayAvailabilityState } from '$shared/ipc/display'
import { invoke, subscribe } from '$lib/ipc.svelte'
import { logRendererError } from '$lib/system/renderer-logger'

/**
 * Whether the display panel exists for this session.
 *
 * The panel is a view of work an agent started on its own, so it has no rail item
 * until that happens. This store is the whole of what the app keeps loaded for it:
 * one event subscription and one flag. The panel's module, its store and the main
 * process's capture code stay unfetched until the item is opened.
 */
class DisplayAvailability {
  /** True once main has seen an agent start or attach to a display target. */
  available = $state(false)

  private cleanups: Array<() => void> = []
  private started = false
  /** Last working state reported, so a busy badge changing never costs a round trip. */
  private reportedWorking: boolean | null = null

  init(): void {
    if (this.started) return
    this.started = true
    this.cleanups.push(
      subscribe('display:available', () => {
        this.available = true
      })
    )
    // A reload loses the event that already fired, so the flag is read once.
    void invoke('display:presence')
      .then((presence: DisplayAvailabilityState) => {
        if (presence.available) this.available = true
      })
      .catch((error: unknown) =>
        logRendererError('The display panel presence could not be read', error)
      )
  }

  destroy(): void {
    for (const cleanup of this.cleanups) cleanup()
    this.cleanups = []
    this.started = false
  }

  /**
   * Report whether an agent is working right now.
   *
   * Presence costs one process-table read, so main only looks while this is true.
   * An idle app never scans for a device.
   */
  noteAgentWorking(working: boolean): void {
    if (this.reportedWorking === working) return
    this.reportedWorking = working
    void invoke('display:noteAgentWorking', working).catch((error: unknown) =>
      logRendererError('The agent working state could not be reported', error)
    )
  }
}

export const displayAvailability = new DisplayAvailability()
