import { tick } from 'svelte'
import {
  calculateThreadHoverPopoverPosition,
  resolveThreadHoverPopoverSize
} from './thread-hover-popover-layout'

/** How long the pointer must rest on a row before its info popover appears. */
export const THREAD_HOVER_POPOVER_DELAY_MS = 550

export interface ThreadHoverPopoverOptions {
  /** Reveal delay in milliseconds. */
  delayMs?: number
  /**
   * Whether something else owns the row's pointer right now   an open actions
   * menu, a rename in progress. While blocked the popover never reveals.
   */
  isBlocked?: () => boolean
  /**
   * Fired when the safety net dismisses the popover because the pointer is no
   * longer on the row. Lets the row drop its own hover state, which a missed
   * `pointerleave` would otherwise leave stuck until the pointer moved back
   * over the row and out again.
   */
  onDismiss?: () => void
}

export interface ThreadHoverPopover {
  /** Whether the popover is on screen. */
  readonly visible: boolean
  /** Resolved viewport position of the popover surface. */
  readonly position: { x: number; y: number }
  /** Row whose hover reveals the popover; pass `undefined` on unmount. */
  setRow(element: HTMLElement | undefined): void
  /** Portaled popover surface; pass `undefined` on unmount. */
  setPopover(element: HTMLElement | undefined): void
  /** Pointer entered the row. */
  enter(): void
  /** Pointer left the row. */
  leave(): void
  /** Dismiss immediately, e.g. a click, a context menu, or a drag start. */
  hide(): void
}

/**
 * Hover-intent for the thread info popover shared by every row that shows one.
 *
 * The row reveals the popover after the pointer rests on it and dismisses it
 * when the pointer leaves, but `pointerleave` alone cannot be trusted for the
 * dismissal. The workspace shell stays mounted and goes `visibility: hidden`
 * when the user opens Settings or the scope view (App.svelte), and a browser
 * does not fire a leave event for an element that disappears under a stationary
 * pointer. A popover open at that instant would stay painted over the page the
 * user just opened, which is exactly the stuck card this controller exists to
 * prevent.
 *
 * So while the pointer is on the row (from `enter()` to dismissal) the
 * controller also watches the window: any pointer movement or press that lands
 * on neither the row nor the popover, any key press, and any window blur or
 * pointer exit all dismiss it. The check is a containment test against the live
 * row, so a hidden or replaced row fails it the moment the pointer moves.
 */
export function createThreadHoverPopover(
  options: ThreadHoverPopoverOptions = {}
): ThreadHoverPopover {
  const delayMs = options.delayMs ?? THREAD_HOVER_POPOVER_DELAY_MS
  const isBlocked = options.isBlocked ?? (() => false)

  let rowEl: HTMLElement | undefined
  let popoverEl: HTMLElement | undefined
  let revealTimer: ReturnType<typeof setTimeout> | null = null
  let watching = false
  let visible = $state(false)
  let position = $state({ x: 0, y: 0 })

  function clearRevealTimer(): void {
    if (revealTimer !== null) {
      clearTimeout(revealTimer)
      revealTimer = null
    }
  }

  /** Whether the pointer event landed on the row or on the popover itself. */
  function overOwnSurface(target: EventTarget | null): boolean {
    if (!(target instanceof Node)) return false
    return Boolean(rowEl?.contains(target) || popoverEl?.contains(target))
  }

  function stopWatching(): void {
    if (!watching) return
    watching = false
    window.removeEventListener('pointermove', onWindowPointerMove, true)
    window.removeEventListener('pointerdown', onWindowPointerDown, true)
    window.removeEventListener('keydown', onWindowKeyDown, true)
    window.removeEventListener('blur', onWindowBlur)
    document.removeEventListener('pointerleave', onDocumentPointerLeave)
  }

  function startWatching(): void {
    if (watching) return
    watching = true
    window.addEventListener('pointermove', onWindowPointerMove, true)
    window.addEventListener('pointerdown', onWindowPointerDown, true)
    window.addEventListener('keydown', onWindowKeyDown, true)
    window.addEventListener('blur', onWindowBlur)
    document.addEventListener('pointerleave', onDocumentPointerLeave)
  }

  /** Every listener below tears the popover down once the pointer is off the row. */
  function dismiss(): void {
    const idle = revealTimer === null && !visible
    clearRevealTimer()
    visible = false
    stopWatching()
    if (!idle) options.onDismiss?.()
  }

  function onWindowPointerMove(event: PointerEvent): void {
    if (overOwnSurface(event.target)) return
    dismiss()
  }

  function onWindowPointerDown(event: PointerEvent): void {
    if (overOwnSurface(event.target)) return
    dismiss()
  }

  function onWindowKeyDown(): void {
    dismiss()
  }

  function onWindowBlur(): void {
    dismiss()
  }

  function onDocumentPointerLeave(): void {
    dismiss()
  }

  async function reveal(): Promise<void> {
    const row = rowEl
    if (!row || isBlocked()) return
    const size = resolveThreadHoverPopoverSize()
    position = calculateThreadHoverPopoverPosition(
      row.getBoundingClientRect(),
      size.width,
      size.height
    )
    visible = true
    await tick()
    const currentRow = rowEl
    const surface = popoverEl
    if (!currentRow || !surface || isBlocked() || !visible) return
    // The first paint used the estimated height; correct it against the real box.
    const rect = surface.getBoundingClientRect()
    position = calculateThreadHoverPopoverPosition(
      currentRow.getBoundingClientRect(),
      rect.width,
      rect.height
    )
  }

  function enter(): void {
    clearRevealTimer()
    if (isBlocked()) return
    startWatching()
    revealTimer = setTimeout(() => {
      revealTimer = null
      void reveal()
    }, delayMs)
  }

  function leave(): void {
    clearRevealTimer()
    visible = false
    stopWatching()
  }

  function hide(): void {
    leave()
  }

  function setRow(element: HTMLElement | undefined): void {
    rowEl = element
    if (!element) leave()
  }

  function setPopover(element: HTMLElement | undefined): void {
    popoverEl = element
  }

  return {
    get visible() {
      return visible
    },
    get position() {
      return position
    },
    setRow,
    setPopover,
    enter,
    leave,
    hide
  }
}
