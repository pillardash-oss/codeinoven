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

/**
 * A popover that owns its own place, reporting each resolved position instead of
 * writing it into the styled element.
 *
 * A bubble the app moves into the shared native host is positioned by a child
 * window that has to follow it, and the host owns the element's inline
 * positioning, so the place cannot be written where it was for a DOM popover.
 * The caller keeps the position and decides what to do with it; the drag, the
 * clamp and the arrow-key nudges are the same ones a DOM popover gets.
 */
interface OffsetPopoverOptions {
  /** Where the bubble is now, which a drag or a nudge starts from. */
  position: () => { x: number; y: number }
  /** Resolved on every drag and nudge, already clamped to the viewport. */
  onMove: (position: { x: number; y: number }) => void
  viewportPadding?: number
  /**
   * Let a press anywhere on the element start a drag, not only its handle.
   *
   * A bubble that covers part of the page it comments on has to be movable out
   * of the way without finding a small target first. Fields, buttons and links
   * keep their own presses, so the body is scenery while the controls work.
   */
  surface?: boolean
}

interface ViewportBounds {
  left: number
  top: number
  right: number
  bottom: number
}

interface Size {
  width: number
  height: number
}

const DRAG_HANDLE_SELECTOR = '[data-popover-drag-handle]'
/**
 * What keeps its own press when the whole element is a drag surface.
 *
 * A comment bubble is mostly a text field with a couple of buttons, and a drag
 * that started inside any of them would fight the caret, the selection and the
 * click the reader meant to make.
 */
const PRESS_OWNER_SELECTOR = [
  DRAG_HANDLE_SELECTOR,
  'input',
  'textarea',
  'select',
  'button',
  'a[href]',
  '[contenteditable]:not([contenteditable="false"])',
  '[data-popover-no-drag]'
].join(',')
const KEYBOARD_STEP = 12

function measure(element: HTMLElement): Size {
  return { width: element.offsetWidth, height: element.offsetHeight }
}

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
 * The place a bubble of `size` may take, kept inside the visual viewport.
 *
 * One definition, so a popover that writes its own coordinates and one the app
 * moves into a native host cannot drift apart at the window's edges.
 */
export function clampPopoverPosition(
  x: number,
  y: number,
  size: Size,
  padding: number
): { x: number; y: number } {
  const viewport = visualViewportBounds()
  return {
    x: clamp(x, viewport.left + padding, viewport.right - size.width - padding),
    y: clamp(y, viewport.top + padding, viewport.bottom - size.height - padding)
  }
}

/**
 * Wire the explicit drag handle: pointer drags and arrow-key nudges, each
 * resolved to a place inside the viewport and handed to `apply`.
 *
 * Shared by both popover kinds, which differ only in what `apply` does with the
 * place it is given.
 */
