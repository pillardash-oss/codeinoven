import { waitBrowserSessionCookies } from './browser-session-cookies'
import { type WebContents } from 'electron'
import type { BrowserLoadError } from '../../../lib/ipc-contract'
import { Logger } from '../../system/logger'
import { isAbortedNavigation, rejectedLoadIsNotAFailure } from './browser-navigation-outcome'
import { validateBrowserUrl } from './browser-validation'
import { liveContents } from './browser-view-contents'
import type { BrowserService } from '../browser-service'

/**
 * Taking a tab's page somewhere, and reading what happened when it got there.
 *
 * One unit decides whether an address may be loaded at all, starts the load, and turns
 * the outcome into the error the panel shows. A navigation the app itself refuses is
 * refused here, once, instead of at every caller.
 */

/**
 * What `browser-service-navigation` reads off the browser service.
 *
 * Each member is the service's own declaration, so this unit and the composition
 * root cannot drift apart: a changed signature is a compile error here.
 */
export interface NavigationHost {
  readonly activeTabId: BrowserService['activeTabId']
  readonly extensions: BrowserService['extensions']
  readonly isViewSourceDocument: BrowserService['isViewSourceDocument']
  readonly pendingNavigationStarts: BrowserService['pendingNavigationStarts']
  readonly publishState: BrowserService['publishState']
  readonly rememberPlayhead: BrowserService['rememberPlayhead']
  readonly requireTab: BrowserService['requireTab']
  readonly tabs: BrowserService['tabs']
}

export class BrowserServiceNavigation {
  constructor(private readonly host: NavigationHost) {}

  /** The active tab of one project's browser, or null when it has none. */
  activeTabIdInProject(projectId: string): string | null {
    const tabId = this.host.activeTabId
    if (!tabId) return null
    const tab = this.host.tabs.get(tabId)
    return tab && tab.projectId === projectId ? tabId : null
  }

  load(tabId: string, url: string): void {
    const tab = this.host.requireTab(tabId)
    // Where a composition was is read before the document is replaced, so a capture
    // round trip does not send the user back to the first frame, and the ordering
    // cannot depend on which IPC the renderer happens to handle first.
    if (tab.composition && liveContents(tab.view)) {
      const navigationStart = this.host.rememberPlayhead(tabId, tab).then(
        () => this.navigateTo(tabId, url),
        () => this.navigateTo(tabId, url)
      )
      this.host.pendingNavigationStarts.set(tabId, navigationStart)
      void navigationStart.then(
        () => {
          if (this.host.pendingNavigationStarts.get(tabId) === navigationStart) {
            this.host.pendingNavigationStarts.delete(tabId)
          }
        },
        () => {
          if (this.host.pendingNavigationStarts.get(tabId) === navigationStart) {
            this.host.pendingNavigationStarts.delete(tabId)
          }
        }
      )
      return
    }
    this.navigateTo(tabId, url)
  }

  /** Start one navigation, reporting a failure rather than rejecting. */
  navigateTo(tabId: string, url: string): Promise<void> {
    const tab = this.host.tabs.get(tabId)
    if (!tab) return Promise.resolve()
    const contents = liveContents(tab.view)
    if (!contents) return Promise.resolve()
    const navigationStart = this.host.extensions
      .ensureJarLoaded(tab.projectId, tab.boxId)
      .catch((error: unknown) => {
        // An extension load failure must not prevent the page itself from opening.
        Logger.dev('Browser extensions could not be prepared before navigation:', {
          tabId,
          error
        })
      })
      .then(() => waitBrowserSessionCookies(contents.session))
      .then(() => {
        if (this.host.tabs.get(tabId) !== tab || contents.isDestroyed()) return
        return contents.loadURL(url).catch((error: unknown) => {
          // Reloads and folder switches cancel the earlier loadURL promise.
          // Its rejection belongs to the replaced navigation, not the page
          // now loading, and must never cover that page with an error card.
          if (
            isAbortedNavigation(error) ||
            this.host.tabs.get(tabId) !== tab ||
            contents.isDestroyed()
          )
            return
          // A media document commits and plays without ever reporting a finished
          // load, so Electron rejects `loadURL` with `ERR_FAILED` over a page that
          // is already on screen. The rejection is read against what the tab
          // recorded before it is allowed to become an error card.
          if (
            rejectedLoadIsNotAFailure({
              reportedFailure: this.host.tabs.get(tabId)?.navigationFailure ?? null,
              loading: !contents.isDestroyed() && contents.isLoading(),
              url: contents.isDestroyed() ? '' : contents.getURL()
            })
          ) {
            return
          }
          Logger.dev('Browser navigation did not complete:', { tabId, url, error })
          const reason = error instanceof Error && error.message ? error.message : String(error)
          this.setTabLoadError(tabId, {
            kind: 'network',
            code: 0,
            description: reason || 'The page could not be opened'
          })
          this.host.publishState(tabId)
        })
      })
      .finally(() => {
        if (this.host.pendingNavigationStarts.get(tabId) === navigationStart) {
          this.host.pendingNavigationStarts.delete(tabId)
        }
      })
    this.host.pendingNavigationStarts.set(tabId, navigationStart)
    return navigationStart
  }

