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
import { trustedIpcMain as ipcMain } from './trusted-ipc-main'

export function registerGlobalBrowserIpcHandlers(): void {
  const tabsStore = new GlobalBrowserTabsStore()
  const historyStore = createBrowserHistoryStore()
  const bookmarkStore = createBrowserBookmarkStore()
  ipcMain.handle('browser:loadTabs', () => tabsStore.load())
  ipcMain.handle('browser:saveTabs', (_event, rawSnapshot) => tabsStore.save(rawSnapshot))
  ipcMain.handle('browser:loadHistory', () => historyStore.load())
  ipcMain.handle('browser:saveHistory', (_event, rawSnapshot) => historyStore.save(rawSnapshot))
  ipcMain.handle('browser:clearHistory', () => historyStore.clear())
  ipcMain.handle('browser:loadBookmarks', () => bookmarkStore.load())
  ipcMain.handle('browser:saveBookmarks', (_event, rawSnapshot) =>
    bookmarkStore.save(rawSnapshot)
  )
  ipcMain.handle('browser:clearBookmarks', () => bookmarkStore.clear())
}
