import {
  nativeImage,
  WebContentsView,
  type MenuItemConstructorOptions,
  type WebContents
} from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { sendToRenderer } from '../../ipc/renderer-delivery'
import { Logger } from '../../system/logger'
import { getConfigRoot } from '../../../lib/utils'
import type {
  BrowserExtensionActivityUpdate,
  BrowserExtensionMenuRecord,
  BrowserExtensionProgress
} from '../../../lib/ipc/browser'
import {
  type BrowserExtensionSidePanelOpenRequest,
  type BrowserExtensionTabEventName,
  type BrowserExtensionTabReplay,
  type BrowserExtensionWebNavigationEventName
} from '../extensions/browser-extension-service'
import { type BrowserExtensionSidePanelHost } from './browser-extension-side-panels'
import { buildExtensionMenuItems, extensionClickContexts } from './browser-context-menu'
import { type BrowserTab } from './browser-types'
import { browserPartitionFor } from './browser-validation'
import {
  EXTENSION_PAGE_TABS_PRELOAD_FILE,
  extensionPageTabsPreloadSource,
  extensionPageTabsScript,
  type BrowserExtensionPageTab
} from '../extensions/browser-extension-page-tabs'
import { resolveBrowserExtensionStoreDir } from '../extensions/browser-extension-registry'
import type { BrowserService } from '../browser-service'
import type { BrowserMenuPage } from './browser-service-common'

/**
 * What installed extensions are told and shown.
 *
 * Extensions are published to the rail, replayed into a fresh worker, told about the
 * tabs and navigations they can see, and given their menu entries. The side panels the
 * rail hosts are part of the same surface: an extension's own document, loaded in its
 * jar, over the frame the rail measures.
 */

/**
 * What `browser-service-extension-runtime` reads off the browser service.
 *
 * Each member is the service's own declaration, so this unit and the composition
 * root cannot drift apart: a changed signature is a compile error here.
 */
export interface ExtensionRuntimeHost {
  readonly activeTabId: BrowserService['activeTabId']
  readonly activeTabIdInProject: BrowserService['activeTabIdInProject']
  extensionPageTabsPreload: BrowserService['extensionPageTabsPreload']
  extensionPageTabsPreloadWrite: BrowserService['extensionPageTabsPreloadWrite']
  readonly extensions: BrowserService['extensions']
  readonly mountedSidePanelViews: BrowserService['mountedSidePanelViews']
  readonly popupWindows: BrowserService['popupWindows']
  readonly raisePageChrome: BrowserService['raisePageChrome']
  readonly sessionForProject: BrowserService['sessionForProject']
  readonly sidePanels: BrowserService['sidePanels']
  readonly sidePanelViewFrames: BrowserService['sidePanelViewFrames']
  readonly stage: BrowserService['stage']
  readonly tabIdForContents: BrowserService['tabIdForContents']
  readonly tabs: BrowserService['tabs']
  readonly window: BrowserService['window']
}

/** What a menu row is high, in points. An extension publishes its icon at store
 *  size, so the menu reduces it to the one line it is drawn on. */
export const MENU_ICON_POINTS = 16

/**
 * An extension's published icon as a menu image.
 *
 * Two pixel representations are built from the one data URL, a single-scale and a
 * double-scale copy of the same picture, so the icon is sharp on a retina menu and
 * still drawn one row high everywhere. A data URL that does not decode answers
 * undefined, which leaves a row with its label and no image rather than no item.
 */
export function extensionMenuIcon(dataUrl: string): MenuItemConstructorOptions['icon'] | undefined {
  const source = nativeImage.createFromDataURL(dataUrl)
  if (source.isEmpty()) return undefined
  const image = nativeImage.createEmpty()
  for (const scaleFactor of [1, 2]) {
    const pixels = MENU_ICON_POINTS * scaleFactor
    const resized = source.resize({ width: pixels, height: pixels, quality: 'best' })
    const buffer = resized.toPNG()
    if (buffer.byteLength === 0) continue
    image.addRepresentation({ scaleFactor, width: pixels, height: pixels, buffer })
  }
  return image.isEmpty() ? undefined : image
}

