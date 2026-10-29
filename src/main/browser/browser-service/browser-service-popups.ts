import { WebContentsView, type MenuItemConstructorOptions, type WebContents } from 'electron'
import type { BrowserShortcutAction } from '../../../lib/ipc-contract'
import { GLOBAL_BROWSER_PROJECT_ID } from '../../../lib/ipc-contract'
import { getGlobalBrowserContextMenuBoxes } from '../../ipc/global-browser-ipc'
import { sendToRenderer } from '../../ipc/renderer-delivery'
import { Logger } from '../../system/logger'
import { type BrowserPopupWindowHost, type BrowserPopupWindowRecord } from './browser-popup-windows'
import {
  matchBrowserShortcut,
  matchesBrowserChord,
  isReservedBrowserAction
} from './browser-shortcuts'
import { type BrowserPageOwner } from './browser-types'
import {
  MAX_POPUP_WINDOWS_PER_TAB,
  ZOOM_STEP,
  isAllowedPopupWindowUrl,
  popupWindowViewport,
  validateBrowserUrl
} from './browser-validation'
import type { BrowserService } from '../browser-service'
import { consoleFrameUrl } from './browser-service-common'
import { installBrowserHistorySwipe } from './browser-history-swipe'
import { liveWindowContents } from './browser-view-contents'
import {
  PANEL_SHORTCUT_TARGETS,
  POPUP_UNCLAIMED_ACTIONS,
  pageKeyFromInput
} from './browser-service-keyboard'

/**
 * Popup windows pages open, hosted by the app instead of by the system.
 *
 * A page's `window.open` becomes a popup in the app's own rail: hosted, wired with the
 * same keyboard and menu behaviour a tab has, kept in the opener's jar, and closed by
 * the page itself when its sign-in or checkout finishes. This unit owns that lifetime
 * and the menu a popup's page shows.
 */

/**
 * What `browser-service-popups` reads off the browser service.
 *
 * Each member is the service's own declaration, so this unit and the composition
 * root cannot drift apart: a changed signature is a compile error here.
 */
export interface PopupsHost {
  readonly allowSiteKeymapOverride: BrowserService['allowSiteKeymapOverride']
  readonly appendConsoleEntry: BrowserService['appendConsoleEntry']
  readonly appShortcutChords: BrowserService['appShortcutChords']
  readonly childTabOpeners: BrowserService['childTabOpeners']
  readonly consumeSwitcherKey: BrowserService['consumeSwitcherKey']
  readonly dispatchPageKey: BrowserService['dispatchPageKey']
  readonly mountedPopupViews: BrowserService['mountedPopupViews']
  readonly nativeStrip: BrowserService['nativeStrip']
  readonly nativeToasts: BrowserService['nativeToasts']
  readonly offerExternalNavigation: BrowserService['offerExternalNavigation']
  readonly openNewTabFor: BrowserService['openNewTabFor']
  readonly pageKeys: BrowserService['pageKeys']
  readonly popupViewFrames: BrowserService['popupViewFrames']
  readonly popupWindows: BrowserService['popupWindows']
  readonly requestPanelShortcut: BrowserService['requestPanelShortcut']
  readonly savePage: BrowserService['savePage']
  readonly shortcutBindings: BrowserService['shortcutBindings']
  readonly showPageContextMenu: BrowserService['showPageContextMenu']
  readonly stage: BrowserService['stage']
  readonly stepTabZoom: BrowserService['stepTabZoom']
  readonly tabs: BrowserService['tabs']
  readonly toggleDevTools: BrowserService['toggleDevTools']
  readonly window: BrowserService['window']
}

/** The owner of a popup window's page: the tab whose page opened it. */
export function popupPageOwner(record: BrowserPopupWindowRecord): BrowserPageOwner {
  return {
    tabId: record.tabId,
    projectId: record.projectId,
    threadId: record.threadId,
    boxId: record.boxId
  }
}

