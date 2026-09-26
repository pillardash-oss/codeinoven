/**
 * The single owner of "the browser owns the keyboard".
 *
 * The browser claims its own shortcuts in the main process, where a key is
 * visible before the application menu acts on it. Main cannot work out for
 * itself whether the browser is the surface the user is working in: the page is
 * a native `WebContentsView`, the toolbar and tab strip are DOM, and main sees
 * neither. So the surfaces report it, and the whole decision lives here, the
 * same way `browser-visibility` owns which surface shows the native view.
 *
 * Two claims are possible, and they mirror the view they belong to:
 *
 *   - `sidebar`    the sidebar holds DOM focus while it shows a browser tab
 *   - `fullscreen` the full screen browser is on screen
 *
 * A full screen claim outranks the sidebar, because that overlay is the only
 * surface on screen while it is up. The effective claim is published to main
 * only when it changes, so focus moving between controls inside one surface is
 * not a message per keystroke.
 */

import { invoke } from '$lib/ipc.svelte'
import type { BrowserSurface } from './browser-visibility.svelte'

class BrowserKeyboardFocus {
  private readonly claims: Record<BrowserSurface, string | null> = {
    sidebar: null,
    fullscreen: null
  }
  /** The tab main was last told about, so a repeated claim is not re-sent. */
  private published: string | null = null

  /**
   * Publish which tab holds the keyboard on one surface, or null to release it.
   *
   * Called as focus moves, so it must stay cheap and idempotent: a claim that
   * changes nothing sends nothing.
   */
  setClaim(surface: BrowserSurface, tabId: string | null): void {
    if (this.claims[surface] === tabId) return
    this.claims[surface] = tabId
    this.publish()
  }

  private publish(): void {
    const effective = this.claims.fullscreen ?? this.claims.sidebar
    if (this.published === effective) return
    this.published = effective
    // A failure is silent: the feature handlers are not registered until after
    // the first paint, and until the claim lands every browser key belongs to
    // the app, which is the state the app is already in.
    void invoke('browser:setChromeFocus', effective).catch(() => {})
  }
}

export const browserKeyboardFocus = new BrowserKeyboardFocus()
