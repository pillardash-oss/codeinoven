import type { BrowserFindRequest, BrowserFindStopAction } from '../../../lib/ipc-contract'
import { sendToRenderer } from '../../ipc/renderer-delivery'
import { browserFindResultFor } from './browser-find'
import { liveContents, liveWindowContents } from './browser-view-contents'
import type { BrowserService } from '../browser-service'

/**
 * Find in a page, as the browser tab's own surface drives it.
 *
 * The session rules live in `browser-find.ts`; this is the tab half: which page is
 * asked, how a stop action ends the session, and the result the find bar is told.
 */

/**
 * What `browser-service-find-bar` reads off the browser service.
 *
 * Each member is the service's own declaration, so this unit and the composition
 * root cannot drift apart: a changed signature is a compile error here.
 */
export interface FindBarHost {
  readonly findSessions: BrowserService['findSessions']
  readonly tabs: BrowserService['tabs']
  readonly window: BrowserService['window']
}

export class BrowserServiceFindBar {
  constructor(private readonly host: FindBarHost) {}

  /**
   * Search a tab's page, or end its search.
   *
   * The search itself is Chromium's: the page is a native view, so its text is
   * only reachable through `findInPage`, and the engine that owns the document is
   * the one that highlights the matches and scrolls to the active one. An empty
   * text is not a search of nothing   it is the field being cleared, which means
   * the highlight on the page goes away, so it ends the session instead of asking
   * Chromium for a match on "".
   *
   * The request id is recorded before the call resolves so that the report of a
   * superseded query can never be taken for the current one; the report arrives
   * on the page's own `found-in-page` event, which is wired when the tab is
   * created.
   */
  findInPage(tabId: string, request: BrowserFindRequest): void {
    const tab = this.host.tabs.get(tabId)
    const contents = tab ? liveContents(tab.view) : undefined
    if (!contents) return
    if (request.text.length === 0) {
      this.stopFindInPage(tabId, 'clearSelection')
      return
    }
    const requestId = contents.findInPage(request.text, {
      forward: request.forward,
      findNext: request.findNext,
      matchCase: request.matchCase
    })
    this.host.findSessions.begin(tabId, requestId, request.text)
  }

  /** End a tab's find session, which is what closing the bar does. */
  stopFindInPage(tabId: string, action: BrowserFindStopAction): void {
    const tab = this.host.tabs.get(tabId)
    this.host.findSessions.take(tabId)
    const contents = tab ? liveContents(tab.view) : undefined
    if (!contents) return
    contents.stopFindInPage(action)
  }

  /**
   * Forward one report from a page's own find to the bar that draws it.
   *
   * A report for a request that has been superseded, for a tab with no session at
   * all (the bar was closed, or the page navigated), or one that repeats what the
   * bar was already told is dropped: the bar is only ever told about the search it
   * is currently showing, and only when there is something new to show.
   */
  publishFindResult(
    tabId: string,
    requestId: number,
    report: { matches: number; activeMatchOrdinal: number }
  ): void {
    const session = this.host.findSessions.acceptReport(tabId, requestId, report)
    if (!session) return
    if (this.host.window.isDestroyed()) return
    sendToRenderer(
      liveWindowContents(this.host.window),
      'browser:findResult',
      browserFindResultFor(tabId, session.text, report)
    )
  }
}
