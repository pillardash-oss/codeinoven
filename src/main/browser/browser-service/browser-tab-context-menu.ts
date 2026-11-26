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

    // The menu is laid out in four sections so the same kind of move always
    // lives in the same place: the actions on this tab, then everything that
    // makes a new tab, then everything that reopens one, then everything that
    // moves one, and close on its own at the bottom. Inside each section the
    // items run tab, group, box, in that order, so a target is always reached
    // the same way down the menu.
    menu.append(new MenuItem({ label: input.title || input.url || 'Blank tab', enabled: false }))
    appendSeparator()
    if (!input.threadScoped) {
      append('Edit tab', { action: 'edit' })
      append(input.pinned ? 'Unpin tab' : 'Pin tab', { action: 'togglePin' })
    }
    // The id is what an agent is pointed at, so it is reachable from the tab it
    // names: copy it here and hand it to a thread without going through the app.
    append('Copy tab ID', { action: 'copyTabId' })
    append(
      input.bookmarked ? 'Remove bookmark' : 'Bookmark tab',
      { action: 'toggleBookmark' },
      input.bookmarkAvailable
    )
    append('Duplicate tab', { action: 'duplicate' })
    // Release a page, keeping its row. Both kinds of strip offer this now: a
    // thread browser tab is slept by the same clock as a global one, so the menu
    // offers the same move. A tab already asleep has nothing to release, a pinned
    // tab stays live on purpose, an address-less tab has no page at all, and the
    // tab a surface has on screen is what the user is looking at. The label stays
    // put and the item greys out, the way the bookmark and reopen items already
    // do, so the menu does not change shape under the pointer.
    append('Put tab to sleep', { action: 'sleep' }, canSleepTab(input))

    // New: the tab first, then the group it can land in, then the box.
    appendSeparator()
    append('New tab', { action: 'newTab' })
    append('New tab before this tab', { action: 'newBefore' })

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
      append(
        'New tab group',
        { action: 'createGroup' },
        input.groups.length < MAX_GLOBAL_BROWSER_GROUPS
      )
    }
    menu.append(new MenuItem({ label: 'New tab in box', submenu: boxPlacement }))

    // Reopen: the closed tab first, then the box it can come back in.
    appendSeparator()
    append('Reopen closed tab', { action: 'reopenClosed' }, input.canReopenClosedTab)
    if (input.boxes.length > 0 || input.boxId !== null) {
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

    // Move: the tab's own move first, then the group it can join or leave.
    if (!input.threadScoped) {
      appendSeparator()
      // Moving a page beside the page on screen is the one way to read two pages at
      // once, so the move sits with the other moves and greys out for a tab that has
      // no page to carry.
      append('Move tab to side panel', { action: 'moveToSidePanel' }, canMoveTabToSide(input))
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
      if (input.groupId !== null) {
        append('Remove from group', { action: 'removeFromGroup' })
        append('Edit tab group', { action: 'editGroup' })
      }
    }

    // Close sits alone at the bottom so it is never next to a move that looks
    // like it.
    appendSeparator()
    append('Close tab', { action: 'close' })
    menu.popup({ window, x, y, callback: () => resolve(choice) })
  })
}

/**
 * Whether this tab has a page to release.
 *
 * A tab already asleep has nothing left to release, a pinned tab stays live on
 * purpose, a tab with no address has no page at all, and the tab the surface has
 * on screen is what the user is looking at. The renderer refuses the same list,
 * so a menu that somehow offers the action still cannot take a page away. A
 * thread browser tab is offered it on the same terms as a global one: its own
 * idle clock sleeps it, and this is the same move on demand.
 */
function canSleepTab(input: BrowserTabContextMenuInput): boolean {
  if (input.hibernated || input.pinned) return false
  return input.url !== '' && !input.active
}

/**
 * Whether this tab has a page to move beside the one on screen.
 *
 * A thread's browser has no rail of its own to move a page into, so the item is only
 * offered where that rail exists, and a tab with no address has no page to carry.
 */
function canMoveTabToSide(input: BrowserTabContextMenuInput): boolean {
  return input.threadScoped !== true && input.url !== ''
}
