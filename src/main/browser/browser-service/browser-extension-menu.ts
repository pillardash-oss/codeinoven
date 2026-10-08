import { Menu, type BrowserWindow } from 'electron'
import type {
  BrowserExtensionMenuChoice,
  BrowserExtensionMenuInput
} from '../../../lib/browser/browser-extension-menu'

/**
 * Native context menu for one browser extension.
 *
 * One menu serves header pins and panel rows, because both act on the same
 * extension and the choice travels back the same way.-resolves null when the
 * menu is dismissed.
 */
export function showBrowserExtensionMenu(
  window: BrowserWindow,
  input: BrowserExtensionMenuInput,
  x: number,
  y: number
): Promise<BrowserExtensionMenuChoice | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (choice: BrowserExtensionMenuChoice | null): void => {
      if (settled) return
      settled = true
      resolve(choice)
    }
    const click = (choice: BrowserExtensionMenuChoice) => (): void => finish(choice)
    const menu = Menu.buildFromTemplate([
      {
        label: `Open ${input.extensionName} popup`,
        enabled: input.hasPopup && input.enabled && input.runsInJar,
        click: click('open-popup')
      },
      {
        label: `Open ${input.extensionName} setup page`,
        enabled: input.hasOptions && input.enabled && input.runsInJar,
        click: click('open-options')
      },
      { type: 'separator' },
      {
        label: input.enabled ? `Disable ${input.extensionName}` : `Enable ${input.extensionName}`,
        click: click('toggle-enabled')
      },
      {
        label: input.pinned
          ? `Unpin ${input.extensionName}`
          : `Pin ${input.extensionName} to header`,
        enabled: input.pinned || (input.hasPopup && !input.pinCapReached),
        click: click('toggle-pin')
      },
      { type: 'separator' },
      {
        label:
          input.host !== null
            ? input.runsOnHost
              ? `Disable on ${input.host}`
              : `Enable on ${input.host}`
            : 'Disable on this site',
        enabled: input.host !== null && input.enabled,
        click: click(input.runsOnHost ? 'block-site' : 'allow-site')
      },
      {
        label: 'Clear per-site rules',
        enabled: true,
        click: click('clear-site-rules')
      },
      { type: 'separator' },
      { label: 'Manage extensions', click: click('manage') },
      { label: `Remove ${input.extensionName}`, click: click('remove') }
    ])
    menu.popup({
      window,
      x,
      y,
      callback: () => finish(null)
    })
  })
}

/** Validate the renderer input for the native extension menu. */
export function validateBrowserExtensionMenuInput(value: unknown): BrowserExtensionMenuInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Browser extension menu input is invalid')
  }
  const record = value as Record<string, unknown>
  const extensionId = record['extensionId']
  const extensionName = record['extensionName']
  const host = record['host']
  if (typeof extensionId !== 'string' || extensionId.length === 0 || extensionId.length > 64) {
    throw new TypeError('Browser extension menu extension ID is invalid')
  }
  if (
    typeof extensionName !== 'string' ||
    extensionName.length === 0 ||
    extensionName.length > 200
  ) {
    throw new TypeError('Browser extension menu extension name is invalid')
  }
  return {
    extensionId,
    extensionName: extensionName.trim().slice(0, 200) || 'extension',
    enabled: record['enabled'] === true,
    pinned: record['pinned'] === true,
    pinCapReached: record['pinCapReached'] === true,
    hasPopup: record['hasPopup'] === true,
    hasOptions: record['hasOptions'] === true,
    host: typeof host === 'string' && host.length > 0 && host.length <= 260 ? host : null,
    runsOnHost: record['runsOnHost'] !== false,
    runsInJar: record['runsInJar'] !== false
  }
}
