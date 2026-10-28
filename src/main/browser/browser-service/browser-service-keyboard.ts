import { type WebContents } from 'electron'
import type {
  BrowserPanelShortcutAction,
  BrowserPageKey,
  BrowserShortcutAction
} from '../../../lib/ipc-contract'
import { sendToRenderer } from '../../ipc/renderer-delivery'
import {
  matchBrowserShortcut,
  matchesBrowserChord,
  type ShortcutKeyInput
} from './browser-shortcuts'
import { MAX_ZOOM_LEVEL, ZOOM_STEP } from './browser-validation'
import { designScreenEntryFromUrl } from '../../../lib/design/screens'
import type { BrowserService } from '../browser-service'

/**
 * Every key the browser claims.
 *
 * A key pressed inside a page never reaches the renderer, so main owns the browser's
 * chords: the actions a page reported as unhandled, the Ctrl+Tab switcher, the panel
 * shortcuts, history, zoom and DevTools. The tables that decide which chord belongs to
 * whom live here too, because a key is only claimed when a table says so.
 */

/**
 * What `browser-service-keyboard` reads off the browser service.
 *
 * Each member is the service's own declaration, so this unit and the composition
 * root cannot drift apart: a changed signature is a compile error here.
 */
export interface KeyboardHost {
  readonly activeTabId: BrowserService['activeTabId']
  readonly allowSiteKeymapOverride: BrowserService['allowSiteKeymapOverride']
  readonly appShortcutChords: BrowserService['appShortcutChords']
  readonly compositionShortcutChords: BrowserService['compositionShortcutChords']
  readonly focusedChromeTabId: BrowserService['focusedChromeTabId']
  readonly popupWindows: BrowserService['popupWindows']
  readonly runPopupWindowShortcut: BrowserService['runPopupWindowShortcut']
  readonly savePage: BrowserService['savePage']
  readonly shortcutBindings: BrowserService['shortcutBindings']
  readonly switcherBindings: BrowserService['switcherBindings']
  readonly tabForContents: BrowserService['tabForContents']
  readonly tabs: BrowserService['tabs']
  readonly window: BrowserService['window']
}

/**
 * Where a renderer-owned shortcut lands. The key is decided in this process,
 * which is the only one that sees it before the application menu, and the tab
 * strip stays the renderer's: it opens, closes and focuses its own tabs.
 */
export const PANEL_SHORTCUT_TARGETS: Readonly<
  Record<
    'designUndo' | 'designRedo' | 'focusAddress' | 'closeTab' | 'newTab' | 'reopenTab',
    BrowserPanelShortcutAction
  >
> = {
  designUndo: 'design-undo',
  designRedo: 'design-redo',
  focusAddress: 'focus-address',
  closeTab: 'close-tab',
  newTab: 'new-tab',
  reopenTab: 'reopen-tab'
}

/**
 * Whether a browser action is answered by the renderer rather than a page.
 *
 * The tab strip, the address field and the find bar are DOM chrome, so these
 * actions reach the renderer even for a tab this process holds no page for: a
 * sleeping tab, a blank one, or one whose view has not been created yet. Page
 * actions (`reload`, `back`, zooming) have nothing to act on in that state.
 */
export function isRendererAnsweredAction(
  action: BrowserShortcutAction
): action is keyof typeof PANEL_SHORTCUT_TARGETS {
  return action in PANEL_SHORTCUT_TARGETS
}

/**
 * The page-key shape of a key pressed in a page.
 *
 * The app chord table is matched against Electron's `Input`, while what travels
 * to the renderer is the DOM event the page would have seen, so this is the one
 * conversion between the two.
 */
export function pageKeyFromInput(input: ShortcutKeyInput): BrowserPageKey {
  return {
    key: input.key.toLowerCase(),
    code: input.code,
    meta: input.meta,
    control: input.control,
    shift: input.shift,
    alt: input.alt,
    repeat: input.isAutoRepeat
  }
}

/**
 * Browser chords a popup window deliberately leaves unclaimed.
 *
 * Screen history belongs to the authored page a tab shows; a popup has none, so
 * its own page keeps the chord instead of the popup swallowing it for an undo
 * that could not run.
 */
export const POPUP_UNCLAIMED_ACTIONS: ReadonlySet<BrowserShortcutAction> =
  new Set<BrowserShortcutAction>(['designUndo', 'designRedo'])

export class BrowserServiceKeyboard {
  constructor(private readonly host: KeyboardHost) {}

