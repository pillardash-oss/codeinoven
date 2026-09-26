/**
 * Publishes the browser surface's shortcuts to the main process.
 *
 * The embedded browser renders a native `WebContentsView`, so a key pressed in
 * the page never reaches this renderer's DOM handlers, and a key pressed in the
 * browser toolbar would reach the application menu before any renderer handler.
 * Both have to be claimed in `before-input-event` in the main process, which
 * holds no keymap. Rather than grow a second copy of the trigger grammar there,
 * the keymap's `browser` category is resolved here into platform-explicit chords
 * (the `mod` token already turned into Command or Control) and pushed over as
 * data. A user override therefore changes what the browser claims, and an
 * unbound entry leaves the key to the rest of the app.
 */

import type {
  BrowserShortcutAction,
  BrowserShortcutBindings,
  BrowserShortcutChord
} from '$shared/ipc-contract'
import { invoke } from '$lib/ipc.svelte'
import { isMacPlatform, parseKeymapTrigger, resolveChordModifiers } from './keymap'

/**
 * The keymap entry behind each action. The ids are the user-visible catalog
 * (Settings > Keymap lists them and lets them be rebound); the actions are the
 * main process's vocabulary, which is what travels over IPC.
 */
const ACTION_ENTRIES: ReadonlyArray<readonly [BrowserShortcutAction, string]> = [
  ['reload', 'browser-reload'],
  ['hardReload', 'browser-hard-reload'],
  ['back', 'browser-back'],
  ['forward', 'browser-forward'],
  ['focusAddress', 'browser-focus-address'],
  ['savePage', 'browser-save-page'],
  ['zoomIn', 'browser-zoom-in'],
  ['zoomOut', 'browser-zoom-out'],
  ['zoomReset', 'browser-zoom-reset'],
  ['toggleDevTools', 'browser-devtools'],
  ['closeTab', 'browser-close-tab'],
  ['newTab', 'browser-new-tab']
]

/** Only the effective key tokens per id are needed, which is what the keymap
 *  store exposes. Taking the reader as an argument keeps this module free of a
 *  cycle back into that store. */
export interface BrowserShortcutKeySource {
  keysFor: (id: string) => readonly string[]
}

/**
 * Resolve an entry's keys into chords main can match.
 *
 * A repeat gesture (a double Escape, a double tap of the modifier) and a
 * descriptive entry are not single chords, so they bind nothing here: the
 * browser claims plain chords only.
 */
function resolveChords(keys: readonly string[], isMac: boolean): BrowserShortcutChord[] {
  const parsed = parseKeymapTrigger(keys)
  if (parsed.kind !== 'binding' || parsed.trigger.kind !== 'chords') return []
  return parsed.trigger.chords.map((chord) => {
    const modifiers = resolveChordModifiers(chord, isMac)
    return { key: chord.key, ...modifiers }
  })
}

/** The current browser shortcut table, resolved for this platform. */
export function browserShortcutBindings(source: BrowserShortcutKeySource): BrowserShortcutBindings {
  const isMac = isMacPlatform()
  const bindings: BrowserShortcutBindings = {}
  for (const [action, id] of ACTION_ENTRIES) {
    const chords = resolveChords(source.keysFor(id), isMac)
    if (chords.length > 0) bindings[action] = chords
  }
  return bindings
}

/**
 * Hand the table to the main process. Called on startup and on every keymap
 * change, so the reported chords are always the effective ones. A failure is
 * silent: the feature handlers are not registered until after the first paint,
 * and the browser keeps every app-level shortcut until the report lands.
 */
export function publishBrowserShortcutBindings(source: BrowserShortcutKeySource): void {
  void invoke('browser:setShortcutBindings', browserShortcutBindings(source)).catch(() => {})
}
