/// <reference types="vite/client" />

/**
 * The tab an extension's own page is acting on, and the script that tells it.
 *
 * An extension's action popup is hosted by the app in a rail popup, which makes it a
 * `WebContents` among the pages, and the runtime's own `chrome.tabs.query` answers
 * "the tab that holds the keyboard" for the active one. The popup holds the keyboard
 * by design, so an extension resolving the tab it acts on from focus is handed its
 * own document   measured as Bitwarden's "Site doesn't match" dialog naming the
 * extension's own id as the website the user is on.
 *
 * This module is the app's side of the repair: the snapshot main knows, and the one
 * line that puts it where the wrappers in `compat/cio-page-tabs.js` read it. The
 * binding itself is that file's, because it runs inside the page's own world   the
 * only world where an extension page's `chrome.tabs` exists   and this side only
 * says which tab the page is acting on, every time the answer changes.
 *
 * See `docs/EMBEDDED_BROWSER_ARCHITECTURE.md`, "The tab an extension's own page
 * acts on", for the measured behaviour this works around.
 */

import pageTabsSource from './compat/cio-page-tabs.js?raw'
import storageEventsSource from './compat/cio-storage-events.js?raw'
import darkReaderStorageSource from './compat/cio-darkreader-storage.js?raw'

/** Where a push leaves the tab, read by the page's wrappers on every call. */
export const EXTENSION_PAGE_TAB_GLOBAL = '__cioPageTabsSnapshot'

/**
 * One page the app hosts for an extension, as the extension should see it.
 *
 * `id` is the page's `WebContents` id, which is the id this runtime's own tab API
 * answers with, so a message the extension sends to this tab reaches the page's
 * content script and an injected script lands in the page the user is looking at.
 * That makes these fields the ones an autofill flow needs to be correct rather than
 * merely quiet.
 */
export interface BrowserExtensionPageTab {
  id: number
  url: string
  title: string
  /** Whether the page is the tab the user is looking at, which is the app's own
   *  truth and outranks focus while an extension's popup holds the keyboard. */
  active: boolean
  loading: boolean
  audible: boolean
  muted: boolean
}

/**
 * The script that tells one extension's own page which tab it is acting on.
 *
 * The snapshot is assigned before the wrappers run, and the wrappers read it at call
 * time, so running this again in a page that already has them is an update: the fact
 * is rewritten, nothing is installed twice, and the wrapper the page's own code is
 * already holding keeps answering from the fresh one.
 */
export function extensionPageTabsScript(tab: BrowserExtensionPageTab): string {
  return `${darkReaderStorageSource}\n;\n${storageEventsSource}\n;\nglobalThis.${EXTENSION_PAGE_TAB_GLOBAL} = ${JSON.stringify(tab)}\n${pageTabsSource}`
}

/** Name of the generated preload file, written into the extension store root. */
export const EXTENSION_PAGE_TABS_PRELOAD_FILE = 'cio-page-tabs-preload.js'

/** The one channel the preload asks on, answered synchronously by main. */
export const EXTENSION_PAGE_TABS_CHANNEL = 'cio:page-tabs'

/**
 * The preload an extension page is created with, which is what makes the wrappers
 * above land in time.
 *
 * Pushing the wrappers from main is a race the page usually wins: an extension
 * popup decides which site it is on while its own bundle evaluates, so a wrapper
 * installed after `did-finish-load` arrives once the decision has already been
 * made from focus, and the popup renders "not a website" with the fix sitting in
 * the document unused. Measured on the real uBlock Origin Lite build.
 *
 * A preload is the only injection point that runs before the page's own scripts,
 * and it runs in an isolated world, so the snapshot is asked for synchronously and
 * handed to the page's own world before anything of the extension's executes. The
 * wrapper source is inlined here rather than sent per call: one read of this file
 * at view creation, and one small payload per document.
 *
 * The page's answer is the app's own tab record, never focus, because the popup
 * holds the keyboard by design. A preload that cannot reach main installs the
 * wrappers with no snapshot: they then leave the runtime's own answer alone except
 * for dropping the extension surfaces this app hosts, which is still the correct
 * list.
 */
export function extensionPageTabsPreloadSource(): string {
  return `const { webFrame, ipcRenderer } = require('electron')
if (location.protocol === 'chrome-extension:') {
  let tab = null
  try {
    tab = ipcRenderer.sendSync(${JSON.stringify(EXTENSION_PAGE_TABS_CHANNEL)}, location.protocol)
  } catch (error) {
    tab = null
  }
  const source =
    ${JSON.stringify(darkReaderStorageSource)} + '\\n;\\n' +
    ${JSON.stringify(storageEventsSource)} + '\\n;\\n' +
    'globalThis.${EXTENSION_PAGE_TAB_GLOBAL} = ' + JSON.stringify(tab) + '\\n' + ${JSON.stringify(pageTabsSource)}
  webFrame.executeJavaScript(source).catch(() => {})
}
`
}
