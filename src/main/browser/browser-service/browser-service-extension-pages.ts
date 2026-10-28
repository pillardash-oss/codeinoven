import { WebContentsView } from 'electron'
import { Logger } from '../../system/logger'
import { type BrowserExtensionActionPopupOpenRequest } from '../extensions/browser-extension-service'
import { ownedExtensionPageUrl } from '../extensions/browser-extension-page-url'
import { type BrowserPageOwner } from './browser-types'
import { MAX_POPUP_WINDOWS_PER_TAB } from './browser-validation'
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
  readonly openExtensionSidePanel: BrowserService['openExtensionSidePanel']
  readonly openNewTabFor: BrowserService['openNewTabFor']
  readonly popupWindows: BrowserService['popupWindows']
  readonly reportExtensionPageTabs: BrowserService['reportExtensionPageTabs']
  readonly sessionForProject: BrowserService['sessionForProject']
  readonly tabForContents: BrowserService['tabForContents']
  readonly tabs: BrowserService['tabs']
  readonly validateTabNavigationUrl: BrowserService['validateTabNavigationUrl']
  readonly window: BrowserService['window']
}

export class BrowserServiceExtensionPages {
  constructor(private readonly host: ExtensionPagesHost) {}

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

  openExtensionWindowFromWorker(request: BrowserExtensionActionPopupOpenRequest): void {
    const owner = this.host.tabForContents(request.extensionTabId)
    if (!owner) return
    const tab = owner.tab
    if (tab.projectId !== request.projectId || tab.boxId !== request.boxId) return

    if (request.kind === 'open-tab') {
      // The extension asked for a window that is not its own popout, and this app
      // has one browser window: the page becomes a tab beside the one the
      // extension is acting on. The URL is held to the same rule a link click is,
      // so a web page is admitted and nothing else is.
      try {
        const url = this.host.validateTabNavigationUrl(request.projectId, tab.boxId, request.url)
        this.host.openNewTabFor(
          { tabId: owner.id, projectId: tab.projectId, threadId: tab.threadId, boxId: tab.boxId },
          url
        )
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
        if (this.host.activeTabId === owner.id && !tab.view.webContents.isDestroyed()) {
          tab.view.webContents.focus()
        }
      }
      return
    }

    if (request.kind === 'hide-window') {
      const cached = this.host.popupWindows.extensionPopupForJar(
        request.extensionId,
        request.projectId,
        request.boxId
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
      request.projectId,
      owner.id,
      tab.threadId,
      tab.boxId,
      request.extensionId,
      requestedUrl
    ).catch((error: unknown) => {
      Logger.dev('An extension action popup could not be opened:', {
        extensionId: request.extensionId,
        error
      })
    })
  }

  /**
   * Open an extension's own popup in the rail. Its page runs in the extension's
   * jar, remains live when hidden, and is retargeted when the extension is used in
   * another tab in the same jar.
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
    // One live popup page per extension jar: moving to another tab retargets this
    // view instead of creating another extension document and worker connection.
    const cached = this.host.popupWindows.extensionPopupForJar(extensionId, projectId, tab.boxId)
    const activateCached = async (popupId: string): Promise<boolean> => {
      if (
        !this.host.popupWindows.retargetExtensionPopup(
          popupId,
          { tabId, projectId, threadId: tab.threadId, boxId: tab.boxId },
          requestedUrl ??
            this.host.extensions.popupUrlFor(extensionId, projectId, tab.boxId) ??
            undefined
        )
      )
        return false
      if (requestedUrl) {
        try {
          if (!(await this.host.popupWindows.navigateExtensionPopup(popupId, requestedUrl)))
            return false
        } catch (error: unknown) {
          Logger.dev('A retained extension page could not navigate to its requested popup:', {
            extensionId,
            error
          })
          return true
        }
      }
      this.host.reportExtensionPageTabs(tabId)
      return true
    }
    if (cached && (await activateCached(cached))) {
      return cached
    }
    const popupKey = JSON.stringify([projectId, tab.boxId, extensionId])
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
    const openedWhileWaiting = this.host.popupWindows.extensionPopupForJar(
      extensionId,
      projectId,
      tab.boxId
    )
    if (openedWhileWaiting && (await activateCached(openedWhileWaiting))) {
      return openedWhileWaiting
    }
    const creation = this.createExtensionPopup(
      projectId,
      tabId,
      tab.threadId,
      tab.boxId,
      extensionId,
      requestedUrl
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
    requestedUrl?: string
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
      await view.webContents.loadURL(url)
    } catch (error: unknown) {
      // A page that could not load is not a popup: without this the rail would keep
      // a tab that can never show anything.
      this.host.popupWindows.close(popupId, 'its page could not be loaded')
      throw error
    }
    return popupId
  }
}
