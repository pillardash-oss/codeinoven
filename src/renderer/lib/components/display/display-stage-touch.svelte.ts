import type { DisplayInputGesture, DisplayInputKey } from '$shared/ipc/display'

/**
 * Touch and typing on a mirrored screen.
 *
 * The panel paints a JPEG of a device the user cannot reach, so a pointer down on
 * that picture has to become the same act on the device: a click is a tap, a drag
 * is a swipe, a held click is a long press, and the keys typed while the picture
 * has focus are the keys the device receives. This module is only that
 * translation; it never talks to IPC and knows nothing about which device it is
 * standing in front of, so the stage stays a view and the gesture rules are
 * testable on their own.
 *
 * One deliberate choice: a gesture is sent when the finger lifts, not while it
 * moves. Android's injector and a simulator both take a whole swipe with its
 * duration, so streaming intermediate moves would fire a dozen swipes where the
 * user made one.
 */

/** A move further than this many pixels is a drag, not a tap. */
const TAP_SLOP_PX = 8
/** How long a still press must last to be a long press. */
const LONG_PRESS_MS = 550
/** The shortest and longest swipe the panel will claim a drag took. */
const MIN_SWIPE_MS = 120
const MAX_SWIPE_MS = 1200
/** Typed characters are gathered for this long so a word costs one round trip. */
const TEXT_FLUSH_MS = 45
/** The most text one gesture may carry, matching the contract's own ceiling. */
const TEXT_LIMIT = 256

/** Where the last touch landed, so the stage can paint a mark there. */
export interface StageTouchMark {
  x: number
  y: number
  /** Bumped per gesture, so the mark can restart its animation. */
  id: number
}

const KEY_NAMES: Record<string, DisplayInputKey> = {
  Enter: 'enter',
  Backspace: 'backspace',
  Tab: 'tab',
  Escape: 'escape',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right'
}

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

export class StageTouch {
  /** The dot the stage paints where the last gesture began. */
  mark = $state<StageTouchMark | null>(null)

  private origin: {
    x: number
    y: number
    clientX: number
    clientY: number
    at: number
  } | null = null
  private dragged = false
  private typed = ''
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private sequence = 0

  constructor(private readonly send: (gesture: DisplayInputGesture) => void) {}

  /** Begin tracking one pointer. Called only while the stage is in control mode. */
  down(event: PointerEvent, surface: HTMLElement): void {
    if (event.button !== 0) return
    try {
      surface.setPointerCapture(event.pointerId)
    } catch {
      // A pointer that is already gone has nothing to capture; the gesture still
      // works, it simply ends when the pointer leaves the picture.
    }
    this.dragged = false
    const point = this.fraction(event, surface)
    this.origin = {
      x: point.x,
      y: point.y,
      clientX: event.clientX,
      clientY: event.clientY,
      at: performance.now()
    }
  }

  /** Track how far the pointer has travelled, so lift knows a tap from a drag. */
  move(event: PointerEvent): void {
    const origin = this.origin
    if (!origin) return
    const distance = Math.hypot(event.clientX - origin.clientX, event.clientY - origin.clientY)
    if (distance > TAP_SLOP_PX) this.dragged = true
  }

  /** Resolve the gesture the pointer made. */
  up(event: PointerEvent, surface: HTMLElement): void {
    const origin = this.origin
    this.origin = null
    if (!origin) return
    const point = this.fraction(event, surface)
    const held = performance.now() - origin.at
    this.mark = { x: point.x, y: point.y, id: (this.sequence += 1) }
    if (this.dragged) {
      this.send({
        type: 'swipe',
        fromX: origin.x,
        fromY: origin.y,
        toX: point.x,
        toY: point.y,
        durationMs: Math.min(MAX_SWIPE_MS, Math.max(MIN_SWIPE_MS, Math.round(held)))
      })
      return
    }
    if (held >= LONG_PRESS_MS) {
      this.send({ type: 'long-press', x: point.x, y: point.y })
      return
    }
    this.send({ type: 'tap', x: point.x, y: point.y })
  }

  /** Drop a half-tracked pointer, keeping whatever was already typed. */
  cancel(): void {
    this.origin = null
    this.flush()
  }

  /**
   * Turn one key into device input.
   *
   * Returns whether the panel consumed the key, so a key it does not send keeps
   * working as the app's own shortcut instead of being swallowed.
   */
  key(event: KeyboardEvent): boolean {
    if (event.metaKey || event.ctrlKey || event.altKey) return false
    const named = KEY_NAMES[event.key]
    if (named) {
      this.flush()
      this.send({ type: 'key', key: named })
      return true
    }
    if (event.key.length === 1) {
      this.queue(event.key)
      return true
    }
    return false
  }

  /** Send whatever has been typed so far. */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    const text = this.typed
    this.typed = ''
    if (text.length > 0) this.send({ type: 'text', text })
  }

  /** Release the pending flush, if any. */
  dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    this.typed = ''
    this.origin = null
  }

  /** Gather one character and send the run once typing pauses. */
  private queue(character: string): void {
    if (this.typed.length >= TEXT_LIMIT) this.flush()
    this.typed += character
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, TEXT_FLUSH_MS)
  }

  /** A pointer position as a fraction of the picture it landed on. */
  private fraction(event: PointerEvent, surface: HTMLElement): { x: number; y: number } {
    const rect = surface.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 }
    return {
      x: clampFraction((event.clientX - rect.left) / rect.width),
      y: clampFraction((event.clientY - rect.top) / rect.height)
    }
  }
}
