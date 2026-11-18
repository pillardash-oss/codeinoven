import { decodeShortcutTokens } from '$lib/keymap/keymap'

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right'

export const TOOLTIP_SHOW_DELAY_MS = 1500
export const TOOLTIP_GAP_PX = 10
export const TOOLTIP_ID = 'codeinoven-tooltip'

interface TooltipRequest {
  content: string
  /** Symbolic key tokens for an optional shortcut chip, e.g. ['mod', 'n']. */
  keys: readonly string[]
  anchorX: number
  anchorY: number
  side: TooltipSide
  sideOffset: number
}

class TooltipState {
  request = $state<TooltipRequest | null>(null)
  visible = $state(false)

  private showTimer: ReturnType<typeof setTimeout> | null = null

  begin(
    content: string,
    anchorX: number,
    anchorY: number,
    side: TooltipSide = 'top',
    sideOffset = TOOLTIP_GAP_PX,
    keys: readonly string[] = []
  ): void {
    if (content.trim() === '') {
      this.end()
      return
    }
    this.clearShowTimer()
    this.request = { content, keys, anchorX, anchorY, side, sideOffset }
    this.visible = false
    this.showTimer = setTimeout(() => {
      this.visible = true
      this.showTimer = null
    }, TOOLTIP_SHOW_DELAY_MS)
  }

  update(anchorX: number, anchorY: number): void {
    const request = this.request
    if (!request) return
    request.anchorX = anchorX
    request.anchorY = anchorY
  }

  end(): void {
    this.clearShowTimer()
    this.request = null
    this.visible = false
  }

  private clearShowTimer(): void {
    if (this.showTimer) {
      clearTimeout(this.showTimer)
      this.showTimer = null
    }
  }
}

export const tooltipState = new TooltipState()

interface SuppressedTitle {
  title: string
  describedBy: string
}

const SUPPRESSED_TITLES = new WeakMap<Element, SuppressedTitle>()

let activeTitleElement: HTMLElement | null = null
let dismissedTitleElement: HTMLElement | null = null

/**
 * Reads an element's optional shortcut declaration for the tooltip chip. The
 * `data-shortcut` attribute holds symbolic key tokens from the keymap registry,
 * written with `encodeShortcutTokens`, e.g. `data-shortcut="mod,shift,n"`.
 */
function shortcutKeysFor(el: HTMLElement): readonly string[] {
  return decodeShortcutTokens(el.getAttribute('data-shortcut'))
}

interface TooltipAnchor {
  x: number
  y: number
  side: TooltipSide
}

/**
 * A rail hugs a window edge, so a tooltip above the pointer opens away from the
 * rail and its arrow points down at nothing. A rail item gets its tooltip beside
 * the rail instead, anchored to the item's own edge so the arrow points back at
 * the icon that owns it.
 */
function railAnchorFor(el: HTMLElement): TooltipAnchor | null {
  const dock = el.closest<HTMLElement>('[data-region="context-dock"]')
  const rail = dock ? null : el.closest<HTMLElement>('[data-region="view-rail"]')
  if (!dock && !rail) return null
  const rect = el.getBoundingClientRect()
  return dock
    ? { x: rect.left, y: rect.top + rect.height / 2, side: 'left' }
    : { x: rect.right, y: rect.top + rect.height / 2, side: 'right' }
}

/** Where a title tooltip starts: beside a rail item, otherwise at the pointer. */
function anchorFor(el: HTMLElement, clientX: number, clientY: number): TooltipAnchor {
  return railAnchorFor(el) ?? { x: clientX, y: clientY, side: 'top' }
}

function resolveTitleElement(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null
  let el: HTMLElement | null = target instanceof HTMLElement ? target : target.parentElement
  while (el && !el.hasAttribute('title') && !SUPPRESSED_TITLES.has(el)) el = el.parentElement
  if (!el) return null
  if (el.closest('[data-tooltip]') !== null) return null
  if (el.closest('[data-tooltip-host]') !== null) return null
  const title = SUPPRESSED_TITLES.get(el)?.title ?? el.getAttribute('title')
  if (!title || title.trim() === '') return null
  return el
}

function suppressNativeTitle(el: HTMLElement): void {
  if (!SUPPRESSED_TITLES.has(el)) {
    SUPPRESSED_TITLES.set(el, {
      title: el.getAttribute('title') ?? '',
      describedBy: el.getAttribute('aria-describedby') ?? ''
    })
  }
  el.removeAttribute('title')
  el.setAttribute('aria-describedby', TOOLTIP_ID)
}

function restoreNativeTitle(el: HTMLElement): void {
  const entry = SUPPRESSED_TITLES.get(el)
  if (!entry) return
  SUPPRESSED_TITLES.delete(el)
  if (el.getAttribute('title') === null) {
    el.setAttribute('title', entry.title)
  }
  if (el.getAttribute('aria-describedby') === TOOLTIP_ID) {
    if (entry.describedBy === '') {
      el.removeAttribute('aria-describedby')
    } else {
      el.setAttribute('aria-describedby', entry.describedBy)
    }
  }
}

