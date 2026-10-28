import { dialog } from '../../system/file-dialogs'
import { app, clipboard, Menu, type MenuItemConstructorOptions, type WebContents } from 'electron'
import { join } from 'node:path'
import { buildBrowserSearchUrl } from '../../../lib/browser-search-engines'
import type { BrowserViewBounds } from '../../../lib/ipc-contract'
import { GLOBAL_BROWSER_PROJECT_ID } from '../../../lib/ipc-contract'
import { getGlobalBrowserContextMenuBoxes } from '../../ipc/global-browser-ipc'
import { sendToRenderer } from '../../ipc/renderer-delivery'
import { Logger } from '../../system/logger'
import {
  buildBrowserContextMenuItems,
  buildBrowserPageMenuItems,
  type BrowserContextMenuActions,
  type BrowserContextMenuContext
} from './browser-context-menu'
import { type BrowserPageOwner, type BrowserTab } from './browser-types'
import {
  peekPointInFrame,
  type BrowserPeekMediaTarget,
  type BrowserPeekPoint
} from './browser-peek'
import { safeBasename, validateBrowserUrl, validateOptionalBoxId } from './browser-validation'
import type { BrowserService } from '../browser-service'
import type { BrowserMenuPage } from './browser-service-common'

/**
 * The native menus a page raises, and the actions behind their rows.
 *
 * A right-click on a page is a native menu built from Electron's context-menu params:
 * the link, the image, the selection and the page itself each contribute rows, and every
 * row runs one action   copy, save, view source, search the selection, open a sibling tab.
 * The same builder serves a popup window's page, because what differs is only which page
 * the action acts on.
 */

/**
 * What `browser-service-menus` reads off the browser service.
 *
 * Each member is the service's own declaration, so this unit and the composition
 * root cannot drift apart: a changed signature is a compile error here.
 */
export interface MenusHost {
  readonly activeTabBounds: BrowserService['activeTabBounds']
  readonly activeTabId: BrowserService['activeTabId']
  readonly contextMenuSearchEngine: BrowserService['contextMenuSearchEngine']
  readonly ensureTab: BrowserService['ensureTab']
  readonly extensionMenuItems: BrowserService['extensionMenuItems']
  readonly navigateTo: BrowserService['navigateTo']
  readonly openNewTabFor: BrowserService['openNewTabFor']
  readonly openPeekFrom: BrowserService['openPeekFrom']
  readonly parkTab: BrowserService['parkTab']
  readonly peekTabs: BrowserService['peekTabs']
  readonly requireTab: BrowserService['requireTab']
  readonly tabs: BrowserService['tabs']
  readonly window: BrowserService['window']
}

export function menuPageFor(tabId: string, tab: BrowserTab): BrowserMenuPage {
  return {
    contents: tab.view.webContents,
    owner: { tabId, projectId: tab.projectId, threadId: tab.threadId, boxId: tab.boxId }
  }
}

/**
 * Copy text from a menu action.
 *
 * The clipboard module returns a promise for every write since Electron 44, and a
 * menu action cannot await it, so the write is fired and a failure is logged instead
 * of becoming an unhandled rejection that would take the main process down.
 */
export function copyTextToClipboard(text: string): void {
  clipboard.writeText(text).catch((error: unknown) => {
    Logger.error('Browser context menu could not copy to the clipboard:', error)
  })
}

export class BrowserServiceMenus {
  constructor(private readonly host: MenusHost) {}

  /** Open the page-level context menu anchored at a point (the toolbar's page
   *  menu and the host's fallback for a click the native view did not take). The
   *  right-click menu is this same page section plus the point-specific ones. */
  showPageMenu(tabId: string, x: number, y: number): void {
    if (this.host.window.isDestroyed()) return
    const tab = this.host.requireTab(tabId)
    const page = menuPageFor(tabId, tab)
    const frame = this.frameForTab(tabId)
    const menu = Menu.buildFromTemplate(
      buildBrowserPageMenuItems(
        this.contextMenuContext(page.contents),
        this.contextMenuActions(page, frame, this.pagePointOf(x, y, frame))
      )
    )
    menu.popup({ window: this.host.window, x, y })
  }

  /**
   * A page-menu point, translated from the window's space into the page's own.
   *
   * The channel behind the page menu is shared: the host's fallback for a click
   * the native view did not take passes the click itself, and the reload button
   * passes its own position under it. Only a point that lands inside the page
   * says anything about where on the page the user is, so one that does not is
   * reported as no point at all.
   */
  pagePointOf(x: number, y: number, frame: BrowserViewBounds | null): BrowserPeekPoint | null {
    if (frame === null) return null
    return peekPointInFrame({ x: Math.round(x - frame.x), y: Math.round(y - frame.y) }, frame)
  }

