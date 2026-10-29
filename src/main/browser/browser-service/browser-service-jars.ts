import { waitBrowserSessionCookies, flushBrowserSessionCookiesFor } from './browser-session-cookies'
import { session } from 'electron'
import { GLOBAL_BROWSER_PROJECT_ID } from '../../../lib/ipc-contract'
import { Logger } from '../../system/logger'
import {
  listBrowserProfilesForPartition,
  listProjectBrowserProfiles,
  removeBrowserProfiles
} from './browser-profile-store'
import { boxIdFromPartition, browserJarFor, browserPartitionFor } from './browser-validation'
import { liveContents } from './browser-view-contents'
import type { BrowserService } from '../browser-service'

/**
 * Forgetting a box, a project, or one jar's storage.
 *
 * Site data lives in a jar, and a jar belongs to a project or to a box inside one. This
 * unit enumerates the jars a target owns, closes the pages that would keep them alive,
 * and clears the storage behind them.
 */

/**
 * What `browser-service-jars` reads off the browser service.
 *
 * Each member is the service's own declaration, so this unit and the composition
 * root cannot drift apart: a changed signature is a compile error here.
 */
export interface JarsHost {
  readonly clearProjectPermissionMemory: BrowserService['clearProjectPermissionMemory']
  readonly closedTabHistory: BrowserService['closedTabHistory']
  readonly configuredSessions: BrowserService['configuredSessions']
  readonly destroy: BrowserService['destroy']
  readonly downloads: BrowserService['downloads']
  readonly extensions: BrowserService['extensions']
  readonly permissionLedgers: BrowserService['permissionLedgers']
  readonly permissionMemory: BrowserService['permissionMemory']
  readonly popupWindows: BrowserService['popupWindows']
  readonly sidePanels: BrowserService['sidePanels']
  readonly tabHistory: BrowserService['tabHistory']
  readonly tabs: BrowserService['tabs']
}

export class BrowserServiceJars {
  constructor(private readonly host: JarsHost) {}

  /**
   * Erase one box's cookies, site data and cache, and forget the permission
   * decisions it remembered.
   *
   * This is the destructive half of deleting a box. The partition *is* the box,
   * so clearing it is what "delete and erase" means, and the ledgers go with it:
   * leaving them behind would let a recreated box inherit decisions for a site
   * the user removed. The session object itself is kept, because a box the user
   * recreates will resolve to this same partition string, and a session already
   * configured is cheaper than one rebuilt on the next tab.
   */
  async clearBoxData(projectId: string, boxId: string): Promise<void> {
    const partition = browserPartitionFor(projectId, boxId)
    // Unload first, then reload: an extension holds open files and a running
    // service worker inside the storage being erased, and reloading the jar's tabs
    // then runs it again against the clean store.
    await this.host.extensions.onJarEmptied(projectId, boxId, true)
    await this.clearJarStorage(partition)
    await this.host.extensions.ensureJarLoaded(projectId, boxId)
  }

  /**
   * A box was deleted. Everything about it goes: its extensions are released and
   * dropped from every extension's jar list, its storage and its remembered
   * permissions are erased, and the Chromium profile directory behind the
   * partition is removed.
   *
   * A box's id is minted per creation, so a box made again after this is a new jar
   * with no relationship to the one that was removed, which is why nothing is kept.
   * The directory has to go explicitly: clearing a session empties a profile
   * without removing the directory that holds it, so a deleted box would otherwise
   * keep its cache on disk forever.
   */
  async forgetBox(projectId: string, boxId: string): Promise<void> {
    const partition = browserPartitionFor(projectId, boxId)
    await this.host.extensions.forgetBox(projectId, boxId)
    await this.clearJarStorage(partition)
    this.host.configuredSessions.delete(partition)
    await removeBrowserProfiles(await listBrowserProfilesForPartition(partition))
  }

  /**
   * A project was deleted, so its browser goes with it.
   *
   * This is the one path that removes a project's whole browser: its tabs are
   * destroyed, every jar it had open settles its connections and empties its
   * storage, the remembered decisions and stored Back/Forward stacks go, and the
   * Chromium profile directories are then removed from disk. None of it can be
   * reached again, because a project id is minted per project.
   *
   * Erasing a context that still exists is a different action: that one keeps its
   * session and clears only what the user asked to clear, so the profile comes back
   * empty rather than gone.
   */
  async forgetProject(projectId: string): Promise<string[]> {
    await this.host.extensions.whenReady()
    this.dropProjectTabs(projectId)
    // The extensions installed for this project's own browser belong to it, so they
    // go with the project rather than lingering as jars nothing can reach. Boxes are
    // left alone: a box is the profile's, and other contexts browse it.
    await this.host.extensions.forgetProject(projectId)
    // Settle the jars that have a live session *before* their directories go: an
    // open database or a connection still in flight would otherwise keep writing
    // into a profile that is being removed underneath it.
    for (const partition of this.projectPartitions(projectId)) {
      await this.settleJar(partition)
      this.host.configuredSessions.delete(partition)
    }
    const profiles = await listProjectBrowserProfiles(projectId)
    // The persisted decision ledger is keyed by partition, so every profile that is
    // about to go is forgotten by name, not only the jars with a live session.
    this.host.clearProjectPermissionMemory(
      projectId,
      profiles.map((profile) => profile.partition)
    )
    const removed = await removeBrowserProfiles(profiles)
    if (removed.length > 0) {
      Logger.info('Removed the browser profiles of a deleted project', { projectId, removed })
    }
    return removed
  }