/** Keep a projected redraw from reintroducing a native tooltip while hovered. */
export function patchSuppressedTooltipTitle(
  el: Element,
  title: string | null,
  describedBy: string | null
): boolean {
  const entry = SUPPRESSED_TITLES.get(el)
  if (!entry) return false
  entry.describedBy = describedBy ?? ''
  if (!title?.trim()) {
    SUPPRESSED_TITLES.delete(el)
    if (activeTitleElement === el) {
      activeTitleElement = null
      tooltipState.end()
    }
    return false
  }
  if (entry.title !== title) {
    entry.title = title
    const request = tooltipState.request
    if (activeTitleElement === el && request && el instanceof HTMLElement)
      tooltipState.begin(
        title,
        request.anchorX,
        request.anchorY,
        request.side,
        request.sideOffset,
        shortcutKeysFor(el)
      )
  }
  return true
}

/** Use the window-server cursor when a native overlay cannot trust hover events. */
export function syncTitleTooltipPointer(x: number, y: number): void {
  const el = resolveTitleElement(document.elementFromPoint(x, y))
  if (el !== dismissedTitleElement) dismissedTitleElement = null
  if (el && el === dismissedTitleElement) return
  if (activeTitleElement === el) {
    if (el) {
      const anchor = anchorFor(el, x, y)
      tooltipState.update(anchor.x, anchor.y)
    }
    return
  }
  if (activeTitleElement) restoreNativeTitle(activeTitleElement)
  activeTitleElement = el
  if (!el) {
    tooltipState.end()
    return
  }
  const title = SUPPRESSED_TITLES.get(el)?.title ?? el.getAttribute('title') ?? ''
  const anchor = anchorFor(el, x, y)
  suppressNativeTitle(el)
  tooltipState.begin(title, anchor.x, anchor.y, anchor.side, TOOLTIP_GAP_PX, shortcutKeysFor(el))
}

/**
 * Delegates the native `title` attribute to the custom tooltip system. Any
 * element (or ancestor) carrying a `title` gets the custom tooltip after the
 * hover delay; the native title is suppressed while hovered and restored on
 * leave. Elements inside an explicit `Tooltip` wrapper (`[data-tooltip]`) or
 * the tooltip host (`[data-tooltip-host]`) are ignored.
 */
export function attachTitleTooltipDelegation(): () => void {
  function onPointerOver(event: PointerEvent): void {
    const el = resolveTitleElement(event.target)
    if (!el || el === dismissedTitleElement) return
    dismissedTitleElement = null
    const anchor = anchorFor(el, event.clientX, event.clientY)
    if (activeTitleElement === el) {
      suppressNativeTitle(el)
      tooltipState.update(anchor.x, anchor.y)
      return
    }
    const title = SUPPRESSED_TITLES.get(el)?.title ?? el.getAttribute('title') ?? ''
    if (activeTitleElement) {
      restoreNativeTitle(activeTitleElement)
    }
    suppressNativeTitle(el)
    activeTitleElement = el
    tooltipState.begin(title, anchor.x, anchor.y, anchor.side, TOOLTIP_GAP_PX, shortcutKeysFor(el))
  }

  function onPointerMove(event: PointerEvent): void {
    const el = activeTitleElement
    if (!el) return
    if (!(event.target instanceof Node)) return
    if (!el.contains(event.target)) return
    // A rail tooltip stays pinned to its item; only a cursor-anchored one follows.
    if (railAnchorFor(el)) return
    tooltipState.update(event.clientX, event.clientY)
  }

  function onPointerOut(event: PointerEvent): void {
    const related = event.relatedTarget instanceof Node ? event.relatedTarget : null
    if (
      dismissedTitleElement &&
      event.target instanceof Node &&
      dismissedTitleElement.contains(event.target) &&
      (!related || !dismissedTitleElement.contains(related))
    )
      dismissedTitleElement = null
    if (!activeTitleElement) return
    if (related && activeTitleElement.contains(related)) return
    restoreNativeTitle(activeTitleElement)
    activeTitleElement = null
    tooltipState.end()
  }

  function onWindowBlur(): void {
    dismissedTitleElement = activeTitleElement ?? dismissedTitleElement
    if (activeTitleElement) {
      restoreNativeTitle(activeTitleElement)
      activeTitleElement = null
    }
    tooltipState.end()
  }

  window.addEventListener('pointerover', onPointerOver, true)
  window.addEventListener('pointermove', onPointerMove, true)
  window.addEventListener('pointerout', onPointerOut, true)
  window.addEventListener('blur', onWindowBlur)
  window.addEventListener('pointerdown', onWindowBlur, true)
  window.addEventListener('keydown', onWindowBlur, true)

  return () => {
    window.removeEventListener('pointerover', onPointerOver, true)
    window.removeEventListener('pointermove', onPointerMove, true)
    window.removeEventListener('pointerout', onPointerOut, true)
    window.removeEventListener('blur', onWindowBlur)
    window.removeEventListener('pointerdown', onWindowBlur, true)
    window.removeEventListener('keydown', onWindowBlur, true)
    dismissedTitleElement = null
    if (activeTitleElement) {
      restoreNativeTitle(activeTitleElement)
      activeTitleElement = null
    }
    tooltipState.end()
  }
}