  /**
   * Run one claimed browser action on a tab.
   *
   * The actions split by owner: what acts on the page happens here, and what
   * acts on the tab strip (focusing the address bar, closing or opening a tab)
   * is forwarded to the renderer, which is the only side that knows the strip.
   * Saving is asynchronous because the save dialog is, and it must never block
   * the key event that asked for it.
   */
  runBrowserShortcut(tabId: string, action: BrowserShortcutAction): void {
    // The address field and the tab strip are the renderer's, so their actions
    // are forwarded before this process looks for a page to act on. A claimed
    // tab with no view (a sleeping or blank tab) still has a row the renderer
    // owns, and that row is what these actions act on.
    if (isRendererAnsweredAction(action)) {
      this.requestPanelShortcut(tabId, PANEL_SHORTCUT_TARGETS[action])
      return
    }
    const tab = this.host.tabs.get(tabId)
    if (!tab || tab.view.webContents.isDestroyed()) return
    const contents = tab.view.webContents
    switch (action) {
      case 'reload':
        contents.reload()
        return
      case 'hardReload':
        contents.reloadIgnoringCache()
        return
      case 'back':
        if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
        return
      case 'forward':
        if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
        return
      case 'zoomIn':
        this.stepTabZoom(contents, ZOOM_STEP)
        return
      case 'zoomOut':
        this.stepTabZoom(contents, -ZOOM_STEP)
        return
      case 'zoomReset':
        contents.setZoomLevel(0)
        return
      case 'toggleDevTools':
        this.toggleDevTools(contents)
        return
      case 'savePage':
        void this.host.savePage(contents)
        return
    }
  }

  /** Screen history bindings apply only to the current authored page. */
  canUseScreenHistory(tabId: string): boolean {
    const tab = this.host.tabs.get(tabId)
    const work = tab?.design ?? tab?.composition
    return Boolean(
      tab &&
      work &&
      !tab.view.webContents.isDestroyed() &&
      designScreenEntryFromUrl(tab.view.webContents.getURL(), work.origin)
    )
  }

  /**
   * Claim the Ctrl+Tab switcher gesture pressed in a page.
   *
   * The switcher is a renderer DOM surface, but a key pressed in the page never
   * reaches it. So the app claims the chord here (the app always wins; a site
   * cannot override Ctrl+Tab), hands the renderer the keyboard and forwards the
   * gesture. Once the renderer owns the keyboard the real Control release reaches
   * the DOM and commits the highlight, so only the first press is forwarded.
   *
   * Returns whether the key was claimed, so the caller prevents it. Preventing it
   * is what stops the page and the application menu from also acting on it.
   */
  consumeSwitcherKey(input: ShortcutKeyInput): boolean {
    if (!matchesBrowserChord(input, this.host.switcherBindings)) return false
    if (!this.host.window.webContents.isDestroyed()) {
      this.host.window.webContents.focus()
      sendToRenderer(this.host.window.webContents, 'browser:switcherKey', { backward: input.shift })
    }
    return true
  }

  /**
   * Ask the renderer to act on the tab strip, which only the renderer owns.
   *
   * When the key came from the page, this process still holds the OS keyboard
   * through the page's own `WebContentsView`, so the renderer can move its
   * `document.activeElement` into the address field but not take the user's
   * typing with it. The actions whose whole point is a DOM field (`focus-address`
   * and `new-tab`) therefore hand the window's web contents the focus first. The
   * tab-strip actions that do not involve a field (`close-tab`, `reopen-tab`)
   * deliberately do not, because the page must keep the keyboard after them.
   */
  requestPanelShortcut(tabId: string, action: BrowserPanelShortcutAction): void {
    // A page's captured chord can land after its window closed, because the
    // `before-input-event` listener outlives the window by one turn. Reading
    // `webContents` on a destroyed window throws "Object has been destroyed",
    // which reached the durable log as an uncaught exception on 2026-10-27.
    // The window and its contents are destroyed in that order, so both are
    // checked here.
    if (this.host.window.isDestroyed() || this.host.window.webContents.isDestroyed()) return
    if (action === 'focus-address' || action === 'new-tab') {
      this.host.window.webContents.focus()
    }
    sendToRenderer(this.host.window.webContents, 'browser:panelShortcut', tabId, action)
  }

