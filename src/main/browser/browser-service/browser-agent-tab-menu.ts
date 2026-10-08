/**
 * The global browser agent tab's context menu, as an OS-native popup.
 *
 * It has to be native for the same reason the tab and box menus are: the page
 * beside the rail is a `WebContentsView` that composites above the renderer,
 * so a document menu would be drawn behind the page and never seen. The OS
 * popup floats above the view instead.
 */

import { Menu, MenuItem, type BrowserWindow } from 'electron'
import type {
  BrowserAgentTabMenuChoice,
  BrowserAgentTabMenuInput
} from '../../../lib/browser/browser-agent-tab-menu'

/**
 * Pop the menu and resolve with what it was answered.
 *
 * Resolves with the choice, or null when it was dismissed without one, which
 * is what lets the caller leave the tab exactly as it was. The promise settles
 * from the popup's own callback, so it stays pending while the menu is open.
 */
export function showBrowserAgentTabMenu(
  window: BrowserWindow,
  input: BrowserAgentTabMenuInput,
  x: number,
  y: number
): Promise<BrowserAgentTabMenuChoice | null> {
  if (window.isDestroyed()) return Promise.resolve(null)
  return new Promise((resolve) => {
    let choice: BrowserAgentTabMenuChoice | null = null
    const menu = new Menu()
    menu.append(
      new MenuItem({ label: input.title || 'Agent conversation', enabled: false })
    )
    menu.append(new MenuItem({ type: 'separator' }))
    menu.append(
      new MenuItem({ label: 'Rename', click: () => (choice = { action: 'rename' }) })
    )
    menu.append(
      new MenuItem({ label: 'Copy thread ID', click: () => (choice = { action: 'copyThreadId' }) })
    )
    menu.append(new MenuItem({ type: 'separator' }))
    menu.append(
      new MenuItem({ label: 'Close conversation', click: () => (choice = { action: 'close' }) })
    )
    menu.popup({ window, x, y, callback: () => resolve(choice) })
  })
}