/** The menu's view of one browser tab's own page. */
/**
 * One tab as `chrome.tabs` describes it, for the lifecycle events the app
 * synthesizes into a worker. Only the fields an extension reads in practice are
 * carried; `index` is always 0 because this browser has one strip and no
 * reorderable per-window indices of its own.
 */
export interface BrowserExtensionTabInfo {
  id: number
  index: number
  windowId: number
  windowType: 'normal'
  active: boolean
  pinned: boolean
  incognito: boolean
  url: string
  title: string
  status: 'loading' | 'complete'
}

export class BrowserServiceExtensionRuntime {
  constructor(private readonly host: ExtensionRuntimeHost) {}

  publishExtensions(): void {
    this.reconcileExtensionPopups()
    this.reconcileExtensionSidePanels()
    if (this.host.window.webContents.isDestroyed()) return
    sendToRenderer(this.host.window.webContents, 'browser:extensions', this.host.extensions.list())
  }

  /** One extension's action state, published the moment its worker reports it. */
  publishExtensionActivity(update: BrowserExtensionActivityUpdate): void {
    if (this.host.window.webContents.isDestroyed()) return
    sendToRenderer(this.host.window.webContents, 'browser:extensionActivity', update)
  }

  // ─── Extensions beside a page ──────────────────────────────────────────────

  /**
   * One tab fact, aimed at the extensions loaded in that tab's jar.
   *
   * The runtime delivers no tab lifecycle events of its own, so these are what
   * an extension's state machine is driven by: a created, updated, activated or
   * removed tab, in the shapes `chrome.tabs` documents, so a listener written
   * against the real API runs unmodified.
   *
   * One fact reaches two kinds of listener, which is why the tab is named rather
   * than left to the arguments: the worker's state machine, through those argument
   * shapes, and the extension's own pages, because a popup the app hosts for an
   * extension is a document that asks the same question the worker is being told
   * the answer to (see `reportExtensionPageTabs`).
   */
  notifyExtensionTab(
    tabId: string,
    projectId: string,
    boxId: string | null,
    name: BrowserExtensionTabEventName,
    args: unknown[]
  ): void {
    this.host.extensions.onTabEvent(projectId, boxId, name, args)
    // The two facts an extension's own page acts on are the address and title of
    // the page it is acting on and whether that page is the one on screen. The rest
    // of the lifecycle either concerns the tab's jar or belongs to a tab that is
    // going away, and a tab that goes away takes its own popups with it.
    if (name === 'onUpdated' || name === 'onActivated') this.reportExtensionPageTabs(tabId)
  }

  /**
   * Tell every extension page one tab owns which tab it is acting on.
   *
   * An extension's action popup is hosted by the app in a rail popup, and it is a
   * `WebContents` among the pages, so the runtime answers its `chrome.tabs.query`
   * from focus   and the popup is the focused view by design. A query for "the tab I
   * am acting on" therefore came back as the popup's own document, which Bitwarden
   * reads as the site the user is on ("Site doesn't match", `CURRENT WEBSITE
   * nngceckbapebfimnlniiiahkandclblb`), so the app pushes the tab it knows instead.
   * See `browser-extension-page-tabs.ts`.
   */
  reportExtensionPageTabs(tabId: string): void {
    for (const contents of this.host.popupWindows.extensionPagesForTab(tabId)) {
      this.pushExtensionPageTab(tabId, contents)
    }
  }

  /**
   * The tab one extension page acts on, for the preload that asks before the
   * page's own scripts exist.
   *
   * Only a `WebContents` this app hosts for an extension can be answered at all:
   * the two registries below are the app's own record of which tab each extension
   * surface belongs to, so a document the app is not hosting gets nothing rather
   * than a guess.
   */
  extensionPageTabForContents(contentsId: number): BrowserExtensionPageTab | null {
    const tabId =
      this.host.popupWindows.tabIdForContents(contentsId) ??
      this.host.sidePanels.tabIdForContents(contentsId)
    if (!tabId) return null
    return this.extensionPageTabSnapshot(tabId)
  }

