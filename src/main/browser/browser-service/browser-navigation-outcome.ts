/**
 * How the browser reads the outcome of a navigation, and where a tab that could
 * not restore its history should be put.
 *
 * Chromium reports a navigation that was superseded (a redirect handing off, a
 * load something else replaced) through the failure channel, and the browser has
 * to tell that apart from a page that really failed in one place only: a tab's
 * error card. A superseded navigation is never a page of its own, or every
 * checkout flow would end on a card saying the page failed.
 *
 * The recovery after a tab's stored history fails to come back is a different
 * question with a different answer: not "what failed" but "where is the page".
 * Two facts make that the honest test, both measured on Electron 44:
 *
 *   - A `restore()` rejection arrives while the page is still settling. The
 *     report's own case is a fine example: an entry Chromium refuses outright
 *     (`ERR_UNSAFE_PORT`) rejects the restore, and the page still reports itself
 *     as loading while the failure is being committed. Judging the page at that
 *     instant reads a dying load as "a page arriving", and the recovery then does
 *     nothing at all.
 *   - A page that is genuinely arriving must not be loaded on top of. Two
 *     navigations issued into one view are one navigation racing another, and the
 *     reported log carries the shape of that race in a single millisecond: an
 *     aborted restore and the failed load of the address the tab was on.
 *
 * So a rejected restore gives the page its moment to settle (bounded, since a page
 * that never settles must not hold the recovery forever) and then asks where it
 * ended up: loading, on the tab's own address, or nowhere. Only the last two are
 * reasons to leave it alone.
 *
 * Pure, so the rules can be read and checked without a browser: nothing here
 * touches Electron.
 */

/** Chromium's `net::ERR_ABORTED`, reported for a navigation that was superseded. */
export const ABORTED_NAVIGATION_ERROR_CODE = -3

/**
 * How long a rejected restore gives the page to settle before the recovery judges it.
 *
 * Long enough for a failed load to commit the document it ends on, short enough
 * that a page which never settles does not delay putting the tab back on its own
 * address by more than a moment.
 */
export const RESTORE_SETTLE_TIMEOUT_MS = 3_000

/**
 * Whether a reported load failure is a navigation that was superseded.
 *
 * One fact in the two shapes the browser sees it in: `did-fail-load` reports a
 * numeric code, while a rejected `navigationHistory.restore()` rejects with an
 * `Error` carrying Chromium's `code` and `errno` next to the address.
 */
export function isAbortedNavigation(failure: unknown): boolean {
  if (typeof failure === 'number') return failure === ABORTED_NAVIGATION_ERROR_CODE
  if (typeof failure !== 'object' || failure === null) return false
  const record = failure as { code?: unknown; errno?: unknown }
  if (record.code === 'ERR_ABORTED') return true
  return record.errno === ABORTED_NAVIGATION_ERROR_CODE
}

/** What a page is doing, as much of it as the recovery needs to know. */
export interface SettledPage {
  /** Whether a navigation is in flight, read after the page was given its moment. */
  loading: boolean
  /** The address the page is on, or an empty string when it committed nothing. */
  url: string
}

/**
 * Whether a rejected history restore should be answered by loading the tab's
 * single stored address.
 *
 * No while a page is still arriving: the recovery must not race a navigation it
 * did not start. No when the page is already on the address the tab was on, since
 * the stack put it there and a reload would only cost the page its state. Yes in
 * every other case, blank page included: a stack whose pages no longer load is not
 * a reason to leave the tab with nothing or with somebody else's document.
 */
export function restoreNeedsFallbackLoad(page: SettledPage, fallbackUrl: string): boolean {
  if (page.loading) return false
  if (!hasCommittedDocument(page.url)) return true
  return page.url !== fallbackUrl
}

/**
 * What the browser recorded about the navigation a rejected `loadURL` belonged to.
 */
export interface RejectedLoadReport {
  /** The failure the page itself reported for this navigation, or null when it reported none. */
  reportedFailure: { kind: string } | null
  /** Whether the page is still loading when the rejection is read. */
  loading: boolean
  /** The address the page has committed to, or an empty string when it committed nothing. */
  url: string
}

/**
 * Whether a rejected `loadURL` is a navigation that did not fail at all.
 *
 * Electron settles `loadURL` on a load that finished or one that failed, and a
 * top-level navigation to a media file satisfies neither in the shape the promise
 * expects: the media document commits (and starts playing), but Chromium reports
 * no load-finished event for it, so the promise rejects with `ERR_FAILED` over a
 * page that is already on screen. The rejection cannot be read on its own, so it
 * is read against what the browser itself recorded: a page that reported no
 * failure, has stopped loading and committed a document is a page that arrived,
 * and the error card must not cover it. Every other rejection stands.
 */
export function rejectedLoadIsNotAFailure(report: RejectedLoadReport): boolean {
  if (report.reportedFailure !== null) return false
  if (report.loading) return false
  return hasCommittedDocument(report.url)
}

/** Whether an address is a document the page actually committed. An empty address
 *  is a view that committed nothing, and `about:blank` is the placeholder every
 *  `WebContentsView` starts on: neither is a page to leave a user looking at. */
function hasCommittedDocument(url: string): boolean {
  return url !== '' && url !== 'about:blank'
}
