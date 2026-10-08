import { Menu, MenuItem, type BrowserWindow } from 'electron'
import type {
  BrowserNewTabMenuChoice,
  BrowserNewTabMenuInput
} from '../../../lib/browser/browser-new-tab-menu'
import { validateBrowserTabSelectionMenuInput, validateOptionalBoxId } from './browser-validation'

/** Reuse the bounded box/group vocabulary of the native tab menus. */
export function validateBrowserNewTabMenuInput(value: unknown): BrowserNewTabMenuInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid new tab menu')
  }
  const input = value as Record<string, unknown>
  const { groups, boxes } = validateBrowserTabSelectionMenuInput({
    selectedCount: 2,
    canCreateGroup: false,
    groups: input.groups,
    boxes: input.boxes
  })
  const groupId = input.groupId
  if (
    groupId !== null &&
    (typeof groupId !== 'string' || !groups.some((group) => group.id === groupId))
  ) {
    throw new TypeError('Invalid new tab group')
  }
  const boxId = validateOptionalBoxId(input.boxId)
  if (boxId !== null && !boxes.some((box) => box.id === boxId))
    throw new TypeError('Invalid new tab box')
  if (typeof input.anchored !== 'boolean') throw new TypeError('Invalid new tab anchor flag')
  return { groupId, boxId, groups, boxes, anchored: input.anchored }
}

export function showBrowserNewTabMenu(
  window: BrowserWindow,
  input: BrowserNewTabMenuInput,
  x: number,
  y: number
): Promise<BrowserNewTabMenuChoice | null> {
  if (window.isDestroyed()) return Promise.resolve(null)
  return new Promise((resolve) => {
    let choice: BrowserNewTabMenuChoice | null = null
    const menu = new Menu()
    const choose = (next: BrowserNewTabMenuChoice): void => {
      choice = next
    }
    menu.append(
      new MenuItem({
        label: 'New tab',
        click: () => choose({ action: 'new', groupId: input.groupId, boxId: input.boxId })
      })
    )
    menu.append(new MenuItem({ type: 'separator' }))
    const placement = (
      label: string,
      entries: Array<{ id: string | null; name: string }>,
      makeChoice: (id: string | null) => BrowserNewTabMenuChoice
    ): void => {
      const submenu = new Menu()
      for (const entry of entries)
        submenu.append(
          new MenuItem({ label: entry.name, click: () => choose(makeChoice(entry.id)) })
        )
      menu.append(new MenuItem({ label, submenu }))
    }
    placement('New tab in box', [{ id: null, name: 'No box' }, ...input.boxes], (boxId) => ({
      action: 'new',
      boxId,
      groupId: input.groupId
    }))
    placement(
      'New tab in group',
      [{ id: null, name: 'Ungrouped' }, ...input.groups],
      (groupId) => ({ action: 'new', groupId, boxId: input.boxId })
    )
    if (input.anchored) {
      menu.append(new MenuItem({ type: 'separator' }))
      menu.append(
        new MenuItem({
          label: 'New tab before this tab',
          click: () => choose({ action: 'before' })
        })
      )
      menu.append(
        new MenuItem({ label: 'New tab after this tab', click: () => choose({ action: 'after' }) })
      )
    }
    menu.popup({ window, x, y, callback: () => resolve(choice) })
  })
}
