/**
 * The single owner of the in-app browser's native-view visibility.
 *
 * The browser renders a native Electron `WebContentsView` owned by the main
 * process, and the compositor paints it ABOVE every DOM surface of the
 * renderer. That inverts the normal stacking order: no DOM modal, sheet or
 * panel can ever cover it. So the view must be detached whenever something is
 * on screen that it would otherwise float over, and re-attached once that
 * something is gone.
 *
 * Every input to that decision lives here, so no component needs to know how
 * any other component is hiding the browser:
 *
 *   - blocks    DOM surfaces that are on screen and must stay in front
 *   - claims    which tab wants to display native content, on which surface
 *   - occlusion floating overlays that currently overlap a surface's frame
 *
 * A component that needs the browser hidden publishes one block for as long as
 * it is on screen (`hideWhile`). A component that displays native content claims
 * the view for its tab (`claimTab`) and asks whether it may be shown
 * (`isVisible`). Both are keyed and return their own release function, so a
 * block or claim can never outlive the surface that published it.
 *
 * Extending the browser to a new scope is a change in this file: add the surface
 * to `BrowserSurface`, add the reason to `BrowserHideBlock`, and resolve it in
 * `owningSurface`. Call sites funnel through this one decision, so none of them
 * has to be re-plumbed.
 */

import { SvelteMap } from 'svelte/reactivity'
import type { Attachment } from 'svelte/attachments'
import type { BrowserViewBounds } from '$shared/ipc-contract'
import { contextSidebarState } from './context-sidebar.svelte'

/** The places the browser can display native content. */
export type BrowserSurface = 'sidebar' | 'fullscreen'

/**
 * A reason a DOM surface publishes while it is on screen and the native view
 * must therefore stay detached.
 */
export type BrowserHideBlock =
  /** A full-window DOM surface covers the workspace (modal, sheet, palette,
   *  media preview, fullscreen file editor, fullscreen terminal). */
  | 'fullscreen-surface'
  /** The workspace is not the active top-level view, so the view would float
   *  over Settings or Scope at its last screen position. */
  | 'workspace-inactive'
  /** The DOM Ctrl+Tab thread switcher dialog is open. */
  | 'switcher'

/** Every reason the native view is hidden: the published blocks above, plus the
 *  reasons this store computes while resolving surfaces. */
export type BrowserHideReason =
  | BrowserHideBlock
  /** A floating DOM overlay overlaps the surface's frame. */
  | 'covered-by-overlay'
  /** A higher-precedence surface is displaying native content. */
  | 'owned-elsewhere'
  /** No surface is currently displaying this tab. */
  | 'not-placed'

function intersects(a: BrowserViewBounds, b: BrowserViewBounds): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

class BrowserVisibilityState {
  /** Blocks published by DOM surfaces that currently invalidate the native
   *  view, keyed so nested or overlapping surfaces cannot clear each other. */
  private blocks = new SvelteMap<string, BrowserHideBlock>()

  /** The tab each surface is displaying. Published while the surface is
   *  mounted, so competing surfaces are resolved here rather than through
   *  suppression props threaded between components. */
  private claims = new SvelteMap<BrowserSurface, string>()

  /** On-screen rectangles of floating DOM overlays, in viewport CSS pixels,
   *  which is also the space the browser view is positioned in. */
  private overlays = new SvelteMap<string, BrowserViewBounds>()

  /**
   * Keep the native view hidden while `hidden` is true, for as long as the
   * publisher is on screen. Returns the release function, so the caller can hand
   * it straight to the lifecycle that owns the surface and never leak a block:
   *
   * ```svelte
   * $effect(() => browserVisibility.hideWhile('my-modal', 'fullscreen-surface', open))
   * ```
   *
   * The `hidden` argument is read while the effect runs, so the effect
   * re-evaluates whenever it changes.
   */
  hideWhile(key: string, reason: BrowserHideBlock, hidden: boolean): () => void {
    if (hidden) this.blocks.set(key, reason)
    else this.blocks.delete(key)
    return () => this.blocks.delete(key)
  }

