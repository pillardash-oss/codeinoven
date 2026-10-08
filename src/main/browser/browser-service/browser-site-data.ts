/**
 * Site data for the embedded browser: the native site-settings menu, its
 * destructive confirmation, and the scoped clearing operations behind both.
 * The service supplies sessions, tabs and the permission/download ledgers.
 */

import { waitBrowserSessionCookies, flushBrowserSessionCookiesFor } from './browser-session-cookies'
import { Menu, MenuItem, dialog, type BrowserWindow, type Session } from 'electron'
import type { BrowserSiteDataScope } from '../../../lib/ipc-contract'
import { Logger } from '../../system/logger'
import { sendToRenderer } from '../../ipc/renderer-delivery'
import { SCOPE_STORAGE_TYPES, browserPartitionFor } from './browser-validation'
import { SITE_MENU_ACTIONS, type BrowserTab, type SiteMenuAction } from './browser-types'

export interface BrowserSiteDataDeps {
  window: BrowserWindow
  /** The session for one jar: the context's own jar when `boxId` is null, and
   *  that box's jar   the profile's, shared with every context that picked the
   *  same box   when it is not. */
  sessionForJar: (projectId: string, boxId: string | null) => Session
  /** Every jar a context-wide clear reaches, the context's own jar first. */
  projectJars: (projectId: string) => (string | null)[]
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
  showSiteMenu(
    projectId: string,
    host: string,
    boxId: string | null,
    boxName: string,
    x: number,
    y: number
  ): void {
    if (this.deps.window.isDestroyed()) return
    const menu = new Menu()
    if (host) menu.append(new MenuItem({ label: host, enabled: false }))
    menu.append(new MenuItem({ type: 'separator' }))
    for (const action of SITE_MENU_ACTIONS) {
      menu.append(
        new MenuItem({
          label: `${action.label}…`,
          click: () => this.confirmAndClearSiteData(projectId, boxId, boxName, action)
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
  private confirmAndClearSiteData(
    projectId: string,
    boxId: string | null,
    boxName: string,
    action: SiteMenuAction
  ): void {
    if (this.deps.window.isDestroyed()) return
    void dialog
      .showMessageBox(this.deps.window, {
        type: 'warning',
        message: `${action.label}?`,
        detail: this.scopedDetail(boxId, boxName, action),
        buttons: [action.label, 'Cancel'],
        defaultId: 1,
        cancelId: 1
      })
      .then((result) => {
        if (result.response !== 0) return
        return this.clearMenuJar(projectId, boxId, action).catch((error: unknown) => {
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

  /** Everything a context's own browser holds goes.
   *
   *  The global browser's boxes go with it: that is where boxes are made, and
   *  clearing the personal browser has always taken them along. A project's clear
   *  is deliberately narrower, because a box is one jar for the whole profile: a
   *  project-wide clear must not wipe an identity the personal browser and other
   *  projects are signed into. Clearing a box is the box's own action (the boxes
   *  panel, or the padlock on a page running in it). */
  async clearProjectData(projectId: string): Promise<void> {
    this.deps.dismissPermissions(projectId)
    this.deps.cancelProjectDownloads(projectId)
    this.deps.clearPermissionMemory(projectId)
    const jars = this.deps.projectJars(projectId)
    await Promise.all(jars.map((boxId) => this.clearJar(projectId, boxId, [])))
    this.reloadProjectTabs(projectId, jars)
  }

  /** Clear only the requested scopes for the project's browser session. Tabs of
   *  the project reload afterwards so cleared state takes effect immediately. */
  async clearSiteData(projectId: string, scopes: BrowserSiteDataScope[]): Promise<void> {
    if (scopes.includes('permissions')) this.forgetPermissions(projectId)
    const jars = this.deps.projectJars(projectId)
    await Promise.all(jars.map((boxId) => this.clearJar(projectId, boxId, scopes)))
    this.reloadProjectTabs(projectId, jars)
  }

  /**
   * One action of the site-settings menu, aimed at the jar the padlock was
   * opened from: a boxed tab clears its own box, and the project's own jar is
   * what a menu with no box belongs to.
   */
  private async clearMenuJar(
    projectId: string,
    boxId: string | null,
    action: SiteMenuAction
  ): Promise<void> {
    if (action.scope === 'permissions') this.forgetPermissions(projectId)
    await this.clearJar(projectId, boxId, [action.scope])
    this.reloadProjectTabs(projectId, [boxId])
  }

  /** Forget every remembered permission grant or denial the project holds. */
  private forgetPermissions(projectId: string): void {
    this.deps.dismissPermissions(projectId)
    this.deps.clearPermissionMemory(projectId)
  }

  /** Empty one jar of the requested scopes, or of everything it holds when no
   *  scope is named. `permissions` live outside the session and are handled by
   *  the caller, so it contributes no storage work here. */
  private async clearJar(
    projectId: string,
    boxId: string | null,
    scopes: readonly BrowserSiteDataScope[]
  ): Promise<void> {
    const browserSession = this.deps.sessionForJar(projectId, boxId)
    await waitBrowserSessionCookies(browserSession)
    const work: Promise<unknown>[] = []
    if (scopes.length === 0) {
      work.push(browserSession.clearStorageData(), browserSession.clearCache())
    }
    for (const scope of scopes) {
      if (scope === 'cache') {
        work.push(browserSession.clearCache())
      } else if (scope === 'cookies' || scope === 'site-data') {
        work.push(browserSession.clearStorageData({ storages: SCOPE_STORAGE_TYPES[scope] }))
      }
    }
    if (work.length === 0) return
    await Promise.all(work)
    await flushBrowserSessionCookiesFor(browserSession)
    await browserSession.closeAllConnections()
  }

  /** The confirmation copy, naming the jar that is about to lose its cookies
   *  when that jar is one box rather than the project's whole browser. */
  private scopedDetail(boxId: string | null, boxName: string, action: SiteMenuAction): string {
    if (boxId === null) return action.detail
    const jar = boxName === '' ? 'this box' : `the ${boxName} box`
    return `${action.detail} Only ${jar} is cleared, and a box is one jar for the whole profile, so every thread and the global browser using it lose this too.`
  }

  /**
   * Reload the tabs a clear just affected, so the cleared state takes effect now
   *  rather than at the next navigation: a session that keeps answering in memory
   *  would otherwise look signed in as the account whose cookies were just erased.
   *
   *  Selected by jar, not by context: a cleared box jar is one session however
   *  many contexts have a tab open in it, and every one of those tabs is looking
   *  at a page whose cookies just went.
   */
  private reloadProjectTabs(projectId: string, jars: readonly (string | null)[]): void {
    const cleared = new Set(jars.map((boxId) => browserPartitionFor(projectId, boxId)))
    this.deps.forEachTab((tab) => {
      if (!cleared.has(browserPartitionFor(tab.projectId, tab.boxId))) return
      if (!tab.initialNavigationStarted) return
      tab.view.webContents.reload()
    })
  }
}
