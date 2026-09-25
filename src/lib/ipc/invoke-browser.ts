import type {
  BrowserCompositionPlayback,
  BrowserDownload,
  BrowserInspectorMarker,
  BrowserPageState,
  BrowserPermissionDecision,
  BrowserPermissionPromptContext,
  BrowserShortcutBindings,
  BrowserSiteDataScope,
  BrowserTransportCommand,
  BrowserViewBounds
} from './browser'
import type { Contract } from './contract-helpers'

export const invokeBrowserContract = {
  'browser:show': {} as Contract<
    [
      tabId: string,
      projectId: string,
      threadId: string,
      initialUrl: string,
      bounds: BrowserViewBounds
    ],
    BrowserPageState
  >,
  'browser:hide': {} as Contract<[tabId: string], void>,
  'browser:setToastVisible': {} as Contract<[visible: boolean], void>,
  'browser:navigate': {} as Contract<[tabId: string, url: string], void>,
  'browser:goBack': {} as Contract<[tabId: string], void>,
  'browser:goForward': {} as Contract<[tabId: string], void>,
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
   * Report which tab's toolbar (address bar, buttons) holds DOM focus, or null
   * when none does. A key pressed in a native page view never reaches the
   * renderer, so main needs the focus the toolbar holds to route the same
   * chords when the user is typing an address.
   */
  'browser:setChromeFocus': {} as Contract<[tabId: string | null], void>,
  /** Toggle the web page's native DevTools. Returns whether it is now open. */
  'browser:toggleDevTools': {} as Contract<[tabId: string], boolean>,
  /**
   * Arm or disarm the element inspector on a design tab. Arming injects the
   * page-side inspector and starts reporting picks; disarming stops picking but
   * leaves the pins in place. Only meaningful on a tab whose
   * `BrowserPageState.design` is set.
   */
  'browser:inspectSetArmed': {} as Contract<[tabId: string, armed: boolean], void>,
  /** Replace the pinned-element set the page draws, after a pick, comment or
   *  removal changed the composer's references. */
  'browser:inspectMarkers': {} as Contract<
    [tabId: string, markers: BrowserInspectorMarker[]],
    void
  >,
  'browser:clearData': {} as Contract<[projectId: string], void>,
  'browser:clearSiteData': {} as Contract<
    [projectId: string, scopes: BrowserSiteDataScope[]],
    void
  >,
  /** Open the native site-settings context menu anchored at the given point
   *  (window-content coordinates in density-independent pixels). */
  'browser:siteMenu': {} as Contract<[projectId: string, host: string, x: number, y: number], void>,
  /** Open the native page context menu (soft and hard reload) anchored at the
   *  given point (window-content coordinates in density-independent pixels). */
  'browser:pageMenu': {} as Contract<[tabId: string, x: number, y: number], void>,
  /** Open the native downloads menu for a project, anchored at the given
   *  point (window-content coordinates in density-independent pixels). Each
   *  entry carries its live actions (pause/resume/cancel/open/reveal). */
  'browser:downloadsMenu': {} as Contract<[projectId: string, x: number, y: number], void>,
  'browser:resolvePermission': {} as Contract<
    [requestId: string, decision: BrowserPermissionDecision],
    void
  >,
  /** Invoked by the native permission popup document when it is ready to
   *  display a request; main resolves with the request on display, or null.
   *  This pull model cannot race document load state, which the previous
   *  push-based first-delivery repeatedly did (blank first prompt). */
  'browser:popupReady': {} as Contract<[], BrowserPermissionPromptContext | null>,
  'browser:destroy': {} as Contract<[tabId: string], void>,
  'browser:destroyThread': {} as Contract<[projectId: string, threadId: string], void>,
  'browser:destroyProject': {} as Contract<[projectId: string], void>,
  'browser:getDownloads': {} as Contract<[projectId: string], BrowserDownload[]>,
  'browser:cancelDownload': {} as Contract<[id: string], void>,
  'browser:pauseDownload': {} as Contract<[id: string], void>,
  'browser:resumeDownload': {} as Contract<[id: string], void>,
  'browser:openDownload': {} as Contract<[id: string], void>,
  'browser:revealDownload': {} as Contract<[id: string], boolean>
}
