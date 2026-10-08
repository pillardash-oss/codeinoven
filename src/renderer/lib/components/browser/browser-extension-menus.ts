import { invoke } from '$lib/ipc.svelte'
import type { BrowserExtension } from '$shared/ipc-contract'
import type { BrowserExtensionMenuChoice } from '$shared/browser/browser-extension-menu'
import { hostOfUrl, runsOnHost } from '$shared/browser/browser-extension-site-rules'
import { browserExtensions } from '$lib/stores/browser-extensions.svelte'
import { browserPopupWindows } from '$lib/stores/browser-popup-windows.svelte'
import { GLOBAL_BROWSER_CONTEXT, globalBrowser } from '$lib/stores/global-browser.svelte'
import { logRendererError } from '$lib/system/renderer-logger'
import { DARK_READER_EXTENSION_ID } from '$shared/browser/browser-darkreader-control'

/** Open the native context menu for one extension and run the choice. */
export async function openBrowserExtensionMenu(
  extension: BrowserExtension,
  x: number,
  y: number
): Promise<void> {
  const tab = globalBrowser.activeTab
  const jar = tab ? (tab.boxId ?? '') : ''
  const host = tab ? hostOfUrl(tab.url) : null
  const runsInJar = tab ? extension.enabled && extension.boxes.includes(tab.boxId ?? '') : false
  const tabState =
    tab && extension.id === DARK_READER_EXTENSION_ID
      ? await invoke('browser:darkReaderTabState', tab.id).catch((error: unknown) => {
          logRendererError('Dark Reader tab controls could not be read', error)
          return null
        })
      : null
  const choice = await invoke(
    'browser:extensionMenu',
    {
      extensionId: extension.id,
      extensionName: extension.name,
      enabled: extension.enabled,
      pinned: extension.pinned,
      pinCapReached: browserExtensions.pinnedCount >= 5,
      hasPopup: extension.popupPath !== null,
      hasOptions: extension.optionsPath !== null,
      host,
      runsOnHost: runsOnHost(extension.blockedHosts, extension.allowedHosts, host),
      runsInJar,
      tabControl: tabState !== null && extension.boxes.includes(jar) && host !== null,
      enabledInTab: tabState?.enabled ?? true,
      tabScoped: tabState?.scoped ?? false
    },
    Math.max(0, Math.round(x)),
    Math.max(0, Math.round(y))
  ).catch((error: unknown) => {
    logRendererError('The extension menu could not open', error)
    return null
  })
  if (choice === null) return
  await runBrowserExtensionMenuChoice(extension, choice, host, jar, tab?.id ?? null)
}

async function runBrowserExtensionMenuChoice(
  extension: BrowserExtension,
  choice: BrowserExtensionMenuChoice,
  host: string | null,
  jar: string,
  tabId: string | null
): Promise<void> {
  const tab = globalBrowser.activeTab
  switch (choice) {
    case 'only-tab':
    case 'disable-tab':
    case 'enable-tab':
    case 'reset-tabs': {
      if (tabId) await invoke('browser:darkReaderTabScope', tabId, choice)
      return
    }
    case 'open-popup': {
      if (!tab) return
      const open = browserPopupWindows.extensionPopupFor(extension.id, tab.id)
      if (open !== null) {
        browserPopupWindows.select(open)
        globalBrowser.showPopupsSidebar()
        return
      }
      const popupId = await browserPopupWindows.openExtension(
        {
          projectId: GLOBAL_BROWSER_CONTEXT.projectId,
          threadId: GLOBAL_BROWSER_CONTEXT.threadId,
          tabId: tab.id,
          boxId: tab.boxId
        },
        extension.id
      )
      if (popupId !== null) globalBrowser.showPopupsSidebar()
      return
    }
    case 'open-options': {
      const url = await browserExtensions.openOptionsPage(extension.id, tab ? tab.boxId : null)
      if (url) globalBrowser.open(url, null, jar)
      return
    }
    case 'toggle-enabled': {
      await browserExtensions.setEnabled(extension.id, !extension.enabled)
      return
    }
    case 'toggle-pin': {
      await browserExtensions.setPinned(extension.id, !extension.pinned)
      return
    }
    case 'block-site': {
      if (!host) return
      const blocked = extension.blockedHosts.includes(host)
        ? extension.blockedHosts
        : [...extension.blockedHosts, host]
      await browserExtensions.setSiteRules(extension.id, blocked, extension.allowedHosts)
      return
    }
    case 'allow-site': {
      if (!host) return
      const blocked = extension.blockedHosts.filter((entry) => entry !== host)
      let allowed = extension.allowedHosts
      if (extension.allowedHosts.length > 0 && !extension.allowedHosts.includes(host)) {
        allowed = [...extension.allowedHosts, host]
      }
      await browserExtensions.setSiteRules(extension.id, blocked, allowed)
      return
    }
    case 'clear-site-rules': {
      await browserExtensions.setSiteRules(extension.id, [], [])
      return
    }
    case 'manage': {
      globalBrowser.showExtensionsSidebar()
      return
    }
    case 'remove': {
      globalBrowser.showExtensionsSidebar()
      return
    }
  }
}
