import { isMacPlatform } from '$lib/shortcut-display'
import { parseKeymapTrigger, resolveChordModifiers } from './keymap'

/**
 * Turn the keymap's region-screenshot entry into a system-wide accelerator.
 *
 * The capture has to be startable while the browser or another app owns the
 * keyboard, so the chord is claimed by the main process rather than handled by a
 * window. The keymap stays the one catalog the user rebinds; this module is the
 * only place its symbolic tokens become an Electron accelerator.
 *
 * Pure key resolution with no IPC or store import, so the mapping can be checked
 * without a running renderer.
 */

/** Key tokens Electron names differently from the keymap grammar. */
const ACCELERATOR_KEYS: Readonly<Record<string, string>> = {
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  escape: 'Esc',
  esc: 'Esc',
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  space: 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  ';': 'Semicolon',
  "'": 'Quote',
  '[': '[',
  ']': ']',
  '\\': '\\',
  '-': '-',
  '=': '=',
  '`': '`'
}

function acceleratorKey(token: string): string | null {
  const named = ACCELERATOR_KEYS[token]
  if (named) return named
  if (/^[a-z]$/u.test(token)) return token.toUpperCase()
  if (/^[0-9]$/u.test(token)) return token
  if (/^f(?:[1-9]|1[0-9]|2[0-4])$/u.test(token)) return token.toUpperCase()
  return null
}

/** The accelerator a keymap entry describes, or null when it binds no single
 *  chord (unbound, descriptive, or a repeat gesture). */
export function acceleratorForKeys(
  keys: readonly string[],
  isMac = isMacPlatform()
): string | null {
  const parsed = parseKeymapTrigger(keys)
  if (parsed.kind !== 'binding' || parsed.trigger.kind !== 'chords') return null
  const chord = parsed.trigger.chords[0]
  if (!chord) return null
  const key = acceleratorKey(chord.key)
  if (!key) return null
  const modifiers = resolveChordModifiers(chord, isMac)
  const parts: string[] = []
  if (modifiers.control) parts.push('Control')
  if (modifiers.meta) parts.push('Command')
  if (modifiers.alt) parts.push('Alt')
  if (modifiers.shift) parts.push('Shift')
  // A global chord always carries a modifier, so a bare key can never be claimed
  // from every other app on the machine.
  if (parts.length === 0) return null
  parts.push(key)
  return parts.join('+')
}

/**
 * The chords macOS claims for its own screenshot service.
 *
 * `globalShortcut.register` happily answers true for these and the system still
 * wins the keypress, so the app's action never runs while the user sees the
 * platform's screenshot UI. They are refused rather than registered, so the
 * keymap can say why instead of leaving a dead shortcut behind.
 */
const MAC_SCREENSHOT_ACCELERATORS: ReadonlySet<string> = new Set([
  'Command+Shift+3',
  'Command+Shift+4',
  'Command+Shift+5',
  'Command+Shift+6',
  'Command+Shift+7'
])

/** Whether macOS owns this chord for a screenshot of its own. */
export function isMacScreenshotAccelerator(accelerator: string): boolean {
  return MAC_SCREENSHOT_ACCELERATORS.has(accelerator)
}