/**
 * The `WebContents` Chromium created for a popup window, read off the options it
 * hands the `createWindow` hook.
 *
 * The hook is called instead of Electron creating a window, and the popup's own
 * `WebContents` travels on an options field the constructor type does not declare.
 * It is therefore read from the object itself and checked before use, because the
 * hook must answer with that exact object: any other one is reported as
 * unconnected and the popup never opens.
 */
export function popupWindowContents(
  options: Electron.BrowserWindowConstructorOptions
): WebContents | null {
  const candidate: unknown = Reflect.get(options, 'webContents')
  return isWebContents(candidate) ? candidate : null
}

/**
 * Whether a value is a live `WebContents`, checked by the methods the app uses
 * on it rather than by `instanceof`: the popup's own contents arrives on an
 * options field with no declared type, so the check has to be structural.
 */
export function isWebContents(value: unknown): value is WebContents {
  if (typeof value !== 'object' || value === null) return false
  return (
    typeof Reflect.get(value, 'getURL') === 'function' &&
    typeof Reflect.get(value, 'isDestroyed') === 'function' &&
    typeof Reflect.get(value, 'loadURL') === 'function'
  )
}

export class BrowserServicePopups {
  constructor(private readonly host: PopupsHost) {}

  /**
   * Ordinary target=_blank links, featureless window.open calls and targeted
   * forms open as tabs. Only Chromium's explicit new-window disposition uses
   * the global browser's popup rail.
   *
   * Both surfaces adopt Chromium's child contents, preserving the opener,
   * session, POST submission and script-close lifecycle.
   */
  windowOpenResponse(
    owner: BrowserPageOwner,
    details: Electron.HandlerDetails
  ): Electron.WindowOpenHandlerResponse {
    if (this.host.offerExternalNavigation(owner, details.url)) return { action: 'deny' }
    if (owner.projectId === GLOBAL_BROWSER_PROJECT_ID && details.disposition === 'new-window') {
      const popup = this.openPopupWindowFor(owner, details)
      if (popup) return popup
    }
    const url = details.url || 'about:blank'
    if (!isAllowedPopupWindowUrl(url)) return { action: 'deny' }
    let children = 0
    for (const opener of this.host.childTabOpeners.values()) {
      if (opener === owner.tabId) children++
    }
    if (children >= MAX_POPUP_WINDOWS_PER_TAB) return { action: 'deny' }
    return {
      action: 'allow',
      createWindow: (options) => {
        const contents = popupWindowContents(options)
        if (!contents) throw new Error('Browser child tab was offered no web contents')
        return this.host.openNewTabFor(owner, url, false, null, contents)
      }
    }
  }

  /**
   * Host the popup window a page asked for, or answer null to let the caller
   * fall back to opening it as a tab.
   *
   * A popup that cannot be hosted   an address the browser will not navigate to,
   * or a tab that already holds as many popups as it may   still gets its window,
   * it just gets it as a tab, which is what the page's own code can survive.
   */
  openPopupWindowFor(
    owner: BrowserPageOwner,
    details: Electron.HandlerDetails
  ): Electron.WindowOpenHandlerResponse | null {
    const url = details.url === '' ? 'about:blank' : details.url
    if (!isAllowedPopupWindowUrl(url)) {
      Logger.error('Browser popup window refused an address it may not navigate to:', url)
      return null
    }
    if (this.host.popupWindows.countForTab(owner.tabId) >= MAX_POPUP_WINDOWS_PER_TAB) {
      Logger.dev('Browser popup window refused: the tab already holds the maximum', {
        tabId: owner.tabId
      })
      return null
    }
    const viewport = popupWindowViewport(details.features)
    return {
      action: 'allow',
      // `createWindow` runs instead of Electron creating a window, and is handed
      // the popup's own `WebContents`. Presenting that one is what keeps the popup
      // a real popup: it keeps its opener, its opener's session and the ability to
      // close itself, none of which survive a page the app loads on its own.
      createWindow: (options) => {
        const contents = popupWindowContents(options)
        if (!contents) {
          Logger.error('Browser popup window was offered no web contents to host')
          throw new Error('Browser popup window was offered no web contents to host')
        }
        return this.host.popupWindows.host(contents, { owner, url, viewport })
      }
    }
  }

