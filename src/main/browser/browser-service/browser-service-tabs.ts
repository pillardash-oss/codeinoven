import { webFrameMain, WebContentsView, type WebContents } from 'electron'
import {
  GLOBAL_BROWSER_PROJECT_ID,
  type BrowserLoadError,
  type BrowserTabDestroyReason
} from '../../../lib/ipc-contract'
import { sendToRenderer } from '../../ipc/renderer-delivery'
import { fetchIconAsDataUrl } from '../../editor/favicon-service'
import { type BrowserDownloadOwner } from './browser-downloads'
import {
  matchBrowserShortcut,
  matchesBrowserChord,
  isReservedBrowserAction
} from './browser-shortcuts'
import { permissionResolutions } from './browser-permissions'
import { type BrowserPageOwner, type BrowserTab } from './browser-types'
import { isAbortedNavigation } from './browser-navigation-outcome'
import { applyBrowserPageBackground } from './browser-page-background'
import { installBrowserHistorySwipe } from './browser-history-swipe'
import { faviconForCommittedUrl, faviconOriginOf, rememberFavicon } from './browser-favicon-memory'
import { browserFindResultFor } from './browser-find'
import type { BrowserService } from '../browser-service'
import { consoleFrameUrl } from './browser-service-common'
import { pageKeyFromInput } from './browser-service-keyboard'
import { liveContents, liveWindowContents } from './browser-view-contents'

/**
 * A browser tab: creating it, finding it, and destroying it.
 *
 * The one place a `WebContentsView` becomes a tab   its jar, its preload, its
 * policies, its initial navigation   and the one place a tab is given back. Every
 * other unit resolves a tab through here rather than reading the map, so a tab that is
 * gone is refused in one place instead of in twenty.
 */

/**
 * What `browser-service-tabs` reads off the browser service.
 *
 * Each member is the service's own declaration, so this unit and the composition
 * root cannot drift apart: a changed signature is a compile error here.
 */
export interface TabsHost {
  activeTabBounds: BrowserService['activeTabBounds']
  activeTabId: BrowserService['activeTabId']
  readonly agentReveals: BrowserService['agentReveals']
  readonly agentTabIds: BrowserService['agentTabIds']
  readonly allowSiteKeymapOverride: BrowserService['allowSiteKeymapOverride']
  readonly appendConsoleEntry: BrowserService['appendConsoleEntry']
  readonly applyScrollbarTheme: BrowserService['applyScrollbarTheme']
  readonly appShortcutChords: BrowserService['appShortcutChords']
  readonly armCompositionQuietly: BrowserService['armCompositionQuietly']
  readonly assistantPageTabIds: BrowserService['assistantPageTabIds']
  readonly canUseScreenHistory: BrowserService['canUseScreenHistory']
  readonly capture: BrowserService['capture']
  readonly captureTabHistory: BrowserService['captureTabHistory']
  readonly childTabOpeners: BrowserService['childTabOpeners']
  readonly compositionShortcutChords: BrowserService['compositionShortcutChords']
  readonly consumeSwitcherKey: BrowserService['consumeSwitcherKey']
  readonly dismissStatusOverlay: BrowserService['dismissStatusOverlay']
  readonly dispatchPageKey: BrowserService['dispatchPageKey']
  displayedTab: BrowserService['displayedTab']
  readonly dropPendingPark: BrowserService['dropPendingPark']
  readonly extensionNavigationUrls: BrowserService['extensionNavigationUrls']
  readonly extensions: BrowserService['extensions']
  readonly extensionTabInfo: BrowserService['extensionTabInfo']
  readonly extensionWebNavigationDetails: BrowserService['extensionWebNavigationDetails']
  readonly findSessions: BrowserService['findSessions']
  focusedChromeTabId: BrowserService['focusedChromeTabId']
  readonly focusPageView: BrowserService['focusPageView']
  readonly forgetParked: BrowserService['forgetParked']
  readonly injectDialogContext: BrowserService['injectDialogContext']
  readonly injectedDialogLabels: BrowserService['injectedDialogLabels']
  readonly inspector: BrowserService['inspector']
  readonly installWindowOpenPolicy: BrowserService['installWindowOpenPolicy']
  readonly isAllowedTabNavigation: BrowserService['isAllowedTabNavigation']
  readonly isPageOnScreen: BrowserService['isPageOnScreen']
  readonly jarHasLivePage: BrowserService['jarHasLivePage']
  keyboardOwnerTabId: BrowserService['keyboardOwnerTabId']
  readonly lastScreenshot: BrowserService['lastScreenshot']
  readonly notifyExtensionTab: BrowserService['notifyExtensionTab']
  readonly notifyExtensionWebNavigation: BrowserService['notifyExtensionWebNavigation']
  readonly offerExternalNavigation: BrowserService['offerExternalNavigation']
  readonly onTargetUrlReport: BrowserService['onTargetUrlReport']
  readonly linkPeek: BrowserService['linkPeek']
  readonly pageKeys: BrowserService['pageKeys']
  readonly peekTabs: BrowserService['peekTabs']
  pendingPageFocusTabId: BrowserService['pendingPageFocusTabId']
  readonly pendingPermissions: BrowserService['pendingPermissions']
  pendingShow: BrowserService['pendingShow']
  readonly playheads: BrowserService['playheads']
  readonly popupWindows: BrowserService['popupWindows']
  readonly publishFindResult: BrowserService['publishFindResult']
  readonly publishState: BrowserService['publishState']
  readonly refreshTabMark: BrowserService['refreshTabMark']
  readonly requestPanelShortcut: BrowserService['requestPanelShortcut']
  readonly resolveLoadOutcome: BrowserService['resolveLoadOutcome']
  readonly resolvePermission: BrowserService['resolvePermission']
  restorePageFocusTabId: BrowserService['restorePageFocusTabId']
  readonly runBrowserShortcut: BrowserService['runBrowserShortcut']
  readonly scrollbarStyles: BrowserService['scrollbarStyles']
  readonly sessionForProject: BrowserService['sessionForProject']
  readonly setTabLoadError: BrowserService['setTabLoadError']
  readonly shortcutBindings: BrowserService['shortcutBindings']
  readonly showTabContextMenu: BrowserService['showTabContextMenu']
  readonly sidePanels: BrowserService['sidePanels']
  readonly stage: BrowserService['stage']
  readonly stashClosedTabHistory: BrowserService['stashClosedTabHistory']
  readonly tabHistory: BrowserService['tabHistory']
  readonly tabs: BrowserService['tabs']
  readonly targetUrlTabId: BrowserService['targetUrlTabId']
  readonly threadBrowserPages: BrowserService['threadBrowserPages']
  readonly window: BrowserService['window']
}