  /**
   * The page behind an extension surface, as the extension should see it.
   *
   * One builder, because two callers need the same answer at different moments:
   * the preload asks for it before the popup's first script runs, and a push sends
   * it again whenever the page it describes changes or moves.
   */
  extensionPageTabSnapshot(tabId: string): BrowserExtensionPageTab | null {
    const tab = this.host.tabs.get(tabId)
    if (!tab) return null
    const page: WebContents | undefined = tab.view.webContents
    if (!page || page.isDestroyed()) return null
    return {
      id: page.id,
      url: page.getURL(),
      title: page.getTitle(),
      active: this.host.activeTabId === tabId,
      loading: page.isLoading(),
      audible: page.isCurrentlyAudible(),
      muted: page.isAudioMuted()
    }
  }

  /**
   * One extension page, told the tab it is acting on.
   *
   * The tab is reported with the page's own `WebContents` id and address, which is
   * what makes an autofill flow correct rather than merely quiet: the extension
   * messages that id, and the message lands in the page's content script.
   */
  pushExtensionPageTab(tabId: string, contents: WebContents): void {
    if (contents.isDestroyed()) return
    const snapshot = this.extensionPageTabSnapshot(tabId)
    if (!snapshot) return
    void contents
      .executeJavaScript(extensionPageTabsScript(snapshot), true)
      .catch((error: unknown) => {
        Logger.dev('An extension page could not be told which tab it acts on', {
          tabId,
          error: error instanceof Error ? error.message : String(error)
        })
      })
  }

  /**
   * Write the preload an extension page is created with, once per run.
   *
   * It has to exist on disk before the first extension surface is created, because
   * `webPreferences.preload` is a path and a view cannot be built without one, so
   * the write is started when the service registers and every caller that can wait
   * does. The content is generated from the same wrapper source main pushes, so the
   * preload and the push can never describe the page differently.
   */
  ensureExtensionPageTabsPreload(): Promise<string | null> {
    this.host.extensionPageTabsPreloadWrite ??= this.writeExtensionPageTabsPreload()
    return this.host.extensionPageTabsPreloadWrite
  }

