import type {
  BrowserDownload,
  BrowserPageState,
  BrowserPermissionDecision,
  BrowserPermissionPromptContext,
  BrowserSiteDataScope,
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
  'browser:stop': {} as Contract<[tabId: string], void>,
  /** Mute or unmute one tab's audio output. Main publishes the applied state
   *  back through `browser:state`. */
  'browser:setMuted': {} as Contract<[tabId: string, muted: boolean], void>,
  /** Toggle the web page's native DevTools. Returns whether it is now open. */
  'browser:toggleDevTools': {} as Contract<[tabId: string], boolean>,
  'browser:clearData': {} as Contract<[projectId: string], void>,
  'browser:clearSiteData': {} as Contract<
    [projectId: string, scopes: BrowserSiteDataScope[]],
    void
  >,
  /** Open the native site-settings context menu anchored at the given point
   *  (window-content coordinates in density-independent pixels). */
  'browser:siteMenu': {} as Contract<[projectId: string, host: string, x: number, y: number], void>,
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