  /**
   * Declare that `tabId` is displaying native content on `surface`. Returns the
   * release function: return it from the lifecycle that owns the surface, so the
   * claim dies with the component that made it.
   *
   * ```svelte
   * $effect(() => browserVisibility.claimTab(tabId, 'sidebar'))
   * ```
   */
  claimTab(tabId: string, surface: BrowserSurface): () => void {
    this.claims.set(surface, tabId)
    return () => {
      if (this.claims.get(surface) === tabId) this.claims.delete(surface)
    }
  }

  /** Publish a floating overlay's on-screen rectangle while it is visible. */
  publishOcclusion(key: string, rect: BrowserViewBounds): void {
    this.overlays.set(key, rect)
  }

  /** Drop an overlay's rectangle once it is hidden or unmounted. */
  clearOcclusion(key: string): void {
    this.overlays.delete(key)
  }

  /**
   * Why the native view for `tabId` is hidden, or null when it may be shown.
   * `bounds` is the frame the requesting surface would occupy.
   *
   * This is the whole decision: a caller never has to combine blocks,
   * placement and overlay occlusion itself.
   */
  hideReasonFor(tabId: string, bounds: BrowserViewBounds | null): BrowserHideReason | null {
    for (const reason of this.blocks.values()) return reason
    const surface = this.owningSurface
    if (surface === null) return 'not-placed'
    if (this.claims.get(surface) !== tabId) return 'owned-elsewhere'
    return this.isCovered(bounds) ? 'covered-by-overlay' : null
  }

  /** Whether the native view for `tabId` may be displayed at `bounds`. */
  isVisible(tabId: string, bounds: BrowserViewBounds | null): boolean {
    return this.hideReasonFor(tabId, bounds) === null
  }

  /**
   * The surface that currently owns the native view. Only one view can exist at
   * a time, so a fullscreen surface outranks the sidebar, and the sidebar owns
   * it only while it is actually displaying the tab that claimed it.
   */
  private get owningSurface(): BrowserSurface | null {
    if (this.claims.has('fullscreen')) return 'fullscreen'
    const tabId = this.claims.get('sidebar')
    if (tabId === undefined) return null
    return contextSidebarState.sidebarVisible && contextSidebarState.sidebarActiveTab?.id === tabId
      ? 'sidebar'
      : null
  }

  /** Whether any published overlay rectangle overlaps `bounds`. */
  private isCovered(bounds: BrowserViewBounds | null): boolean {
    if (!bounds || bounds.width < 1 || bounds.height < 1) return false
    for (const overlay of this.overlays.values()) {
      if (intersects(overlay, bounds)) return true
    }
    return false
  }
}

export const browserVisibility = new BrowserVisibilityState()

let occlusionSequence = 0

/**
 * Attachment that publishes a floating overlay's rectangle for as long as it is
 * mounted, re-measuring when the element resizes or the window does.
 *
 * Use it for overlays whose geometry is CSS-driven (dock chip rows, sheets,
 * anchored panels). A surface the user can drag, such as the dockable panel or
 * the computer-use PiP, must publish from its position state instead, because
 * moving an element does not resize it and no observer would fire.
 */
export const trackBrowserOcclusion: Attachment<HTMLElement> = (element) => {
  const key = `occlusion-${++occlusionSequence}`
  const measure = (): void => {
    const rect = element.getBoundingClientRect()
    if (rect.width >= 1 && rect.height >= 1) {
      browserVisibility.publishOcclusion(key, {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
      })
    } else {
      // An empty dock slot renders a zero-size anchor; it covers nothing.
      browserVisibility.clearOcclusion(key)
    }
  }
  measure()
  const observer = new ResizeObserver(measure)
  observer.observe(element)
  window.addEventListener('resize', measure)
  return () => {
    observer.disconnect()
    window.removeEventListener('resize', measure)
    browserVisibility.clearOcclusion(key)
  }
}