  /** The rectangle a tab's page is on screen at, or null while it is parked or
   *  displayed off the app window. */
  frameForTab(tabId: string): BrowserViewBounds | null {
    return this.host.activeTabId === tabId ? this.host.activeTabBounds : null
  }

  /**
   * Open the full right-click menu for one point in a tab's page.
   *
   * The OS popup composites above the native view, so the page never detaches
   * for the menu. The reported point is in the view's own coordinates, so it is
   * translated into the window's content space the popup expects; when the
   * tab's on-screen frame is not known the popup falls back to the pointer.
   */
  showTabContextMenu(tabId: string, params: Electron.ContextMenuParams): void {
    const tab = this.host.tabs.get(tabId)
    if (!tab || this.host.window.isDestroyed() || tab.view.webContents.isDestroyed()) return
    const frame = this.frameForTab(tabId)
    this.showPageContextMenu(menuPageFor(tabId, tab), params, frame)
  }

  /** Build and pop the point-specific context menu for one page. */
  showPageContextMenu(
    page: BrowserMenuPage,
    params: Electron.ContextMenuParams,
    frame: BrowserViewBounds | null,
    extraItems: MenuItemConstructorOptions[] = []
  ): void {
    const menu = Menu.buildFromTemplate([
      ...extraItems,
      ...buildBrowserContextMenuItems(
        params,
        this.contextMenuContext(page.contents),
        this.contextMenuActions(page, frame, { x: params.x, y: params.y }),
        this.host.extensionMenuItems(page, params)
      )
    ])
    // The point Electron reports is in the page's own coordinates, and a native
    // menu wants the window's, so the frame the page is displayed at is added.
    if (frame)
      menu.popup({ window: this.host.window, x: frame.x + params.x, y: frame.y + params.y })
    else menu.popup({ window: this.host.window })
  }

  /** Live facts the context menu needs about a page. */
  contextMenuContext(contents: WebContents): BrowserContextMenuContext {
    return {
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      searchEngineName: this.host.contextMenuSearchEngine.name,
      boxes: getGlobalBrowserContextMenuBoxes()
    }
  }

  /**
   * The actions a page's context menu can run.
   *
   * Every action re-checks that its page is alive when it fires, because the menu
   * can outlive the page it was opened over. A link or media URL the browser's
   * navigation policy refuses is dropped with a log rather than opened.
   *
   * One set serves a tab's page and a popup window's, because the menu offers the
   * same actions over both: what differs is only which page they act on and which
   * tab a page they open belongs to.
   */
  /**
   * The menu's actions for one page.
   *
   * `frame` and `point` are where the click that opened the menu landed, which
   * only the page's own right-click and the host's fallback can supply: they are
   * what a Peek opened from this menu grows out of.
   */
  contextMenuActions(
    page: BrowserMenuPage,
    frame: BrowserViewBounds | null,
    point: BrowserPeekPoint | null
  ): BrowserContextMenuActions {
    const contents = page.contents
    const owner = page.owner
    const live = (): WebContents | null =>
      contents.isDestroyed() || this.host.window.isDestroyed() ? null : contents
    const openInNewTab = (url: string): void => {
      try {
        this.host.openNewTabFor(owner, validateBrowserUrl(url))
      } catch (error: unknown) {
        Logger.error('Browser context menu refused a link:', error)
      }
    }
    const saveAs = (url: string): void => {
      try {
        live()?.downloadURL(validateBrowserUrl(url))
      } catch (error: unknown) {
        Logger.error('Browser context menu refused a download:', error)
      }
    }
    return {
      goBack: () => {
        const current = live()
        if (current?.navigationHistory.canGoBack()) current.navigationHistory.goBack()
      },
      goForward: () => {
        const current = live()
        if (current?.navigationHistory.canGoForward()) current.navigationHistory.goForward()
      },
      reload: () => live()?.reload(),
      hardReload: () => live()?.reloadIgnoringCache(),
      savePage: () => void this.savePage(contents),
      print: () => live()?.print({}),
      viewSource: () => this.openViewSourceInNewTab(page),
      copyPageAddress: () => {
        const current = live()
        if (current) copyTextToClipboard(current.getURL())
      },
      inspectElement: (x, y) => live()?.inspectElement(x, y),
      selectAll: () => live()?.selectAll(),
      openLinkInNewTab: openInNewTab,
      openLinkInBox: (url, rawBoxId) => {
        const boxId = validateOptionalBoxId(rawBoxId)
        if (!boxId || !getGlobalBrowserContextMenuBoxes().some((box) => box.id === boxId)) return
        try {
          this.host.openNewTabFor({ ...owner, boxId }, validateBrowserUrl(url))
        } catch (error: unknown) {
          Logger.error('Browser context menu refused a link in a box:', error)
        }
      },
      ...(owner.projectId === GLOBAL_BROWSER_PROJECT_ID
        ? {
            openPeekWindow: (url: string, media?: BrowserPeekMediaTarget | null): void => {
              const current = live()
              if (!current) return
              let target: string
              try {
                target = validateBrowserUrl(url)
              } catch (error: unknown) {
                Logger.error('Browser Peek refused a link:', error)
                return
              }
              this.host.openPeekFrom(owner, current, target, frame, point, media ?? null)
            }
          }
        : {}),
      saveLinkAs: saveAs,
      openMediaInNewTab: openInNewTab,
      saveMediaAs: saveAs,
      copyImage: (x, y) => live()?.copyImageAt(x, y),
      copyAddress: (url) => copyTextToClipboard(url),
      copyText: (text) => copyTextToClipboard(text),
      searchFor: (text) => this.searchSelectionInNewTab(owner, text),
      undo: () => live()?.undo(),
      redo: () => live()?.redo(),
      cut: () => live()?.cut(),
      copy: () => live()?.copy(),
      paste: () => live()?.paste(),
      pasteAndMatchStyle: () => live()?.pasteAndMatchStyle(),
      deleteSelection: () => live()?.delete(),
      replaceMisspelling: (word) => live()?.replaceMisspelling(word)
    }
  }

