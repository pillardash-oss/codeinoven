/**
 * Keyboard resolution for the embedded browser.
 *
 * A browser tab is a native `WebContentsView`, so its keys never reach the
 * renderer's DOM handlers. Left alone they reach the application menu instead,
 * and in a development build that menu is Electron's default: Cmd/Ctrl+R there
 * reloads the app window, Cmd/Ctrl+W closes it, Cmd/Ctrl+0 opens the Chats
 * view and Cmd/Ctrl+S folds the left sidebar. A user typing an address or
 * clicking in a page expects those keys to act on the page.
 *
 * So the chords are claimed in the main process, where a key is visible before
 * the menu acts on it (`webContents.on('before-input-event')`, whose own
 * documentation states that preventing the event also prevents the menu
 * shortcut). The chords themselves come from the renderer: the keymap's
 * `browser` category, resolved per platform, so a user override wins and this
 * process never grows a second copy of the trigger grammar.
 */

import type {
  BrowserShortcutAction,
  BrowserShortcutBindings,
  BrowserShortcutChord
} from '../../../lib/ipc/browser'

/**
 * The part of Electron's `Input` a chord decision needs, declared structurally
 * rather than as `Electron.Input` so this module carries no Electron import of
 * its own (the same narrowing `production-housekeeping.ts` uses).
 */
export interface ShortcutKeyInput {
  type: string
  key: string
  meta: boolean
  control: boolean
  shift: boolean
  alt: boolean
  isAutoRepeat: boolean
}

/**
 * Actions a held key may repeat. Zoom is Chrome's: holding Cmd/Ctrl+= keeps
 * stepping while reload, navigation and tab actions are one press each, because
 * auto-repeat would reload a page or open tabs in a burst.
 */
const REPEATABLE_ACTIONS: ReadonlySet<BrowserShortcutAction> = new Set<BrowserShortcutAction>([
  'zoomIn',
  'zoomOut'
])

function chordMatchesInput(chord: BrowserShortcutChord, input: ShortcutKeyInput): boolean {
  if (input.meta !== chord.meta) return false
  if (input.control !== chord.control) return false
  if (input.alt !== chord.alt) return false
  const key = input.key.toLowerCase()
  if (key === chord.key) return input.shift === chord.shift
  // Shift and the `=` key produce `+` on most layouts, so a chord stored on `=`
  // also answers the shifted glyph. Chrome's zoom-in accepts both for the same
  // reason, and no other browser chord ends on a shifted character.
  return chord.key === '=' && key === '+' && input.shift
}

/**
 * The action a key press claims for the browser, or null when the browser has
 * no binding for it and the key belongs to the rest of the app.
 */
export function matchBrowserShortcut(
  input: ShortcutKeyInput,
  bindings: BrowserShortcutBindings
): BrowserShortcutAction | null {
  if (input.type !== 'keyDown') return null
  for (const action of Object.keys(bindings) as BrowserShortcutAction[]) {
    const chords = bindings[action]
    if (!chords || chords.length === 0) continue
    if (input.isAutoRepeat && !REPEATABLE_ACTIONS.has(action)) continue
    if (chords.some((chord) => chordMatchesInput(chord, input))) return action
  }
  return null
}
