import keymapData from './keymap.json'

/**
 * A single shortcut entry in the keymap registry. `keys` uses symbolic tokens:
 * `mod` (⌘ on macOS / Ctrl elsewhere), `shift`, `alt`, `cmd`, `ctrl`, and plain
 * keys like `enter`, `escape`, `tab`, `space`, `backspace`, `arrowup`,
 * `arrowdown`, `arrowleft`, `arrowright`, `home`, `end`, `click`, letters, and
 * digits.
 */
export interface KeymapShortcut {
  id: string
  keys: string[]
  label: string
  description: string
  scenario: string
}

export interface KeymapCategory {
  id: string
  label: string
  shortcuts: KeymapShortcut[]
}

export interface KeymapRegistry {
  version: number
  categories: KeymapCategory[]
}

/** The full shortcut catalog — single source of truth for the app's keymap. */
export const KEYMAP: KeymapRegistry = keymapData as unknown as KeymapRegistry

export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0
}

/** Maps a symbolic key token to its display label for the current platform. */
export function keyTokenLabel(key: string, isMac: boolean): string {
  switch (key) {
    case 'mod':
      return isMac ? '⌘' : 'Ctrl'
    case 'shift':
      return isMac ? '⇧' : 'Shift'
    case 'alt':
      return isMac ? '⌥' : 'Alt'
    case 'cmd':
      return '⌘'
    case 'ctrl':
      return 'Ctrl'
    case 'enter':
      return 'Enter'
    case 'escape':
      return 'Esc'
    case 'space':
      return 'Space'
    case 'tab':
      return 'Tab'
    case 'backspace':
      return isMac ? '⌫' : 'Backspace'
    case 'arrowup':
      return isMac ? '↑' : 'Up'
    case 'arrowdown':
      return isMac ? '↓' : 'Down'
    case 'arrowleft':
      return isMac ? '←' : 'Left'
    case 'arrowright':
      return isMac ? '→' : 'Right'
    case 'home':
      return 'Home'
    case 'end':
      return 'End'
    case 'click':
      return isMac ? 'Click' : 'Click'
    case 'comma':
      return ','
    default:
      return key.length === 1 ? key.toUpperCase() : key
  }
}

/** Renders a shortcut's keys as one platform-aware display string.
 *  macOS uses symbol chords (⌘⇧N); Windows/Linux use joined names (Ctrl+Shift+N). */
export function formatKeyCombo(keys: readonly string[], isMac = isMacPlatform()): string {
  return keys.map((key) => keyTokenLabel(key, isMac)).join(isMac ? '' : '+')
}