  /**
   * Lift the app's floating chrome back over a page surface that just mounted.
   *
   * A child view lands on top of whatever the app window already holds, and the
   * toast card and the floating tab strip are bounded `WebContentsView`s in that
   * same window: they are the app's own chrome, drawn over whatever page happens
   * to be on screen. A tab's page, a popup window's page and an extension side
   * panel's document are all mounted the same way, so every one of them has to
   * hand the top back. Without this an open side panel covered the part of a
   * toast it overlapped, because the panel was mounted after the card was drawn
   * and the raise the card had done for itself no longer held.
   */
  raisePageChrome(): void {
    this.host.nativeStrip.raise()
    this.host.nativeToasts.raise()
  }

  /**
   * The view plumbing popup windows run on.
   *
   * The registry owns popup lifetimes; every native call a view needs stays here,
   * beside the tab ones, so a popup and a tab are placed, parked and dropped the
   * same way and there is one place to look when a page is not where it should be.
   */
  popupWindowHost(): BrowserPopupWindowHost {
    return {
      mount: (view, bounds) => {
        if (this.host.window.isDestroyed()) return
        try {
          this.host.popupViewFrames.set(view, bounds)
          if (this.host.mountedPopupViews.has(view)) {
            // Already on screen: re-asserting the frame is a native call, which is
            // still cheaper than the re-parent a repeat would otherwise cost.
            view.setBounds(bounds)
            return
          }
          this.host.stage.release(view)
          this.host.window.contentView.addChildView(view)
          this.host.mountedPopupViews.add(view)
          view.setBounds(bounds)
          this.raisePageChrome()
        } catch (error: unknown) {
          Logger.error('Browser popup window could not be placed:', error)
        }
      },
      unmount: (view, viewport) => {
        this.detachPopupView(view)
        this.host.stage.park(view, viewport)
      },
      discard: (view) => {
        this.detachPopupView(view)
        this.host.stage.release(view)
      },
      wire: (record) => this.wirePopupWindow(record),
      changed: () => this.publishPopupWindows()
    }
  }

  /**
   * Take a popup's view out of the app window, answering whether it was in it.
   *
   * A view whose page destroyed itself cannot be handed to the window at all, so
   * every native call is defended: the popup is gone and the app must not follow
   * it.
   */
  detachPopupView(view: WebContentsView): boolean {
    this.host.popupViewFrames.delete(view)
    if (!this.host.mountedPopupViews.has(view)) return false
    this.host.mountedPopupViews.delete(view)
    if (this.host.window.isDestroyed()) return false
    try {
      this.host.window.contentView.removeChildView(view)
    } catch (error: unknown) {
      Logger.error('Browser popup window could not be detached:', error)
      return false
    }
    return true
  }