  /**
   * Open the current document's source in a new tab.
   *
   * Chromium renders `view-source:` itself, but the browser's navigation
   * validation accepts http and https only, so this is a main-initiated load the
   * page's own navigation rules never see. The displayed address keeps the
   * `view-source:` prefix, exactly as a normal browser shows it.
   */
  openViewSourceInNewTab(page: BrowserMenuPage): void {
    const contents = page.contents
    if (contents.isDestroyed()) return
    const current = contents.getURL()
    const inner = current.startsWith('view-source:')
      ? current.slice('view-source:'.length)
      : current
    let target: string
    try {
      target = `view-source:${validateBrowserUrl(inner)}`
    } catch {
      return
    }
    const tabId = `browser:${crypto.randomUUID()}`
    const sourceTab = this.host.ensureTab(
      tabId,
      page.owner.projectId,
      page.owner.threadId,
      page.owner.boxId
    )
    sourceTab.initialNavigationStarted = true
    this.host.parkTab(tabId)
    this.host.navigateTo(tabId, target)
    sendToRenderer(this.host.window.webContents, 'browser:openRequested', target, {
      projectId: page.owner.projectId,
      threadId: page.owner.threadId,
      requestedTabId: tabId,
      sourceTabId: this.host.peekTabs.get(page.owner.tabId) ?? page.owner.tabId,
      reveal: true,
      boxId: page.owner.boxId
    })
  }

  /** Run the context-menu web search in a new tab, using the reported engine. */
  searchSelectionInNewTab(owner: BrowserPageOwner, query: string): void {
    const url = buildBrowserSearchUrl(this.host.contextMenuSearchEngine, query)
    if (!url) return
    try {
      this.host.openNewTabFor(owner, validateBrowserUrl(url))
    } catch (error: unknown) {
      Logger.error('Browser context menu could not run a search:', error)
    }
  }

  /**
   * Save a page to a file the user picks.
   *
   * Chromium writes the page as it stands (markup plus its resources) rather
   * than the raw response, which is what Chrome's own "Web page, complete"
   * does and the only useful answer for a page a script rendered. A refusal or a
   * write failure has no UI of its own, so it is reported as an app toast
   * instead of leaving the user with a key that silently did nothing.
   *
   * The page is a `WebContents` rather than a tab, because a popup window's page
   * is saved exactly the way a tab's is.
   */
  async savePage(contents: WebContents): Promise<void> {
    if (contents.isDestroyed() || this.host.window.isDestroyed()) return
    const title = contents.getTitle() || contents.getURL()
    const { canceled, filePath } = await dialog.showSaveDialog(this.host.window, {
      title: 'Save page',
      defaultPath: join(app.getPath('downloads'), `${safeBasename(title)}.html`),
      filters: [{ name: 'Web page, complete', extensions: ['html'] }]
    })
    if (canceled || !filePath) return
    if (contents.isDestroyed()) return
    try {
      await contents.savePage(filePath, 'HTMLComplete')
    } catch (error: unknown) {
      Logger.error('Browser page could not be saved:', error)
      if (this.host.window.webContents.isDestroyed()) return
      sendToRenderer(this.host.window.webContents, 'app:toast', {
        message: 'This page could not be saved to that file.',
        type: 'error'
      })
    }
  }
}
