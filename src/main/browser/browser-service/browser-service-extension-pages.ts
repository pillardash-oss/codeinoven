import { WebContentsView } from 'electron'
import { Logger } from '../../system/logger'
import { type BrowserExtensionActionPopupOpenRequest } from '../extensions/browser-extension-service'
import { ownedExtensionPageUrl } from '../extensions/browser-extension-page-url'
import { browserPartitionFor } from './browser-validation'
import {
  BROWSER_EXTENSION_HOSTED_WINDOW_ID,
  extensionWindowKey
} from '../../../lib/browser/browser-extension-window'
import { loadExtensionDocument } from '../extensions/browser-extension-page-load'
import { type BrowserPageOwner, type BrowserTab } from './browser-types'
import { MAX_POPUP_WINDOWS_PER_TAB } from './browser-validation'
import { liveContents } from './browser-view-contents'
import type { BrowserService } from '../browser-service'

/**
 * The pages an extension opens and the app hosts.
 *
 * A worker calling `chrome.windows.create`, a page calling `chrome.runtime.openOptionsPage`
 * and an action popup all end in the same place: an extension document loaded in the jar
 * the extension runs in, presented as a tab or as a popup of its own.
 */

/**
 * What `browser-service-extension-pages` reads off the browser service.
 *
 * Each member is the service's own declaration, so this unit and the composition
 * root cannot drift apart: a changed signature is a compile error here.
 */
export interface ExtensionPagesHost {
  readonly activeTabId: BrowserService['activeTabId']
  readonly ensureExtensionPageTabsPreload: BrowserService['ensureExtensionPageTabsPreload']
  readonly ensureTab: BrowserService['ensureTab']
  readonly extensionPopupOpenings: BrowserService['extensionPopupOpenings']
  readonly extensions: BrowserService['extensions']
  readonly notifyExtensionWindow: BrowserService['notifyExtensionWindow']
  readonly openExtensionSidePanel: BrowserService['openExtensionSidePanel']
  readonly openNewTabFor: BrowserService['openNewTabFor']
  readonly popupWindows: BrowserService['popupWindows']
  readonly reportExtensionPageTabs: BrowserService['reportExtensionPageTabs']
  readonly sessionForProject: BrowserService['sessionForProject']
  readonly sidePanels: BrowserService['sidePanels']
  readonly tabForContents: BrowserService['tabForContents']
  readonly tabs: BrowserService['tabs']
  readonly validateTabNavigationUrl: BrowserService['validateTabNavigationUrl']
  readonly window: BrowserService['window']
}

export class BrowserServiceExtensionPages {
  constructor(private readonly host: ExtensionPagesHost) {}

  /**
   * Open a web page because an extension's own page called `chrome.tabs.create`,
   * and answer with the id of the tab that page now lives in.
   *
   * There is no second window: the tab strip is the app's, so a launch from a
   * password manager's popup becomes a tab beside the page that popup was acting
   * on, in that page's jar, held to the same address rule a link click is. The id
   * returned is the new page's `WebContents` id, which is the id this runtime's
   * own `chrome.tabs` answers with, so the caller's own bookkeeping works against
   * the tab it opened.
   *
   * Null for a request with nothing to open, an address the browser will not
   * navigate to, or a surface that no longer has a tab to open beside   in which
   * case the page's call answers with no tab rather than a promise that hangs.
   *
   * `active` is accepted for the shape `chrome.tabs.create` documents, and the tab
   * is revealed either way: the strip is the one surface this browser has, and a
   * tab the user was not shown is a page they cannot reach.
   */
  openTabFromExtensionPage(
    contentsId: number,
    request: { url: string; active: boolean }
  ): number | null {
    const owner = this.ownerForExtensionSurface(contentsId)
    if (!owner) {
      Logger.dev('An extension page asked for a tab with no page to open it beside')
      return null
    }
    try {
      const url = this.host.validateTabNavigationUrl(owner.projectId, owner.boxId, request.url)
      return this.host.openNewTabFor(owner, url).id
    } catch (error: unknown) {
      Logger.dev('An extension page asked for a tab on an address it may not open:', {
        url: request.url,
        error
      })
      return null
    }
  }

