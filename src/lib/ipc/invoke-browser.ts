import type {
  BrowserCompositionPlayback,
  BrowserDownload,
  BrowserExtension,
  BrowserExtensionInstallInput,
  BrowserExtensionSidePanel,
  BrowserFindRequest,
  BrowserFindStopAction,
  BrowserInspectorMarker,
  BrowserInspectorTheme,
  BrowserPageState,
  BrowserPermissionDecision,
  BrowserPermissionPromptContext,
  BrowserPopupWindow,
  BrowserShortcutBindings,
  BrowserSwitcherBindings,
  BrowserSiteDataScope,
  BrowserScrollbarTheme,
  BrowserTabDestroyReason,
  BrowserTransportCommand,
  BrowserViewBounds
} from './browser'
import type { Contract } from './contract-helpers'
import type { BrowserSearchEngine } from '../browser-search-engines'
import type { GlobalBrowserTabsSnapshot } from '../browser/global-browser-tabs'
import type { BrowserBookmarksSnapshot, BrowserHistorySnapshot } from '../browser/browser-library'
import type { BrowserBoxMenuChoice, BrowserBoxMenuInput } from '../browser/browser-box-menu'
import type {
  BrowserOverlayAck,
  BrowserOverlaySnapshot,
  BrowserStripOverlayInteraction,
  BrowserStripOverlayRequest,
  ToastOverlayCursor,
  ToastOverlayInteractionReport,
  ToastOverlayRequest
} from '../browser-overlay'

