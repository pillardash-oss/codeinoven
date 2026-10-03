import { Menu, MenuItem, type BrowserWindow } from 'electron'
import type {
  BrowserTabContextMenuChoice,
  BrowserTabContextMenuInput
} from '../../../lib/browser/browser-tab-context-menu'
import { MAX_GLOBAL_BROWSER_GROUPS } from '../../../lib/browser/global-browser-tabs'

/** Show regular tab actions in an OS popup above the native browser view. */
export function showBrowserTabContextMenu(
  window: BrowserWindow,
  input: BrowserTabContextMenuInput,
  x: number,
  y: number
): Promise<BrowserTabContextMenuChoice | null> {
  if (window.isDestroyed()) return Promise.resolve(null)

  return new Promise((resolve) => {
    let choice: BrowserTabContextMenuChoice | null = null
    const menu = new Menu()
    const choose = (next: BrowserTabContextMenuChoice): void => {
      choice = next
    }
    const append = (label: string, next: BrowserTabContextMenuChoice, enabled = true): void => {
      menu.append(new MenuItem({ label, enabled, click: () => choose(next) }))
    }
    const appendSeparator = (): void => menu.append(new MenuItem({ type: 'separator' }))

    menu.append(new MenuItem({ label: input.title || input.url || 'Blank tab', enabled: false }))
    appendSeparator()
    append('Edit tab', { action: 'edit' })
    append(input.pinned ? 'Unpin tab' : 'Pin tab', { action: 'togglePin' })
    append(
      input.bookmarked ? 'Remove bookmark' : 'Bookmark tab',
      { action: 'toggleBookmark' },
      input.bookmarkAvailable
    )
    append('Duplicate tab', { action: 'duplicate' }, input.url !== '')
    appendSeparator()
    append('New tab before this tab', { action: 'newBefore' })
    append('New tab', { action: 'newTab' })

    const boxPlacement = new Menu()
    if (input.boxId === null) {
      boxPlacement.append(
        new MenuItem({
          label: 'No box',
          click: () => choose({ action: 'newPlaced', groupId: input.groupId, boxId: null })
        })
      )
    } else {
      const currentBox = input.boxes.find((box) => box.id === input.boxId)
      boxPlacement.append(
        new MenuItem({
          label: currentBox?.name ?? 'Current box',
          click: () => choose({ action: 'newPlaced', groupId: input.groupId, boxId: input.boxId })
        })
      )
    }
    for (const box of input.boxes.filter((candidate) => candidate.id !== input.boxId)) {
      boxPlacement.append(
        new MenuItem({
          label: box.name,
          click: () => choose({ action: 'newPlaced', groupId: input.groupId, boxId: box.id })
        })
      )
    }
    if (input.boxId !== null) {
      boxPlacement.append(
        new MenuItem({
          label: 'No box',
          click: () => choose({ action: 'newPlaced', groupId: input.groupId, boxId: null })
        })
      )
    }
    menu.append(new MenuItem({ label: 'New tab in box', submenu: boxPlacement }))

    const groupPlacement = new Menu()
    if (input.groupId === null) {
      groupPlacement.append(
        new MenuItem({
          label: 'Ungrouped',
          click: () => choose({ action: 'newPlaced', groupId: null, boxId: input.boxId })
        })
      )
    } else {
      const currentGroup = input.groups.find((group) => group.id === input.groupId)
      groupPlacement.append(
        new MenuItem({
          label: currentGroup?.name ?? 'Current group',
          click: () => choose({ action: 'newPlaced', groupId: input.groupId, boxId: input.boxId })
        })
      )
    }
    for (const group of input.groups.filter((candidate) => candidate.id !== input.groupId)) {
      groupPlacement.append(
        new MenuItem({
          label: group.name,
          click: () => choose({ action: 'newPlaced', groupId: group.id, boxId: input.boxId })
        })
      )
    }
    if (input.groupId !== null) {
      groupPlacement.append(
        new MenuItem({
          label: 'Ungrouped',
          click: () => choose({ action: 'newPlaced', groupId: null, boxId: input.boxId })
        })
      )
    }
    menu.append(new MenuItem({ label: 'New tab in group', submenu: groupPlacement }))
    appendSeparator()
    append(
      'New tab group',
      { action: 'createGroup' },
      input.groups.length < MAX_GLOBAL_BROWSER_GROUPS
    )
    if (input.groupId !== null) {
      append('Edit tab group', { action: 'editGroup' })
      append('Remove from group', { action: 'removeFromGroup' })
    }
    for (const group of input.groups.filter((candidate) => candidate.id !== input.groupId)) {
      append(`Move to ${group.name}`, { action: 'moveToGroup', groupId: group.id })
    }

    if (input.boxes.length > 0 || input.boxId !== null) {
      appendSeparator()
      const boxMenu = new Menu()
      if (input.boxId !== null) {
        boxMenu.append(
          new MenuItem({
            label: 'No box',
            click: () => choose({ action: 'reopenInBox', boxId: null })
          })
        )
      }
      for (const box of input.boxes.filter((candidate) => candidate.id !== input.boxId)) {
        boxMenu.append(
          new MenuItem({
            label: box.name,
            click: () => choose({ action: 'reopenInBox', boxId: box.id })
          })
        )
      }
      menu.append(new MenuItem({ label: 'Reopen in box', submenu: boxMenu }))
    }

    appendSeparator()
    append('Reopen closed tab', { action: 'reopenClosed' }, input.canReopenClosedTab)
    appendSeparator()
    append('Close tab', { action: 'close' })
    menu.popup({ window, x, y, callback: () => resolve(choice) })
  })
}