  /**
   * The tab an extension's own document acts on.
   *
   * A document the app hosts for an extension   an action popup in the rail, a
   * side panel, an extension page opened as a tab   stands beside one page of one
   * browser and is that page's to act on, so the request a document makes lands
   * where the document came from. Null when the surface is gone and its tab with
   * it, which is a request with nowhere to go.
   */
  ownerForExtensionSurface(contentsId: number): BrowserPageOwner | null {
    const record = this.host.popupWindows.recordForContents(contentsId)
    const tabId =
      record?.tabId ??
      this.host.sidePanels.tabIdForContents(contentsId) ??
      this.host.tabForContents(contentsId)?.id
    if (!tabId) return null
    const tab = this.host.tabs.get(tabId)
    if (!tab) return null
    return { tabId, projectId: tab.projectId, threadId: tab.threadId, boxId: tab.boxId }
  }

  /** Resolve a worker window request and route it to the surface it belongs on. */
  /**
   * Open one extension's own page because the extension asked for it, which today
   * means `chrome.runtime.openOptionsPage()` from its worker.
   *
   * The app hosts extension pages as browser tabs, so this reaches the same surface
   * the extensions panel offers, from a click in the extension's own popup instead
   * of from the panel. The tab lands in the jar the extension asked from, beside
   * whatever page is already open there, because that page is what its settings
   * usually act on.
   */
  openExtensionPageFromWorker(request: {
    projectId: string
    boxId: string | null
    extensionId: string
    page: 'options'
  }): void {
    this.openExtensionOptionsTab(request.projectId, request.boxId, request.extensionId, null)
  }

  /**
   * Open an extension's settings page because the extension's own popup asked for
   * it, and close that popup the way a browser does.
   *
   * A popup's "More settings" row is a page this app hosts rather than a worker
   * call, so the settings page takes the popup's place: the popup closes, and the
   * tab opens beside the page it was acting on. Leaving it up would stack two
   * surfaces asking the same question.
   */
  openOptionsPageFromPage(contentsId: number): void {
    const record = this.host.popupWindows.recordForContents(contentsId)
    if (!record || !record.extensionId) return
    const tab = this.host.tabs.get(record.tabId)
    const owner: BrowserPageOwner | null =
      tab && tab.projectId === record.projectId && tab.boxId === record.boxId
        ? {
            tabId: record.tabId,
            projectId: tab.projectId,
            threadId: tab.threadId,
            boxId: tab.boxId
          }
        : null
    this.openExtensionOptionsTab(record.projectId, record.boxId, record.extensionId, owner)
    this.host.popupWindows.dismiss(record.id)
  }

  /**
   * Put one extension's options page in a tab of the jar it runs in.
   *
   * `owner` is the tab to open beside when the caller knows it, which a popup does
   * because it is acting on that page. Otherwise the jar's active tab is used, and a
   * jar with no page open has nowhere to put the tab: the extensions panel is then
   * the way in.
   */
  openExtensionOptionsTab(
    projectId: string,
    boxId: string | null,
    extensionId: string,
    owner: BrowserPageOwner | null
  ): void {
    const url = this.host.extensions.optionsUrlFor(extensionId, projectId, boxId)
    if (!url) {
      Logger.dev('An extension asked for a settings page it does not have:', { extensionId })
      return
    }
    const target = owner ?? this.extensionPageOwner(projectId, boxId)
    if (!target) return
    try {
      this.host.openNewTabFor(target, this.host.validateTabNavigationUrl(projectId, boxId, url))
    } catch (error: unknown) {
      Logger.dev('An extension settings page could not be opened:', { extensionId, error })
    }
  }

  /**
   * The tab an extension page should open beside: the jar's active tab when the
   * user is looking at one, otherwise the first tab of that jar.
   *
   * Null when the jar has no page open at all, which is the one case where there is
   * no window the tab could belong to; the extensions panel is then the way in.
   */
  extensionPageOwner(projectId: string, boxId: string | null): BrowserPageOwner | null {
    const entries = [...this.host.tabs.entries()].filter(
      ([, candidate]) => candidate.projectId === projectId && candidate.boxId === boxId
    )
    const entry = entries.find(([tabId]) => tabId === this.host.activeTabId) ?? entries[0]
    if (!entry) return null
    const [tabId, tab] = entry
    return { tabId, projectId: tab.projectId, threadId: tab.threadId, boxId: tab.boxId }
  }

