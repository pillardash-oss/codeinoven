import type { WebContents } from 'electron'
import { Logger } from '../../system/logger'

type HistoryDirection = 'back' | 'forward'

interface SwipeDocument {
  cooldownUntil: number
}

// Weak ownership lets a destroyed page release its observer without a timer or
// a service-wide sweep. The cooldown survives replacement of the page document.
const documents = new WeakMap<WebContents, SwipeDocument>()
const SWIPE_WORLD_ID = 1001
const NAVIGATION_COOLDOWN_MS = 800

/** Runs wholly in the page renderer's isolated world, with no app API exposed. */
function waitForHistorySwipe(cooldownUntil: number): Promise<HistoryDirection> {
  const host = window as Window & {
    __cioHistorySwipe?: (until: number) => Promise<HistoryDirection>
  }
  if (host.__cioHistorySwipe) return host.__cioHistorySwipe(cooldownUntil)

  const threshold = 180
  const idleMs = 280
  const maximumDurationMs = 1400
  const horizontalRatio = 3
  let resolveSwipe: ((direction: HistoryDirection) => void) | null = null
  let notBefore = cooldownUntil
  let lastAt = 0
  let startedAt = 0
  let horizontal = 0
  let vertical = 0
  let blocked = false
  let completed = false

  function reset(): void {
    lastAt = 0
    startedAt = 0
    horizontal = 0
    vertical = 0
    blocked = false
    completed = false
  }

  /** Only the event's bounded ancestor chain is inspected, once per gesture. */
  function pageOwnsGesture(path: EventTarget[], deltaX: number): boolean {
    if (document.contentType.startsWith('image/')) return true
    if (path.length > 32) return true
    for (const target of path) {
      if (!(target instanceof Element)) continue
      // Image viewers and drawing surfaces can pan without a DOM scrollbar.
      if (target.matches('canvas, svg, img, video, input, textarea, [contenteditable="true"]')) {
        return true
      }
      const style = getComputedStyle(target)
      if (style.overscrollBehaviorX === 'contain' || style.overscrollBehaviorX === 'none') {
        return true
      }
      const remaining = target.scrollWidth - target.clientWidth
      const scrollingRoot = target === document.scrollingElement
      if (
        remaining <= 2 ||
        (!scrollingRoot && !['auto', 'scroll', 'hidden'].includes(style.overflowX))
      ) {
        continue
      }
      // RTL scrollLeft can be negative. Either endpoint remains a possible
      // browser gesture, but a gesture that starts as a pan stays a pan.
      const left = target.scrollLeft
      const minimum = style.direction === 'rtl' ? -remaining : 0
      const maximum = style.direction === 'rtl' ? 0 : remaining
      if ((deltaX < 0 && left > minimum + 1) || (deltaX > 0 && left < maximum - 1)) {
        return true
      }
    }
    return false
  }

  window.addEventListener(
    'wheel',
    (event: WheelEvent) => {
      if (!event.isTrusted) return
      const path = event.composedPath()
      // Let the site's handlers finish first, including handlers registered
      // after this observer. A prevented wheel belongs to the page.
      queueMicrotask(() => {
        const now = Date.now()
        if (now - lastAt > idleMs) reset()
        const first = lastAt === 0
        lastAt = now
        if (first) {
          startedAt = now
          blocked = pageOwnsGesture(path, event.deltaX)
        }
        if (
          event.defaultPrevented ||
          event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey ||
          event.shiftKey ||
          event.buttons !== 0 ||
          !Number.isFinite(event.deltaX) ||
          !Number.isFinite(event.deltaY)
        ) {
          blocked = true
        }
        if (blocked || completed || now < notBefore || now - startedAt > maximumDurationMs) return
        // Reversing a swipe cancels it; distance is never accumulated across
        // two opposing motions. Small trackpad jitter is ignored.
        if (Math.abs(event.deltaX) > 1 && horizontal * event.deltaX < 0) {
          blocked = true
          return
        }
        horizontal += event.deltaX
        vertical += Math.abs(event.deltaY)
        if (vertical > 24 && vertical > Math.abs(horizontal)) {
          blocked = true
          return
        }
        if (Math.abs(horizontal) < threshold || Math.abs(horizontal) < vertical * horizontalRatio)
          return
        if (!resolveSwipe) return
        completed = true
        const resolve = resolveSwipe
        resolveSwipe = null
        resolve(horizontal < 0 ? 'back' : 'forward')
      })
    },
    { passive: true }
  )
  window.addEventListener('blur', reset)
  window.addEventListener('pagehide', reset)
  host.__cioHistorySwipe = (until) => {
    notBefore = until
    return new Promise((resolve) => {
      resolveSwipe = resolve
    })
  }
  return host.__cioHistorySwipe(cooldownUntil)
}

/** Install on every main-frame document, for global and conversation tabs alike. */
export function installBrowserHistorySwipe(contents: WebContents): void {
  if (contents.isDestroyed()) return
  const previous = documents.get(contents)
  const state: SwipeDocument = {
    cooldownUntil: previous?.cooldownUntil ?? 0
  }
  documents.set(contents, state)

  const arm = (): void => {
    if (contents.isDestroyed() || documents.get(contents) !== state) return
    const code = `(${waitForHistorySwipe.toString()})(${state.cooldownUntil})`
    void contents
      .executeJavaScriptInIsolatedWorld(SWIPE_WORLD_ID, [{ code }])
      .then((direction: unknown) => {
        if (contents.isDestroyed() || documents.get(contents) !== state) return
        if (direction !== 'back' && direction !== 'forward') return
        state.cooldownUntil = Date.now() + NAVIGATION_COOLDOWN_MS
        const history = contents.navigationHistory
        if (direction === 'back' && history.canGoBack()) history.goBack()
        if (direction === 'forward' && history.canGoForward()) history.goForward()
        arm()
      })
      .catch((error: unknown) => {
        if (contents.isDestroyed() || documents.get(contents) !== state) return
        Logger.dev('Browser history swipe observer ended:', error)
      })
  }
  arm()
}
