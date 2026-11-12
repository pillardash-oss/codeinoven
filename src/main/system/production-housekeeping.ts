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

function isDevToolsShortcut(input: KeyboardShortcutInput): boolean {
  if (input.type !== 'keyDown') return false

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

/**
 * Keep reload and DevTools out of a shipped build.
 *
 * The window's own `devTools: false` already refuses to open the inspector; the
 * chord is intercepted here as well so a shipped build never even reaches the
 * toggle. Development keeps both, since reload and the inspector are the tools
 * that work is done with.
 */
export function lockDownProductionWindow(window: BrowserWindow): void {
  window.webContents.on('before-input-event', (event, input) => {
    if (isDevToolsShortcut(input) || isProductionReloadShortcut(input)) {
      event.preventDefault()
    }
  })
}
