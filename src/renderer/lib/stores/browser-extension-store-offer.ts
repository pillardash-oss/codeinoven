import type { BrowserExtension } from '$shared/ipc-contract'
import {
  webstoreExtensionIdFromUrl,
  webstoreExtensionNameFromTitle
} from '$shared/browser/browser-webstore'
import { browserExtensions, type BrowserExtensionInstall } from './browser-extensions.svelte'
import { globalBrowser } from './global-browser.svelte'
import { DEFAULT_BOX_NAME, extensionJarForBox } from './global-browser-types'

/**
 * The extension the page on screen is, when that page is its Chrome Web Store
 * page.
 *
 * This exists because the store cannot install anything here: its "Add to
 * Chrome" button is Chrome's inline-install API, which Electron does not
 * implement, so the page's own button is dead and the app has to offer the
 * install itself. Three surfaces have to agree on when that offer exists   the
 * address bar's chip, the rail's extensions tool and the panel's install row  
 * so they read it from here instead of deriving it three times.
 *
 * The offer is a reading, not a subscription: it answers from the browser and
 * extensions stores, and a caller that reads it inside a `$derived` is what
 * makes it track the page, the title and the installed list.
 */
export interface StoreExtensionOffer {
  /** The extension's Web Store id. */
  id: string
  /** What the store page calls it, or null when its title names nothing. */
  name: string | null
  /** The installed record, when this extension is already installed. An
   *  installed extension is never offered again, which is what keeps the rail's
   *  indicator meaning "there is something to install here". */
  installed: BrowserExtension | null
  /** The box the page runs in, which is where the install would land: browsing
   *  the store inside a box is how the user says which box should have it. */
  boxName: string
  /**
   * This extension's own install, queued or running, or null when none is.
   *
   * Per extension rather than one flag for the browser: installs queue now, so
   * the page's chip and the panel's offer row both have to say whether this
   * particular offer has been taken, and a second install of something else must
   * not read as this one being under way.
   */
  install: BrowserExtensionInstall | null
}

/**
 * What this offer's install is doing, in two words, or null when nothing is in
 * flight for it.
 *
 * One wording for the page's chip and the panel's own row, so a queued install
 * cannot read as a running one in one place and not in the other. The queue is
 * real: main runs two installs at a time, so a third waits its turn.
 */
export function storeOfferInstallVerb(offer: StoreExtensionOffer): string | null {
  if (!offer.install) return null
  return offer.install.phase === 'queued' ? 'Waiting to install' : 'Installing'
}

/** The offer the page on screen makes, or null when it makes none. */
export function storeExtensionOffer(): StoreExtensionOffer | null {
  const tab = globalBrowser.activeTab
  if (!tab || tab.url === '') return null
  const id = webstoreExtensionIdFromUrl(tab.url)
  if (id === null) return null
  return {
    id,
    name: webstoreExtensionNameFromTitle(tab.title),
    installed:
      browserExtensions.extensions.find((extension) => extension.webstoreId === id) ?? null,
    boxName: globalBrowser.boxById(globalBrowser.activeTabBoxId)?.name ?? DEFAULT_BOX_NAME,
    install: browserExtensions.installForWebstoreId(id)
  }
}

/**
 * Install the extension the page on screen offers, into the box that page runs
 * in. The rail is revealed first, because an install started from the page has
 * no dialog of its own and the rail is where its progress and its result show.
 *
 * Nothing here waits for another install: it queues behind whatever is running and
 * the page's offer row says so. The store page's name is handed over, because this
 * is the one moment anything knows what the extension is called.
 */
export async function installStoreExtensionOffer(): Promise<void> {
  const offer = storeExtensionOffer()
  if (!offer || offer.installed || offer.install) return
  globalBrowser.showExtensionsSidebar()
  await browserExtensions.install(
    {
      source: 'webstore',
      value: offer.id,
      boxes: [extensionJarForBox(globalBrowser.activeTabBoxId)]
    },
    offer.name
  )
}