  /**
   * The page of one jar a request lands on when it named none.
   *
   * An extension's worker shares one notion of the tab it acts for across the whole
   * jar, so a request can arrive unable to name the page it belongs to   a passkey
   * prompt is issued by the very worker the ceremony woke. The jar's page on screen
   * is then the page the prompt is about, which is the same answer a browser gives.
   * A jar with nothing on screen falls back to its first page, and a jar with no
   * page at all answers null.
   */
  jarPageOwner(jar: string): { id: string; tab: BrowserTab } | null {
    const entries = [...this.host.tabs.entries()].filter(
      ([, candidate]) => browserPartitionFor(candidate.projectId, candidate.boxId) === jar
    )
    const entry = entries.find(([tabId]) => tabId === this.host.activeTabId) ?? entries[0]
    if (!entry) return null
    const [tabId, tab] = entry
    return { id: tabId, tab }
  }

  openExtensionWindowFromWorker(request: BrowserExtensionActionPopupOpenRequest): void {
    // A request names the jar it came from, and a box's jar is one session every
    // context that picked that box shares. The jar is therefore what the request is
    // held to, never the context the jar first happened to be loaded by: a boxed
    // conversation tab and the global browser's tab of the same box are the same
    // jar, and refusing the conversation's request because the global browser got
    // there first is what kept a passkey prompt in the thread browser from ever
    // being asked for.
    const jar = browserPartitionFor(request.projectId, request.boxId)
    const owner = this.host.tabForContents(request.extensionTabId) ?? this.jarPageOwner(jar)
    if (!owner) {
      this.refuseExtensionWindow(request, 'there is no page to open it beside')
      return
    }
    const tab = owner.tab
    if (browserPartitionFor(tab.projectId, tab.boxId) !== jar) {
      Logger.dev('An extension window request named a page in another jar:', {
        extensionId: request.extensionId,
        kind: request.kind,
        requestedJar: jar,
        tabJar: browserPartitionFor(tab.projectId, tab.boxId)
      })
      this.refuseExtensionWindow(request, 'the page it named is in another jar')
      return
    }
    // The page's own context owns what it opens: a box's jar is shared, its tabs
    // are not, and a popup opened beside a conversation's page belongs to that
    // conversation.
    const tabOwner = {
      tabId: owner.id,
      projectId: tab.projectId,
      threadId: tab.threadId,
      boxId: tab.boxId
    }

    if (request.kind === 'open-tab') {
      // The extension asked for a window that is not its own popout, and this app
      // has one browser window: the page becomes a tab beside the one the
      // extension is acting on. The URL is held to the same rule a link click is,
      // so a web page is admitted and nothing else is.
      try {
        const url = this.host.validateTabNavigationUrl(tab.projectId, tab.boxId, request.url)
        this.host.openNewTabFor(tabOwner, url)
      } catch (error: unknown) {
        Logger.dev('An extension window request used an invalid URL:', {
          extensionId: request.extensionId,
          error
        })
      }
      return
    }

    if (request.kind === 'focus-browser') {
      if (!this.host.window.isDestroyed()) {
        this.host.window.focus()
        if (this.host.activeTabId === owner.id && liveContents(tab.view)) {
          tab.view.webContents.focus()
        }
      }
      return
    }

    if (request.kind === 'hide-window') {
      // A window the extension asked for is hidden by its own address, which is
      // what names it to the extension too: hiding the jar's action popup instead
      // would take the vault away while leaving the prompt on screen.
      const windowKey = request.url ? extensionWindowKey(request.url) : null
      const cached =
        windowKey === null
          ? this.host.popupWindows.extensionPopupForJar(
              request.extensionId,
              tabOwner.projectId,
              tabOwner.boxId
            )
          : this.host.popupWindows.extensionWindowFor(
              request.extensionId,
              tabOwner.projectId,
              tabOwner.boxId,
              windowKey
            )
      if (cached) this.host.popupWindows.dismiss(cached)
      return
    }

    const requestedUrl =
      request.kind === 'open-window' || request.kind === 'focus-window'
        ? (ownedExtensionPageUrl(request.extensionId, request.url) ?? undefined)
        : undefined
    if ((request.kind === 'open-window' || request.kind === 'focus-window') && !requestedUrl) {
      Logger.dev('An extension popup request used an invalid extension URL:', {
        extensionId: request.extensionId
      })
      return
    }
    void this.openExtensionPopup(
      tabOwner.projectId,
      tabOwner.tabId,
      tabOwner.threadId,
      tabOwner.boxId,
      request.extensionId,
      requestedUrl
    ).catch((error: unknown) => {
      Logger.dev('An extension action popup could not be opened:', {
        extensionId: request.extensionId,
        error
      })
      this.refuseExtensionWindow(request, 'its page could not be opened')
    })
  }