  /**
   * Give a popup window's page its own browser behaviour.
   *
   * It is a page in the app's browser, so it gets what a tab's page gets: the
   * browser's own keyboard chords rather than the application menu's, the browser's
   * right-click menu over its content, the browser's navigation policy, and a
   * landing place for a window it opens itself.
   */
  wirePopupWindow(record: BrowserPopupWindowRecord): void {
    const contents = record.view.webContents
    // A popup's page is a page in the app's browser, so what it logs belongs to
    // the tab that owns it rather than being dropped: a page that opens a popup
    // for a sign-in flow reports its own troubles there, and without this the
    // ownership of that page is the only record that the trouble happened.
    contents.on('console-message', (details) => {
      this.host.appendConsoleEntry(record.tabId, {
        level: details.level,
        message: details.message,
        sourceId: details.sourceId,
        lineNumber: details.lineNumber,
        frameUrl: consoleFrameUrl(details.frame)
      })
    })
    // A popup's keys reach its own page and then the application menu, where
    // Cmd/Ctrl+W would close the app window rather than this popup.
    contents.on('dom-ready', () => {
      this.host.pageKeys.install(contents)
      // A popup is a page with its own history, and the user's trackpad gesture
      // belongs to whichever page they are pointing at. Installing the same
      // observer the tabs use is what makes a swipe inside this window walk this
      // window's history: the gesture is delivered to the page under the pointer,
      // so a swipe in the main page keeps moving the main page.
      installBrowserHistorySwipe(contents)
    })
    contents.on('destroyed', () => this.host.pageKeys.release(contents))
    contents.on('before-input-event', (event, input) => {
      if (this.host.consumeSwitcherKey(input)) {
        event.preventDefault()
        return
      }
      const action = matchBrowserShortcut(input, this.host.shortcutBindings)
      // A popup answers the browser's chords except the ones that need chrome it
      // does not have (see `POPUP_UNCLAIMED_ACTIONS`): those are left to the page
      // rather than prevented into a no-op.
      const usable = action && !POPUP_UNCLAIMED_ACTIONS.has(action) ? action : null
      if (this.host.allowSiteKeymapOverride) {
        // Reserved chrome is claimed; the rest is the page's until it reports it
        // did not handle it, exactly as for a tab's page.
        if (usable && isReservedBrowserAction(usable)) {
          event.preventDefault()
          this.runPopupWindowShortcut(record, usable)
        }
        return
      }
      if (usable) {
        event.preventDefault()
        this.runPopupWindowShortcut(record, usable)
        return
      }
      if (matchesBrowserChord(input, this.host.appShortcutChords)) {
        event.preventDefault()
        this.host.dispatchPageKey(pageKeyFromInput(input))
      }
    })
    contents.on('context-menu', (_event, params) => {
      this.showPopupWindowContextMenu(record, params)
    })
    contents.on('will-navigate', (event, url) => {
      if (this.host.offerExternalNavigation(popupPageOwner(record), url)) {
        event.preventDefault()
        return
      }
      if (!this.isAllowedPopupNavigation(record, url)) event.preventDefault()
    })
    contents.on('will-redirect', (event, url) => {
      if (this.host.offerExternalNavigation(popupPageOwner(record), url)) event.preventDefault()
    })
    contents.on('will-frame-navigate', (details) => {
      if (details.isMainFrame) return
      if (
        this.host.offerExternalNavigation(popupPageOwner(record), details.url, details.frame?.url)
      ) {
        details.preventDefault()
      }
    })
    contents.setWindowOpenHandler((details) =>
      this.windowOpenResponse(popupPageOwner(record), details)
    )
    this.installDevToolsOpenPolicy(contents, () => popupPageOwner(record))
  }

  /**
   * Whether a popup's page may navigate itself to an address.
   *
   * A page's popup is held to what every page is held to: http or https, plus the
   * blank document it legitimately starts at. An extension's own popup is a
   * `chrome-extension:` document, so the extension's own files are allowed on top
   * of that; a navigation anywhere else would be the popup leaving the extension
   * that owns it.
   */
  isAllowedPopupNavigation(record: BrowserPopupWindowRecord, url: string): boolean {
    if (isAllowedPopupWindowUrl(url)) return true
    if (record.extensionId === null) return false
    try {
      const parsed = new URL(url)
      return parsed.protocol === 'chrome-extension:' && parsed.host === record.extensionId
    } catch {
      return false
    }
  }

  /** Install the landing policy for the windows a page opens. */
  installWindowOpenPolicy(view: WebContentsView, owner: BrowserPageOwner): void {
    view.webContents.setWindowOpenHandler((details) => this.windowOpenResponse(owner, details))
    this.installDevToolsOpenPolicy(view.webContents, () => owner)
  }