function attachDrag(options: {
  node: HTMLElement
  padding: number
  read: () => { x: number; y: number }
  apply: (position: { x: number; y: number }) => void
  surface?: boolean
}): () => void {
  const { node, padding, read, apply, surface = false } = options
  const candidate = node.querySelector<HTMLElement>(DRAG_HANDLE_SELECTOR)
  if (!candidate && !surface) return () => {}
  const handle: HTMLElement | null = candidate
  /** What holds the pointer for the drag in flight: the handle, or the element. */
  let grabber: HTMLElement = handle ?? node

  let dragPointerId: number | null = null
  let dragStart = { x: 0, y: 0 }
  let dragOrigin = { x: 0, y: 0 }

  function place(nextX: number, nextY: number): void {
    apply(clampPopoverPosition(nextX, nextY, measure(node), padding))
  }

  function restCursor(): void {
    if (surface) node.style.cursor = 'grab'
    else grabber.style.removeProperty('cursor')
  }

  function finishDrag(event: PointerEvent): void {
    if (dragPointerId !== event.pointerId) return
    dragPointerId = null
    if (grabber.hasPointerCapture(event.pointerId)) grabber.releasePointerCapture(event.pointerId)
    grabber.style.removeProperty('cursor')
    restCursor()
    grabber = handle ?? node
  }

  function beginDrag(event: PointerEvent, from: HTMLElement): void {
    if (event.button !== 0 || !event.isPrimary) return
    dragPointerId = event.pointerId
    dragStart = { x: event.screenX, y: event.screenY }
    dragOrigin = read()
    grabber = from
    grabber.setPointerCapture(event.pointerId)
    grabber.style.cursor = 'grabbing'
    event.preventDefault()
  }

  function onPointerDown(event: PointerEvent): void {
    if (!handle) return
    beginDrag(event, handle)
  }

  function onPointerMove(event: PointerEvent): void {
    if (dragPointerId !== event.pointerId) return
    if ((event.buttons & 1) === 0) {
      finishDrag(event)
      return
    }
    place(dragOrigin.x + event.screenX - dragStart.x, dragOrigin.y + event.screenY - dragStart.y)
    event.preventDefault()
  }

  /** A press on the bubble's own body, which leaves every control alone. */
  function onSurfacePointerDown(event: PointerEvent): void {
    if (event.target instanceof Element && event.target.closest(PRESS_OWNER_SELECTOR)) return
    beginDrag(event, node)
  }

  function onSurfacePointerMove(event: PointerEvent): void {
    if (grabber !== node) return
    onPointerMove(event)
  }

  function onSurfaceFinish(event: PointerEvent): void {
    if (grabber !== node) return
    finishDrag(event)
  }

  function onKeyDown(event: KeyboardEvent): void {
    const direction = {
      ArrowLeft: { x: -KEYBOARD_STEP, y: 0 },
      ArrowRight: { x: KEYBOARD_STEP, y: 0 },
      ArrowUp: { x: 0, y: -KEYBOARD_STEP },
      ArrowDown: { x: 0, y: KEYBOARD_STEP }
    }[event.key]
    if (!direction) return

    const origin = read()
    place(origin.x + direction.x, origin.y + direction.y)
    event.preventDefault()
    event.stopPropagation()
  }

  /**
   * The bubble's own controls keep a cursor that names what they do.
   *
   * The grab cursor is inherited by everything inside the bubble, so a close or
   * done button would advertise a drag it does not start. Their cursors are
   * written here and handed back untouched when the bubble goes.
   */
  const controlCursors: Array<{ element: HTMLElement; cursor: string }> = []
  function claimControlCursors(): void {
    for (const element of Array.from(
      node.querySelectorAll<HTMLElement>(
        'button:not([data-popover-drag-handle]), a[href], select, summary'
      )
    )) {
      if (controlCursors.some((claim) => claim.element === element)) continue
      controlCursors.push({ element, cursor: element.style.getPropertyValue('cursor') })
      element.style.cursor = 'pointer'
    }
  }

  handle?.addEventListener('pointerdown', onPointerDown)
  handle?.addEventListener('pointermove', onPointerMove)
  handle?.addEventListener('pointerup', finishDrag)
  handle?.addEventListener('pointercancel', finishDrag)
  handle?.addEventListener('lostpointercapture', finishDrag)
  handle?.addEventListener('keydown', onKeyDown)
  if (surface) {
    node.style.cursor = 'grab'
    // The bubble's own controls mount with the bubble, and the attachment can
    // run before the nested field does: one pass now and one after the flush
    // catches every one of them either way.
    claimControlCursors()
    queueMicrotask(claimControlCursors)
    node.addEventListener('pointerdown', onSurfacePointerDown)
    node.addEventListener('pointermove', onSurfacePointerMove)
    node.addEventListener('pointerup', onSurfaceFinish)
    node.addEventListener('pointercancel', onSurfaceFinish)
    node.addEventListener('lostpointercapture', onSurfaceFinish)
  }

  return () => {
    handle?.removeEventListener('pointerdown', onPointerDown)
    handle?.removeEventListener('pointermove', onPointerMove)
    handle?.removeEventListener('pointerup', finishDrag)
    handle?.removeEventListener('pointercancel', finishDrag)
    handle?.removeEventListener('lostpointercapture', finishDrag)
    if (dragPointerId !== null && grabber.hasPointerCapture(dragPointerId)) {
      grabber.releasePointerCapture(dragPointerId)
    }
    handle?.removeEventListener('keydown', onKeyDown)
    grabber.style.removeProperty('cursor')
    node.style.removeProperty('cursor')
    for (const claimed of controlCursors) {
      if (claimed.cursor) claimed.element.style.setProperty('cursor', claimed.cursor)
      else claimed.element.style.removeProperty('cursor')
    }
    node.removeEventListener('pointerdown', onSurfacePointerDown)
    node.removeEventListener('pointermove', onSurfacePointerMove)
    node.removeEventListener('pointerup', onSurfaceFinish)
    node.removeEventListener('pointercancel', onSurfaceFinish)
    node.removeEventListener('lostpointercapture', onSurfaceFinish)
  }
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
    let left = options.x
    let top = options.y
    let scheduledFrame: number | null = null

    function place(nextLeft: number, nextTop: number): void {
      const resolved = clampPopoverPosition(nextLeft, nextTop, measure(node), padding)
      left = resolved.x
      top = resolved.y
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

    place(options.x, options.y)
    constrainToViewport()

    const resizeObserver = new ResizeObserver(scheduleConstraint)
    resizeObserver.observe(node)
    window.addEventListener('resize', scheduleConstraint)
    window.visualViewport?.addEventListener('resize', scheduleConstraint)
    window.visualViewport?.addEventListener('scroll', scheduleConstraint)
    const releaseDrag = attachDrag({
      node,
      padding,
      read: () => ({ x: left, y: top }),
      apply: (position) => place(position.x, position.y)
    })

    return () => {
      if (scheduledFrame !== null) window.cancelAnimationFrame(scheduledFrame)
      releaseDrag()
      resizeObserver.disconnect()
      window.removeEventListener('resize', scheduleConstraint)
      window.visualViewport?.removeEventListener('resize', scheduleConstraint)
      window.visualViewport?.removeEventListener('scroll', scheduleConstraint)
    }
  }
}

/**
 * The same drag, for a popover the caller positions itself.
 *
 * The place is reported and the caller keeps it, which is what a bubble drawn by
 * the shared native host needs: the child window has to follow the place, so the
 * caller owns it rather than the styled element.
 */
export function draggablePopoverOffset(options: OffsetPopoverOptions): Attachment<HTMLElement> {
  return (node) =>
    attachDrag({
      node,
      padding: options.viewportPadding ?? 12,
      read: options.position,
      apply: options.onMove,
      surface: options.surface
    })
}
