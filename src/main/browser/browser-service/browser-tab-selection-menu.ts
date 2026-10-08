import { Menu, MenuItem, type BrowserWindow } from 'electron'
import type {
  BrowserTabSelectionMenuChoice,
  BrowserTabSelectionMenuInput
} from '../../../lib/browser/browser-tab-selection-menu'

/** Open the bulk tab actions as a native popup above the WebContentsView. */
export function showBrowserTabSelectionMenu(
  window: BrowserWindow,
  input: BrowserTabSelectionMenuInput,
  x: number,
  y: number
): Promise<BrowserTabSelectionMenuChoice | null> {
  if (window.isDestroyed()) return Promise.resolve(null)

  return new Promise((resolve) => {
    let choice: BrowserTabSelectionMenuChoice | null = null
    const menu = new Menu()
    menu.append(
      new MenuItem({
        label: `${input.selectedCount} tabs selected`,
        enabled: false
      })
    )
    menu.append(new MenuItem({ type: 'separator' }))

    const groupMenu = new Menu()
    if (input.groups.length === 0) {
      groupMenu.append(new MenuItem({ label: 'No groups yet', enabled: false }))
    } else {
      for (const group of input.groups) {
        groupMenu.append(
          new MenuItem({
            label: group.name,
            click: () => {
              choice = { action: 'moveToGroup', groupId: group.id }
            }
          })
        )
      }
    }
    menu.append(new MenuItem({ label: 'Add selected tabs to group', submenu: groupMenu }))
    menu.append(
      new MenuItem({
        label: 'Create group from selection',
        enabled: input.canCreateGroup,
        click: () => {
          choice = { action: 'createGroup' }
        }
      })
    )
    menu.append(new MenuItem({ type: 'separator' }))

    const boxMenu = new Menu()
    boxMenu.append(
      new MenuItem({
        label: 'No box',
        click: () => {
          choice = { action: 'reopenInBox', boxId: null }
        }
      })
    )
    for (const box of input.boxes) {
      boxMenu.append(
        new MenuItem({
          label: box.name,
          click: () => {
            choice = { action: 'reopenInBox', boxId: box.id }
          }
        })
      )
    }
    menu.append(new MenuItem({ label: 'Add selected tabs to box', submenu: boxMenu }))
    menu.popup({
      window,
      x,
      y,
      callback: () => resolve(choice)
    })
  })
}
