import { invoke, subscribe } from '$lib/ipc.svelte'
import type { UpdateBlockers } from '$shared/ipc-contract'

/**
 * What a pending install is waiting on, for the force-install modal.
 *
 * Held apart from `updater.svelte.ts` because it is a modal's data rather than
 * the update's state: nothing outside the modal reads it, so keeping it here
 * means the update store never carries a payload the gate does not need, and the
 * modal's payload never has to be invalidated by unrelated status changes.
 *
 * Loaded on demand (the click that opens the modal) and then refreshed off the
 * gate's own broadcast, which arrives on every poll. The poll already recomputes
 * what the gate is waiting on, so re-reading on it costs one round trip every
 * five seconds while a modal is open and nothing at all while it is closed. No
 * second timer is needed to keep an open list from going stale.
 */
class UpdateBlockersState {
  payload = $state<UpdateBlockers | null>(null)
  /** True while the install is being dispatched, so the modal's own action can
   *  report progress and refuse a second click. */
  forcing = $state(false)

  private cleanups: Array<() => void> = []

  init(): void {
    // Only refresh once the modal has asked for something, so a closed modal
    // never turns the gate's poll into a per-tick payload fetch.
    const unsubWaiting = subscribe('updater:waiting-for-threads', () => {
      if (this.payload) void this.refresh()
    })
    this.cleanups.push(unsubWaiting)
  }

  destroy(): void {
    for (const cleanup of this.cleanups) cleanup()
    this.cleanups = []
    this.payload = null
    this.forcing = false
  }

  /**
   * Read the blockers. Called when the modal opens, so the list it shows is the
   * one at the moment the user asked to see it rather than whatever the rail
   * happened to know when it last polled.
   */
  async refresh(): Promise<void> {
    try {
      this.payload = await invoke('updater:blockers')
    } catch (error: unknown) {
      this.payload = null
      throw error
    }
  }

  /**
   * Stop everything the gate is waiting on and install anyway.
   *
   * `forcing` is left set once the call returns: a successful call quits the app,
   * so there is no later state to settle into, and clearing it would briefly
   * re-enable the button the user already pressed.
   */
  /**
   * Load the blockers and report whether there is anything to show.
   *
   * The read is also the decision, which is why both entry points share it rather
   * than each deciding for itself. A click that lands just after the gate opened
   * on its own has nothing left to stop, and opening then would show a modal
   * about an install that is already on its way   with a destructive button on it.
   * Returning false there keeps the surface closed, which is the truthful answer.
   */
  async prepare(): Promise<boolean> {
    try {
      await this.refresh()
    } catch {
      return false
    }
    return (this.payload?.activeCount ?? 0) > 0
  }

  /**
   * Forget the loaded list.
   *
   * Called when the modal closes so the next open re-reads rather than showing a
   * snapshot of a gate that has moved on. Without it the modal could reopen
   * listing work that has since finished, or omit work that has since started,
   * while the rail's count beside it said something else.
   */
  close(): void {
    this.payload = null
  }

  async forceInstall(): Promise<void> {
    if (this.forcing) return
    this.forcing = true
    try {
      await invoke('updater:forceInstall')
    } catch {
      this.forcing = false
    }
  }
}

export const updateBlockers = new UpdateBlockersState()