export class BrowserServiceTabs {
  /** Tabs whose close is already running, so a page that reports its own
   *  destruction mid-close cannot re-enter the same close. */
  private readonly closing = new Set<string>()

  constructor(private readonly host: TabsHost) {}

  /**
   * The cookie box a tab already runs in, or the conversation's own jar when this
   * is a tab this process has not created yet.
   *
   * A jar cannot move between boxes, so an app-owned surface that re-addresses a
   * tab the user put in a box has to keep that box: asking for the unboxed jar
   * instead would refuse the very page the surface is about to show, which is what
   * made a page unreachable the moment the user switched the thread browser's box.
   * Only the strip's own show chooses a box, because that is the surface the user
   * picks one in.
   */
  boxOfExistingTab(tabId: string): string | null {
    return this.host.tabs.get(tabId)?.boxId ?? null
  }

  ensureTab(
    tabId: string,
    projectId: string,
    threadId: string,
    boxId: string | null = null,
    childContents?: WebContents
  ): BrowserTab {
    const existing = this.host.tabs.get(tabId)
    if (existing) {
      if (existing.projectId !== projectId || existing.threadId !== threadId) {
        throw new Error('Browser tab belongs to a different project or thread')
      }
      if (existing.boxId !== boxId) {
        // Cookies cannot move between jars, so a tab cannot either. Re-parenting
        // one would leave the page reading a store its session does not have.
        throw new Error('Browser tab belongs to a different box')
      }
      if (liveContents(existing.view)) return existing
      // A tab whose page destroyed itself keeps its record but has nothing left
      // to draw, so nothing would ever hand it a page again and it came back
      // blank for the rest of the session. Retiring the dead record here is what
      // lets the show that asked for it build a real view instead.
      this.host.tabs.delete(tabId)
      this.host.stage.release(existing.view)
      this.host.forgetParked(tabId)
      if (this.host.displayedTab?.tabId === tabId) this.host.displayedTab = null
      if (this.host.activeTabId === tabId) {
        this.host.activeTabId = null
        this.host.activeTabBounds = null
      }
      if (this.host.keyboardOwnerTabId === tabId) this.host.keyboardOwnerTabId = null
      if (this.host.focusedChromeTabId === tabId) this.host.focusedChromeTabId = null
    }

    const browserSession = this.host.sessionForProject(projectId, boxId)

    // Extension loading is deliberately off the tab-creation path: `ensureTab` is
    // synchronous and creating a page must not wait on disk. The extension service
    // is single-flight per jar, so a burst of shows loads each extension once.
    void this.host.extensions.ensureJarLoaded(projectId, boxId)

    const view = childContents
      ? new WebContentsView({ webContents: childContents })
      : new WebContentsView({
          webPreferences: {
            session: browserSession,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true,
            devTools: true
          }
        })
    // The tab carries no document yet, so nothing of the page's own surface is
    // painted over the app until one commits.
    applyBrowserPageBackground(view)
    const tab: BrowserTab = {
      view,
      projectId,
      threadId,
      boxId,
      initialNavigationStarted: false,
      consoleEntries: [],
      favicon: null,
      faviconByOrigin: new Map(),
      requestedViewport: null,
      displayedViewport: null,
      design: null,
      composition: null,
      transport: null,
      transportMuted: false,
      navigationGeneration: 0,
      loadError: null,
      navigationFailure: null
    }
    this.host.tabs.set(tabId, tab)
    this.host.notifyExtensionTab(tabId, projectId, boxId, 'onCreated', [
      this.host.extensionTabInfo(tabId, tab)
    ])

    const publish = (): void => this.host.publishState(tabId)
    // A native click is explicit keyboard intent. Page scripts, reloads and
    // agent DOM operations may focus the contents too, but cannot claim it.
    view.webContents.on('before-mouse-event', (_event, mouse) => {
      if (mouse.type !== 'mouseDown' || !this.host.isPageOnScreen(tabId)) return
      this.host.pendingPageFocusTabId = null
      this.host.focusPageView(tabId, tab)
    })
    view.webContents.on('focus', () => {
      if (this.host.keyboardOwnerTabId === tabId) return
      // Native focus can precede mouseDown. Let that click claim ownership
      // before rejecting an unsolicited handover, and recheck after the turn.
      setImmediate(() => {
        const page = liveContents(view)
        if (!page) return
        if (!page.isFocused() || this.host.keyboardOwnerTabId === tabId) return
        const ownerId = this.host.keyboardOwnerTabId
        const owner = ownerId ? this.host.tabs.get(ownerId) : undefined
        if (ownerId && owner && this.host.isPageOnScreen(ownerId)) {
          this.host.focusPageView(ownerId, owner)
        } else {
          liveWindowContents(this.host.window)?.focus()
        }
      })
    })
    // A key pressed in the page reaches this view's web contents and nothing
    // else in the app, so this is where the browser claims the chords it
    // reserves. Preventing the event also prevents the application menu from
    // acting on the key, which is what keeps Cmd/Ctrl+R from reloading the whole
    // app (in a development build the menu is Electron's default one) and
    // Cmd/Ctrl+W from closing its window.
    //
    // Only reserved chrome chords are claimed, so a page keeps every shortcut it
    // can answer itself, including `mod+f` for its own find. A key the page
    // receives is dispatched to the page first; nothing here intercepts an app
    // shortcut, so the page's own handler always wins.
    view.webContents.on('before-input-event', (event, input) => {
      if (this.host.peekTabs.has(tabId) && input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault()
        this.host.requestPanelShortcut(tabId, 'close-tab')
        return
      }
      // The switcher is claimed first: it is an app-level gesture that must work
      // from inside a page, and it must never be shadowed by a browser binding.
      if (this.host.consumeSwitcherKey(input)) {
        event.preventDefault()
        return
      }
      if (
        this.host.tabs.get(tabId)?.composition &&
        matchesBrowserChord(input, this.host.compositionShortcutChords)
      ) {
        event.preventDefault()
        this.host.dispatchPageKey(pageKeyFromInput(input))
        return
      }
      const action = matchBrowserShortcut(input, this.host.shortcutBindings)
      const usable =
        action &&
        ((action !== 'designUndo' && action !== 'designRedo') ||
          this.host.canUseScreenHistory(tabId))
          ? action
          : null
      if (this.host.allowSiteKeymapOverride) {
        // The page goes first. Reserved chrome is still claimed here   no page can
        // answer a reload or a tab close, and the application menu would take the
        // key instead   and every other chord is left to the page, which reports
        // back the ones it did not handle (see `handlePageKey`).
        if (usable && isReservedBrowserAction(usable)) {
          event.preventDefault()
          this.host.runBrowserShortcut(tabId, usable)
        }
        return
      }
      // The app wins every chord, whether the page is focused or not.
      if (usable) {
        event.preventDefault()
        this.host.runBrowserShortcut(tabId, usable)
        return
      }
      if (matchesBrowserChord(input, this.host.appShortcutChords)) {
        event.preventDefault()
        this.host.dispatchPageKey(pageKeyFromInput(input))
      }
    })
    // The page itself never sees the application's DOM menus, so this is where
    // the browser's own right-click menu is produced: link, image, media,
    // selection, editing and page actions, decided from the point clicked.
    view.webContents.on('context-menu', (_event, params) => {
      if (this.host.tabs.get(tabId)?.composition) {
        void view.webContents
          .executeJavaScript('globalThis.CIOVideo?.editing === true')
          .then((editing: unknown) => {
            if (editing !== true && liveContents(view)) this.host.showTabContextMenu(tabId, params)
          })
          .catch(() => {})
        return
      }
      this.host.showTabContextMenu(tabId, params)
    })
    // Audio the page emits is a tab-level fact the strip renders, so the state
    // event follows it the same way it follows a title or favicon change.
    view.webContents.on('audio-state-changed', publish)
    // Chromium reports the resolved address under the pointer here, and an empty
    // string once it leaves the link. That is the whole source of the bottom-left
    // status bubble: an embedded page has no browser chrome to draw one itself.
    view.webContents.on('update-target-url', (_event, url) => {
      this.host.onTargetUrlReport(tabId, url)
    })
    // The document is parsed at dom-ready, which is the earliest point at which
    // the capture observer can be installed before the page's own scripts ask
    // for the microphone.
    view.webContents.on('dom-ready', () => {
      installBrowserHistorySwipe(view.webContents)
      // The observer that reports a chord the page did not handle, so the app's
      // own shortcuts still reach the app from inside a page.
      this.host.pageKeys.install(view.webContents)
      // Take a Peek is a global browser gesture and nothing else: a thread's page
      // is the surface a conversation already talks to, so it has no peek. Only
      // a global tab gets the observer that claims an Option-click on a link,
      // which otherwise keeps Chromium's meaning for it and downloads the page.
      if (tab.projectId === GLOBAL_BROWSER_PROJECT_ID) {
        this.host.linkPeek.install(view.webContents)
      }
      this.host.capture.reset(tabId)
      this.watchCaptureMainFrame(tabId, view.webContents)
      // The document that just arrived drops the last one's stylesheet, so the
      // app's scrollbar colours are installed again here.
      this.host.applyScrollbarTheme(tabId, view.webContents)
      publish()
      this.host.notifyExtensionWebNavigation(
        tab.projectId,
        tab.boxId,
        'onDOMContentLoaded',
        this.host.extensionWebNavigationDetails(tab, view.webContents.getURL())
      )
    })
    view.webContents.on('did-finish-load', () => {
      this.host.injectDialogContext(tabId)
      // The dom-ready install can race the document it runs in; watching again is
      // idempotent per frame and covers that case.
      this.watchCaptureMainFrame(tabId, view.webContents)
      // A composition is armed on the document that just arrived, which is what
      // covers a preview reloading itself: the folder is recognised on the
      // navigation, and the playback runtime is installed here.
      if (tab.composition) this.host.armCompositionQuietly(tabId, tab)
      // The document that arrived is the answer to whether the navigation failed,
      // so this is where the error card is confirmed or lifted.
      this.host.resolveLoadOutcome(tabId)
      this.host.notifyExtensionWebNavigation(
        tab.projectId,
        tab.boxId,
        'onCompleted',
        this.host.extensionWebNavigationDetails(tab, view.webContents.getURL())
      )
    })
    view.webContents.on(
      'did-frame-finish-load',
      (_event, isMainFrame, frameProcessId, frameRoutingId) => {
        if (isMainFrame) return
        const frame = webFrameMain.fromId(frameProcessId, frameRoutingId)
        if (frame) {
          this.host.injectDialogContext(tabId, frame)
          // A recorder embedded in an iframe is a capture of this tab too.
          this.host.capture.watch(tabId, frame)
        }
      }
    )
    view.webContents.on('devtools-opened', publish)
    view.webContents.on('devtools-closed', publish)
    view.webContents.on('did-start-loading', () => {
      publish()
      this.host.notifyExtensionTab(tabId, tab.projectId, tab.boxId, 'onUpdated', [
        tab.view.webContents.id,
        { status: 'loading' },
        this.host.extensionTabInfo(tabId, tab)
      ])
    })
    view.webContents.on('did-stop-loading', () => {
      publish()
      // The safety net for a mark that resolved while the document was still
      // arriving, which `did-finish-load` cannot see because recognition is
      // asynchronous. Arming is idempotent, so this costs nothing when the load's
      // own arm already happened.
      if (tab.composition) this.host.armCompositionQuietly(tabId, tab)
    })
    // A main-frame navigation is a fresh attempt, so the provisional failure of
    // the last one is dropped here. The published `loadError` is deliberately left
    // in place until this navigation resolves, so the card cannot flicker away for
    // the empty frame a load starts with.
    view.webContents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return
      tab.navigationFailure = null
      this.host.notifyExtensionWebNavigation(
        tab.projectId,
        tab.boxId,
        'onBeforeNavigate',
        // The generation this navigation will land on, so the attempt and the
        // commit it leads to carry the same document id.
        this.host.extensionWebNavigationDetails(tab, details.url, {
          documentGeneration: tab.navigationGeneration + 1
        })
      )
    })
    view.webContents.on('did-navigate', (_event, url, httpResponseCode, httpStatusText) => {
      // An HTTP error status is provisional: it becomes the tab's error only if
      // the document the server sent turns out to be empty, which is read when
      // the load finishes. A network failure already recorded for this navigation
      // outranks it, because the error document the failure commits reports no
      // status of its own.
      if (tab.navigationFailure?.kind !== 'network') {
        tab.navigationFailure =
          httpResponseCode >= 400
            ? {
                kind: 'http',
                code: httpResponseCode,
                description: httpStatusText || `HTTP ${httpResponseCode}`
              }
            : null
      }
      // A committed document comes back with the icon its own origin is known by.
      // Chromium announces an icon only when it changes, so clearing the tab here
      // and waiting for the announcement left a reload, a client-side redirect, or
      // a link inside one site iconless, and the strip fell back to the globe. An
      // origin the tab has never shown still starts out without an icon.
      tab.favicon = faviconForCommittedUrl(tab.faviconByOrigin, url)
      // Capture state belongs to the document that ended here, so the tab must
      // not keep claiming it is recording until the new page says otherwise.
      this.host.capture.reset(tabId)
      // The inspector lives in the document that ended here. Its desired mode is
      // kept (a live preview reloads itself mid-session), but the outstanding
      // event promise is void and the next arm installs into the new document.
      this.host.inspector.reset(tabId)
      // A design tab announces what it is serving on every commit, not only when
      // the answer changes. The renderer decides which pins the page draws, and
      // the answer it needs for that is the design, so a reload that says nothing
      // left a session that had lost that answer unable to ask for it again: the
      // pins stayed away until something else marked the tab, which is what a
      // refresh used to fix and could no longer. A commit off the design's own
      // origin says nothing here: the mark is about to be cleared for it.
      if (tab.design && url.startsWith(tab.design.origin)) this.host.publishState(tabId)
      // Recognition is decided from the page that just committed, not from a record
      // of who opened the tab last: that is what keeps a design a design across a
      // restart, and what covers a tab the agent opened itself.
      // Whatever runtime the document that just ended had went with it, and the
      // next document is a new one even when it is the same URL loaded again.
      tab.navigationGeneration += 1
      tab.transport = null
      this.host.refreshTabMark(tabId, tab)
      // The dialog shim lived in the document that just went away, so the next
      // report has to install it again rather than trust the old record.
      this.host.injectedDialogLabels.delete(tabId)
      // The document that just committed is also what decides the surface it is
      // drawn over, which is white for a loaded page and the app's own surface
      // for an empty one.
      applyBrowserPageBackground(tab.view)
      publish()
      this.host.notifyExtensionTab(tabId, tab.projectId, tab.boxId, 'onUpdated', [
        tab.view.webContents.id,
        { status: 'complete', url },
        this.host.extensionTabInfo(tabId, tab)
      ])
      // Chromium's page transition is not exposed, so a commit to the address the
      // tab was already showing is the one case the app can tell apart: a reload.
      const committedFrom = this.host.extensionNavigationUrls.get(tabId) ?? null
      this.host.notifyExtensionWebNavigation(
        tab.projectId,
        tab.boxId,
        'onCommitted',
        this.host.extensionWebNavigationDetails(tab, url, {
          transitionType: committedFrom === url ? 'reload' : 'link'
        })
      )
      this.host.extensionNavigationUrls.set(tabId, url)
      // Chromium's find does not survive a document, so a session that was live
      // across this navigation is over: the page has no matches to report and the
      // bar must not keep showing the count of the document that just went away.
      // The report is sent rather than left to the engine, which says nothing at
      // all for a search that no longer exists, and it names the text that was
      // being searched so the bar it belongs to is the one that answers it.
      const findSession = this.host.findSessions.take(tabId)
      if (findSession && !this.host.window.isDestroyed()) {
        sendToRenderer(
          liveWindowContents(this.host.window),
          'browser:findResult',
          browserFindResultFor(tabId, findSession.text, { matches: 0, activeMatchOrdinal: 0 })
        )
      }
    })
    // Every report from this page's own find: the session decides which of them
    // the bar is waiting for, and which of those say anything new (see
    // `BrowserFindSessions`).
    view.webContents.on('found-in-page', (_event, result) => {
      this.host.publishFindResult(tabId, result.requestId, result)
    })
    view.webContents.on('did-navigate-in-page', (_event, url) => {
      publish()
      this.host.notifyExtensionTab(tabId, tab.projectId, tab.boxId, 'onUpdated', [
        tab.view.webContents.id,
        { url },
        this.host.extensionTabInfo(tabId, tab)
      ])
      const navigatedFrom = this.host.extensionNavigationUrls.get(tabId) ?? ''
      const previousHash = navigatedFrom.indexOf('#')
      const nextHash = url.indexOf('#')
      // Two addresses that agree through their first '#' moved inside the same
      // document, which the runtime reports as a fragment change rather than a
      // history push.
      const fragmentOnly =
        previousHash !== -1 &&
        nextHash !== -1 &&
        navigatedFrom.slice(0, previousHash + 1) === url.slice(0, nextHash + 1)
      this.host.notifyExtensionWebNavigation(
        tab.projectId,
        tab.boxId,
        fragmentOnly ? 'onReferenceFragmentUpdated' : 'onHistoryStateUpdated',
        this.host.extensionWebNavigationDetails(tab, url, {
          transitionType: navigatedFrom === url ? 'reload' : 'link'
        })
      )
      this.host.extensionNavigationUrls.set(tabId, url)
    })
    view.webContents.on('page-title-updated', (_event, title) => {
      publish()
      this.host.notifyExtensionTab(tabId, tab.projectId, tab.boxId, 'onUpdated', [
        tab.view.webContents.id,
        { title },
        this.host.extensionTabInfo(tabId, tab)
      ])
    })
    view.webContents.on('page-favicon-updated', (_event, favicons) => {
      const source = favicons.find((candidate) => candidate.length > 0) ?? null
      if (!source) return
      // Read now, not when the fetch resolves: the document that declared this
      // icon is the one that owns it, whatever the tab moves on to while the icon
      // is in flight.
      const declaredBy = faviconOriginOf(view.webContents.getURL())
      // Electron reports icon URLs, but remote images are blocked by the
      // renderer CSP   convert to a data URL so any consumer can render it.
      void fetchIconAsDataUrl(source).then((favicon) => {
        if (!favicon) return
        if (declaredBy !== null) rememberFavicon(tab.faviconByOrigin, declaredBy, favicon)
        // An answer for a document the tab has already left is remembered for that
        // document's origin and goes no further, so the icon on screen always
        // belongs to the origin on screen.
        const live = liveContents(view)
        if (!live) return
        if (declaredBy !== faviconOriginOf(live.getURL())) return
        if (tab.favicon === favicon) return
        tab.favicon = favicon
        publish()
        this.host.notifyExtensionTab(tabId, tab.projectId, tab.boxId, 'onUpdated', [
          live.id,
          { favIconUrl: source },
          this.host.extensionTabInfo(tabId, tab)
        ])
      })
    })
    view.webContents.on('console-message', (details) => {
      this.host.appendConsoleEntry(tabId, {
        level: details.level,
        message: details.message,
        sourceId: details.sourceId,
        lineNumber: details.lineNumber,
        frameUrl: consoleFrameUrl(details.frame)
      })
    })
    view.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        // An aborted load is a navigation that was superseded (a redirect, or a
        // load the app replaced), never a page worth an error card: the policy and
        // the restore recovery share `isAbortedNavigation` so they cannot disagree.
        if (!isMainFrame || isAbortedNavigation(errorCode)) return
        // The failed navigation can still commit an error document, which has no
        // shim of its own, so the record of what is installed must not survive it.
        this.host.injectedDialogLabels.delete(tabId)
        const failure: BrowserLoadError = {
          kind: 'network',
          code: errorCode,
          description: errorDescription
        }
        tab.navigationFailure = failure
        // A network failure is final the moment it is reported, so the card goes
        // up without waiting for the error document that may or may not commit.
        this.host.setTabLoadError(tabId, failure)
        this.host.appendConsoleEntry(tabId, {
          level: 'error',
          message: `Navigation failed (${errorCode}): ${errorDescription}`,
          sourceId: validatedURL,
          lineNumber: 0,
          // The navigation that failed never committed a document, so there is no
          // frame behind this entry: the address is the one in the message.
          frameUrl: null
        })
        this.host.notifyExtensionWebNavigation(
          tab.projectId,
          tab.boxId,
          'onErrorOccurred',
          this.host.extensionWebNavigationDetails(tab, validatedURL, {
            error: errorDescription
          })
        )
      }
    )
    view.webContents.on('render-process-gone', (_event, details) => {
      // The recovered document is brand new and may not report a navigation
      // commit, so nothing about the dead document's injection may be trusted.
      this.host.injectedDialogLabels.delete(tabId)
      // A renderer that exited on its own (window teardown, a reload of the app)
      // is not a page error; every other reason leaves the tab with nothing.
      if (details.reason !== 'clean-exit') {
        this.host.setTabLoadError(tabId, {
          kind: 'crashed',
          code: details.exitCode,
          description: details.reason
        })
      }
      this.host.appendConsoleEntry(tabId, {
        level: 'error',
        message: `Browser renderer stopped: ${details.reason} (exit ${details.exitCode})`,
        sourceId: view.webContents.getURL(),
        lineNumber: 0,
        // The frame that would have named itself is the one that died.
        frameUrl: null
      })
    })
    const owner: BrowserPageOwner = { tabId, projectId, threadId, boxId: tab.boxId }
    view.webContents.on('will-navigate', (event, url) => {
      // An external address (the App Store, mail, a native app) is offered to
      // the OS behind a confirmation; the page itself never navigates to it.
      if (this.host.offerExternalNavigation(owner, url)) {
        event.preventDefault()
        return
      }
      if (!this.host.isAllowedTabNavigation(projectId, tab.boxId, url)) event.preventDefault()
    })
    view.webContents.on('will-redirect', (event, url) => {
      if (this.host.offerExternalNavigation(owner, url)) event.preventDefault()
    })
    // `will-navigate` is the main frame only. A companion-app button often
    // lives in a page's own embedded frame (an embedded widget, a booking
    // panel), whose navigation fires this event and nothing else, so it is
    // handled here rather than left to be dropped in silence.
    view.webContents.on('will-frame-navigate', (details) => {
      if (details.isMainFrame) return
      if (this.host.offerExternalNavigation(owner, details.url, details.frame?.url)) {
        details.preventDefault()
      }
    })
    this.host.installWindowOpenPolicy(view, owner)
    return tab
  }

  /**
   * The tab that owns a page inside one project's browser session.
   *
   * A page is either a tab's own or a popup window's, and the reports that arrive
   * with a `WebContents`   a permission a page asks for, a file it downloads   name
   * the tab the user was reading, so the prompt and the download row belong to
   * something on screen.
   */
  tabIdForContents(projectId: string, contentsId: number): string | undefined {
    const owner = this.tabForContents(contentsId)
    return owner && owner.tab.projectId === projectId ? owner.id : undefined
  }

  /**
   * The tab a page belongs to, whichever project owns it.
   *
   * A box's jar is shared, so the context that configured a session is not
   * necessarily the context a page in it belongs to: anything that has to name the
   * tab behind a page (a permission prompt, a download row) resolves it here and
   * reads the tab's own project.
   */
  tabForContents(contentsId: number): { id: string; tab: BrowserTab } | null {
    for (const [id, tab] of this.host.tabs) {
      if (liveContents(tab.view)?.id === contentsId) return { id, tab }
    }
    const ownerTabId = this.host.popupWindows.tabIdForContents(contentsId)
    if (!ownerTabId) return null
    const tab = this.host.tabs.get(ownerTabId)
    return tab ? { id: ownerTabId, tab } : null
  }

  /**
   * The tab behind a page, as the download manager reads it: which project owns
   *  the tab, and which box its jar belongs to.
   *
   * A boxed tab runs in a jar the profile owns, but the page is still a
   * conversation's tab, so a download reported against it belongs to the project
   * the user was browsing rather than to whichever context opened the jar first,
   * and a resume has to be issued through that same jar.
   */
  ownerTabForContents(contentsId: number): BrowserDownloadOwner | null {
    const owner = this.tabForContents(contentsId)
    return owner ? { projectId: owner.tab.projectId, boxId: owner.tab.boxId } : null
  }

  requireTab(tabId: string): BrowserTab {
    const tab = this.host.tabs.get(tabId)
    if (!tab) throw new Error('Browser tab does not exist')
    return tab
  }

  /**
   * The tab a best-effort page control works on, or `undefined` once it is gone.
   *
   * The renderer issues Back/Forward, Reload and Stop from the tab state it held
   * a moment ago, so the tab can be gone before the command lands: the user closed
   * it, or its page is a tab this process has never shown and therefore never
   * created. A control with no page to act on is nothing to do rather than a
   * failure, exactly as the page context menu already treats a gone tab
   * (`live()?.reload()`), so the close race never surfaces as a main-process
   * "Browser tab does not exist" error. Operations that mutate the tab's durable
   * state still use `requireTab`, because a missing tab there is a real defect.
   */
  liveTab(tabId: string): BrowserTab | undefined {
    return this.host.tabs.get(tabId)
  }

  /**
   * Whether a tab is showing a `view-source:` document.
   *
   * Chromium renders one as static text and never runs page scripts in it, and
   * `executeJavaScript` against such a document never settles. The document
   * shims that would otherwise be injected into it are therefore skipped, which
   * keeps every injection point from parking on a promise that cannot resolve.
   */
  isViewSourceDocument(contents: WebContents): boolean {
    return contents.isDestroyed() || contents.getURL().startsWith('view-source:')
  }

  /** Install the capture observer into a tab's main frame. Called again after
   *  every navigation, because an observer lives in one document's world. */
  watchCaptureMainFrame(tabId: string, contents: WebContents): void {
    if (this.isViewSourceDocument(contents)) return
    this.host.capture.watch(tabId, contents.mainFrame)
  }

  destroy(tabId: string, reason: BrowserTabDestroyReason): void {
    // A page that destroys itself reports it while this call is already inside
    // `webContents.close()`, so the same tab can ask to be closed twice. The call
    // that is already running owns the cleanup, and the re-entrant one used to
    // read a view whose page was already gone and throw there, which aborted the
    // close halfway and left the tab named with nothing behind it.
    if (this.closing.has(tabId)) return
    this.closing.add(tabId)
    try {
      this.closeTab(tabId, reason)
    } finally {
      this.closing.delete(tabId)
    }
  }

  private closeTab(tabId: string, reason: BrowserTabDestroyReason): void {
    this.host.childTabOpeners.delete(tabId)
    for (const [childId, openerId] of this.host.childTabOpeners) {
      if (openerId !== tabId) continue
      this.destroy(childId, 'closed')
      this.host.requestPanelShortcut(childId, 'close-tab')
    }
    if (this.host.pendingShow?.tabId === tabId) this.host.pendingShow = null
    // A hide that is still inside its grace window must not park a tab that is
    // about to be gone: the view would be handed to the stage window only to be
    // destroyed.
    this.host.dropPendingPark(tabId)
    if (reason === 'closed') {
      for (const [peekId, sourceId] of this.host.peekTabs) {
        if (sourceId === tabId) this.destroy(peekId, 'closed')
      }
    }
    const tab = this.host.tabs.get(tabId)
    // The stack dies with the view, so a tab that is only being hibernated hands
    // its stack over before it goes. A tab that is being closed hands it to the
    // session's reopen set instead: the stack outlives the tab just long enough
    // for Cmd/Ctrl+Shift+T to bring it back, and a restart empties that set. Both
    // halves run before the early return, because a destroy for a tab this process
    // no longer holds still has a record to settle.
    if (reason === 'hibernated') {
      if (tab) this.host.captureTabHistory(tabId, tab)
    } else {
      if (!this.host.peekTabs.has(tabId)) this.host.stashClosedTabHistory(tabId, tab)
      else this.host.peekTabs.delete(tabId)
      this.host.tabHistory.forget(tabId)
    }
    if (!tab) return
    // The extension-visible removal goes out before the page closes, because the
    // id it carries is the page's own.
    const removedContents = liveContents(tab.view)
    if (removedContents && !removedContents.isDestroyed()) {
      this.host.notifyExtensionTab(tabId, tab.projectId, tab.boxId, 'onRemoved', [
        removedContents.id,
        { windowId: 0, isWindowClosing: false }
      ])
    }
    // A popup window is the tab's own window as far as the user is concerned, so
    // closing the tab closes what its page opened rather than leaving a sign-in
    // stranded behind a tab that no longer exists.
    this.host.popupWindows.closeForTab(tabId, 'its tab closed')
    this.host.sidePanels.closeForTab(tabId, 'its tab closed')
    for (const [requestId, pending] of this.host.pendingPermissions) {
      if (pending.request.tabId === tabId)
        this.host.resolvePermission(requestId, permissionResolutions.dismiss)
    }
    if (this.host.activeTabId === tabId) {
      this.host.activeTabId = null
      this.host.activeTabBounds = null
    }
    if (this.host.displayedTab?.tabId === tabId) this.host.displayedTab = null
    if (this.host.targetUrlTabId === tabId) this.host.dismissStatusOverlay()
    // A destroyed tab can no longer hold the keyboard, so its toolbar must not
    // stay the tab the window-level interception routes to.
    if (this.host.focusedChromeTabId === tabId) this.host.focusedChromeTabId = null
    // Likewise a destroyed page cannot be given the keyboard back on return.
    if (this.host.keyboardOwnerTabId === tabId) this.host.keyboardOwnerTabId = null
    if (this.host.restorePageFocusTabId === tabId) this.host.restorePageFocusTabId = null
    if (removedContents) {
      this.host.pageKeys.release(removedContents)
      this.host.linkPeek.release(removedContents)
    }
    this.host.injectedDialogLabels.delete(tabId)
    this.host.extensionNavigationUrls.delete(tabId)
    this.host.forgetParked(tabId)
    this.host.agentReveals.delete(tabId)
    this.host.lastScreenshot.delete(tabId)
    this.host.playheads.delete(tabId)
    this.host.scrollbarStyles.delete(tabId)
    this.host.capture.forget(tabId)
    this.host.inspector.forget(tabId)
    this.host.findSessions.take(tabId)
    this.host.stage.release(tab.view)
    const closingContents = liveContents(tab.view)
    if (closingContents) closingContents.close()
    this.host.tabs.delete(tabId)
    // A cached popup is still a live extension document. Unloading its extension
    // would invalidate that document even though it remains available for reuse.
    if (!this.host.jarHasLivePage(tab.projectId, tab.boxId)) {
      void this.host.extensions.onJarEmptied(tab.projectId, tab.boxId)
    }
    for (const [contextKey, agentTabId] of this.host.agentTabIds) {
      if (agentTabId === tabId) this.host.agentTabIds.delete(contextKey)
    }
    for (const [threadId, pageTabId] of this.host.assistantPageTabIds) {
      if (pageTabId === tabId) this.host.assistantPageTabIds.delete(threadId)
    }
    for (const [scopeId, page] of this.host.threadBrowserPages) {
      // A hibernated tab is put to sleep, not closed: its binding stays so the
      // page can be mounted again the next time the agent reaches for it, which is
      // what the revival in `conversationPageTab` is for.
      if (page.tabId === tabId && reason === 'closed') this.host.threadBrowserPages.delete(scopeId)
    }
  }
}
