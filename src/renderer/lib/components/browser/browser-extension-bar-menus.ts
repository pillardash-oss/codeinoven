import { invoke } from '$lib/ipc.svelte'
import { WEBSTORE_HOME_URL } from '$shared/browser/browser-webstore'
import type {
  BrowserExtensionBarMenuChoice,
  BrowserExtensionBarMenuInput
} from '$shared/browser/browser-extension-bar-menu'
import { browserExtensionDropdown } from '$lib/stores/browser-extension-dropdown.svelte'
import { browserExtensions } from '$lib/stores/browser-extensions.svelte'
import {
  installStoreExtensionInBox,
  storeExtensionOfferForPage,
  storeOfferInstallVerb
} from '$lib/stores/browser-extension-store-offer'
import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
import { extensionJarIdFor } from '$shared/browser/browser-extension-jar'
import { reportError } from '$lib/stores/app-errors.svelte'

/**
 * The thread browser's extension button: one native menu, and the two things a
 * click in it can do.
 *
 * The global browser hangs its extension chrome off a rail, so a pin there opens a
 * popup as one more tab of that rail. The thread browser has no rail, so the same
 * click opens the same popup in a dropdown under the button instead. Everything
 * else is shared rather than re-implemented: the extensions are the profile's, the
 * popup is main's, and the Web Store offer is read by the same code that reads it
 * for the global browser's address bar.
 *
 * The menu is native because the page below the toolbar is a native view composited
 * above the renderer, so a document dropdown would be drawn behind it.
 */

/** The tab the button belongs to: everything a menu row and a popup need. */
export interface ThreadBrowserExtensionTab {
  tabId: string
  projectId: string
  threadId: string
  /** The box the tab runs in, or null for the conversation's own jar. */
  boxId: string | null
  url: string
  title: string
}

/**
 * The jar this tab's extensions belong to.
 *
 * A boxed tab reads the box's jar, which the profile shares, and an unboxed tab
 * reads the jar of the conversation it belongs to, which nothing else reads. That
 * is the whole difference from the profile's own browser: an extension installed
 * beside a project's conversation is that project's, not everyone's.
 */
function jarForTab(tab: ThreadBrowserExtensionTab): string {
  return extensionJarIdFor(tab.projectId, tab.boxId)
}

/**
 * The extensions of one tab's jar, as the menu offers them.
 *
 * Exactly the extensions of the selected box, never the profile's list: a disabled
 * extension runs nowhere and a jar an extension is not loaded in has nothing to
 * open, so both are left out. The menu lists what a click can actually reach on
 * this page, which is what a browser's toolbar does.
 */
function extensionEntries(
  tab: ThreadBrowserExtensionTab
): BrowserExtensionBarMenuInput['extensions'] {
  const jar = jarForTab(tab)
  return browserExtensions.extensions
    .filter((extension) => extension.enabled && extension.boxes.includes(jar))
    .map((extension) => ({
      id: extension.id,
      name: extension.name,
      hasPopup: extension.popupPath !== null,
      hasOptions: extension.optionsPath !== null
    }))
}

/**
 * Open the menu under the extension button and run what it was answered.
 *
 * A left-click lists the extensions and the store offer; a right-click adds the two
 * ways to install, which is the whole difference between the directions. The offer
 * heads both, because installing what the user is looking at is the row they opened
 * the menu for.
 */
export async function openThreadBrowserExtensionMenu(
  tab: ThreadBrowserExtensionTab,
  anchor: HTMLElement,
  installDoors: boolean
): Promise<void> {
  const offer = storeExtensionOfferForPage(tab)
  const input: BrowserExtensionBarMenuInput = {
    extensions: extensionEntries(tab),
    offer:
      offer && !offer.installed
        ? { name: offer.name, installVerb: storeOfferInstallVerb(offer) }
        : null,
    installDoors
  }
  const rect = anchor.getBoundingClientRect()
  const x = Math.max(0, Math.round(rect.left))
  const y = Math.max(0, Math.round(rect.bottom + 4))
  const choice = await invoke('browser:extensionBarMenu', input, x, y).catch((error: unknown) => {
    reportError(error, 'The extensions menu could not be opened.')
    return null
  })
  if (choice === null) return
  await runThreadBrowserExtensionChoice(tab, choice, offer)
}

/** Run one menu choice against the tab the menu was opened for. */
async function runThreadBrowserExtensionChoice(
  tab: ThreadBrowserExtensionTab,
  choice: BrowserExtensionBarMenuChoice,
  offer: ReturnType<typeof storeExtensionOfferForPage>
): Promise<void> {
  switch (choice.kind) {
    case 'extension': {
      await openExtensionFromBar(tab, choice.extensionId)
      return
    }
    case 'install-offer': {
      if (!offer) return
      await installStoreExtensionInBox(offer, tab.projectId, tab.boxId)
      return
    }
    case 'install-webstore': {
      // The store's own "Add to Chrome" is Chrome's inline-install API, which
      // Electron does not implement. So this opens the store in this browser and
      // the extension's page is what offers the install, through the same button.
      contextSidebarState.openBrowserForContext(
        WEBSTORE_HOME_URL,
        tab.projectId,
        tab.threadId,
        undefined,
        true,
        tab.boxId
      )
      return
    }
    case 'install-folder': {
      const folder = await browserExtensions.pickFolder()
      if (!folder) return
      await browserExtensions.install({
        source: 'folder',
        value: folder,
        boxes: [jarForTab(tab)]
      })
      return
    }
  }
}

/**
 * Open one extension the way its own manifest says it opens.
 *
 * An extension with a popup opens that, in the dropdown. One with only a setup page
 * opens it in a tab of this browser, which is what a browser does with an extension
 * whose icon has nothing to pop up; an extension with neither runs on the page and
 * offers no surface, so the menu does not offer it as a door at all.
 */
async function openExtensionFromBar(
  tab: ThreadBrowserExtensionTab,
  extensionId: string
): Promise<void> {
  const extension = browserExtensions.extensions.find((candidate) => candidate.id === extensionId)
  if (!extension) return
  if (extension.popupPath !== null) {
    await browserExtensionDropdown.toggle(
      {
        tabId: tab.tabId,
        projectId: tab.projectId,
        threadId: tab.threadId,
        boxId: tab.boxId
      },
      extensionId
    )
    return
  }
  const url = await browserExtensions.openOptionsPage(extensionId, tab.boxId)
  if (!url) return
  contextSidebarState.openBrowserForContext(
    url,
    tab.projectId,
    tab.threadId,
    undefined,
    true,
    tab.boxId
  )
}