  async writeExtensionPageTabsPreload(): Promise<string | null> {
    const file = join(
      getConfigRoot(),
      resolveBrowserExtensionStoreDir(),
      EXTENSION_PAGE_TABS_PRELOAD_FILE
    )
    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, extensionPageTabsPreloadSource(), 'utf8')
      this.host.extensionPageTabsPreload = file
      return file
    } catch (error: unknown) {
      Logger.error('The extension page-tabs preload could not be written:', error)
      return null
    }
  }

  /**
   * One navigation fact for a tab's main frame, aimed at the extensions loaded
   * in that tab's jar.
   *
   * `chrome.webNavigation` is compiled out of the runtime, so nothing drives an
   * extension's navigation listeners on its own. The app watches the tab's own
   * main frame and hands each step over in the details shape the API documents,
   * so a listener written against the real API runs unmodified.
   */
  notifyExtensionWebNavigation(
    projectId: string,
    boxId: string | null,
    name: BrowserExtensionWebNavigationEventName,
    details: Record<string, unknown>
  ): void {
    this.host.extensions.onWebNavigationEvent(projectId, boxId, name, details)
  }

  /**
   * One `chrome.webNavigation` details record for a main-frame event.
   *
   * Chromium exposes neither a document id nor a page transition, so the document
   * id is the page's own web contents id and a navigation generation, and the
   * transition is approximated by the caller.
   *
   * The generation is the tab's committed-navigation counter, which is why
   * `onBeforeNavigate` passes `documentGeneration + 1`: that counter increments when
   * the navigation commits, so the attempt and the commit that follows it only share
   * a document id if the attempt names the document it is about to create. An
   * extension correlating the two events by `documentId` is the reason.
   */
  extensionWebNavigationDetails(
    tab: BrowserTab,
    url: string,
    options?: { transitionType?: 'link' | 'reload'; error?: string; documentGeneration?: number }
  ): Record<string, unknown> {
    const contents: WebContents | undefined = tab.view.webContents
    const webContentsId = contents && !contents.isDestroyed() ? contents.id : -1
    const generation = options?.documentGeneration ?? tab.navigationGeneration
    const details: Record<string, unknown> = {
      tabId: webContentsId,
      frameId: 0,
      parentFrameId: -1,
      url,
      timeStamp: Date.now(),
      documentId: `${webContentsId}-${generation}`,
      documentLifecycle: 'active',
      transitionQualifiers: []
    }
    if (options?.transitionType) details['transitionType'] = options.transitionType
    if (options?.error) details['error'] = options.error
    return details
  }

  /** A tab became the one on screen: the extension-visible activation event. */
  notifyExtensionActivated(tabId: string): void {
    const tab = this.host.tabs.get(tabId)
    if (!tab) return
    const contents: WebContents | undefined = tab.view.webContents
    if (!contents || contents.isDestroyed()) return
    this.host.popupWindows.followActiveTab(
      { tabId, projectId: tab.projectId, threadId: tab.threadId, boxId: tab.boxId },
      (extensionId) => this.host.extensions.popupUrlFor(extensionId, tab.projectId, tab.boxId)
    )
    this.notifyExtensionTab(tabId, tab.projectId, tab.boxId, 'onActivated', [
      { tabId: contents.id, windowId: 0 }
    ])
  }

  /**
   * Every tab event a jar's worker needs to know what is already open.
   *
   * A worker starts long after the tabs it runs beside, and the runtime gives it
   * no usable way to discover them: `chrome.tabs.query` answers from the
   * runtime's own focus state, so a query for the active tab comes back empty
   * whenever the app is not the focused one, and a browser view is not a tab in
   * a window the runtime tracks. Both a fresh worker and a restarted one are
   * therefore handed this replay, built from the app's own tab registry.
   *
   * Order matters and is the only contract here: every tab is announced, then
   * each tab's address and title, then the tab that is on screen. An extension
   * that scopes its state per tab ends up with the right state on the right tab,
   * which is what a badge count or a locked padlock on the current tab is.
   *
   * A hibernated tab has no page and is left out: announcing a page the runtime
   * cannot resolve would be a lie the extension then acts on.
   */
  extensionTabReplay(projectId: string, boxId: string | null): BrowserExtensionTabReplay[] {
    // By jar, not by owner: a box's session is one jar however many contexts have
    // a tab in it, and an extension loaded there must be told about every page it
    // can see, including ones a conversation opened rather than the global browser.
    const partition = browserPartitionFor(projectId, boxId)
    const live: { tabId: string; tab: BrowserTab; contents: WebContents }[] = []
    for (const [tabId, tab] of this.host.tabs) {
      if (browserPartitionFor(tab.projectId, tab.boxId) !== partition) continue
      const contents: WebContents | undefined = tab.view.webContents
      if (!contents || contents.isDestroyed()) continue
      live.push({ tabId, tab, contents })
    }
    const events: BrowserExtensionTabReplay[] = []
    for (const entry of live) {
      events.push({ name: 'onCreated', args: [this.extensionTabInfo(entry.tabId, entry.tab)] })
    }
    for (const entry of live) {
      const info = this.extensionTabInfo(entry.tabId, entry.tab)
      // `changeInfo.url` is not decoration: an extension that tracks what a tab
      // is showing filters its `onUpdated` listener on it, so an update that
      // omits the address is an update it never sees.
      events.push({
        name: 'onUpdated',
        args: [entry.contents.id, { status: info.status, url: info.url }, info]
      })
    }
    const active = live.find((entry) => entry.tabId === this.host.activeTabId)
    if (active) {
      events.push({
        name: 'onActivated',
        args: [{ tabId: active.contents.id, windowId: 0 }]
      })
    }
    return events
  }

  /** One tab as `chrome.tabs` describes it, for a synthesized event. */
  extensionTabInfo(tabId: string, tab: BrowserTab): BrowserExtensionTabInfo {
    const contents: WebContents | undefined = tab.view.webContents
    const active = this.host.activeTabId === tabId
    if (!contents || contents.isDestroyed()) {
      return {
        id: -1,
        index: 0,
        windowId: 0,
        windowType: 'normal',
        active,
        pinned: false,
        incognito: false,
        url: '',
        title: '',
        status: 'complete'
      }
    }
    return {
      id: contents.id,
      index: 0,
      windowId: 0,
      windowType: 'normal',
      active,
      pinned: false,
      incognito: false,
      url: contents.getURL(),
      title: contents.getTitle(),
      status: contents.isLoading() ? 'loading' : 'complete'
    }
  }

  /**
   * The right-click items every extension in the page's jar contributed.
   *
   * Recorded trees are read at click time rather than kept warm, and a chosen
   * item travels back through its extension's bridge as `contextMenus.onClicked`.
   */
  extensionMenuItems(
    page: BrowserMenuPage,
    params: Electron.ContextMenuParams
  ): MenuItemConstructorOptions[] {
    const sections = this.host.extensions.menuRecordsFor(page.owner.projectId, page.owner.boxId)
    if (sections.length === 0) return []
    return buildExtensionMenuItems(
      sections,
      extensionClickContexts(params),
      (section, item) => {
        this.dispatchExtensionMenuClick(page, params, section.extensionId, item)
      },
      extensionMenuIcon
    )
  }

  /** Hand one chosen extension item back to the worker that recorded it. */
  dispatchExtensionMenuClick(
    page: BrowserMenuPage,
    params: Electron.ContextMenuParams,
    extensionId: string,
    item: BrowserExtensionMenuRecord
  ): void {
    const contents = page.contents
    if (contents.isDestroyed()) return
    const info: Record<string, unknown> = {
      menuItemId: item.rawId,
      editable: params.isEditable,
      pageUrl: contents.getURL(),
      frameId: 0
    }
    if (item.parentId) info['parentMenuItemId'] = item.parentId
    if (params.linkURL) info['linkUrl'] = params.linkURL
    if (params.srcURL) info['srcUrl'] = params.srcURL
    if (params.selectionText.trim()) info['selectionText'] = params.selectionText
    if (params.mediaType !== 'none') info['mediaType'] = params.mediaType
    if (item.type === 'checkbox' || item.type === 'radio') {
      info['wasChecked'] = item.checked
      info['checked'] = !item.checked
    }
    this.host.extensions.dispatchMenuClick(
      page.owner.projectId,
      page.owner.boxId,
      extensionId,
      info,
      {
        id: contents.id,
        url: contents.getURL(),
        title: contents.getTitle(),
        active: this.host.activeTabId === page.owner.tabId,
        windowId: 0,
        index: 0
      }
    )
  }

  /**
   * Close extension popups whose extension is no longer there to answer.
   *
   * An extension's popup hosts the extension's own page in the jar that runs it, so
   * an extension that was uninstalled, disabled, or taken out of that box leaves a
   * page behind that nothing can talk to. The installed list is published on every
   * change to it, which makes that the one place that sees all of them.
   */
  reconcileExtensionPopups(): void {
    const jarsByExtension = new Map<string, Set<string>>()
    for (const extension of this.host.extensions.list()) {
      if (!extension.enabled) continue
      jarsByExtension.set(extension.id, new Set(extension.boxes))
    }
    this.host.popupWindows.closeWhere((record) => {
      if (record.extensionId === null) return false
      const jars = jarsByExtension.get(record.extensionId)
      if (!jars) return true
      return !jars.has(record.boxId ?? '')
    }, 'its extension was unloaded')
  }

  publishExtensionProgress(progress: BrowserExtensionProgress): void {
    if (this.host.window.webContents.isDestroyed()) return
    sendToRenderer(this.host.window.webContents, 'browser:extensionProgress', progress)
  }

  /**
   * The view plumbing extension side panels run on.
   *
   * The registry owns panel lifetimes; every native call a view needs stays here,
   * beside the tab and popup ones, so a panel is placed, parked and dropped the
   * same way and there is one place to look when a document is not where it should
   * be.
   */
  sidePanelHost(): BrowserExtensionSidePanelHost {
    return {
      mount: (view, bounds) => {
        if (this.host.window.isDestroyed()) return
        try {
          this.host.sidePanelViewFrames.set(view, bounds)
          if (this.host.mountedSidePanelViews.has(view)) {
            // Already on screen: re-asserting the frame is cheaper than the
            // re-parent a repeat would otherwise cost.
            view.setBounds(bounds)
            return
          }
          this.host.stage.release(view)
          this.host.window.contentView.addChildView(view)
          this.host.mountedSidePanelViews.add(view)
          view.setBounds(bounds)
          this.host.raisePageChrome()
        } catch (error: unknown) {
          Logger.error('Browser extension side panel could not be placed:', error)
        }
      },
      unmount: (view, viewport) => {
        this.detachSidePanelView(view)
        this.host.stage.park(view, viewport)
      },
      discard: (view) => {
        this.detachSidePanelView(view)
        this.host.stage.release(view)
      },
      changed: () => this.publishExtensionSidePanels(),
      notify: (record, opened) => {
        // A panel opening and closing are the two facts the worker's own
        // `chrome.sidePanel.onOpened` / `onClosed` are made of, and the tab id is
        // the one the extension already knows this panel by.
        if (opened) {
          this.host.extensions.reportSidePanelOpened(
            record.projectId,
            record.boxId,
            record.extensionId,
            record.extensionTabId
          )
          return
        }
        this.host.extensions.reportSidePanelClosed(
          record.projectId,
          record.boxId,
          record.extensionId,
          record.extensionTabId
        )
      }
    }
  }

  /**
   * Take a side panel's view out of the app window, answering whether it was in
   * it. A view whose document destroyed itself cannot be handed to the window at
   * all, so every native call is defended.
   */
  detachSidePanelView(view: WebContentsView): boolean {
    this.host.sidePanelViewFrames.delete(view)
    if (!this.host.mountedSidePanelViews.has(view)) return false
    this.host.mountedSidePanelViews.delete(view)
    if (this.host.window.isDestroyed()) return false
    try {
      this.host.window.contentView.removeChildView(view)
    } catch (error: unknown) {
      Logger.error('Browser extension side panel could not be detached:', error)
      return false
    }
    return true
  }

  /**
   * Raise one extension's side panel over the rail.
   *
   * The worker names the extension's own tab id; a request may name none, in which
   * case Chromium's answer is the active tab of that project's browser. The panel's
   * document is loaded in the jar the extension runs in, which is the only session
   * its own files resolve in.
   */
  async openExtensionSidePanel(request: BrowserExtensionSidePanelOpenRequest): Promise<void> {
    const appTabId =
      request.extensionTabId === null
        ? this.host.activeTabIdInProject(request.projectId)
        : (this.host.tabIdForContents(request.projectId, request.extensionTabId) ?? null)
    if (!appTabId) {
      Logger.dev('An extension side panel had no tab to open on:', {
        extensionId: request.extensionId,
        extensionTabId: request.extensionTabId
      })
      return
    }
    const tab = this.host.tabs.get(appTabId)
    if (!tab) return
    this.host.sidePanels.open({
      session: this.host.sessionForProject(request.projectId, request.boxId),
      extensionId: request.extensionId,
      extensionName: request.extensionName,
      projectId: request.projectId,
      boxId: request.boxId,
      appTabId,
      extensionTabId: request.extensionTabId ?? tab.view.webContents.id,
      // Awaited, not read as a field: the panel's document is the extension's own,
      // so it decides which site it is on as its bundle starts, exactly like an
      // action popup. Reading the field would hand the first panel of a session a
      // null preload and leave it with the late push, which is the defect the
      // preload exists to remove. Null only when the write itself failed, and the
      // panel then still opens on the push rather than not opening at all.
      preload: await this.ensureExtensionPageTabsPreload(),
      path: request.path,
      url: request.url
    })
  }

  /** Publish the extension side panels the browser holds, whole, after any change. */
  publishExtensionSidePanels(): void {
    if (this.host.window.webContents.isDestroyed()) return
    sendToRenderer(
      this.host.window.webContents,
      'browser:extensionSidePanels',
      this.host.sidePanels.list()
    )
  }

  /**
   * Close side panels whose extension is no longer there to answer.
   *
   * A panel hosts the extension's own document in the jar that runs it, so an
   * extension that was uninstalled, disabled, or taken out of that box leaves a
   * document behind that nothing can talk to. The installed list is published on
   * every change to it, which makes that the one place that sees all of them.
   */
  reconcileExtensionSidePanels(): void {
    const jarsByExtension = new Map<string, Set<string>>()
    for (const extension of this.host.extensions.list()) {
      if (!extension.enabled) continue
      jarsByExtension.set(extension.id, new Set(extension.boxes))
    }
    this.host.sidePanels.closeWhere((record) => {
      const jars = jarsByExtension.get(record.extensionId)
      if (!jars) return true
      return !jars.has(record.boxId ?? '')
    }, 'its extension was unloaded')
  }
}