  /** DevTools link commands use their own event, independent of window.open. */
  installDevToolsOpenPolicy(contents: WebContents, owner: () => BrowserPageOwner): void {
    contents.on('devtools-open-url', (_event, url) => {
      if (contents.isDestroyed() || this.host.window.isDestroyed()) return
      const source = owner()
      if (!this.host.tabs.has(source.tabId)) return
      try {
        this.host.openNewTabFor(source, validateBrowserUrl(url))
      } catch (error: unknown) {
        Logger.error('Browser DevTools rejected a link:', error)
      }
    })
  }

  /**
   * Run one browser chord pressed inside a popup window.
   *
   * Cmd/Ctrl+W dismisses the popup surface. A page-created window ends; an
   * extension action popup is parked for reuse. The chords that belong to the
   * app's own chrome (the address bar, a new tab) are forwarded to the renderer
   * under the owning tab, which is the tab the app would act on.
   */
  runPopupWindowShortcut(record: BrowserPopupWindowRecord, action: BrowserShortcutAction): void {
    const contents = record.view.webContents
    if (contents.isDestroyed()) return
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
        this.host.stepTabZoom(contents, ZOOM_STEP)
        return
      case 'zoomOut':
        this.host.stepTabZoom(contents, -ZOOM_STEP)
        return
      case 'zoomReset':
        contents.setZoomLevel(0)
        return
      case 'toggleDevTools':
        this.host.toggleDevTools(contents)
        return
      case 'savePage':
        void this.host.savePage(contents)
        return
      case 'closeTab':
        this.host.popupWindows.close(record.id, 'the user closed its window')
        return
      case 'focusAddress':
      case 'newTab':
        this.host.requestPanelShortcut(record.tabId, PANEL_SHORTCUT_TARGETS[action])
        return
    }
  }

  /** Publish the popup windows the browser holds, whole, after any change. */
  publishPopupWindows(): void {
    if (!liveWindowContents(this.host.window)) return
    sendToRenderer(
      liveWindowContents(this.host.window),
      'browser:popupWindows',
      this.host.popupWindows.list()
    )
  }

  /**
   * Open the full right-click menu for one point in a popup window's page.
   *
   * It is the same menu a tab's page gets, over the popup's own page and anchored
   * at the frame the rail has it on screen at.
   */
  showPopupWindowContextMenu(
    record: BrowserPopupWindowRecord,
    params: Electron.ContextMenuParams
  ): void {
    const contents = record.view.webContents
    if (contents.isDestroyed() || this.host.window.isDestroyed()) return
    this.host.showPageContextMenu(
      { contents, owner: popupPageOwner(record) },
      params,
      record.displayedBounds,
      [...this.popupWindowMenuItems(record), { type: 'separator' }]
    )
  }

  popupWindowMenuItems(record: BrowserPopupWindowRecord): MenuItemConstructorOptions[] {
    const choose = (
      action: 'open' | 'duplicate' | 'moveBox' | 'duplicateBox' | 'fullscreen',
      boxId: string | null = null
    ): void => {
      if (!this.host.popupWindows.find(record.id) || this.host.window.isDestroyed()) return
      sendToRenderer(
        liveWindowContents(this.host.window),
        'browser:popupWindowAction',
        record.id,
        action,
        boxId
      )
    }
    const boxes = (action: 'moveBox' | 'duplicateBox'): MenuItemConstructorOptions[] => [
      { label: 'New box', click: () => choose(action) },
      ...getGlobalBrowserContextMenuBoxes().map((box) => ({
        label: box.name,
        click: () => choose(action, box.id)
      }))
    ]
    return [
      { label: 'Open in new tab', click: () => choose('open') },
      { label: 'Duplicate in new tab', click: () => choose('duplicate') },
      { label: 'Move to box', submenu: boxes('moveBox') },
      { label: 'Duplicate in box', submenu: boxes('duplicateBox') },
      { type: 'separator' },
      { label: 'Full screen', click: () => choose('fullscreen') }
    ]
  }
}
