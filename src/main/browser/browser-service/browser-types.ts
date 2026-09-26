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
  BrowserDownload,
  BrowserPermissionRequest,
  BrowserSiteDataScope
} from '../../../lib/ipc-contract'

/** Viewport a tab is laid out at while it is parked offscreen, in CSS pixels. */
export interface BrowserViewport {
  width: number
  height: number
}

export interface BrowserTab {
  view: WebContentsView
  projectId: string
  threadId: string
  initialNavigationStarted: boolean
  consoleEntries: BrowserConsoleEntry[]
  /** Favicon data URL from the last `page-favicon-updated`, cleared on navigation. */
  favicon: string | null
  /** Size this tab is laid out at while parked offscreen. A displayed tab is
   *  laid out at the on-screen surface's size instead, and keeps this value for
   *  whenever it is parked again. */
  viewport: BrowserViewport
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
}

export interface PendingBrowserPermission {
  request: BrowserPermissionRequest
  callback: (granted: boolean) => void
  timer: ReturnType<typeof setTimeout>
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

export interface BrowserDownloadRecord {
  item: Electron.DownloadItem
  download: BrowserDownload
  lastEmittedAt: number
}
