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
  /** Why an install the user asked for did not happen, or '' while all is well. */
  failure = $state('')

  private cleanups: Array<() => void> = []

  /**
   * How long a force install may stay unconfirmed before the button must stop
   * pretending it is working. The main process bounds its own dispatch at 30s
   * and reports a failure, so this is the backstop for the case where even that
   * report never arrives (a wedged main process). Without a bound, a click that
   * the platform installer silently drops leaves this surface spinning forever.
   */
  private static readonly FORCE_INSTALL_BACKSTOP_MS = 45_000
  private backstop: ReturnType<typeof setTimeout> | null = null

  init(): void {
    // Only refresh once the modal has asked for something, so a closed modal
    // never turns the gate's poll into a per-tick payload fetch.
    const unsubWaiting = subscribe('updater:waiting-for-work', () => {
      if (this.payload) void this.refresh()
    })
    this.cleanups.push(unsubWaiting)
    // An install that failed after it was dispatched ends the wait as surely as
    // a completed one, so the surface has to stop claiming progress and say what
    // happened instead of spinning over work that has already been stopped.
    const unsubStatus = subscribe('updater:status', (status) => {
      if (status.state !== 'error' || !this.forcing) return
      this.settleFailure(status.errorMessage ?? 'The update could not be installed.')
    })
    this.cleanups.push(unsubStatus)
  }

  destroy(): void {
    for (const cleanup of this.cleanups) cleanup()
    this.cleanups = []
    this.clearBackstop()
    this.payload = null
    this.forcing = false
    this.failure = ''
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
   * Load the blockers and report whether there is anything to show.
   *
   * The read is also the decision, which is why both entry points share it rather
   * than each deciding for itself. A click that lands just after the gate opened
   * on its own has nothing left to stop, and opening then would show a modal
   * about an install that is already on its way, with a destructive button on it.
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
   * while the rail's count beside it said something else. The install state it
   * reports goes with it: a closed surface cannot be waiting on anything, and the
   * app being open again is proof the install it was dispatching did not happen.
   */
  close(): void {
    this.payload = null
    this.clearBackstop()
    this.forcing = false
    this.failure = ''
  }

  /**
   * Stop everything the gate is waiting on and install anyway.
   *
   * `forcing` stays set while the call is in flight: a successful install takes
   * the app down, so there is no later state to settle into. It is only ever
   * cleared by a real outcome (the updater reporting a failure, this call
   * rejecting, or the backstop above), because the one thing this surface must
   * never do is spin for an install that is not coming.
   */
  async forceInstall(): Promise<void> {
    if (this.forcing) return
    this.forcing = true
    this.failure = ''
    this.armBackstop()
    try {
      await invoke('updater:forceInstall')
    } catch (error: unknown) {
      this.settleFailure(
        error instanceof Error ? error.message : 'The update could not be installed.'
      )
    }
  }

  /**
   * Stop reporting progress on an install that did not take the app down, and
   * say why. The list is re-read as well: the work the install stopped is gone
   * from the gate by now, and a stale list under a failure message would invite
   * the user to stop it a second time.
   */
  private settleFailure(message: string): void {
    this.clearBackstop()
    this.forcing = false
    this.failure = message
    if (this.payload) void this.refresh()
  }

  private armBackstop(): void {
    this.clearBackstop()
    this.backstop = setTimeout(() => {
      this.backstop = null
      this.settleFailure(
        'The update did not restart the app. Try installing it again, or download it from the releases page.'
      )
    }, UpdateBlockersState.FORCE_INSTALL_BACKSTOP_MS)
  }

  private clearBackstop(): void {
    if (!this.backstop) return
    clearTimeout(this.backstop)
    this.backstop = null
  }
}

export const updateBlockers = new UpdateBlockersState()
