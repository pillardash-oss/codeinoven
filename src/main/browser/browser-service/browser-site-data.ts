/**
 * Site data for the embedded browser: the native site-settings menu, its
 * destructive confirmation, and the scoped clearing operations behind both.
 * The service supplies sessions, tabs and the permission/download ledgers.
 */

import { Menu, MenuItem, dialog, type BrowserWindow, type Session } from 'electron'
import type { BrowserSiteDataScope } from '../../../lib/ipc-contract'
import { Logger } from '../../system/logger'
import { sendToRenderer } from '../../ipc/renderer-delivery'
import { SCOPE_STORAGE_TYPES } from './browser-validation'
import { SITE_MENU_ACTIONS, type BrowserTab, type SiteMenuAction } from './browser-types'

export interface BrowserSiteDataDeps {
  window: BrowserWindow
  sessionForProject: (projectId: string) => Session
  forEachTab: (visit: (tab: BrowserTab) => void) => void
  /** Dismiss pending permission prompts that belong to a project. */
  dismissPermissions: (projectId: string) => void
  /** Forget every remembered grant or denial for a project's session. */
  clearPermissionMemory: (projectId: string) => void
  cancelProjectDownloads: (projectId: string) => void
}

export class BrowserSiteDataService {
  constructor(private readonly deps: BrowserSiteDataDeps) {}

  /** Open the OS-native site-settings context menu. Runs in a nested run loop
   *  and composites above the WebContentsView, so the page never has to be
   *  detached for the menu. */
  showSiteMenu(projectId: string, host: string, x: number, y: number): void {
    if (this.deps.window.isDestroyed()) return
    const menu = new Menu()
    if (host) menu.append(new MenuItem({ label: host, enabled: false }))
    menu.append(new MenuItem({ type: 'separator' }))
    for (const action of SITE_MENU_ACTIONS) {
      menu.append(
        new MenuItem({
          label: `${action.label}…`,
          click: () => this.confirmAndClearSiteData(projectId, action)
        })
      )
    }
    menu.popup({
      window: this.deps.window,
      x,
      y,
      callback: () => {
        if (!this.deps.window.webContents.isDestroyed()) {
          sendToRenderer(this.deps.window.webContents, 'browser:siteMenuClosed')
        }
      }
    })
  }

  /** Confirm the destructive site-data action with a parented native dialog
   *  before executing it. */
  private confirmAndClearSiteData(projectId: string, action: SiteMenuAction): void {
    if (this.deps.window.isDestroyed()) return
    void dialog
      .showMessageBox(this.deps.window, {
        type: 'warning',
        message: `${action.label}?`,
        detail: action.detail,
        buttons: [action.label, 'Cancel'],
        defaultId: 1,
        cancelId: 1
      })
      .then((result) => {
        if (result.response !== 0) return
        return this.clearSiteData(projectId, [action.scope]).catch((error: unknown) => {
          Logger.error('Browser site data could not be cleared:', error)
          if (this.deps.window.isDestroyed()) return
          void dialog.showMessageBox(this.deps.window, {
            type: 'error',
            message: 'Site data could not be cleared',
            detail:
              error instanceof Error && error.message
                ? error.message
                : 'An unexpected error occurred while clearing browser site data.',
            buttons: ['OK']
          })
        })
      })
      .catch((error: unknown) => {
        Logger.error('Browser site data confirmation failed:', error)
      })
  }

  async clearProjectData(projectId: string): Promise<void> {
    this.deps.dismissPermissions(projectId)
    this.deps.cancelProjectDownloads(projectId)
    this.deps.clearPermissionMemory(projectId)
    const browserSession = this.deps.sessionForProject(projectId)
    await Promise.all([browserSession.clearStorageData(), browserSession.clearCache()])
    await browserSession.closeAllConnections()
    this.reloadProjectTabs(projectId)
  }

  /** Clear only the requested scopes for the project's browser session. Tabs of
   *  the project reload afterwards so cleared state takes effect immediately. */
  async clearSiteData(projectId: string, scopes: BrowserSiteDataScope[]): Promise<void> {
    if (scopes.includes('permissions')) {
      this.deps.dismissPermissions(projectId)
      this.deps.clearPermissionMemory(projectId)
    }
    const browserSession = this.deps.sessionForProject(projectId)
    const work: Promise<unknown>[] = []
    for (const scope of scopes) {
      if (scope === 'cache') {
        work.push(browserSession.clearCache())
      } else if (scope === 'cookies' || scope === 'site-data') {
        work.push(browserSession.clearStorageData({ storages: SCOPE_STORAGE_TYPES[scope] }))
      }
    }
    if (work.length > 0) {
      await Promise.all(work)
      await browserSession.closeAllConnections()
    }
    this.reloadProjectTabs(projectId)
  }

  private reloadProjectTabs(projectId: string): void {
    this.deps.forEachTab((tab) => {
      if (tab.projectId === projectId && tab.initialNavigationStarted) tab.view.webContents.reload()
    })
  }
}
