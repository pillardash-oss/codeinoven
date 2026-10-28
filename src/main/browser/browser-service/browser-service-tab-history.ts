import { type WebContents } from 'electron'
import {
  boundedBrowserTabHistory,
  type BrowserTabHistoryRecord
} from '../../../lib/browser/browser-tab-history'
import { Logger } from '../../system/logger'
import { type BrowserTab } from './browser-types'
import { RESTORE_SETTLE_TIMEOUT_MS, restoreNeedsFallbackLoad } from './browser-navigation-outcome'
import { liveContents } from './browser-view-contents'
import type { BrowserService } from '../browser-service'

/**
 * Every tab's Back/Forward stack, made durable.
 *
 * The stack lives in the live `WebContentsView` and goes with it, so the service is
 * the only thing that can read it off a view or that sees all three moments it has to
 * be written down: parking a view, destroying a tab, and quitting. This unit owns the
 * reads, the writes and the one recovery path a failed restore takes.
 */

/**
 * What `browser-service-tab-history` reads off the browser service.
 *
 * Each member is the service's own declaration, so this unit and the composition
 * root cannot drift apart: a changed signature is a compile error here.
 */
export interface TabHistoryHost {
  readonly closedTabHistory: BrowserService['closedTabHistory']
  readonly load: BrowserService['load']
  readonly loadWaits: BrowserService['loadWaits']
  readonly peekTabs: BrowserService['peekTabs']
  readonly tabHistory: BrowserService['tabHistory']
  readonly tabs: BrowserService['tabs']
}

export class BrowserServiceTabHistory {
  constructor(private readonly host: TabHistoryHost) {}

  /**
   * Read every stored Back/Forward stack.
   *
   * Awaited by the bootstrap before the service accepts browser IPC, for the same
   * reason the permission ledgers are: a tab can be shown on the very first frame
   * the renderer is allowed to ask, and a stack that had not been read yet would
   * be a tab restored with no history and no second chance to get one.
   */
  async hydrateTabHistory(): Promise<void> {
    try {
      await this.host.tabHistory.load()
    } catch (error: unknown) {
      Logger.error('Browser tab history could not be loaded:', error)
    }
  }

  /**
   * Read one tab's Back/Forward stack off its live view, or null when the view is
   * gone or has nothing loadable to restore.
   */
  readTabHistory(tabId: string, tab: BrowserTab): BrowserTabHistoryRecord | null {
    const contents = liveContents(tab.view)
    if (!contents) return null
    const history = contents.navigationHistory
    const bounded = boundedBrowserTabHistory(
      history.getAllEntries().map((entry) => {
        const captured: { url: string; title: string; pageState?: string } = {
          url: entry.url,
          title: entry.title
        }
        if (entry.pageState) captured.pageState = entry.pageState
        return captured
      }),
      history.getActiveIndex()
    )
    // Nothing loadable means nothing to restore, so there is no record: an empty
    // stack is the same as no stack, and one fewer row to keep.
    if (!bounded) return null
    return {
      projectId: tab.projectId,
      threadId: tab.threadId,
      entries: bounded.entries,
      index: bounded.index,
      updatedAt: Date.now()
    }
  }

  /**
   * Read one tab's Back/Forward stack off its live view and remember it durably.
   *
   * Called at the moments the view is about to lose the stack: parking it off
   * screen, hibernating it, and quitting. Nothing is captured on a navigation,
   * because the view is where the stack belongs while the tab is alive. The tab
   * is live again, so any copy kept for a reopen is dropped here rather than left
   * to be restored twice.
   */
  captureTabHistory(tabId: string, tab: BrowserTab): void {
    if (this.host.peekTabs.has(tabId)) return
    const record = this.readTabHistory(tabId, tab)
    if (!record) return
    this.host.closedTabHistory.forget(tabId)
    this.host.tabHistory.store(tabId, record)
  }

  /**
   * Keep a closing tab's stack for a reopen instead of discarding it.
   *
   * A live tab's stack is read off its view before the view closes; a tab that
   * was already hibernated has no view left, so its durable stack is the one that
   * goes into the session set. Either way the durable copy is removed by the
   * caller, because a closed tab's stack lives only until it is reopened or the
   * session ends.
   */
  stashClosedTabHistory(tabId: string, tab: BrowserTab | undefined): void {
    const record =
      tab && liveContents(tab.view)
        ? this.readTabHistory(tabId, tab)
        : this.host.tabHistory.recordFor(tabId)
    if (record) this.host.closedTabHistory.stash(tabId, record)
  }

  /**
   * Put a tab's stored stack back into a view that has just been created.
   *
   * Answers whether a restore was started, which is what tells the caller not to
   * load the tab's single stored address over it: `restore()` puts the view on the
   * entry the tab was on, which is that address, with everything behind it alive.
   *
   * A record is only ever restored into the tab that wrote it. A tab id is unique,
   * but the project and thread are checked as well, so a thread browser's stack can
   * never be served to a global tab even if a file is edited to claim it. A tab
   * that was closed and is being reopened reads its stack from the session set,
   * which is the one place a closed tab's history is still alive.
   */
  restoreTabHistory(tabId: string, tab: BrowserTab, fallbackUrl: string): boolean {
    const record = this.host.tabHistory.recordFor(tabId) ?? this.host.closedTabHistory.peek(tabId)
    if (!record) return false
    if (record.projectId !== tab.projectId || record.threadId !== tab.threadId) return false
    const contents = liveContents(tab.view)
    if (!contents) return false
    void contents.navigationHistory
      .restore({ entries: record.entries.map((entry) => ({ ...entry })), index: record.index })
      .catch(
        (error: unknown) => void this.recoverFromFailedRestore(tabId, contents, fallbackUrl, error)
      )
    return true
  }

  /**
   * What a tab does when its stored stack did not come back.
   *
   * The rejection arrives while the page is still settling   Chromium reports a
   * failure before it commits the document the failure ends on   so the page is
   * given its moment first (bounded; see `RESTORE_SETTLE_TIMEOUT_MS`). Judging it
   * earlier reads a load that is dying as a page that is arriving, and the
   * recovery then does nothing; loading over a page that really is arriving is
   * the other half of the same mistake, a second navigation racing the first.
   *
   * Once the page has settled, `restoreNeedsFallbackLoad` decides: a page that is
   * still loading or that is already on the tab's address is left alone, and
   * anything else gets that address, which is the whole of what is left to try.
   */
  async recoverFromFailedRestore(
    tabId: string,
    contents: WebContents,
    fallbackUrl: string,
    error: unknown
  ): Promise<void> {
    if (contents.isDestroyed()) return
    await this.host.loadWaits.wait(contents, RESTORE_SETTLE_TIMEOUT_MS)
    if (contents.isDestroyed()) return
    const page = { loading: contents.isLoading(), url: contents.getURL() }
    if (!restoreNeedsFallbackLoad(page, fallbackUrl)) {
      Logger.dev('Browser tab history restore left the page where the stack put it:', {
        tabId,
        error,
        page
      })
      return
    }
    Logger.dev('Browser tab history could not be restored:', { tabId, error, page })
    if (fallbackUrl) this.host.load(tabId, fallbackUrl)
  }

  /**
   * Write every open tab's stack, and wait for the file.
   *
   * The commit point for quitting, and the one place the write is awaited rather
   * than coalesced: the views are closed right after it, so a write that had only
   * been started would lose exactly what it was meant to save.
   */
  async flushTabHistory(): Promise<void> {
    for (const [tabId, tab] of this.host.tabs) this.captureTabHistory(tabId, tab)
    await this.host.tabHistory.flush()
  }
}
