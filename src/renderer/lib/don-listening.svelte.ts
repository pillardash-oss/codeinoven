/**
 * The Don Listening panel's open state, owned by the app rather than by the
 * gesture that opens it.
 *
 * The panel is raised by tapping the dictation modifier three times in a row,
 * from anywhere in the window, so the state cannot live inside any one view: the
 * window-level gesture and the panel mounted at the app root are far apart.
 * `App.svelte` is a view of this state, exactly as it is for the walkthrough and
 * the docked files.
 *
 * One panel exists at a time. Opening again while it is already open is a no-op
 * rather than a toggle, because a fourth tap of the modifier is the start of a
 * fresh sequence, not a second "open" that should close what it just opened.
 */
class DonListeningState {
  /** Whether the panel exists at all. False drops it, and its dock chip with it. */
  isOpen = $state(false)

  /**
   * How many times the gesture has asked the panel to start listening as it
   * opens. The gesture runs in the window and the panel mounts afterwards, so
   * the request has to outlive the call that made it; the panel consumes it once
   * its own mic is registered.
   */
  listenRequest = $state(0)

  /**
   * Show the panel, expanded, wherever the user is in the app.
   *
   * `listen` is the triple-press gesture: the user pressed the dictation
   * modifier three times to start talking to Don, so the take begins as soon as
   * the panel's own mic exists. A panel opened any other way waits for the user.
   */
  open(options: { listen?: boolean } = {}): void {
    this.isOpen = true
    if (options.listen) this.listenRequest += 1
  }

  /** Drop the panel. Whatever it holds is discarded, so the next open is empty. */
  close(): void {
    this.isOpen = false
  }

  /** Flip the panel: the escape hatch for a host that offers a single control. */
  toggle(): void {
    this.isOpen = !this.isOpen
  }
}

export const donListening = new DonListeningState()
