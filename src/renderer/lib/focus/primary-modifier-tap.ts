/**
 * Double-tap detection for the platform's primary keyboard modifier (Cmd on
 * macOS, Ctrl on Windows/Linux). This is the app-wide "put the caret back in
 * the chat composer" gesture.
 *
 * A tap is a fresh press and release: auto-repeat of a held key never counts,
 * the second tap must follow a release of the first, and anything else the user
 * does in between (another key, a pointer press, the window losing focus)
 * cancels the pair. A real chord (Cmd+C, Cmd+Shift+S, Ctrl+C in a terminal)
 * can therefore never complete the gesture by accident.
 */

/** How long the second tap may follow the first one. Matches the app's other
 *  double-tap gesture (dictation) and the OS double-click interval. */
export const PRIMARY_MODIFIER_TAP_WINDOW_MS = 500

/** The slice of a `KeyboardEvent` this detector reads. */
export interface PrimaryModifierTapEvent {
  key: string
  repeat: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
}

export interface PrimaryModifierTapOptions {
  /** `KeyboardEvent.key` of the primary modifier: 'Meta' on macOS, 'Control' elsewhere. */
  primaryKey: string
  /** Tap window in milliseconds. Defaults to 500. */
  windowMs?: number
  /** Monotonic clock, injectable so the window can be exercised without wall time. */
  now?: () => number
}

/** Stateful detector: feed it every window keydown and keyup, act on the
 *  keydown that completes the double tap. */
export class PrimaryModifierTapDetector {
  readonly #primaryKey: string
  readonly #windowMs: number
  readonly #now: () => number
  /** Timestamp of the pending first tap, or null while no tap is pending. */
  #lastTapAt: number | null = null
  /** True while the primary modifier itself is held. Left and right Cmd both
   *  report `key: 'Meta'`, so without this latch pressing the second one while
   *  the first is still down would count as a second tap. */
  #pressed = false

  constructor(options: PrimaryModifierTapOptions) {
    this.#primaryKey = options.primaryKey
    this.#windowMs = options.windowMs ?? PRIMARY_MODIFIER_TAP_WINDOW_MS
    this.#now = options.now ?? (() => performance.now())
  }

  /**
   * Returns true exactly on the keydown that completes the double tap. The pair
   * then resets, so a third tap starts a new one instead of firing on its own.
   */
  handleKeydown(event: PrimaryModifierTapEvent): boolean {
    if (event.key !== this.#primaryKey) {
      // Another key means typing or a chord: a pending tap is stale.
      this.reset()
      return false
    }
    // Auto-repeat of a held modifier is not a tap.
    if (event.repeat) return false
    // A second non-repeat keydown without a release in between (the other Cmd
    // key) is still one held modifier, not a tap.
    if (this.#pressed) return false
    this.#pressed = true
    if (event.altKey || event.shiftKey) {
      // A tap never lands inside a chord: a press made while another modifier
      // is already held does not arm the gesture.
      this.#lastTapAt = null
      return false
    }
    if (this.#primaryKey === 'Meta' ? event.ctrlKey : event.metaKey) {
      this.#lastTapAt = null
      return false
    }

    const now = this.#now()
    const isDoubleTap = this.#lastTapAt !== null && now - this.#lastTapAt <= this.#windowMs
    this.#lastTapAt = isDoubleTap ? null : now
    return isDoubleTap
  }

  /** Feed every window keyup so the next press counts as a fresh tap. */
  handleKeyup(event: { key: string }): void {
    if (event.key === this.#primaryKey) this.#pressed = false
  }

  /**
   * Cancel a forming pair. Called on a pointer press (Ctrl+click multi-select
   * is not a tap) and when the window loses focus, which also drops the held
   * latch because the matching keyup can be delivered to another application.
   */
  reset(): void {
    this.#lastTapAt = null
    this.#pressed = false
  }
}
