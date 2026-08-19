import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'

interface KeyboardShortcutInput {
  type: string
  key: string
  code: string
  shift: boolean
  control: boolean
  alt: boolean
  meta: boolean
}

function isBlockedProductionShortcut(input: KeyboardShortcutInput): boolean {
  if (input.type !== 'keyDown') return false

  const key = input.key.toLowerCase()
  const code = input.code.toLowerCase()
  const primaryModifier = input.control || input.meta

  const isReload =
    key === 'f5' ||
    code === 'f5' ||
    (primaryModifier && key === 'r') ||
    (primaryModifier && code === 'keyr')
  const isDeveloperTools =
    key === 'f12' ||
    code === 'f12' ||
    (input.control && input.shift && ['c', 'i', 'j'].includes(key)) ||
    (input.meta && input.alt && ['c', 'i', 'j'].includes(key))

  return isReload || isDeveloperTools
}

/**
 * Remove menu entries that can reload the renderer or open Chromium developer
 * tools. macOS requires an application menu, while Windows and Linux can omit it.
 */
export function installProductionApplicationMenu(appName: string): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }

  const template: MenuItemConstructorOptions[] = [
    {
      label: appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    { role: 'windowMenu' }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** Block renderer reload and developer-tool accelerators in production. */
export function lockDownProductionWindow(window: BrowserWindow): void {
  window.webContents.on('before-input-event', (event, input) => {
    if (isBlockedProductionShortcut(input)) {
      event.preventDefault()
    }
  })
}
