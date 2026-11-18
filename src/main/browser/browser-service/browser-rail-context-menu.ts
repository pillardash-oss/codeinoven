import { Menu, MenuItem, type BrowserWindow } from 'electron'
import type { BrowserRailContextMenuChoice } from '../../../lib/browser/browser-rail-context-menu'

/**
 * Show the thread browser rail's actions above the native page.
 *
 * The rail icon sits at the window edge beside the thread browser, so its menu
 * opens across a `WebContentsView` that no DOM menu can paint over. An OS popup
 * is a window of its own and needs no page teardown, which keeps the page the
 * user right-clicked about visible while the actions are chosen.
 */
export function showBrowserRailContextMenu(
  window: BrowserWindow,
  x: number,
  y: number
): Promise<BrowserRailContextMenuChoice | null> {
  if (window.isDestroyed()) return Promise.resolve(null)

  return new Promise((resolve) => {
    let choice: BrowserRailContextMenuChoice | null = null
    const menu = new Menu()
    const choose = (action: BrowserRailContextMenuChoice['action']): void => {
      choice = { action }
    }
    menu.append(new MenuItem({ label: 'Close all tabs', click: () => choose('closeAllTabs') }))
    menu.append(new MenuItem({ label: 'Close browser', click: () => choose('closeBrowser') }))
    menu.append(new MenuItem({ type: 'separator' }))
    menu.append(new MenuItem({ label: 'Manage downloads', click: () => choose('downloads') }))
    menu.append(new MenuItem({ type: 'separator' }))
    menu.append(
      new MenuItem({
        label: 'Clear cookies and site data',
        click: () => choose('clearData')
      })
    )
    menu.popup({ window, x, y, callback: () => resolve(choice) })
  })
}
