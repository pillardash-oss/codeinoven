import type { BrowserExtension } from '$shared/ipc-contract'
import { GLOBAL_BROWSER_PROJECT_ID } from '$shared/types/project'
import {
  webstoreExtensionIdFromUrl,
  webstoreExtensionNameFromTitle
} from '$shared/browser/browser-webstore'
import { extensionJarIdFor } from '$shared/browser/browser-extension-jar'
import { browserExtensions, type BrowserExtensionInstall } from './browser-extensions.svelte'
import { globalBrowser } from './global-browser.svelte'
import { DEFAULT_BOX_NAME } from './global-browser-types'

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
   *  the store inside a box is how the user says which box should have it. A box
   *  is the profile's one jar for that box, so the install is loaded while any
   *  context uses it. */
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
  if (!tab) return null
  return storeExtensionOfferForPage({
    projectId: GLOBAL_BROWSER_PROJECT_ID,
    url: tab.url,
    title: tab.title,
    boxId: tab.boxId
  })
}

/** The page a surface is showing, reduced to what an offer is read from. */
export interface StoreExtensionOfferPage {
  /** The project (or space) the page's browser belongs to. */
  projectId: string
  url: string
  title: string
  /** The box the page runs in, or null for a scope's own jar. */
  boxId: string | null
}

/**
 * The same offer, for a page any browser surface is showing.
 *
 * The thread browser draws the same extension chrome the global one does, and its
 * pages make the same offer, so the reading is shared: only the page it is read
 * from differs, and the jar the install would land in follows from that page.
 *
 * "Already installed" is answered for that jar and not for the profile: an
 * extension installed beside one project's conversation is that project's, so a
 * store page in another project has one to install, exactly as it would in a box
 * that does not run it yet.
 */
export function storeExtensionOfferForPage(
  page: StoreExtensionOfferPage | null
): StoreExtensionOffer | null {
  if (!page || page.url === '') return null
  const id = webstoreExtensionIdFromUrl(page.url)
  if (id === null) return null
  const jarId = extensionJarIdFor(page.projectId, page.boxId)
  const box = page.boxId === null ? null : globalBrowser.boxById(page.boxId)
  return {
    id,
    name: webstoreExtensionNameFromTitle(page.title),
    installed:
      browserExtensions.extensions.find(
        (extension) => extension.webstoreId === id && extension.boxes.includes(jarId)
      ) ?? null,
    boxName: box?.name ?? DEFAULT_BOX_NAME,
    install: browserExtensions.installForWebstoreId(id)
  }
}

/**
 * Install one offer into one page's jar.
 *
 * The caller names the context and the box, because the surface that offers the
 * install knows which page made the offer and this module does not: the same offer
 * made from a project's thread browser belongs to that project, and one made from
 * the global browser belongs to the profile. Nothing here waits for another
 * install: it queues behind whatever is running, and every surface that shows the
 * offer says so.
 */
export async function installStoreExtensionInBox(
  offer: StoreExtensionOffer,
  projectId: string,
  boxId: string | null
): Promise<void> {
  if (offer.installed || offer.install) return
  await browserExtensions.install(
    {
      source: 'webstore',
      value: offer.id,
      boxes: [extensionJarIdFor(projectId, boxId)]
    },
    offer.name
  )
}

/**
 * Install the extension the page on screen offers, into the box that page runs
 * in. The box is the profile's one jar for that box rather than a per-context
 * jar, so the install lands there for every context that picks it. The rail is
 * revealed first, because an install started from the page has no dialog of its
 * own and the rail is where its progress and its result show.
 *
 * Nothing here waits for another install: it queues behind whatever is running and
 * the page's offer row says so. The store page's name is handed over, because this
 * is the one moment anything knows what the extension is called.
 */
export async function installStoreExtensionOffer(): Promise<void> {
  const offer = storeExtensionOffer()
  if (!offer || offer.installed || offer.install) return
  globalBrowser.showExtensionsSidebar()
  await installStoreExtensionInBox(offer, GLOBAL_BROWSER_PROJECT_ID, globalBrowser.activeTabBoxId)
}
