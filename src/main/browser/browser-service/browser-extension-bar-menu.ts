/**
 * The thread browser's extension-bar menu, as an OS-native popup.
 *
 * Native for the reason every menu in this browser is: the page on screen is a
 * `WebContentsView` composited above the renderer, so a document dropdown opened
 * under the toolbar would be drawn behind the page and never seen. The OS popup
 * floats above the view instead, which is exactly what the profile's boxes and
 * downloads menus already rely on.
 *
 * One menu covers both directions. The store page's offer heads it, because
 * installing what the user is looking at is the row they opened it for; the
 * extensions of the tab's jar follow; and a right-click adds the two ways in,
 * which is the only difference between the two menus.
 */

import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import {
  MAX_BROWSER_EXTENSION_BAR_ENTRIES,
  type BrowserExtensionBarMenuChoice,
  type BrowserExtensionBarMenuInput
} from '../../../lib/browser/browser-extension-bar-menu'

/** Clip a value for a menu label, so a long name cannot dominate it. */
function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/**
 * Pop the menu and resolve with what it was answered.
 *
 * Resolves with the choice, or null when it was dismissed without one, which is what
 * lets the caller leave the tab and its popup exactly as they were. The promise
 * settles from the popup's own callback, so it stays pending for as long as the menu
 * is open.
 */
export function showBrowserExtensionBarMenu(
  window: BrowserWindow,
  input: BrowserExtensionBarMenuInput,
  x: number,
  y: number
): Promise<BrowserExtensionBarMenuChoice | null> {
  if (window.isDestroyed()) return Promise.resolve(null)
  return new Promise((resolve) => {
    let choice: BrowserExtensionBarMenuChoice | null = null
    const pick = (next: BrowserExtensionBarMenuChoice) => (): void => {
      choice = next
    }
    const template: MenuItemConstructorOptions[] = []
    if (input.offer) {
      const verb = input.offer.installVerb
      const name = clip(input.offer.name ?? 'this extension', 60)
      template.push({
        label: verb === null ? `Install ${name}` : `${verb} ${name}`,
        // A second click on an install already queued would queue another, so the
        // row states what is in flight and stops being an action.
        enabled: verb === null,
        click: pick({ kind: 'install-offer' })
      })
      template.push({ type: 'separator' })
    }
    for (const extension of input.extensions.slice(0, MAX_BROWSER_EXTENSION_BAR_ENTRIES)) {
      template.push({
        label: clip(extension.name, 60),
        // An extension that declares neither a popup nor a setup page has nowhere
        // to go; it still runs on the page, so the row states that instead of
        // pretending to be a door.
        enabled: extension.hasPopup || extension.hasOptions,
        click: pick({ kind: 'extension', extensionId: extension.id })
      })
    }
    if (input.extensions.length === 0) {
      template.push({ label: 'No extensions run in this tab', enabled: false })
    }
    if (input.installDoors) {
      template.push({ type: 'separator' })
      template.push({
        label: 'Install from Chrome Web Store…',
        click: pick({ kind: 'install-webstore' })
      })
      template.push({ label: 'Install from Folder…', click: pick({ kind: 'install-folder' }) })
    }
    Menu.buildFromTemplate(template).popup({
      window,
      x,
      y,
      callback: () => resolve(choice)
    })
  })
}

/** Bound one extension row's name, matching what a menu can draw. */
const MAX_EXTENSION_NAME_LENGTH = 200

/**
 * Validate the renderer input for the extension-bar menu.
 *
 * The list is the renderer's, so every field is checked here: main builds an OS
 * menu out of it and must not be handed a row whose id or label it cannot trust.
 */
export function validateBrowserExtensionBarMenuInput(value: unknown): BrowserExtensionBarMenuInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Browser extension bar menu input is invalid')
  }
  const record = value as Record<string, unknown>
  const rawExtensions = record['extensions']
  if (!Array.isArray(rawExtensions)) {
    throw new TypeError('Browser extension bar menu entries are invalid')
  }
  const extensions: BrowserExtensionBarMenuInput['extensions'] = []
  for (const entry of rawExtensions.slice(0, MAX_BROWSER_EXTENSION_BAR_ENTRIES)) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Record<string, unknown>
    const id = row['id']
    const name = row['name']
    if (typeof id !== 'string' || id.length === 0 || id.length > 64) continue
    const label = typeof name === 'string' ? name.trim().slice(0, MAX_EXTENSION_NAME_LENGTH) : ''
    extensions.push({
      id,
      name: label.length > 0 ? label : 'extension',
      hasPopup: row['hasPopup'] === true,
      hasOptions: row['hasOptions'] === true
    })
  }
  const rawOffer = record['offer']
  let offer: BrowserExtensionBarMenuInput['offer'] = null
  if (typeof rawOffer === 'object' && rawOffer !== null && !Array.isArray(rawOffer)) {
    const source = rawOffer as Record<string, unknown>
    const rawName = source['name']
    const rawVerb = source['installVerb']
    offer = {
      name:
        typeof rawName === 'string' && rawName.trim().length > 0
          ? rawName.trim().slice(0, MAX_EXTENSION_NAME_LENGTH)
          : null,
      installVerb:
        typeof rawVerb === 'string' && rawVerb.trim().length > 0
          ? rawVerb.trim().slice(0, 40)
          : null
    }
  }
  return { extensions, offer, installDoors: record['installDoors'] === true }
}
