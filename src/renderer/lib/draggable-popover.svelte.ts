import type { Attachment } from 'svelte/attachments'

interface DraggablePopoverOptions {
  /** Preferred left edge in viewport coordinates. */
  x: number
  /** Preferred top edge in viewport coordinates. */
  y: number
  /** Disable positioning and dragging, for example while rendered as a mobile sheet. */
  disabled?: boolean
  /** Minimum distance from every visual viewport edge. */
  viewportPadding?: number
}

interface ViewportBounds {
  left: number
  top: number
  right: number
  bottom: number
}

const DRAG_HANDLE_SELECTOR = '[data-popover-drag-handle]'
const KEYBOARD_STEP = 12

function visualViewportBounds(): ViewportBounds {
  const viewport = window.visualViewport
  const left = viewport?.offsetLeft ?? 0
  const top = viewport?.offsetTop ?? 0
  const width = viewport?.width ?? window.innerWidth
  const height = viewport?.height ?? window.innerHeight

  return { left, top, right: left + width, bottom: top + height }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum))
}

/**
 * Keeps a fixed popover inside the visual viewport and lets its explicit drag
 * handle move it. Resize work is coalesced into animation frames so editable
 * popovers do not repeatedly measure while their content grows.
 */
export function draggablePopover(options: DraggablePopoverOptions): Attachment<HTMLElement> {
  return (node) => {
    if (options.disabled) {
      node.style.removeProperty('left')
      node.style.removeProperty('top')
      node.style.removeProperty('max-width')
      node.style.removeProperty('max-height')
      node.style.removeProperty('overflow-y')
      return
    }

    const padding = options.viewportPadding ?? 12
    const handle = node.querySelector<HTMLElement>(DRAG_HANDLE_SELECTOR)
    let left = options.x
    let top = options.y
    let dragPointerId: number | null = null
    let dragStart = { x: 0, y: 0 }
    let dragOrigin = { x: 0, y: 0 }
    let scheduledFrame: number | null = null

    function place(nextLeft: number, nextTop: number): void {
      const viewport = visualViewportBounds()
      const width = node.offsetWidth
      const height = node.offsetHeight

      left = clamp(nextLeft, viewport.left + padding, viewport.right - width - padding)
      top = clamp(nextTop, viewport.top + padding, viewport.bottom - height - padding)
      node.style.left = `${left}px`
      node.style.top = `${top}px`
    }

    function constrainToViewport(): void {
      scheduledFrame = null
      const viewport = visualViewportBounds()
      node.style.maxWidth = `${Math.max(0, viewport.right - viewport.left - padding * 2)}px`
      node.style.maxHeight = `${Math.max(0, viewport.bottom - viewport.top - padding * 2)}px`
      node.style.overflowY = 'auto'
      place(left, top)
    }

    function scheduleConstraint(): void {
      if (scheduledFrame !== null) return
      scheduledFrame = window.requestAnimationFrame(constrainToViewport)
    }

    function finishDrag(event: PointerEvent): void {
      if (dragPointerId !== event.pointerId || !handle) return
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId)
      dragPointerId = null
      handle.style.removeProperty('cursor')
    }

    function onPointerDown(event: PointerEvent): void {
      if (!handle || event.button !== 0 || !event.isPrimary) return
      dragPointerId = event.pointerId
      dragStart = { x: event.clientX, y: event.clientY }
      dragOrigin = { x: left, y: top }
      handle.setPointerCapture(event.pointerId)
      handle.focus({ preventScroll: true })
      handle.style.cursor = 'grabbing'
      event.preventDefault()
    }

    function onPointerMove(event: PointerEvent): void {
      if (dragPointerId !== event.pointerId) return
      place(dragOrigin.x + event.clientX - dragStart.x, dragOrigin.y + event.clientY - dragStart.y)
      event.preventDefault()
    }

    function onKeyDown(event: KeyboardEvent): void {
      const direction = {
        ArrowLeft: { x: -KEYBOARD_STEP, y: 0 },
        ArrowRight: { x: KEYBOARD_STEP, y: 0 },
        ArrowUp: { x: 0, y: -KEYBOARD_STEP },
        ArrowDown: { x: 0, y: KEYBOARD_STEP }
      }[event.key]
      if (!direction) return

      place(left + direction.x, top + direction.y)
      event.preventDefault()
      event.stopPropagation()
    }

    node.style.left = `${left}px`
    node.style.top = `${top}px`
    constrainToViewport()

    const resizeObserver = new ResizeObserver(scheduleConstraint)
    resizeObserver.observe(node)
    window.addEventListener('resize', scheduleConstraint)
    window.visualViewport?.addEventListener('resize', scheduleConstraint)
    window.visualViewport?.addEventListener('scroll', scheduleConstraint)
    handle?.addEventListener('pointerdown', onPointerDown)
    handle?.addEventListener('pointermove', onPointerMove)
    handle?.addEventListener('pointerup', finishDrag)
    handle?.addEventListener('pointercancel', finishDrag)
    handle?.addEventListener('keydown', onKeyDown)

    return () => {
      if (scheduledFrame !== null) window.cancelAnimationFrame(scheduledFrame)
      resizeObserver.disconnect()
      window.removeEventListener('resize', scheduleConstraint)
      window.visualViewport?.removeEventListener('resize', scheduleConstraint)
      window.visualViewport?.removeEventListener('scroll', scheduleConstraint)
      handle?.removeEventListener('pointerdown', onPointerDown)
      handle?.removeEventListener('pointermove', onPointerMove)
      handle?.removeEventListener('pointerup', finishDrag)
      handle?.removeEventListener('pointercancel', finishDrag)
      handle?.removeEventListener('keydown', onKeyDown)
      handle?.style.removeProperty('cursor')
    }
  }
}
