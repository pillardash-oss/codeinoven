/**
 * Find in a browser page.
 *
 * A tab's page is a native `WebContentsView`, so nothing in this app can read
 * its text: the search is Chromium's own `webContents.findInPage`, and the
 * matches are highlighted by the engine that owns the document. What main adds
 * is the boundary   the request is validated here, the result the page reports is
 * shaped for the find bar, and the two never touch a page's own DOM or data.
 *
 * The session rule lives here too, because it is a rule about the engine rather
 * than about a tab: `findInPage` hands back a request id and every
 * `found-in-page` event carries it, so the events of a request the user has
 * already moved past are recognisable and dropped. Without that, a fast typist
 * sees the count of a query they finished typing two characters ago.
 */

import type {
  BrowserFindRequest,
  BrowserFindResult,
  BrowserFindStopAction
} from '../../../lib/ipc/browser'

/** The longest text a find request may carry, in UTF-16 code units. */
const MAX_FIND_TEXT_LENGTH = 512

const FIND_STOP_ACTIONS: ReadonlySet<string> = new Set<BrowserFindStopAction>([
  'clearSelection',
  'keepSelection',
  'activateSelection'
])

/** One tab's live find session, plus what the bar has already been told. */
interface BrowserFindSession {
  requestId: number
  text: string
  reportedMatches: number
  reportedOrdinal: number
}

/**
 * Validate one find request from the renderer.
 *
 * The text goes straight into Chromium's find, which searches the page's own
 * document, so it is bounded rather than trusted: a find bar is a field a person
 * types in, and a megabyte of "text" is not one. The flags are coerced to
 * booleans because they only select behaviour, never a target.
 */
export function validateBrowserFindRequest(value: unknown): BrowserFindRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Browser find request must be an object')
  }
  const request = value as Record<string, unknown>
  const text = request['text']
  if (typeof text !== 'string') {
    throw new TypeError('Browser find request needs text')
  }
  if (text.length > MAX_FIND_TEXT_LENGTH) {
    throw new TypeError('Browser find text exceeds the cap')
  }
  return {
    text,
    forward: request['forward'] === true,
    findNext: request['findNext'] === true,
    matchCase: request['matchCase'] === true
  }
}

/** Validate how a find session ends. */
export function validateBrowserFindStopAction(value: unknown): BrowserFindStopAction {
  if (typeof value !== 'string' || !FIND_STOP_ACTIONS.has(value)) {
    throw new TypeError('Browser find stop action is unknown')
  }
  return value as BrowserFindStopAction
}

/**
 * Track which find request each page is answering, and what the bar was told.
 *
 * One entry per tab, replaced by every new request: the newest id is the only
 * one the bar is waiting for, so a report from an older one is dropped instead of
 * briefly overwriting the count on screen. The text travels with the id because
 * it is the same fact   which search this report belongs to   and the bar compares
 * it against its own field, which is what stops a report arriving for a query the
 * user has already cleared.
 *
 * The last report forwarded is kept too, because a scan narrates its own
 * progress: Chromium reports every step of one search, and two reports that carry
 * the same count and ordinal are the same thing said twice. Dropping the repeats
 * keeps a large page's scan from becoming a burst of renderer updates for a count
 * that never moved.
 */
export class BrowserFindSessions {
  private readonly sessions = new Map<string, BrowserFindSession>()

  /** Record the request a page has just been asked to answer. */
  begin(tabId: string, requestId: number, text: string): void {
    this.sessions.set(tabId, { requestId, text, reportedMatches: -1, reportedOrdinal: -1 })
  }

  /**
   * Take one report from a page, answering the text it belongs to when the bar
   * should be told about it, or null when it is superseded or says nothing new.
   */
  acceptReport(
    tabId: string,
    requestId: number,
    report: { matches: number; activeMatchOrdinal: number }
  ): { text: string } | null {
    const session = this.sessions.get(tabId)
    if (!session || session.requestId !== requestId) return null
    if (
      session.reportedMatches === report.matches &&
      session.reportedOrdinal === report.activeMatchOrdinal
    ) {
      return null
    }
    session.reportedMatches = report.matches
    session.reportedOrdinal = report.activeMatchOrdinal
    return { text: session.text }
  }

  /**
   * Remove a tab's session and hand it back.
   *
   * The caller keeps the text because the session ending is not always silent: a
   * navigation ends one, and the bar still has to be told that the page it was
   * searching has no matches left. A session that was already gone returns null,
   * which is what a page with no search in flight reports.
   */
  take(tabId: string): { text: string } | null {
    const session = this.sessions.get(tabId)
    if (!session) return null
    this.sessions.delete(tabId)
    return { text: session.text }
  }
}

/**
 * Shape one `found-in-page` report for the find bar.
 *
 * Chromium reports the ordinal of the match it is on as 1-based and counts every
 * match on the page, so a page with nothing to show reads `0/0` without this app
 * inventing a zero. `finalUpdate` is deliberately not carried: an intermediate
 * count is still the true count of the matches found so far, and a bar that
 * waited for the scan to settle would sit empty while the user typed.
 */
export function browserFindResultFor(
  tabId: string,
  text: string,
  report: { matches: number; activeMatchOrdinal: number }
): BrowserFindResult {
  return {
    tabId,
    text,
    matches: Math.max(0, report.matches),
    activeMatchOrdinal: Math.max(0, report.activeMatchOrdinal)
  }
}
