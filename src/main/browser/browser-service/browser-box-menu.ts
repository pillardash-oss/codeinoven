/**
 * The thread browser's box menu, as an OS-native popup.
 *
 * It has to be native for the same reason the downloads and site menus are: the
 * page on screen is a `WebContentsView` that composites above the renderer, so a
 * document dropdown opened under the toolbar is drawn behind the page and never
 * seen. The OS popup floats above the view instead.
 */

import { Menu, MenuItem, type BrowserWindow } from 'electron'
import type {
  BrowserBoxMenuChoice,
  BrowserBoxMenuInput
} from '../../../lib/browser/browser-box-menu'

/**
 * Pop the menu and resolve with what it was answered.
 *
 * Resolves with the choice, or null when it was dismissed without one, which is
 * what lets the caller leave the tab exactly as it was. The promise settles from
 * the popup's own callback, so it stays pending for as long as the menu is open.
 */
export function showBrowserBoxMenu(
  window: BrowserWindow,
  input: BrowserBoxMenuInput,
  x: number,
  y: number
): Promise<BrowserBoxMenuChoice | null> {
  if (window.isDestroyed()) return Promise.resolve(null)
  return new Promise((resolve) => {
    let choice: BrowserBoxMenuChoice | null = null
    const menu = new Menu()
    menu.append(
      new MenuItem({
        // The scope's jar is where every conversation starts, so it heads the
        // menu and says what it is; a box could share the scope's name.
        label: `${input.scopeLabel} (this conversation)`,
        // Checkboxes rather than a radio group: the separator below splits
        // Electron's radio groups, and two groups would each keep their own tick.
        type: 'checkbox',
        checked: input.currentBoxId === null,
        click: () => {
          choice = { boxId: null }
        }
      })
    )
    if (input.boxes.length > 0) menu.append(new MenuItem({ type: 'separator' }))
    for (const box of input.boxes) {
      menu.append(
        new MenuItem({
          label: box.name,
          type: 'checkbox',
          checked: box.id === input.currentBoxId,
          click: () => {
            choice = { boxId: box.id }
          }
        })
      )
    }
    menu.popup({
      window,
      x,
      y,
      callback: () => resolve(choice)
    })
  })
}
