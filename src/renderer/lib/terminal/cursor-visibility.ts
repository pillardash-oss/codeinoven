/**
 * Hides the embedded ghostty-web terminal's caret while the terminal does not
 * hold input focus, like a native terminal.
 *
 * ghostty-web's CanvasRenderer keeps caret visibility in a private `cursorVisible`
 * field that its blink timer unconditionally flips every 530ms, and it exposes no
 * setter to turn the caret off. On focus loss we pause that timer and flip the
 * flag: a one-shot forced redraw erases the stale caret, and with blinking paused
 * the render loop stops repainting the cursor row, so it stays hidden. On focus
 * regain we restore the last DECSCUSR blink intent. New DECSCUSR updates that
 * arrive while blurred are recorded but not applied, so a fresh blink timer can
 * never re-enable a caret that must stay hidden.
 */

import type { Terminal } from 'ghostty-web'

/** The private cursor-rendering internals ghostty-web does not expose. */
interface CursorRendererInternals {
  cursorVisible: boolean
  scrollbarOpacity: number
}

/** The app's default caret (bar + blink), matching `cursor-shape.ts`. */
const DEFAULT_BLINKING = true

export class TerminalCursorController {
  private focused = false
  private blinking = DEFAULT_BLINKING

  constructor(private readonly term: Terminal) {}

  /** The terminal gained input focus — show the caret and resume blinking. */
  focus(): void {
    this.focused = true
    const renderer = this.term.renderer
    if (!renderer) return
    const internals = renderer as unknown as CursorRendererInternals
    internals.cursorVisible = true
    if (this.blinking) renderer.setCursorBlink(true)
    this.redraw()
  }

  /** The terminal lost input focus — hide the caret like a native terminal. */
  blur(): void {
    this.focused = false
    const renderer = this.term.renderer
    if (!renderer) return
    // Pausing the blink timer is what makes the hidden state stick; otherwise
    // its 530ms toggle would immediately re-enable the caret.
    renderer.setCursorBlink(false)
    const internals = renderer as unknown as CursorRendererInternals
    internals.cursorVisible = false
    this.redraw()
  }

  /** A DECSCUSR sequence changed the intended blink state. */
  updateBlink(blinking: boolean): void {
    this.blinking = blinking
    if (!this.focused) return
    this.term.renderer?.setCursorBlink(blinking)
  }

  /**
   * Force a full redraw so the caret appears/disappears immediately. While the
   * blink timer is paused the render loop only repaints the cursor row when the
   * cursor moves, which would otherwise leave the previous frame's pixels behind.
   */
  private redraw(): void {
    const renderer = this.term.renderer
    if (!renderer || !this.term.wasmTerm) return
    const { scrollbarOpacity } = renderer as unknown as CursorRendererInternals
    renderer.render(this.term.wasmTerm, true, this.term.viewportY, this.term, scrollbarOpacity)
  }
}
