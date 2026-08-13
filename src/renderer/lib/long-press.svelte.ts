import type { Attachment } from 'svelte/attachments'

/**
 * Long-press attachment — the touch equivalent of a hover reveal.
 *
 * Rows across the workspace only expose their actions on hover, which a finger
 * cannot produce. Attaching this makes a stationary press of `durationMs` open
 * the same actions, and swallows the click that the browser fires afterwards so
 * the press does not also activate the row underneath.
 *
 * Only touch and pen pointers are handled: a mouse already has hover and the
 * right-click context menu, and reacting to a held left button would fight with
 * the drag-and-drop reordering the same rows use.
 */

interface LongPressOptions {
  /** Runs once the press has been held still for long enough. */
  onLongPress: () => void
  /** Hold time before the press counts. Defaults to 500ms. */
  durationMs?: number
  /** Movement that cancels the press — a scroll, not a press. Defaults to 10px. */
  moveTolerancePx?: number
  /** Skip wiring entirely (e.g. a picker row with no actions). */
  enabled?: boolean
}

export function longPress(options: LongPressOptions): Attachment<HTMLElement> {
  return (node) => {
    if (options.enabled === false) return

    const duration = options.durationMs ?? 500
    const tolerance = options.moveTolerancePx ?? 10

    let timer: ReturnType<typeof setTimeout> | undefined
    let origin: { x: number; y: number } | null = null

    function cancel(): void {
      clearTimeout(timer)
      timer = undefined
      origin = null
    }

    /**
     * A long press is followed by a `click` once the finger lifts. Swallow
     * exactly one, in the capture phase, so the row does not open as well.
     */
    function swallowNextClick(): void {
      const swallow = (event: MouseEvent): void => {
        event.preventDefault()
        event.stopPropagation()
      }
      node.addEventListener('click', swallow, { capture: true, once: true })
      // If no click arrives (the pointer left the row), drop the listener so it
      // cannot eat an unrelated click later on.
      setTimeout(() => node.removeEventListener('click', swallow, { capture: true }), 700)
    }

    function onPointerDown(event: PointerEvent): void {
      if (event.pointerType === 'mouse' || !event.isPrimary) return
      cancel()
      origin = { x: event.clientX, y: event.clientY }
      timer = setTimeout(() => {
        timer = undefined
        origin = null
        swallowNextClick()
        options.onLongPress()
      }, duration)
    }

    function onPointerMove(event: PointerEvent): void {
      if (!origin) return
      const moved =
        Math.abs(event.clientX - origin.x) > tolerance ||
        Math.abs(event.clientY - origin.y) > tolerance
      if (moved) cancel()
    }

    node.addEventListener('pointerdown', onPointerDown)
    node.addEventListener('pointermove', onPointerMove)
    node.addEventListener('pointerup', cancel)
    node.addEventListener('pointercancel', cancel)
    node.addEventListener('pointerleave', cancel)
    // A scroll started inside the row never becomes a press.
    window.addEventListener('scroll', cancel, { capture: true, passive: true })

    return () => {
      cancel()
      node.removeEventListener('pointerdown', onPointerDown)
      node.removeEventListener('pointermove', onPointerMove)
      node.removeEventListener('pointerup', cancel)
      node.removeEventListener('pointercancel', cancel)
      node.removeEventListener('pointerleave', cancel)
      window.removeEventListener('scroll', cancel, { capture: true })
    }
  }
}