  /**
   * Tear down everything one project's browser holds in this window: its tabs, the
   * stored stacks they own, and the download records named after it.
   *
   * Shared by the renderer's `browser:destroyProject` (a workspace closed) and by
   * `forgetProject` (the project itself is gone), so a closed workspace and a
   * deleted project can never leave different remnants behind.
   */
  dropProjectTabs(projectId: string): void {
    for (const [tabId, tab] of [...this.host.tabs]) {
      if (tab.projectId === projectId) this.host.destroy(tabId, 'closed')
    }
    this.host.tabHistory.forgetScopes((record) => record.projectId === projectId)
    this.host.closedTabHistory.forgetScopes((record) => record.projectId === projectId)
    this.host.downloads.forgetProject(projectId)
  }

  /** Every jar of one project that this window currently holds a session for.
   *  Only the project's own jar: a box's jar is the profile's, shared by every
   *  context that picked that box, so a project's removal never touches one. */
  projectPartitions(projectId: string): string[] {
    const own = browserPartitionFor(projectId)
    return [...this.host.configuredSessions].filter((partition) => partition === own)
  }

  /**
   * Close a jar's connections and empty its storage and cache, so removing the
   * directory behind it does not race a write already in flight. A jar that cannot
   * be settled is reported and still removed: its profile is unreachable either way,
   * and a failure here must not strand gigabytes.
   */
  async settleJar(partition: string): Promise<void> {
    try {
      const browserSession = session.fromPartition(partition)
      await waitBrowserSessionCookies(browserSession)
      await browserSession.closeAllConnections()
      await browserSession.clearStorageData()
      await browserSession.clearCache()
    } catch (error: unknown) {
      Logger.error(`Browser profile "${partition}" could not be emptied before removal:`, error)
    }
  }

  /** Erase one jar's storage, cache and remembered permission decisions. */
  async clearJarStorage(partition: string): Promise<void> {
    const browserSession = session.fromPartition(partition)
    await waitBrowserSessionCookies(browserSession)
    await browserSession.clearStorageData()
    await flushBrowserSessionCookiesFor(browserSession)
    await browserSession.clearCache()
    await browserSession.closeAllConnections()
    await this.host.permissionMemory.forget(partition, this.host.permissionLedgers())
    // The jar's own tabs reload so the cleared state takes effect now rather than
    // at the next navigation: an in-memory session would otherwise keep answering
    // as the account whose cookies were just erased.
    for (const tab of this.host.tabs.values()) {
      if (browserPartitionFor(tab.projectId, tab.boxId) !== partition) continue
      if (!tab.initialNavigationStarted || !liveContents(tab.view)) continue
      tab.view.webContents.reload()
    }
  }

  /**
   * Every jar that currently has a live page, so the extension service can aim a
   * load at the jars that exist rather than at every jar the user ever made.
   *
   *  Listed by jar, not by tab owner: a box's session is one jar however many
   *  contexts have a tab in it, so the global browser and a project browsing the
   *  same box contribute one entry. The profile's default box is that same rule
   *  taken to its end: a tab in it is a tab in the global browser's own jar, so it
   *  is reported as the global browser rather than as the context that opened it.
   */
  liveJars(): { projectId: string; boxId: string | null }[] {
    const jars: { projectId: string; boxId: string | null }[] = []
    const partitions = new Set<string>()
    for (const tab of this.host.tabs.values()) {
      if (!liveContents(tab.view)) continue
      const jar = browserJarFor(tab.projectId, tab.boxId)
      const partition = browserPartitionFor(jar.projectId, jar.boxId)
      if (partitions.has(partition)) continue
      partitions.add(partition)
      jars.push(jar)
    }
    for (const owner of [
      ...this.host.popupWindows.liveJars(),
      ...this.host.sidePanels.liveJars()
    ]) {
      const jar = browserJarFor(owner.projectId, owner.boxId)
      const partition = browserPartitionFor(jar.projectId, jar.boxId)
      if (partitions.has(partition)) continue
      partitions.add(partition)
      jars.push(jar)
    }
    return jars
  }

  /** Retained extension documents keep their jar alive after site tabs close. */
  jarHasLivePage(projectId: string, boxId: string | null): boolean {
    // Asked about the jar rather than about its owner: a box's jar is shared, so
    // the global browser reading a page in it is enough to keep its extensions
    // loaded even as a project's tab in the same box closes.
    const partition = browserPartitionFor(projectId, boxId)
    return this.liveJars().some(
      (jar) => browserPartitionFor(jar.projectId, jar.boxId) === partition
    )
  }

  /** Every jar one context holds a session for, the context's own jar first.
   *
   *  The own jar is always listed even before a session exists for it, because a
   *  context-wide clear has always meant "this browser" and must keep meaning it.
   *  The global browser's boxes are listed too: that is where boxes are made and
   *  where they are managed, so clearing the personal browser still takes its own
   *  boxes with it. A project's clear lists only its own jar, because a box is
   *  shared by every context that picked it and one project must not wipe an
   *  identity the personal browser and other projects are signed into. */
  projectJars(projectId: string): (string | null)[] {
    const jars: (string | null)[] = [null]
    if (projectId !== GLOBAL_BROWSER_PROJECT_ID) return jars
    for (const partition of this.host.configuredSessions) {
      const boxId = boxIdFromPartition(partition)
      if (!boxId || jars.includes(boxId)) continue
      jars.push(boxId)
    }
    return jars
  }
}
