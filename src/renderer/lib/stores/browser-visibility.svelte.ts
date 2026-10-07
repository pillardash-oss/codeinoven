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
 *   - frames    native rectangles actually on screen, the inverse question
 *
 * A component that needs the browser hidden publishes one block for as long as
 * it is on screen (`hideWhile`). A component that displays native content claims
 * the view for its tab (`claimTab`) and asks whether it may be shown
 * (`isVisible`). Both are keyed and return their own release function, so a
 * block or claim can never outlive the surface that published it.
 *
 * The third question runs the other way. A DOM surface that has to stay usable
 * while the page is up   the toaster, which asks whether a page covers the
 * corner it draws in and hands the stack to a window of its own when one does
 *   needs to know where the page actually is (`publishNativeFrame`). That
 * publication is a read for everyone else and must never reach `isCovered`,
 * which is the mechanism that hides the page in the first place.
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
export type BrowserSurface = 'sidebar' | 'fullscreen' | 'workspace' | 'peek'

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

  /** On-screen rectangles of the native views themselves, published by the
   *  surface displaying each one. Read by anything that has to ask whether a page
   *  covers it (the toaster's corner check). Deliberately not consulted by
   *  `isCovered`: that is the decision to hide the page, and feeding the page's
   *  own rectangle back into it would hide it on every write. */
  private nativeFrames = new SvelteMap<string, BrowserViewBounds>()
  private pageFrames = new SvelteMap<string, { tabId: string; bounds: BrowserViewBounds }>()

  /** Layout frames stay available when a peek parks its source's native page. */
  publishPageFrame(key: string, tabId: string, bounds: BrowserViewBounds): void {
    this.pageFrames.set(key, { tabId, bounds })
  }

  clearPageFrame(key: string): void {
    this.pageFrames.delete(key)
  }

  get sourceTabId(): string | null {
    if (this.claims.has('workspace')) return this.claims.get('workspace') ?? null
    if ([...this.blocks.values()].includes('workspace-inactive')) return null
    if (this.claims.has('fullscreen')) return this.claims.get('fullscreen') ?? null
    const tabId = this.claims.get('sidebar')
    return contextSidebarState.sidebarVisible && contextSidebarState.sidebarActiveTab?.id === tabId
      ? (tabId ?? null)
      : null
  }

  pageBoundsFor(tabId: string): BrowserViewBounds | null {
    // The fullscreen frame has precedence over the still-mounted sidebar frame.
    const key =
      this.claims.get('fullscreen') === tabId && !this.claims.has('workspace')
        ? `native-fullscreen-${tabId}`
        : null
    if (key && this.pageFrames.has(key)) return this.pageFrames.get(key)?.bounds ?? null
    for (const frame of this.pageFrames.values()) {
      if (frame.tabId === tabId) return frame.bounds
    }
    return null
  }

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
   * onMount(() => browserVisibility.claimTab(tabId, 'sidebar'))
   * ```
   *
   * Called from a lifecycle rather than an `$effect` on purpose: a claim is a
   * side effect that lasts exactly as long as its component, and its inputs are
   * snapshotted at construction, so there is nothing for an effect to track.
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
   * Publish a native view's on-screen rectangle for as long as it is really on
   * screen. A parked view covers nothing, so its surface clears the frame
   * instead of publishing the rectangle it would occupy.
   */
  publishNativeFrame(key: string, rect: BrowserViewBounds): void {
    this.nativeFrames.set(key, rect)
  }

  /** Drop a native view's rectangle once it is off screen or unmounted. */
  clearNativeFrame(key: string): void {
    this.nativeFrames.delete(key)
  }

  /** A dock may use the native window while a browser surface owns a page.
   * Dock occlusion is deliberately excluded to avoid a hide/show feedback loop. */
  get canUseNativeDock(): boolean {
    const surface = this.owningSurface
    if (surface === null) return false
    for (const reason of this.blocks.values()) {
      if (reason === 'workspace-inactive' && (surface === 'workspace' || surface === 'peek'))
        continue
      return false
    }
    return true
  }

  /** Every native rectangle currently on screen, in viewport CSS pixels. */
  get onScreenFrames(): BrowserViewBounds[] {
    return [...this.nativeFrames.values()]
  }

  /**
   * Whether a full-window DOM surface is on screen over the browser: a modal, a
   * sheet, the command palette, or the thread switcher.
   *
   * The same reason `hideReasonFor` carries, exposed for a surface that has to
   * decide whether it may keep drawing above a page. `workspace-inactive` is
   * excluded for the same reason it is excluded there: the workspace shell stays
   * mounted and hidden while the browser's own top-level view is the active one,
   * so it says nothing about a full-window surface being up.
   */
  get hasFullWindowSurface(): boolean {
    for (const reason of this.blocks.values()) {
      if (reason !== 'workspace-inactive') return true
    }
    return false
  }

  /**
   * Whether any on-screen native view overlaps `bounds`.
   *
   * The question a DOM surface asks before drawing somewhere: a page is opaque
   * and composites above every DOM node, so a surface that must be readable picks
   * somewhere else to be. Both rectangles are in viewport CSS pixels, which is
   * the space the native views are positioned in.
   */
  overlapsNative(bounds: BrowserViewBounds): boolean {
    for (const frame of this.nativeFrames.values()) {
      if (intersects(frame, bounds)) return true
    }
    return false
  }

  /**
   * Why the native view for `tabId` is hidden, or null when it may be shown.
   * `bounds` is the frame the requesting surface would occupy.
   *
   * This is the whole decision: a caller never has to combine blocks,
   * placement and overlay occlusion itself.
   */
  hideReasonFor(tabId: string, bounds: BrowserViewBounds | null): BrowserHideReason | null {
    const surface = this.owningSurface
    for (const reason of this.blocks.values()) {
      // `workspace-inactive` reports that the workspace shell is hidden because
      // another top-level view owns the window, which is equally true while the
      // browser view is the active one   the shell stays mounted but hidden.
      // That reason exists to stop a browser docked inside the shell from
      // floating over Settings or Scope, so it must never suppress the browser's
      // own top-level workspace surface, which is not inside the shell at all.
      // Without this, opening the browser view published the block and the page
      // was attached in main but never shown.
      if (reason === 'workspace-inactive' && (surface === 'workspace' || surface === 'peek'))
        continue
      return reason
    }
    if (surface === null) return 'not-placed'
    if (this.claims.get(surface) !== tabId) return 'owned-elsewhere'
    return this.isCovered(bounds) ? 'covered-by-overlay' : null
  }

  /** Whether a popup window's page may be displayed at `bounds`. */
  isPopupVisible(bounds: BrowserViewBounds | null): boolean {
    return this.popupHideReasonFor(bounds) === null
  }

  /**
   * Why a popup window's native view must stay hidden, or null when it may be
   * shown. `bounds` is the frame the rail's panel would occupy.
   *
   * A popup window's page is a second native view, so it needs the same answer a
   * tab's page does for everything that has to stay in front of it: a full-window
   * DOM surface, the thread switcher, or a floating overlay over the panel. It has
   * no claim to resolve   the rail decides which popup it is showing   so this is
   * the published blocks plus occlusion, and nothing else.
   */
  popupHideReasonFor(bounds: BrowserViewBounds | null): BrowserHideReason | null {
    if (this.claims.has('peek') && bounds) {
      const sourceId = this.sourceTabId
      const sourceBounds = sourceId ? this.pageBoundsFor(sourceId) : null
      if (sourceBounds && intersects(sourceBounds, bounds)) return 'owned-elsewhere'
    }
    for (const reason of this.blocks.values()) {
      // The popup panel lives in the browser's own top-level view, which is not
      // inside the workspace shell, so the shell's own hidden state says nothing
      // about it (see `hideReasonFor`).
      if (reason === 'workspace-inactive') continue
      return reason
    }
    return this.isCovered(bounds) ? 'covered-by-overlay' : null
  }

  /** Whether the native view for `tabId` may be displayed at `bounds`. */
  isVisible(tabId: string, bounds: BrowserViewBounds | null): boolean {
    return this.hideReasonFor(tabId, bounds) === null
  }

  /**
   * The surface that currently owns the native view. Only one view can be on
   * screen at a time, so a full-window surface outranks the sidebar: the
   * global browser workspace, then the full screen dialog, then the sidebar,
   * which owns it only while it is actually displaying the tab that claimed it.
   * Other tabs are not detached any more, they run parked offscreen.
   */
  private get owningSurface(): BrowserSurface | null {
    if (this.claims.has('peek')) return 'peek'
    if (this.claims.has('workspace')) return 'workspace'
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
 * Use it for overlays whose geometry is CSS-driven and anchored in the layout
 * (sheets, side panels). A surface the user can drag   the dockable panel, a
 * minimized dock row, the computer-use PiP   must publish from its position state
 * instead, because moving an element does not resize it and no observer would fire.
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
