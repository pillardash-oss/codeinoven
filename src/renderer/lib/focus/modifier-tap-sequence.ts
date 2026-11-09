/**
 * Repeat-tap detection for one bare modifier key: the same modifier pressed
 * `count` times in a row, inside one window, with nothing else in between.
 *
 * This is the generalization of {@link PrimaryModifierTapDetector}'s shape. The
 * dictation binding is a double tap of a modifier (by default left Alt, Option
 * on macOS), and a third tap in the same window is a different gesture: the
 * Don Listening panel. Both have to be read from the same presses without either
 * one stealing the other's, so a caller runs this detector alongside its own
 * double-tap logic and treats the completing press as belonging to the longer
 * gesture.
 *
 * A tap is a fresh press and release: auto-repeat of a held key never counts, the
 * next tap must follow a release of the previous one, and anything else the user
 * does in between (another key, a chord, a pointer press, the window losing
 * focus) cancels the sequence. So a real chord (Option+Tab, Alt+F4) can never
 * complete the gesture by accident, and neither can holding the modifier down.
 */

/** How long each tap may follow the one before it. Matches the app's other
 *  modifier gestures (composer focus, dictation) and the OS double-click
 *  interval. */
export const MODIFIER_TAP_SEQUENCE_WINDOW_MS = 500

/** How many taps complete the sequence when a caller does not say. */
export const MODIFIER_TAP_SEQUENCE_COUNT = 3

/** The slice of a `KeyboardEvent` this detector reads. */
export interface ModifierTapSequenceEvent {
  /** `KeyboardEvent.code`, e.g. 'AltLeft'. */
  code: string
  repeat: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
}

/** The part of a dictation binding the detector reads. */
export interface ModifierTapSequenceBinding {
  /** `KeyboardEvent.code` of the modifier, e.g. 'AltLeft'. */
  code: string
}

export interface ModifierTapSequenceOptions {
  /** Taps that complete the sequence. Defaults to 3, and never below 2. */
  count?: number
  /** Tap window in milliseconds. Defaults to 500. */
  windowMs?: number
  /** Monotonic clock, injectable so the window can be exercised without wall time. */
  now?: () => number
}

type ModifierFlag = 'ctrl' | 'meta' | 'alt' | 'shift'

/**
 * Which `KeyboardEvent` flag each modifier code sets for its own keydown. A
 * modifier key's keydown always reports its own flag as true, so that flag must
 * be exempted when deciding whether the press is bare (a bare left-Alt press
 * has `altKey === true`).
 */
const OWN_MODIFIER_FLAG: ReadonlyMap<string, ModifierFlag> = new Map([
  ['AltLeft', 'alt'],
  ['AltRight', 'alt'],
  ['ControlLeft', 'ctrl'],
  ['ControlRight', 'ctrl'],
  ['MetaLeft', 'meta'],
  ['MetaRight', 'meta'],
  ['ShiftLeft', 'shift'],
  ['ShiftRight', 'shift']
])

/** True while `event` is that modifier alone: no other modifier is held. */
function isBareModifierPress(event: ModifierTapSequenceEvent): boolean {
  const own = OWN_MODIFIER_FLAG.get(event.code) ?? null
  return (
    (own === 'ctrl' || !event.ctrlKey) &&
    (own === 'meta' || !event.metaKey) &&
    (own === 'alt' || !event.altKey) &&
    (own === 'shift' || !event.shiftKey)
  )
}

/** Stateful detector: feed it every keydown and keyup of the bound modifier key
 *  (and its `reset` on anything else), act on the keydown that completes the
 *  sequence of taps. */
export class ModifierTapSequenceDetector {
  readonly #count: number
  readonly #windowMs: number
  readonly #now: () => number
  /** Taps accepted so far in the sequence forming now. */
  #taps = 0
  /** Timestamp of the most recent accepted tap, or null while none is pending. */
  #lastTapAt: number | null = null
  /** The modifier code currently held. Left and right variants both report the
   *  same flags, so without this latch a second press of the bound key while it
   *  is still down would count as a fresh tap. */
  #pressedCode: string | null = null

  constructor(options: ModifierTapSequenceOptions = {}) {
    const count = options.count ?? MODIFIER_TAP_SEQUENCE_COUNT
    // A sequence of one is not a gesture: the bound key's own keydown would fire
    // on every press, including inside chords the caller filtered for.
    this.#count = Math.max(2, Math.trunc(count))
    this.#windowMs = options.windowMs ?? MODIFIER_TAP_SEQUENCE_WINDOW_MS
    this.#now = options.now ?? (() => performance.now())
  }

  /** How many taps complete the sequence. */
  get count(): number {
    return this.#count
  }

  /**
   * Returns true exactly on the keydown that completes the sequence of taps.
   * The sequence then resets, so the next tap starts a new one instead of
   * completing another on its own.
   */
  handleKeydown(event: ModifierTapSequenceEvent, binding: ModifierTapSequenceBinding): boolean {
    if (event.code !== binding.code) {
      // Another key means typing or a chord: a forming sequence is stale.
      this.reset()
      return false
    }
    // Auto-repeat of a held modifier is not a tap.
    if (event.repeat) return false
    // A second non-repeat keydown without a release in between is still one
    // held modifier, not a tap.
    if (this.#pressedCode === event.code) return false
    this.#pressedCode = event.code
    if (!isBareModifierPress(event)) {
      // A tap never lands inside a chord: a press made while another modifier is
      // already held drops what was forming. The held latch stays, because this
      // keydown is still that modifier going down.
      this.#clearTaps()
      return false
    }

    const now = this.#now()
    const withinWindow = this.#lastTapAt !== null && now - this.#lastTapAt <= this.#windowMs
    const taps = withinWindow ? this.#taps + 1 : 1
    if (taps >= this.#count) {
      this.#clearTaps()
      return true
    }
    this.#taps = taps
    this.#lastTapAt = now
    return false
  }

  /** Feed every keyup of the bound modifier so its next press counts as a tap. */
  handleKeyup(event: { code: string }): void {
    if (event.code === this.#pressedCode) this.#pressedCode = null
  }

  /**
   * Cancel a forming sequence. Called on any other press, on a pointer press
   * (an Option+click is not a tap) and when the window loses focus, which also
   * drops the held latch because the matching keyup can be delivered to another
   * application.
   */
  reset(): void {
    this.#clearTaps()
    this.#pressedCode = null
  }

  /** Drop the taps forming now, keeping the held modifier latch. */
  #clearTaps(): void {
    this.#taps = 0
    this.#lastTapAt = null
  }
}
