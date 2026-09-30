import {
  type BrowserStripOverlayChrome,
  type BrowserStripOverlayTab,
  type BrowserStripStoreOffer
} from '$shared/browser-overlay'
import { globalBrowser } from './stores/global-browser.svelte'
import { browserTabLabel } from './stores/global-browser-types'
import { browserBookmarks } from './stores/browser-bookmarks.svelte'
import {
  storeExtensionOffer,
  storeOfferInstallVerb,
  type StoreExtensionOffer
} from './stores/browser-extension-store-offer'
import { browserTabAccent, browserTabIconUrl } from './components/browser/browser-tab-appearance'

/**
 * The floating tab strip and its address row, projected for the overlay.
 *
 * Kept apart from `browser-overlay-bridge`, which the toast stack imports on the
 * first paint: these projections read the browser store, and the browser store
 * pulls the tab strip's model, its persistence and its popup windows with it, so
 * importing them from the toaster's module pinned the whole browser into the
 * entry chunk. Only the docked strip reads them, and the docked strip is part of
 * the browser's lazy view.
 */

/**
 * The floating tab strip, projected for the overlay.
 *
 * One flat list, pinned tabs first and the rest in the store's own order. The
 * floating panel exists to switch tabs, so a row carries what a user picks a tab
 * by   its icon, its name and the page's live state   and nothing the docked
 * panel's own tools need: no group headers, no search, no notes, no per-tab
 * menus. Those live in the docked strip, which is where they stay available.
 *
 * `icon` prefers the tab's own custom icon over the page's favicon, exactly as
 * the docked row does, so a tab the user dressed looks the same in both.
 */
export function projectStripTabs(): BrowserStripOverlayTab[] {
  const ordered = [...globalBrowser.pinnedTabs, ...globalBrowser.tabs.filter((tab) => !tab.pinned)]
  return ordered.map((tab) => {
    const runtime = globalBrowser.runtimeFor(tab.id)
    return {
      id: tab.id,
      label: browserTabLabel(tab),
      url: tab.url,
      icon: browserTabIconUrl(tab, globalBrowser.tabIconUrl(tab.id)) ?? tab.favicon,
      accent: browserTabAccent(tab),
      active: globalBrowser.activeTabId === tab.id,
      loading: runtime.loading,
      pinned: tab.pinned,
      hibernated: tab.hibernated,
      audible: runtime.audible,
      muted: runtime.muted
    }
  })
}

/**
 * The address row above the strip, projected for the overlay.
 *
 * The docked panel reads the same store values, so the row the overlay draws and
 * the row the app window draws say the same thing down to the bookmark star. The
 * page on screen is the active tab, which is the tab the strip's rows mark too.
 */
export function projectStripChrome(): BrowserStripOverlayChrome {
  const tab = globalBrowser.activeTab
  const address = tab?.url ?? ''
  const runtime = tab ? globalBrowser.runtimeFor(tab.id) : null
  const offer = storeExtensionOffer()
  return {
    url: address,
    secure: address.startsWith('https:'),
    loading: runtime?.loading ?? false,
    canGoBack: runtime?.canGoBack ?? false,
    canGoForward: runtime?.canGoForward ?? false,
    bookmarked: address !== '' && browserBookmarks.isBookmarked(address),
    storeOffer: offer ? storeOfferChrome(offer) : null
  }
}

/**
 * The store page's chip, as the overlay draws it.
 *
 * It answers for this one offer, never for the browser: installs queue, so another
 * extension downloading behind this page leaves the chip a door rather than a
 * spinner.
 */
function storeOfferChrome(offer: StoreExtensionOffer): BrowserStripStoreOffer {
  if (offer.installed) {
    return {
      title: `${offer.name ?? 'This extension'} is installed. Open the extensions panel.`,
      installed: true,
      installing: false
    }
  }
  const verb = storeOfferInstallVerb(offer)
  return {
    title: verb
      ? `${verb} ${offer.name ?? 'the extension'}`
      : `Install ${offer.name ?? 'this extension'} in ${offer.boxName}`,
    installed: false,
    installing: offer.install !== null
  }
}
