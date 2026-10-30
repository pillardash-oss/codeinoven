import type { BrowserPageState } from '$shared/ipc-contract'
import { isStorableBrowserFavicon } from '$shared/browser/global-browser-tabs'
import { browserAudio } from '../browser-audio.svelte'
import { browserTabLoadingTitle, isSameBrowserLoadError } from '../global-browser-types'
import type { GlobalBrowserState } from '../global-browser.svelte'

/** GlobalBrowserState storage: one concern, moved verbatim from the composition root. */
export class GlobalBrowserStateStorage {
  constructor(private readonly host: GlobalBrowserState) {}

  /** Apply a live page snapshot: the navigation identity onto the tab, and the
   *  loading/audio/capture state onto the map the strip and header read. */
  applyPageState(state: BrowserPageState): void {
    const tab = this.host.tabById(state.tabId)
    if (!tab) return
    let changed = false
    // A document with no committed address yet (a fresh tab, an about:blank
    // popup) reports an empty URL and must not erase the address on screen.
    if (state.url && tab.url !== state.url) {
      const loadingTitle = browserTabLoadingTitle(tab, state.url)
      tab.url = state.url
      if (loadingTitle !== null) tab.title = loadingTitle
      // The icon is the icon of an address, so a tab that moved is not the tab
      // the stored icon was read from: it goes with the address it came from, and
      // the row picks up the new one from the page or from the address itself
      // (see `ensureFavicon`).
      if (tab.favicon !== null) {
        tab.favicon = null
        this.host.tabFavicons.forget(tab.id)
      }
      changed = true
    }
    const title = state.title.trim()
    if (title && tab.title !== title) {
      tab.title = title
      changed = true
    }
    // An icon the document reported is adopted. A report of none is deliberately
    // not an erasure: Chromium announces an icon only when it differs from the one
    // the tab already holds, so a reopened hibernated tab (whose page has no
    // remembered icon yet) would blank its own row on the way back, and a page
    // that reloads at the same address would lose the mark it just had. Only the
    // address changing replaces the icon, above.
    if (isStorableBrowserFavicon(state.favicon) && tab.favicon !== state.favicon) {
      tab.favicon = state.favicon
      changed = true
    }
    // Loading a page is a use of the tab, which is what keeps a tab the user is
    // actively navigating from being hibernated mid-load.
    if (state.loading) tab.lastUsedAt = Date.now()
    // A peek's gate reads the document, not just the load flag: see
    // `peekDocumentSeen` for why one is not enough without the other.
    const peek = [...this.host.peeks.values()].find((entry) => entry.tab.id === state.tabId)
    if (peek && (state.loading || state.url !== '')) peek.documentSeen = true
    if (changed && !peek) this.host.units['queries'].persist()
    browserAudio.reportGlobalTab(state.tabId, state.audible && !state.muted)
    browserAudio.reportCapture(state.tabId, null, null, state.capturing, state)
    const current = this.host.runtime.get(state.tabId)
    if (
      current &&
      current.audible === state.audible &&
      current.muted === state.muted &&
      current.microphoneActive === state.microphoneActive &&
      current.cameraActive === state.cameraActive &&
      current.screenActive === state.screenActive &&
      current.capturing === state.capturing &&
      current.loading === state.loading &&
      isSameBrowserLoadError(current.loadError, state.loadError) &&
      current.canGoBack === state.canGoBack &&
      current.canGoForward === state.canGoForward
    ) {
      return
    }
    this.host.runtime.set(state.tabId, {
      audible: state.audible,
      muted: state.muted,
      capturing: state.capturing,
      microphoneActive: state.microphoneActive,
      cameraActive: state.cameraActive,
      screenActive: state.screenActive,
      loading: state.loading,
      loadError: state.loadError,
      canGoBack: state.canGoBack,
      canGoForward: state.canGoForward
    })
  }
}
