/**
 * The global browser's durable tab list over IPC.
 *
 * Registered with the early hydration surface rather than inside the browser
 * service, because the service is constructed after first paint and the renderer
 * hydrates the tab list while its document evaluates. The list is app state, not
 * browser runtime, so it is available from the moment the renderer can ask.
 */

import { GlobalBrowserTabsStore } from '../browser/global-browser-tabs-store'
import { trustedIpcMain as ipcMain } from './trusted-ipc-main'

export function registerGlobalBrowserIpcHandlers(): void {
  const store = new GlobalBrowserTabsStore()
  ipcMain.handle('browser:loadTabs', () => store.load())
  ipcMain.handle('browser:saveTabs', (_event, rawSnapshot) => store.save(rawSnapshot))
}
