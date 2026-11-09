/**
 * Keeps a reader's place in a live terminal while output keeps arriving.
 *
 * ghostty-web ends every `write()` with `viewportY !== 0 && scrollToBottom()`,
 * so each chunk of PTY output snaps the viewport back to the newest line. A
 * shell that never stops printing (a dev server log, a watch task, a tail) then
 * cannot be read at all: scrolling up to an older line is undone by the next
 * chunk, and a selection dragged over older output lands on rows that have
 * already moved, which is why copying a log out of a streaming run failed.
 *
 * This wraps the write so the viewport stays anchored to the content the reader
 * is looking at, and only follows the output while the viewport sits at the
 * bottom and no drag is extending a selection.
 */

import type { Terminal } from 'ghostty-web'

/**
 * Private ghostty-web scroll state the hold has to keep in step. An in-flight
 * smooth-scroll animation would otherwise overwrite the restored offset on its
 * next frame, so the animation is cancelled when the anchor is applied.
 */
interface TerminalScrollState {
  targetViewportY?: number
  scrollAnimationFrame?: number
  scrollAnimationStartTime?: number
  scrollAnimationStartY?: number
}

export interface OutputScrollHold {
  /** Feed PTY output to the terminal without moving the reader's viewport. */
  write: (text: string) => void
  dispose: () => void
}

/** The reader is looking at the newest line, so output should keep following. */
function followsOutput(term: Terminal): boolean {
  return term.getViewportY() <= 0
}

/**
 * Write one chunk and put the viewport back where the reader left it.
 *
 * Rows that leave the screen for the scrollback move the anchored content back
 * by exactly as many lines, so the offset grows by the same amount.
 */
function writeAnchored(term: Terminal, text: string): void {
  const state = term as unknown as TerminalScrollState
  const offset = term.getViewportY()
  const animating = state.scrollAnimationFrame !== undefined
  const base = animating ? (state.targetViewportY ?? offset) : offset
  const scrollbackBefore = term.getScrollbackLength()
  term.write(text)
  const scrollbackAfter = term.getScrollbackLength()
  const anchor = Math.min(
    scrollbackAfter,
    Math.max(0, Math.round(base + scrollbackAfter - scrollbackBefore))
  )
  state.targetViewportY = anchor
  if (animating) {
    if (state.scrollAnimationFrame !== undefined) cancelAnimationFrame(state.scrollAnimationFrame)
    state.scrollAnimationFrame = undefined
    state.scrollAnimationStartTime = undefined
    state.scrollAnimationStartY = undefined
  }
  if (Math.round(term.getViewportY()) !== anchor) term.scrollToLine(anchor)
}

/**
 * Attach the hold to one terminal host.
 *
 * A drag that is extending a selection must hold the view even at the bottom of
 * the buffer, otherwise the rows under the pointer keep sliding away mid-drag
 * and the copied text is a smear instead of what the reader selected.
 */
export function createOutputScrollHold(term: Terminal, host: HTMLElement): OutputScrollHold {
  let dragging = false
  const onPointerDown = (event: PointerEvent): void => {
    if (event.button === 0) dragging = true
  }
  const onPointerUp = (): void => {
    dragging = false
  }
  host.addEventListener('pointerdown', onPointerDown, { capture: true })
  window.addEventListener('pointerup', onPointerUp, { capture: true })
  window.addEventListener('pointercancel', onPointerUp, { capture: true })

  return {
    write: (text: string): void => {
      if (!dragging && followsOutput(term)) {
        term.write(text)
        return
      }
      writeAnchored(term, text)
    },
    dispose: (): void => {
      dragging = false
      host.removeEventListener('pointerdown', onPointerDown, { capture: true })
      window.removeEventListener('pointerup', onPointerUp, { capture: true })
      window.removeEventListener('pointercancel', onPointerUp, { capture: true })
    }
  }
}
