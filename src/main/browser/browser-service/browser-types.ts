/**
 * Shared record shapes for the embedded browser service: one live tab, one
 * pending permission prompt, one tracked download, and the destructive
 * site-data actions offered by the native site-settings menu.
 */

import type { WebContentsView } from 'electron'
import type {
  BrowserConsoleEntry,
  BrowserDownload,
  BrowserPermissionRequest,
  BrowserSiteDataScope
} from '../../../lib/ipc-contract'

export interface BrowserTab {
  view: WebContentsView
  projectId: string
  threadId: string
  initialNavigationStarted: boolean
  consoleEntries: BrowserConsoleEntry[]
  /** Favicon data URL from the last `page-favicon-updated`, cleared on navigation. */
  favicon: string | null
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
