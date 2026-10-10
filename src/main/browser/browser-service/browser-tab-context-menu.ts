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
    if (!input.threadScoped) {
      append('Edit tab', { action: 'edit' })
      append(input.pinned ? 'Unpin tab' : 'Pin tab', { action: 'togglePin' })
    }
    append(
      input.bookmarked ? 'Remove bookmark' : 'Bookmark tab',
      { action: 'toggleBookmark' },
      input.bookmarkAvailable
    )
    append('Duplicate tab', { action: 'duplicate' })
    // Releasing a page is a global browser's own move: a thread's browser tabs
    // are never hibernated, and neither is a tab already asleep, a pinned tab, an
    // address-less one, or the tab the surface has on screen. The label stays put
    // and the item greys out, the way the bookmark and reopen items already do,
    // so the menu does not change shape under the pointer.
    append('Put tab to sleep', { action: 'sleep' }, canSleepTab(input))
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

    if (!input.threadScoped) {
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
      const movePlacement = new Menu()
      const moveTargets = input.groups.filter((candidate) => candidate.id !== input.groupId)
      if (moveTargets.length === 0) {
        movePlacement.append(new MenuItem({ label: 'No other groups', enabled: false }))
      } else {
        for (const group of moveTargets) {
          movePlacement.append(
            new MenuItem({
              label: group.name,
              click: () => choose({ action: 'moveToGroup', groupId: group.id })
            })
          )
        }
      }
      menu.append(new MenuItem({ label: 'Move tab to group', submenu: movePlacement }))
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

/**
 * Whether this tab has a page to release.
 *
 * A thread's browser tabs are never hibernated (they go with their thread), a
 * tab already asleep has nothing left to release, a pinned tab stays live on
 * purpose, a tab with no address has no page at all, and the tab the surface has
 * on screen is what the user is looking at. The renderer refuses the same list,
 * so a menu that somehow offers the action still cannot take a page away.
 */
function canSleepTab(input: BrowserTabContextMenuInput): boolean {
  if (input.threadScoped === true || input.hibernated || input.pinned) return false
  return input.url !== '' && !input.active
}
