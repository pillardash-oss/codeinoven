/**
 * Occlusion registry for native (Electron `WebContentsView`) surfaces.
 *
 * The in-app browser renders a native view owned by the main process, and the
 * compositor always paints it ABOVE every DOM surface of the renderer. A
 * floating DOM overlay that overlaps the browser frame (the dockable modal
 * panel, or its bottom-right dock chip) is therefore painted behind the page
 * and cannot be seen or clicked. Overlays publish their on-screen rectangle
 * here while they are visible, and the browser panel asks whether its own frame
 * is covered, so it can detach the native view for as long as the overlay needs
 * that space and re-attach it as soon as the overlay moves away.
 *
 * Rectangles use viewport (CSS pixel) coordinates, which is also the
 * coordinate space of `BrowserViewBounds`   the browser panel measures its frame
 * with `getBoundingClientRect`, so both sides are directly comparable.
 */

import { SvelteMap } from 'svelte/reactivity'
import type { Attachment } from 'svelte/attachments'
import type { BrowserViewBounds } from '$shared/ipc-contract'

function intersects(a: BrowserViewBounds, b: BrowserViewBounds): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

class NativeViewOcclusionState {
  /** Visible DOM overlays keyed by owner, in viewport coordinates. */
  private overlays = new SvelteMap<string, BrowserViewBounds>()

  /** Publish (or refresh) the on-screen rectangle of a DOM overlay that floats
   *  above native content. Owners call this whenever their geometry changes. */
  setOverlayRect(key: string, rect: BrowserViewBounds): void {
    this.overlays.set(key, rect)
  }

  /** Drop an overlay's rectangle once it is hidden or destroyed. */
  clearOverlayRect(key: string): void {
    this.overlays.delete(key)
  }

  /** Whether any registered overlay currently covers part of `rect`. */
  isCovered(rect: BrowserViewBounds | null): boolean {
    if (!rect || rect.width < 1 || rect.height < 1) return false
    for (const overlay of this.overlays.values()) {
      if (intersects(overlay, rect)) return true
    }
    return false
  }
}

export const nativeViewOcclusion = new NativeViewOcclusionState()

let overlaySequence = 0

/**
 * Attachment that publishes an anchored overlay element's rectangle for as long
 * as it is mounted, re-measuring when the element resizes or the window does.
 *
 * Use it for overlays whose geometry is CSS-driven (dock chip rows, sheets,
 * anchored panels). A surface the user can drag   the dockable panel, the
 * computer-use PiP   must publish from its position state instead, because
 * moving an element does not resize it and no observer would fire.
 */
export const trackNativeViewOverlay: Attachment<HTMLElement> = (element) => {
  const key = `overlay-${++overlaySequence}`
  const measure = (): void => {
    const rect = element.getBoundingClientRect()
    if (rect.width >= 1 && rect.height >= 1) {
      nativeViewOcclusion.setOverlayRect(key, {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
      })
    } else {
      // An empty dock slot renders a zero-size anchor; it covers nothing.
      nativeViewOcclusion.clearOverlayRect(key)
    }
  }
  measure()
  const observer = new ResizeObserver(measure)
  observer.observe(element)
  window.addEventListener('resize', measure)
  return () => {
    observer.disconnect()
    window.removeEventListener('resize', measure)
    nativeViewOcclusion.clearOverlayRect(key)
  }
}
