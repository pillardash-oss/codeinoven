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

/**
 * Reads an element's optional shortcut declaration for the tooltip chip. The
 * `data-shortcut` attribute holds comma-separated symbolic key tokens from the
 * keymap registry, e.g. `data-shortcut="mod,shift,n"`.
 */
function shortcutKeysFor(el: HTMLElement): readonly string[] {
  const raw = el.getAttribute('data-shortcut')
  if (!raw) return []
  return raw
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)
}

function resolveTitleElement(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null
  const el = target.closest<HTMLElement>('[title]')
  if (!el) return null
  if (el.closest('[data-tooltip]') !== null) return null
  if (el.closest('[data-tooltip-host]') !== null) return null
  const title = el.getAttribute('title')
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
    if (!el) return
    if (activeTitleElement === el) {
      suppressNativeTitle(el)
      tooltipState.update(event.clientX, event.clientY)
      return
    }
    const title = el.getAttribute('title') ?? ''
    if (activeTitleElement) {
      restoreNativeTitle(activeTitleElement)
    }
    suppressNativeTitle(el)
    activeTitleElement = el
    tooltipState.begin(
      title,
      event.clientX,
      event.clientY,
      'top',
      TOOLTIP_GAP_PX,
      shortcutKeysFor(el)
    )
  }

  function onPointerMove(event: PointerEvent): void {
    if (!activeTitleElement) return
    if (!(event.target instanceof Node)) return
    if (!activeTitleElement.contains(event.target)) return
    tooltipState.update(event.clientX, event.clientY)
  }

  function onPointerOut(event: PointerEvent): void {
    if (!activeTitleElement) return
    const related = event.relatedTarget as Node | null
    if (related && activeTitleElement.contains(related)) return
    restoreNativeTitle(activeTitleElement)
    activeTitleElement = null
    tooltipState.end()
  }

  function onWindowBlur(): void {
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

  return () => {
    window.removeEventListener('pointerover', onPointerOver, true)
    window.removeEventListener('pointermove', onPointerMove, true)
    window.removeEventListener('pointerout', onPointerOut, true)
    window.removeEventListener('blur', onWindowBlur)
    if (activeTitleElement) {
      restoreNativeTitle(activeTitleElement)
      activeTitleElement = null
    }
    tooltipState.end()
  }
}