export const invokeBrowserContract = {
  /**
   * The global browser's durable tab list, or null before it has ever been
   * stored. It lives in the config directory rather than the renderer's
   * `localStorage` because that storage is scoped to the renderer origin and is
   * silently in-memory whenever another app instance holds the profile, which
   * lost every open tab on the next launch.
   */
  'browser:loadTabs': {} as Contract<[], GlobalBrowserTabsSnapshot | null>,
  'browser:saveTabs': {} as Contract<[snapshot: GlobalBrowserTabsSnapshot], void>,
  /**
   * The browser's durable browsing history, newest first. It is app state rather
   * than browser runtime, so it is read from the same early surface the tab list
   * is, and it is what survives a restart.
   */
  'browser:loadHistory': {} as Contract<[], BrowserHistorySnapshot>,
  'browser:saveHistory': {} as Contract<[snapshot: BrowserHistorySnapshot], void>,
  /** Forget the whole browsing history. The clear is applied in main, so a
   *  renderer that is closing right after it cannot re-save what it cleared. */
  'browser:clearHistory': {} as Contract<[], void>,
  /** The saved pages, newest first. */
  'browser:loadBookmarks': {} as Contract<[], BrowserBookmarksSnapshot>,
  'browser:saveBookmarks': {} as Contract<[snapshot: BrowserBookmarksSnapshot], void>,
  /** Remove every bookmark, applied in main for the same reason as the history
   *  clear above. */
  'browser:clearBookmarks': {} as Contract<[], void>,
  'browser:show': {} as Contract<
    [
      tabId: string,
      projectId: string,
      threadId: string,
      initialUrl: string,
      bounds: BrowserViewBounds,
      /**
       * The box this tab belongs to, or null for the context's own jar. Optional
       * and trailing so every existing caller keeps meaning what it meant: an
       * absent box is today's single durable profile, not a new behaviour. The
       * profile's own box names itself here like any other box and resolves to the
       * profile's jar, so null and that id are two different jars rather than two
       * spellings of one.
       */
      boxId?: string | null
    ],
    BrowserPageState
  >,
  /**
   * Bind a browser tab's assistant conversation to the page that tab is on.
   *
   * The conversation is a real chat thread rather than a tab of its own, so this
   * is the only link between it and the page it answers about: the app records
   * it when the rail resolves the conversation, and main uses it to attach the
   * agent's browser capability (`cio:browser`) to the page the user is looking
   * at. Idempotent, and it survives a navigate: the binding is to the tab, not
   * to one address.
   */
  'browser:bindAssistantPage': {} as Contract<[assistantThreadId: string, tabId: string], void>,
  /** Drop that binding, for a conversation that is being closed. */
  'browser:unbindAssistantPage': {} as Contract<[assistantThreadId: string], void>,
  'browser:hide': {} as Contract<[tabId: string], void>,
  /**
   * Show an extension's own side panel in the rail.
   *
   * Electron compiles `chrome.sidePanel` out, so an extension that declares a
   * panel has no host of its own. The app hosts the extension's own document,
   * loaded from its own origin in the jar the extension runs in, and this is the
   * call that puts it on screen: the rail measures the frame it drew for the panel
   * and this app puts the document in it. The panel is the extension's own HTML,
   * not markup this app re-renders.
   */
  'browser:showExtensionSidePanel': {} as Contract<
    [extensionId: string, bounds: BrowserViewBounds],
    void
  >,
  /**
   * Take an extension side panel off screen without stopping it, the way a parked
   * tab is laid out offscreen rather than unloaded, so a panel mid-request is not
   * frozen by the user closing the rail.
   */
  'browser:hideExtensionSidePanel': {} as Contract<[extensionId: string], void>,
  /** Give an extension side panel the keyboard, after the user picks it in the rail. */
  'browser:focusExtensionSidePanel': {} as Contract<[extensionId: string], void>,
  /**
   * Close an extension side panel: its document stops and it leaves the rail. The
   * extension is told through its own `chrome.sidePanel.onClosed`.
   */
  'browser:closeExtensionSidePanel': {} as Contract<[extensionId: string], void>,
  /** The extension side panels the rail is hosting for one project. */
  'browser:getExtensionSidePanels': {} as Contract<
    [projectId: string],
    BrowserExtensionSidePanel[]
  >,
  /**
   * Place a popup window's page over the frame the rail measured for it. The
   * popup is a native view like a tab's page is, so the rail's rectangle is
   * what puts it on screen inside the panel rather than over the window.
   */
  'browser:showPopupWindow': {} as Contract<[popupId: string, bounds: BrowserViewBounds], void>,
  /**
   * Take a popup window's page off screen. The page keeps running, laid out
   * offscreen at the size it was last displayed at, exactly as a parked tab
   * does, so a sign-in that is still completing does not freeze.
   */
  'browser:hidePopupWindow': {} as Contract<[popupId: string], void>,
  /** Give a popup window's page the keyboard, after the user picks it in the rail. */
  'browser:focusPopupWindow': {} as Contract<[popupId: string], void>,
  /**
   * Close a popup window on the user's behalf: its page stops and it leaves the
   * rail. A page that closes itself needs nothing here, it is reported closed.
   */
  'browser:closePopupWindow': {} as Contract<[popupId: string], void>,
  /** The popup windows the browser is holding for one project. */
  'browser:getPopupWindows': {} as Contract<[projectId: string], BrowserPopupWindow[]>,
  /**
   * Open an extension's own action popup in the rail.
   *
   * Electron draws no toolbar and no action popup, so an extension's declared
   * `action.default_popup` has no host of its own; the app hosts it in the rail
   * instead, bound to the jar the extension runs in. From then on it is a popup
   * like any other: the channels above place it, give it the keyboard and close
   * it, and the rail draws it as a tab of its own.
   *
   * Answers the popup's id, which is the popup already open when that extension
   * already has one in this tab.
   *
   * The tab's own project, thread and box travel with the call rather than being
   * inferred: a tab the user just opened has no page yet, so main has no record of
   * it, and the popup has to be hosted on the jar that tab lives in. The rail is
   * shared by the global browser and by a project's, so a caller naming the global
   * project for a project tab would be refused.
   *
   * Answers the popup's id, which is the popup already open when that extension
   * already has one in this tab. Answers `null` when nothing opened, which is the
   * case where the extension asked to open its own side panel on an action click
   * and the rail raised that panel instead.
   */
  'browser:openExtensionPopup': {} as Contract<
    [projectId: string, tabId: string, threadId: string, boxId: string | null, extensionId: string],
    string | null
  >,
  /**
   * Park the active browser page because a toast could not be shown over it.
   *
   * `browser:setToastOverlay` is the normal path: the stack moves into a child
   * window that composites above the page. This is the safety net for the one
   * case that window cannot serve (it could not be created at all), and the page
   * comes back as soon as the toast is gone.
   */
  'browser:setToastVisible': {} as Contract<[visible: boolean], void>,
  /**
   * Point the native overlay at the toast stack the app renderer is holding, or
   * take it down with null because no page covers the stack's corner.
   *
   * Answers false only when the overlay had to be created and could not be, so
   * the renderer can fall back to parking the page instead of leaving the toast
   * invisible behind it.
   */
  'browser:setToastOverlay': {} as Contract<[request: ToastOverlayRequest], boolean>,
  /**
   * Point the native overlay at the browser's floating tab strip, or take it
   * down with null because the panel closed or no page covers its band.
   *
   * Answers false only when the overlay window could not be created, which is
   * the app renderer's cue to keep the strip in its own DOM and let it occlude
   * the page, exactly as it did before the overlay existed.
   */
  'browser:setStripOverlay': {} as Contract<[request: BrowserStripOverlayRequest | null], boolean>,
  /**
   * Everything on display in the overlay, asked for by the overlay document
   * itself once its listener is bound. First delivery is a pull here because a
   * push straight after `loadURL` loses the same race the permission popup
   * documents.
   */
  'browser:overlayReady': {} as Contract<[], BrowserOverlaySnapshot>,
  /**
   * Where the pointer is, in the overlay document's own client coordinates, or
   * null while there is no overlay window to measure it in.
   *
   * The overlay asks for this rather than believing its own pointer events,
   * because the events a click-through window receives cannot tell content the
   * pointer is on from a window the window server has just re-evaluated. It is
   * what settles the click-through state, so it is answered from the window
   * server every time.
   */
  'browser:overlayCursor': {} as Contract<[], ToastOverlayCursor | null>,
  /**
   * The user acted on a card the overlay drew. The overlay carries no handlers,
   * so it names the toast and the interaction and the app renderer runs the
   * handler that toast actually holds.
   */
  'browser:overlayInteract': {} as Contract<[report: ToastOverlayInteractionReport], void>,
  /**
   * The user acted on the floating strip the overlay drew: picked a tab to show,
   * closed one, or moved the pointer into or out of the strip's own rectangle.
   * The overlay carries no handlers, so the app renderer owns what each means.
   */
  'browser:overlayStripInteract': {} as Contract<[report: BrowserStripOverlayInteraction], void>,
  /**
   * The content the overlay was given is now on its screen.
   *
   * Cards and rows carry handlers that live in the app renderer, so the overlay
   * is only usable while that round trip works. This is the overlay's
   * confirmation of it: it names the revisions it drew, and the app renderer
   * stops drawing its own copy only once it has heard them, taking the content
   * back into its own window when it never does.
   */
  'browser:overlayDrawn': {} as Contract<[ack: BrowserOverlayAck], void>,
  /**
   * Whether the pointer is over drawn content, which is what decides if the
   * overlay window swallows a click or passes it through to the page beneath it.
   */
  'browser:overlayPointer': {} as Contract<[overContent: boolean], void>,
  'browser:navigate': {} as Contract<
    [tabId: string, projectId: string, threadId: string, url: string, boxId?: string | null],
    void
  >,
  'browser:goBack': {} as Contract<[tabId: string], void>,
  'browser:goForward': {} as Contract<[tabId: string], void>,
  /** Route a mouse history button to the focused browser page when one owns focus. */
  'browser:mouseHistoryNavigation': {} as Contract<[direction: 'back' | 'forward'], boolean>,
  'browser:reload': {} as Contract<[tabId: string], void>,
  /**
   * Run one playback action on a composition tab and answer with the state it
   * left behind, so the panel shows what happened rather than what it asked for.
   * Only meaningful on a tab whose `BrowserPageState.composition` is set.
   */
  'browser:transport': {} as Contract<
    [tabId: string, command: BrowserTransportCommand, value: number | boolean],
    BrowserCompositionPlayback | null
  >,
  /** Read a composition tab's playhead without changing it. Null when the tab is
   *  not a composition, or is showing a page that has not been armed. */
  'browser:transportState': {} as Contract<[tabId: string], BrowserCompositionPlayback | null>,
  /** Reload bypassing the HTTP cache (hard reload). */
  'browser:reloadIgnoringCache': {} as Contract<[tabId: string], void>,
  'browser:stop': {} as Contract<[tabId: string], void>,
  /** Mute or unmute one tab's audio output. Main publishes the applied state
   *  back through `browser:state`. */
  'browser:setMuted': {} as Contract<[tabId: string, muted: boolean], void>,
  /**
   * Replace the browser surface's shortcut table. The renderer resolves the
   * keymap's `browser` category into platform-explicit chords and pushes them
   * whenever the keymap changes, because main intercepts those keys before the
   * application menu can and holds no keymap of its own.
   */
  'browser:setShortcutBindings': {} as Contract<[bindings: BrowserShortcutBindings], void>,
  /**
   * Replace the Ctrl+Tab switcher chords. A key pressed in a native page never
   * reaches the renderer, so main claims these chords there and forwards the
   * gesture; the chords come from the renderer's keymap, which main cannot read.
   */
  'browser:setSwitcherBindings': {} as Contract<[bindings: BrowserSwitcherBindings], void>,
  /**
   * Report the address bar's active search engine. Main builds the browser's
   * native context menu and its "Search <engine> for ..." item, and holds no
   * config of its own, so the resolved engine is pushed whenever the config
   * loads or is patched. A failure is ignored until the handlers are live.
   */
  'browser:setSearchEngine': {} as Contract<[engine: BrowserSearchEngine], void>,
  /** The app's scrollbar colours, applied to every browser tab so a default
   *  page scrollbar is drawn on brand. A user-origin stylesheet yields to a
   *  site's own scrollbar styling. */
  'browser:setScrollbarTheme': {} as Contract<[theme: BrowserScrollbarTheme], void>,
  /**
   * Report which tab's toolbar (address bar, buttons) holds DOM focus, or null
   * when none does. A key pressed in a native page view never reaches the
   * renderer, so main needs the focus the toolbar holds to route the same
   * chords when the user is typing an address.
   */
  'browser:setChromeFocus': {} as Contract<[tabId: string | null], void>,
  /**
   * Hand a tab's page the keyboard.
   *
   * A page is a native `WebContentsView` above the DOM, so DOM focus in the app
   * chrome never reaches it and a tab switch has to hand the keyboard over
   * deliberately. When the tab is already on screen main focuses it now; a tab
   * whose show is still in flight has the intent held until it is shown, which is
   * what keeps a switch raced against the page's own mount focused.
   */
  'browser:focusPage': {} as Contract<[tabId: string], void>,
  /** Toggle the web page's native DevTools. Returns whether it is now open. */
  'browser:toggleDevTools': {} as Contract<[tabId: string], boolean>,
  /**
   * Search one tab's page with Chromium's own find.
   *
   * A page is a native `WebContentsView`, so the app cannot read its text: this
   * asks the page to search itself, and every match is highlighted by the engine
   * that owns the document. The answer arrives asynchronously over
   * `browser:findResult`, because the page reports the count and the ordinal it
   * is on, and the bar draws nothing it has not been told.
   */
  'browser:findInPage': {} as Contract<[tabId: string, request: BrowserFindRequest], void>,
  /** End one tab's find session. Closing the find bar clears the highlight; a
   *  session left alone keeps it, which is what stepping away from the field
   *  means. */
  'browser:stopFindInPage': {} as Contract<[tabId: string, action: BrowserFindStopAction], void>,
  /**
   * Arm or disarm the element inspector on a design tab. Arming injects the
   * page-side inspector and starts reporting picks; disarming stops picking but
   * leaves the pins in place, and both keep reporting a pin the user clicks.
   * Only meaningful on a tab whose `BrowserPageState.design` is set.
   *
   * The theme rides on the arm so the injected overlay is themed by the time it
   * draws its first box, instead of racing a separate theme push.
   */
  'browser:inspectSetArmed': {} as Contract<
    [tabId: string, armed: boolean, theme?: BrowserInspectorTheme],
    void
  >,
  /** Replace the pinned-element set the page draws, after a pick or a removal
   *  changed the composer's references. */
  'browser:inspectMarkers': {} as Contract<
    [tabId: string, markers: BrowserInspectorMarker[]],
    void
  >,
  /** Re-theme a tab's page overlay. Sent when the application's theme changes,
   *  so a pin and its comment follow light and dark mode without a re-arm. */
  'browser:inspectTheme': {} as Contract<[tabId: string, theme: BrowserInspectorTheme], void>,
  /**
   * Put one pinned element in front of the user: highlight it, and optionally
   * scroll it into view. This is how a comment clicked in the composer brings
   * the browser back to the element it was made on.
   */
  'browser:inspectFocus': {} as Contract<
    [tabId: string, referenceId: string | null, scroll: boolean],
    void
  >,
  /** Clear this context's browser data. Every jar it has goes, boxes included:
   *  a per-box clear is a separate, narrower action. */
  'browser:clearData': {} as Contract<[projectId: string], void>,
  /** The browser's installed extensions, whole. Short enough to publish as one
   *  list rather than as deltas, and the rail draws every row from it. */
  'browser:extensions': {} as Contract<[], BrowserExtension[]>,
  /** Install an extension by Web Store id or from an unpacked folder.
   *
   * Two run at a time and the rest queue, so this resolves when *this* install is
   * on disk and registered, however many were in front of it. Every step of it
   * arrives on `browser:extensionProgress` meanwhile, keyed by the `installId` the
   * caller put in the input, because two installs reporting at once would
   * otherwise be indistinguishable. */
  'browser:extensionInstall': {} as Contract<
    [input: BrowserExtensionInstallInput],
    BrowserExtension
  >,
  'browser:extensionUninstall': {} as Contract<[extensionId: string], void>,
  /** Check again and apply the newest validated Web Store package for one extension. */
  'browser:extensionUpdateFromWebStore': {} as Contract<[extensionId: string], BrowserExtension>,
  /** Enable or disable one extension, choose the jars it runs in, or pin it into
   *  the browser view's header. `boxes` is the whole replacement list, never a
   *  delta, and it is always explicit: a jar left out of it never loads the
   *  extension. A pin is refused past `MAX_PINNED_EXTENSIONS`, and for an
   *  extension with no popup to open. */
  'browser:extensionUpdate': {} as Contract<
    [extensionId: string, patch: { enabled?: boolean; boxes?: string[]; pinned?: boolean }],
    BrowserExtension
  >,
  /** Ask the user for an unpacked extension folder. Null when they cancel. */
  'browser:extensionPickFolder': {} as Contract<[], string | null>,
  /** Erase one box's cookies, site data and cache, and forget the permission
   *  decisions it remembered. This is the destructive half of deleting a box. */
  'browser:clearBoxData': {} as Contract<[projectId: string, boxId: string], void>,
  /** A box was deleted: erase it the way `browser:clearBoxData` does, and remove
   *  the Chromium profile directory behind it. Nothing can name a deleted box's
   *  jar again, so the whole profile goes rather than being emptied in place. */
  'browser:forgetBox': {} as Contract<[projectId: string, boxId: string], void>,
  'browser:clearSiteData': {} as Contract<
    [projectId: string, scopes: BrowserSiteDataScope[]],
    void
  >,
  /**
   * Open the native site-settings context menu anchored at the given point
   * (window-content coordinates in density-independent pixels).
   *
   * A boxed tab clears its own box, so the jar the padlock was opened from comes
   * with it: `boxId` names the jar to clear and `boxName` is what the confirmation
   * says, because only the renderer knows a box's name and the copy has to say
   * which jar is about to lose its cookies.
   */
  'browser:siteMenu': {} as Contract<
    [projectId: string, host: string, boxId: string | null, boxName: string, x: number, y: number],
    void
  >,
  /** Open the native page context menu (soft and hard reload) anchored at the
   *  given point (window-content coordinates in density-independent pixels). */
  'browser:pageMenu': {} as Contract<[tabId: string, x: number, y: number], void>,
  /** Open the native downloads menu for a project, anchored at the given
   *  point (window-content coordinates in density-independent pixels). Each
   *  entry carries its live actions (pause/resume/cancel/open/reveal). */
  'browser:downloadsMenu': {} as Contract<[projectId: string, x: number, y: number], void>,
  /**
   * Open the thread browser's native box menu, anchored at the given point
   * (window-content coordinates in density-independent pixels).
   *
   * The profile's boxes are the renderer's, so they travel with the call; main
   * only turns them into OS menu items and names the one that was picked. The
   * reply is null when the menu was dismissed, and a chosen `null` box is the
   * conversation scope's own jar.
   */
  'browser:boxMenu': {} as Contract<
    [input: BrowserBoxMenuInput, x: number, y: number],
    BrowserBoxMenuChoice | null
  >,
  'browser:resolvePermission': {} as Contract<
    [requestId: string, decision: BrowserPermissionDecision],
    void
  >,
  /** Invoked by the native permission popup document when it is ready to
   *  display a request; main resolves with the request on display, or null.
   *  This pull model cannot race document load state, which the previous
   *  push-based first-delivery repeatedly did (blank first prompt). */
  'browser:popupReady': {} as Contract<[], BrowserPermissionPromptContext | null>,
  'browser:destroy': {} as Contract<[tabId: string, reason: BrowserTabDestroyReason], void>,
  'browser:destroyThread': {} as Contract<[projectId: string, threadId: string], void>,
  'browser:destroyProject': {} as Contract<[projectId: string], void>,
  'browser:getDownloads': {} as Contract<[projectId: string], BrowserDownload[]>,
  'browser:cancelDownload': {} as Contract<[id: string], void>,
  'browser:pauseDownload': {} as Contract<[id: string], void>,
  /** Continue a download from the bytes it already has, whether it was paused in
   *  this run or stopped by an earlier one. */
  'browser:resumeDownload': {} as Contract<[id: string], void>,
  /** Start a stopped download over, from its first byte, into the same file. */
  'browser:retryDownload': {} as Contract<[id: string], void>,
  /** Drop a finished, interrupted or cancelled download record from the list. */
  'browser:removeDownload': {} as Contract<[id: string], void>,
  'browser:openDownload': {} as Contract<[id: string], void>,
  'browser:revealDownload': {} as Contract<[id: string], boolean>
}
