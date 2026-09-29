/**
 * Shared record shapes for the embedded browser service: one live tab, one
 * pending permission prompt, one tracked download, and the destructive
 * site-data actions offered by the native site-settings menu.
 */

import type { WebContentsView } from 'electron'
import type {
  BrowserCompositionTab,
  BrowserConsoleEntry,
  BrowserDesignTab,
  BrowserLoadError,
  BrowserPermissionRequest,
  BrowserSiteDataScope
} from '../../../lib/ipc-contract'

/** Viewport a tab is laid out at while it is parked offscreen, in CSS pixels. */
export interface BrowserViewport {
  width: number
  height: number
}

/**
 * The browser tab a page belongs to, and the project and thread a page it opens
 * inherits.
 *
 * One shape covers both kinds of page the browser hosts: a tab names itself, and
 * a popup window names the tab whose page opened it. Everything that decides
 * where a new page lands (a background tab, a popup window in the rail) reads
 * those three fields and nothing else, so a page opened by a page is owned the
 * same way whether the opener was a tab or a popup.
 */
export interface BrowserPageOwner {
  /** The tab the page belongs to, or its owning tab for a popup window. */
  tabId: string
  projectId: string
  threadId: string
  /** The box the owning tab lives in, so a sibling opened from it lands in the
   *  same jar. Null for the context's own jar. */
  boxId: string | null
}

/** A viewport the page was laid out at, and when that happened. */
export interface BrowserViewportApplication {
  viewport: BrowserViewport
  at: number
}

/**
 * Everything a park needs to know: why it is happening, and the one case where
 * the caller's size wins over the tab's own.
 */
export interface ParkBrowserTabOptions {
  /**
   * Lay the page out at exactly this viewport instead of the tab's own. Only for
   * a caller that must preserve the frame the user is looking at right now (the
   * toast hold, which takes the view away for a moment and puts it back).
   */
  size?: BrowserViewport
  /** Keep the tab the active one, because it is coming straight back. */
  keepActive?: boolean
  /** Why the tab is being parked. Carried into the dev log so a recorded frame
   *  of the browser surface can be matched to the moment that produced it. */
  reason: string
}

export interface BrowserTab {
  view: WebContentsView
  projectId: string
  threadId: string
  /**
   * The box this tab's page lives in, or null for the context's own jar.
   *
   * It is fixed for the tab's whole life: a page cannot change cookie jars, so a
   * show that names a different box for the same tab is refused rather than
   * silently re-parented onto another jar's storage.
   */
  boxId: string | null
  initialNavigationStarted: boolean
  consoleEntries: BrowserConsoleEntry[]
  /**
   * Favicon data URL for the document on screen: the last one `page-favicon-updated`
   * announced, or the icon the committed URL's origin is already known by.
   */
  favicon: string | null
  /**
   * The icons this tab has shown, keyed by the origin that showed them, most
   * recently used last and bounded per tab. Checked on every committed navigation,
   * because Chromium announces an icon only when it changes.
   */
  faviconByOrigin: Map<string, string>
  /**
   * The viewport an agent asked this tab to be laid out at while parked, and when
   * it asked. Null until an agent requests one, which leaves the desktop default.
   */
  requestedViewport: BrowserViewportApplication | null
  /**
   * The frame this tab was last displayed at, and when it was displayed.
   *
   * Parking lays the page out at the newest of this and `requestedViewport`, so a
   * hide never resizes the page away from the size the user was reading it at. A
   * tab that was never displayed and never asked falls back to
   * `DEFAULT_PARKED_VIEWPORT`, which is the deterministic desktop size an agent's
   * offscreen tab is mounted at.
   */
  displayedViewport: BrowserViewportApplication | null
  /** The design folder this tab is rendering, when the design capability opened
   *  it. Non-null is what makes the tab eligible for the element inspector. */
  design: BrowserDesignTab | null
  /** The video composition this tab is showing, read from the served folder's
   *  manifest. Non-null is what arms the transport and what the panel draws the
   *  transport bar from. */
  composition: BrowserCompositionTab | null
  /**
   * The document the playback runtime was installed into, and the timeline it was
   * installed with, or null while the current document has none.
   *
   * Arming reads this rather than assuming: a document is armed once, and the same
   * document is armed again only when the timeline the agent wrote changed under
   * it, because installing a second runtime would restart the video at zero. The
   * generation is what tells one document from the next one loaded at the same URL,
   * which the live refresh produces every time the composition changes.
   */
  transport: { generation: number; url: string; duration: number; fps: number } | null
  /**
   * Whether the mute in force on this tab is the player's rather than the user's.
   *
   * A composition is muted whenever its transport is not playing, because a page
   * can always start sound the runtime cannot reach. Remembering that the app made
   * the mute is what lets a play lift it without ever overriding a mute the user
   * chose for themselves.
   */
  transportMuted: boolean
  /** Counts committed navigations, so a runtime installed a moment ago can be told
   *  from one installed into a document that has since been replaced. */
  navigationGeneration: number
  /**
   * The failure the current document ended on, or null while the tab has a page.
   *
   * Held on the tab rather than recomputed so the renderer keeps showing the
   * error card across every unrelated `browser:state` report until a navigation
   * actually succeeds.
   */
  loadError: BrowserLoadError | null
  /**
   * The failure recorded for the navigation currently in flight, before it is
   * known whether it is a failure at all.
   *
   * A network error is a failure the moment `did-fail-load` fires, but an HTTP
   * error status is only one when the document it served turns out to be empty,
   * which cannot be read until `did-finish-load`. This is that provisional value;
   * a main-frame navigation start clears it.
   */
  navigationFailure: BrowserLoadError | null
}

export interface PendingBrowserPermission {
  request: BrowserPermissionRequest
  callback: (granted: boolean) => void
  timer: ReturnType<typeof setTimeout>
  /**
   * The partition the prompt belongs to: a decision is remembered against the jar
   * the request came from, not against the context, so a box keeps its own
   * answers. Held here rather than derived from `request.projectId`, because the
   * same context can have one jar per box.
   */
  partition: string
}

/** A destructive site-data action offered by the native site-settings menu. */
export interface SiteMenuAction {
  scope: BrowserSiteDataScope
  label: string
  detail: string
}

export const SITE_MENU_ACTIONS: readonly SiteMenuAction[] = [
  {
    scope: 'cookies',
    label: 'Clear cookies',
    detail: 'Cookies for sites visited in this browser will be deleted. You may be signed out.'
  },
  {
    scope: 'site-data',
    label: 'Clear site data',
    detail:
      'Storage, service workers and sessions for sites visited in this browser will be deleted.'
  },
  {
    scope: 'cache',
    label: 'Clear cache',
    detail: 'Cached files for sites visited in this browser will be deleted.'
  },
  {
    scope: 'permissions',
    label: 'Reset permissions',
    detail:
      'Remembered camera, microphone and other permission choices for sites visited in this browser will be forgotten.'
  }
]