  /**
   * End the extension's pretend window when the app cannot draw it.
   *
   * The worker shim answers a `chrome.windows.create` as soon as the request is
   * routed, so a window this app then fails to host is still a window the extension
   * believes it has, and a password manager waits on its prompt forever. Telling it
   * the window is gone is the truthful answer: it aborts the pending ceremony, and
   * the page falls back to whatever its own sign-in offers.
   */
  refuseExtensionWindow(request: BrowserExtensionActionPopupOpenRequest, reason: string): void {
    if (request.kind !== 'open-window' && request.kind !== 'focus-window') return
    Logger.dev('An extension window could not be shown, so it was reported closed:', {
      extensionId: request.extensionId,
      reason
    })
    this.host.notifyExtensionWindow(request.projectId, request.boxId, 'onRemoved', [
      BROWSER_EXTENSION_HOSTED_WINDOW_ID
    ])
  }

  /**
   * Open one of an extension's own pages in the rail.
   *
   * Two kinds of page land here, and they are two objects in a browser:
   *
   *   - the extension's action popup, which a click on its icon opens: one retained
   *     page per jar, parked off screen while the user works on the page instead;
   *   - a window the extension asked the app for with `chrome.windows.create`,
   *     which a password manager uses for its passkey prompt: its own address, its
   *     own page and its own life, and the extension is told when it ends.
   *
   * Keeping the second kind out of the first is what makes a passkey prompt appear:
   * reusing the vault popup for it replaced both documents, and the navigation that
   * did it was then aborted as superseded, so neither page came up.
   */
  async openExtensionPopup(
    projectId: string,
    tabId: string,
    threadId: string,
    boxId: string | null,
    extensionId: string,
    requestedUrl?: string
  ): Promise<string | null> {
    const tab = this.host.ensureTab(tabId, projectId, threadId, boxId)
    // The popup is about to load, and its first act is to ask its own worker a
    // question about the desktop bridge. A worker released since the last time is
    // a fresh life that has not reconnected yet, so it is touched before its page
    // is created and the reconnect runs while the page loads.
    this.host.extensions.wakeWorker(projectId, boxId, extensionId)
    // An extension can ask for its panel to open when its action is clicked, and
    // Chromium opens the panel rather than the action popup when it does. The
    // panel is a surface of the rail, so there is no popup id to answer with.
    const actionPanel = requestedUrl
      ? null
      : this.host.extensions.sidePanelForActionClick(
          projectId,
          tab.boxId,
          extensionId,
          tab.view.webContents.id
        )
    if (actionPanel) {
      await this.host.openExtensionSidePanel({
        projectId,
        boxId: tab.boxId,
        extensionId,
        extensionName: actionPanel.extensionName,
        extensionTabId: tab.view.webContents.id,
        path: actionPanel.path,
        url: actionPanel.url
      })
      return null
    }
    const windowKey = requestedUrl ? extensionWindowKey(requestedUrl) : null
    const owner = { tabId, projectId, threadId: tab.threadId, boxId: tab.boxId }
    const activateCached = async (popupId: string): Promise<boolean> => {
      // The page a click on the icon asks for is already the one a retained action
      // popup is showing, so it is left alone: only a request that names another
      // page (an extension window, a popout) makes the retained page load again.
      const shown = windowKey
        ? await this.host.popupWindows.activateExtensionWindow(popupId, requestedUrl ?? '')
        : await this.host.popupWindows.retargetExtensionPopup(popupId, owner, requestedUrl)
      if (!shown) return false
      this.host.reportExtensionPageTabs(tabId)
      return true
    }
    // One live page per surface: the jar's action popup, and one per window the
    // extension asked for, so a passkey prompt opening beside the vault popup does
    // not take it away.
    const cached =
      windowKey === null
        ? this.host.popupWindows.extensionPopupForJar(extensionId, projectId, tab.boxId)
        : this.host.popupWindows.extensionWindowFor(extensionId, projectId, tab.boxId, windowKey)
    const popupKey = JSON.stringify([projectId, tab.boxId, extensionId, windowKey])
    let opening = this.host.extensionPopupOpenings.get(popupKey)
    while (opening) {
      try {
        await opening
      } catch {
        // A later action can retry after a failed load; the failed page cleans
        // itself up before the next creation starts.
      }
      opening = this.host.extensionPopupOpenings.get(popupKey)
    }
    const openedWhileWaiting =
      windowKey === null
        ? this.host.popupWindows.extensionPopupForJar(extensionId, projectId, tab.boxId)
        : this.host.popupWindows.extensionWindowFor(extensionId, projectId, tab.boxId, windowKey)
    if (openedWhileWaiting && (await activateCached(openedWhileWaiting))) {
      return openedWhileWaiting
    }
    if (cached && cached !== openedWhileWaiting && (await activateCached(cached))) {
      return cached
    }
    const creation = this.createExtensionPopup(
      projectId,
      tabId,
      tab.threadId,
      tab.boxId,
      extensionId,
      requestedUrl,
      windowKey
    )
    this.host.extensionPopupOpenings.set(popupKey, creation)
    try {
      return await creation
    } finally {
      if (this.host.extensionPopupOpenings.get(popupKey) === creation) {
        this.host.extensionPopupOpenings.delete(popupKey)
      }
    }
  }