  /**
   * Act on a chord a page reported as unhandled.
   *
   * The page observer only reports what the page's own handlers left alone, so
   * this is the app's turn. A browser action still runs when it is the browser
   * that answers the chord (Save, which a page may override), an app chord is
   * replayed into the renderer, which owns the DOM its keymap handlers live in,
   * and anything else is a page key that merely carried a modifier and is dropped.
   */
  handlePageKey(contents: WebContents, key: BrowserPageKey): void {
    if (!this.host.allowSiteKeymapOverride) return
    const input: ShortcutKeyInput = {
      type: 'keyDown',
      key: key.key,
      code: key.code,
      meta: key.meta,
      control: key.control,
      shift: key.shift,
      alt: key.alt,
      isAutoRepeat: key.repeat
    }
    const action = matchBrowserShortcut(input, this.host.shortcutBindings)
    const popup = this.host.popupWindows.recordForContents(contents.id)
    if (popup) {
      if (action && !POPUP_UNCLAIMED_ACTIONS.has(action)) {
        this.host.runPopupWindowShortcut(popup, action)
        return
      }
    } else {
      const owner = this.host.tabForContents(contents.id)
      if (
        owner?.tab.composition &&
        matchesBrowserChord(input, this.host.compositionShortcutChords)
      ) {
        this.dispatchPageKey(key)
        return
      }
      if (
        owner &&
        action &&
        ((action !== 'designUndo' && action !== 'designRedo') || this.canUseScreenHistory(owner.id))
      ) {
        this.runBrowserShortcut(owner.id, action)
        return
      }
    }
    if (matchesBrowserChord(input, this.host.appShortcutChords)) this.dispatchPageKey(key)
  }

  /**
   * Replay a chord into the renderer, which owns the keymap handlers.
   *
   * The app's web contents takes the keyboard first: the chords this carries open
   * DOM surfaces (the spotlight's field, a dialog) that cannot receive typing
   * while a page holds the OS keyboard.
   */
  dispatchPageKey(key: BrowserPageKey): void {
    if (this.host.window.webContents.isDestroyed()) return
    this.host.window.webContents.focus()
    sendToRenderer(this.host.window.webContents, 'browser:pageKey', key)
  }

  /**
   * Resolve a key pressed while the browser toolbar holds DOM focus.
   *
   * That key goes to the app renderer, so the window-level interception is the
   * only place it can be claimed before the application menu acts on it. Called
   * from `before-input-event` on the window's web contents; when it answers true
   * the caller prevents the event, which the renderer, the page and the menu all
   * then never see.
   */
  consumeChromeShortcut(event: Electron.Event, input: Electron.Input): boolean {
    const tabId = this.host.focusedChromeTabId
    if (!tabId) return false
    const action = matchBrowserShortcut(input, this.host.shortcutBindings)
    if (!action) return false
    if ((action === 'designUndo' || action === 'designRedo') && !this.canUseScreenHistory(tabId))
      return false
    // A claim can name a tab this process holds no page for: a sleeping tab, a
    // blank one, or a tab whose view is still being created. Its row is the
    // renderer's regardless, so the strip's own actions are still claimed here.
    // Claiming them is what keeps Cmd/Ctrl+W on a sleeping tab from falling
    // through to the application menu's "Close Window" and closing the app. A
    // page action has nothing to act on without a page, so it is left alone.
    if (!this.host.tabs.has(tabId) && !isRendererAnsweredAction(action)) return false
    event.preventDefault()
    this.runBrowserShortcut(tabId, action)
    return true
  }

  /** Route a mouse history button to the browser only when its active page or
   *  toolbar owns focus. The caller falls back to app navigation when this
   *  returns false. A focused browser consumes the input even at a history end. */
  navigateFocusedHistory(direction: 'back' | 'forward'): boolean {
    const tabId = this.host.activeTabId
    if (!tabId) return false
    const tab = this.host.tabs.get(tabId)
    if (!tab || tab.view.webContents.isDestroyed()) return false

    const isFocusedToolbar = tabId === this.host.focusedChromeTabId
    const isFocusedPage = tab.view.webContents.isFocused()
    if (!isFocusedToolbar && !isFocusedPage) return false

    const history = tab.view.webContents.navigationHistory
    if (direction === 'back' && history.canGoBack()) history.goBack()
    if (direction === 'forward' && history.canGoForward()) history.goForward()
    return true
  }

  /** Toggle the web page's own DevTools. Returns whether it is now open. */
  toggleDevTools(contents: WebContents): boolean {
    if (contents.isDevToolsOpened()) {
      contents.closeDevTools()
      return false
    }
    // Plain native behavior: default dock inside the window, resizable
    // there, fully undockable from DevTools' own controls.
    contents.openDevTools()
    return true
  }

  /** Step one tab's zoom, clamped to Chromium's own range. */
  stepTabZoom(contents: WebContents, step: number): void {
    const next = Math.min(MAX_ZOOM_LEVEL, Math.max(-MAX_ZOOM_LEVEL, contents.getZoomLevel() + step))
    contents.setZoomLevel(next)
  }
}
