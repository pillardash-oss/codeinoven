/**
 * The global browser's durable app state over IPC: the tab list, the browsing
 * history and the bookmarks.
 *
 * Registered with the early hydration surface rather than inside the browser
 * service, because the service is constructed after first paint and the renderer
 * reads this state while its document evaluates. None of it is browser runtime:
 * it is app state, available from the moment the renderer can ask.
 */

import {
  createBrowserBookmarkStore,
  createBrowserHistoryStore
} from '../browser/browser-library-store'
import { GlobalBrowserTabsStore } from '../browser/global-browser-tabs-store'
import type { BrowserContextMenuBoxEntry } from '../../lib/browser/browser-box-menu'
import {
  parseGlobalBrowserTabsSnapshot,
  type GlobalBrowserTabsSnapshot
} from '../../lib/browser/global-browser-tabs'
import { trustedIpcMain as ipcMain } from './trusted-ipc-main'

let contextMenuBoxes: BrowserContextMenuBoxEntry[] = []

/** Box labels from the global browser snapshot, available to native page menus. */
export function getGlobalBrowserContextMenuBoxes(): BrowserContextMenuBoxEntry[] {
  return contextMenuBoxes
}

function rememberContextMenuBoxes(snapshot: GlobalBrowserTabsSnapshot | null): void {
  contextMenuBoxes = (snapshot?.boxes ?? []).map(({ id, name }) => ({ id, name }))
}

export function registerGlobalBrowserIpcHandlers(): void {
  const tabsStore = new GlobalBrowserTabsStore()
  const historyStore = createBrowserHistoryStore()
  const bookmarkStore = createBrowserBookmarkStore()
  ipcMain.handle('browser:loadTabs', async () => {
    const snapshot = await tabsStore.load()
    rememberContextMenuBoxes(snapshot)
    return snapshot
  })
  ipcMain.handle('browser:saveTabs', async (_event, rawSnapshot) => {
    await tabsStore.save(rawSnapshot)
    rememberContextMenuBoxes(parseGlobalBrowserTabsSnapshot(rawSnapshot))
  })
  ipcMain.handle('browser:loadHistory', () => historyStore.load())
  ipcMain.handle('browser:saveHistory', (_event, rawSnapshot) => historyStore.save(rawSnapshot))
  ipcMain.handle('browser:clearHistory', () => historyStore.clear())
  ipcMain.handle('browser:loadBookmarks', () => bookmarkStore.load())
  ipcMain.handle('browser:saveBookmarks', (_event, rawSnapshot) => bookmarkStore.save(rawSnapshot))
  ipcMain.handle('browser:clearBookmarks', () => bookmarkStore.clear())
}