  /**
   * Whether a tab may navigate to an address. HTTP and HTTPS always may. A
   * `chrome-extension://` address may only when it names an enabled extension
   * that runs in that tab's own jar, so one box can never open another jar's
   * extension files.
   */
  isAllowedTabNavigation(projectId: string, boxId: string | null, url: string): boolean {
    try {
      validateBrowserUrl(url)
      return true
    } catch {
      // Not http(s). Only an installed extension page in this jar passes.
    }
    try {
      return this.host.extensions.isExtensionPageAllowed(url, projectId, boxId)
    } catch {
      return false
    }
  }

  /**
   * Validate an address a tab is about to load. Accepts http(s) plus an
   * extension page allowed in that jar. Throws when neither passes, so callers
   * keep the same refusal shape as before.
   */
  validateTabNavigationUrl(projectId: string, boxId: string | null, value: unknown): string {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError('Browser URL must be a string of at most 8192 characters')
    }
    const candidate = value
    try {
      return validateBrowserUrl(candidate)
    } catch {
      // Fall through to the extension-page check below.
    }
    if (this.host.extensions.isExtensionPageAllowed(candidate, projectId, boxId)) return candidate
    throw new TypeError('Browser URL must use http or https')
  }

  /**
   * Settle the error state of the tab once a navigation has finished.
   *
   * A network failure and a crash are already final; an HTTP error status is
   * only this app's error to show when the page it served has nothing visible in
   * it, so that one case is read from the page before it is published. Identity is
   * re-checked after the read, because the user can navigate again while it is in
   * flight.
   */
  resolveLoadOutcome(tabId: string): void {
    const tab = this.host.tabs.get(tabId)
    if (!tab) return
    const failure = tab.navigationFailure
    if (!failure || failure.kind !== 'http') {
      this.setTabLoadError(tabId, failure)
      return
    }
    void this.documentHasNothingToShow(tab.view.webContents).then((nothingVisible) => {
      const current = this.host.tabs.get(tabId)
      if (!current || current.navigationFailure !== failure) return
      this.setTabLoadError(tabId, nothingVisible ? failure : null)
    })
  }

  /** Publish a tab's load error only when it actually changed. */
  setTabLoadError(tabId: string, error: BrowserLoadError | null): void {
    const tab = this.host.tabs.get(tabId)
    if (!tab) return
    const previous = tab.loadError
    if (previous === error) return
    if (
      previous !== null &&
      error !== null &&
      previous.kind === error.kind &&
      previous.code === error.code &&
      previous.description === error.description
    ) {
      return
    }
    tab.loadError = error
    this.host.publishState(tabId)
  }

  /**
   * Whether the loaded document shows the user anything at all.
   *
   * The catch-all rule for an HTTP error status: the app stands in only when the
   * server's own answer has nothing to look at, and never covers a page that did
   * render. Empty is judged by what is on screen, not by markup: an error body
   * with a container but no text, image, control or drawn media is still a blank
   * frame to the user, while any visible text or rendered element is the site's
   * own page and is left alone.
   *
   * Read in the page's own world: the main process cannot see page markup, and
   * `innerText` already excludes hidden text. Any failure to answer is read as
   * "has content", so a real page is never masked by a probe that could not run.
   */
  async documentHasNothingToShow(contents: WebContents): Promise<boolean> {
    // A `view-source:` document never runs scripts, so the probe could not
    // settle on it; it is treated as having content, which it plainly does.
    if (this.host.isViewSourceDocument(contents)) return false
    try {
      const result: unknown = await contents.executeJavaScript(
        '(function () {' +
          ' var body = document.body; if (!body) return true;' +
          ' if ((body.innerText || "").trim().length > 0) return false;' +
          ' var nodes = body.querySelectorAll("img, svg, canvas, video, audio, iframe, embed, object, input, button, select, textarea, [style*=background], [style*=Background]");' +
          ' for (var i = 0; i < nodes.length; i++) {' +
          '  var rect = nodes[i].getBoundingClientRect();' +
          '  if (rect.width > 1 && rect.height > 1) return false;' +
          ' }' +
          ' return true;' +
          '})()'
      )
      return result === true
    } catch {
      return false
    }
  }
}
