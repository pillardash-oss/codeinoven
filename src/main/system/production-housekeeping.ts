import type { BrowserWindow } from 'electron'

interface KeyboardShortcutInput {
  type: string
  key: string
  code: string
  shift: boolean
  alt: boolean
  control: boolean
  meta: boolean
  isAutoRepeat: boolean
}

function isProductionReloadShortcut(input: KeyboardShortcutInput): boolean {
  if (input.type !== 'keyDown') return false

  const key = input.key.toLowerCase()
  const code = input.code.toLowerCase()
  const primaryModifier = input.control || input.meta

  return (
    key === 'f5' ||
    code === 'f5' ||
    (primaryModifier && key === 'r') ||
    (primaryModifier && code === 'keyr')
  )
}

function isToggleDevToolsShortcut(input: KeyboardShortcutInput): boolean {
  if (input.type !== 'keyDown' || input.isAutoRepeat) return false

  const key = input.key.toLowerCase()
  const code = input.code.toLowerCase()
  const isInspectKey = key === 'i' || code === 'keyi'

  return (
    key === 'f12' ||
    code === 'f12' ||
    (input.control && input.shift && isInspectKey) ||
    (input.meta && input.alt && isInspectKey)
  )
}

/** Keep reload disabled while exposing a menu-independent DevTools shortcut. */
export function lockDownProductionWindow(window: BrowserWindow): void {
  window.webContents.on('before-input-event', (event, input) => {
    if (isToggleDevToolsShortcut(input)) {
      event.preventDefault()
      window.webContents.toggleDevTools()
      return
    }

    if (isProductionReloadShortcut(input)) {
      event.preventDefault()
    }
  })
}