  /** Create the one cached action popup page after jar-level access is ready. */
  async createExtensionPopup(
    projectId: string,
    tabId: string,
    threadId: string,
    boxId: string | null,
    extensionId: string,
    requestedUrl?: string,
    windowKey: string | null = null
  ): Promise<string> {
    if (this.host.popupWindows.countForTab(tabId) >= MAX_POPUP_WINDOWS_PER_TAB) {
      throw new Error('This tab already holds the popups it may host')
    }
    await this.host.extensions.ensureExtensionPagesAvailable(extensionId)
    const url = requestedUrl ?? this.host.extensions.popupUrlFor(extensionId, projectId, boxId)
    if (!url) throw new Error('That extension offers no popup in this box')
    // The extension has to be loaded in the jar before its own page can resolve: a
    // jar is loaded on demand and does not wait for a popup.
    await this.host.extensions.ensureJarLoaded(projectId, boxId)
    // The wrappers that answer this page's `chrome.tabs.query` must be in the
    // document before the extension's own bundle reads them: a popup decides which
    // site it is on as it starts, so a push that arrives after `did-finish-load`
    // lands once the decision was already made from focus. See
    // `browser-extension-page-tabs.ts`.
    const preload = await this.host.ensureExtensionPageTabsPreload()
    const view = new WebContentsView({
      webPreferences: {
        session: this.host.sessionForProject(projectId, boxId),
        preload: preload ?? undefined,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        devTools: true
      }
    })
    const popupId = this.host.popupWindows.hostExtension({
      owner: { tabId, projectId, threadId, boxId },
      extensionId,
      windowKey,
      url,
      view,
      viewport: null
    })
    // The wrappers that answer this page's `chrome.tabs.query` live in its
    // document, so every document it arrives with is told which tab it acts on.
    // The preload above already answered the first document; this is what keeps the
    // answer current as the page navigates and as the tab behind it changes.
    view.webContents.on('did-finish-load', () => {
      const currentTabId = this.host.popupWindows.tabIdForContents(view.webContents.id)
      if (currentTabId) this.host.reportExtensionPageTabs(currentTabId)
    })
    try {
      await loadExtensionDocument(view.webContents, url)
    } catch (error: unknown) {
      // A page that could not load is not a popup: without this the rail would keep
      // a tab that can never show anything.
      this.host.popupWindows.close(popupId, 'its page could not be loaded')
      throw error
    }
    return popupId
  }
}
