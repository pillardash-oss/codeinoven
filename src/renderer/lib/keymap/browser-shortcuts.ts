/**
 * Publishes the browser surface's reserved shortcuts to the main process.
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
 *
 * What the browser claims is deliberately only its own reserved chrome: reload,
 * hard reload, back, forward, focus the address bar, zoom, DevTools, and the tab
 * actions, which are the chords a normal browser reserves and no page can
 * answer. Everything a page can answer is left to it, and an app shortcut the
 * page did not handle is reported back up and replayed (see
 * {@link appShortcutChords}), so a page keeps its own find, bold and save while
 * Cmd/Ctrl+K still opens the app's spotlight from inside a page.
 */

import type {
  BrowserPageKey,
  BrowserShortcutAction,
  BrowserShortcutBindings,
  BrowserShortcutChord,
  BrowserSwitcherBindings
} from '$shared/ipc-contract'
import { invoke, subscribe } from '$lib/ipc.svelte'
import { KEYMAP, isMacPlatform, parseKeymapTrigger, resolveChordModifiers } from './keymap'

/**
 * The keymap entry behind each action. The ids are the user-visible catalog
 * (Settings > Keymap lists them and lets them be rebound); the actions are the
 * main process's vocabulary, which is what travels over IPC.
 *
 * Every entry here ends on a chord a browser reserves, so a page rarely answers
 * it and the app keeps `mod+r`, `mod+w` and the tab chords for itself. `savePage`
 * is the exception main treats as page-overridable (a site may draw its own Save);
 * find (`mod+f`, `mod+g`) and every app shortcut stay out of this table
 * altogether and travel the other way, as chords the page may keep.
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
  ['designUndo', 'browser-design-undo'],
  ['designRedo', 'browser-design-redo'],
  ['closeTab', 'browser-close-tab'],
  ['newTab', 'browser-new-tab'],
  ['reopenTab', 'browser-reopen-tab']
]

/** The ids main answers itself through the browser table, so the app-chord table
 *  must not also carry them and let a page override a reserved chord. */
const BROWSER_OWNED_IDS: ReadonlySet<string> = new Set<string>([
  ...ACTION_ENTRIES.map(([, id]) => id),
  'thread-switcher'
])

/**
 * Rich-text chords a page owns wherever it has a caret.
 *
 * Undo, redo, bold, italic and inline code are the page's own native editing
 * commands inside a focused input, a textarea or a `contenteditable`. A native
 * command does not mark the `keydown` as handled, so main would otherwise report
 * the chord as unhandled and steal the page's undo. Derived from the `editor`
 * category so a future editor binding is covered without a second list.
 */
const PAGE_OWNED_EDITOR_IDS: ReadonlySet<string> = new Set(
  (KEYMAP.categories.find((category) => category.id === 'editor')?.shortcuts ?? []).map(
    (shortcut) => shortcut.id
  )
)

/**
 * Keys that always belong to the page's own caret and scroll movement.
 *
 * Option/Control+Arrow is word-jump and scroll on every platform, and the app's
 * own arrow chords are surface-scoped (the terminal's word hop, the palette's
 * back gesture), so none of them can be a page shortcut the app should replay.
 */
const PAGE_OWNED_ARROW_KEYS: ReadonlySet<string> = new Set([
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright'
])

/**
 * App chords a page may never run, however unhandled it left the key.
 *
 * Both are bound to a chord a page has its own reason to use (`mod+d` is a
 * bookmark in Chrome, `mod+shift+d` is nothing) and neither is safe to fire from
 * a page the user was reading: one opens the delete-thread confirmation, the other
 * quits the app without asking. A shortcut belongs to a page's own focus and
 * needs the app's own focus to be the user's intent, which neither has.
 */
const PAGE_FORBIDDEN_IDS: ReadonlySet<string> = new Set(['app-quit-direct', 'nav-delete-thread'])

/**
 * Every app-global chord a page may override, as a flat chord list.
 *
 * A key pressed in a page never reaches the renderer, so an app shortcut the
 * page did not handle can only be recognised in main and replayed: this is that
 * set. It is every keymap entry except the browser's own table (already answered
 * in main), the editor chords a page owns wherever it has a caret, the chords a
 * page may never run (see {@link PAGE_FORBIDDEN_IDS}) and the arrow chords whose
 * app bindings are surface-scoped. Only chords that carry Command, Control or
 * Option/Alt are kept, because every app-global binding does and a plain key is
 * the page's.
 */
export function appShortcutChords(source: BrowserShortcutKeySource): BrowserShortcutChord[] {
  const isMac = isMacPlatform()
  const chords: BrowserShortcutChord[] = []
  const seen = new Set<string>()
  // A chord the browser table already answers is matched before this table, so an
  // app entry that shares one (close-surface and close-tab on `mod+w`,
  // history-back and browser-back on `mod+[`) must not travel here again.
  const browserOwned = new Set<string>()
  for (const bound of Object.values(browserShortcutBindings(source))) {
    for (const chord of bound ?? []) browserOwned.add(chordSignature(chord))
  }
  const push = (chord: BrowserShortcutChord): void => {
    const signature = chordSignature(chord)
    if (seen.has(signature) || browserOwned.has(signature)) return
    seen.add(signature)
    chords.push(chord)
  }
  for (const category of KEYMAP.categories) {
    for (const shortcut of category.shortcuts) {
      if (BROWSER_OWNED_IDS.has(shortcut.id)) continue
      if (PAGE_OWNED_EDITOR_IDS.has(shortcut.id)) continue
      if (PAGE_FORBIDDEN_IDS.has(shortcut.id)) continue
      for (const chord of resolveChords(source.keysFor(shortcut.id), isMac)) {
        if (PAGE_OWNED_ARROW_KEYS.has(chord.key)) continue
        if (!chord.meta && !chord.control && !chord.alt) continue
        push(chord)
      }
    }
  }
  return chords
}

/** A chord's identity, for de-duplication and for comparing two tables. */
function chordSignature(chord: BrowserShortcutChord): string {
  return `${chord.key}|${chord.meta}|${chord.control}|${chord.alt}|${chord.shift}`
}

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
 * The Ctrl+Tab switcher chords, resolved for this platform.
 *
 * The switcher is a global gesture, not a browser action, but a key pressed in a
 * native page never reaches the renderer. So its chords travel to main the same
 * way the browser table does: main claims them in the page and forwards the
 * gesture back. Ctrl+Tab is a chord every browser reserves, so the page loses
 * nothing it could have answered. An unbound entry resolves to no chords, which
 * leaves Ctrl+Tab to the page.
 */
export function browserSwitcherChords(source: BrowserShortcutKeySource): BrowserSwitcherBindings {
  return resolveChords(source.keysFor('thread-switcher'), isMacPlatform())
}

/**
 * Hand the tables to the main process. Called on startup and on every keymap
 * change, so the reported chords are always the effective ones. A failure is
 * silent: the feature handlers are not registered until after the first paint,
 * and the browser keeps every app-level shortcut until the report lands.
 */
export function publishBrowserShortcutBindings(source: BrowserShortcutKeySource): void {
  void invoke('browser:setShortcutBindings', browserShortcutBindings(source)).catch(() => {})
  void invoke('browser:setSwitcherBindings', browserSwitcherChords(source)).catch(() => {})
  void invoke('browser:setAppShortcutChords', appShortcutChords(source)).catch(() => {})
}

/**
 * Replay an app shortcut a page reported as unhandled.
 *
 * The chord is rebuilt as a real `KeyboardEvent` and dispatched into the app's
 * own document, so every existing keymap handler runs exactly as if the key had
 * been pressed over the app's chrome. Main only forwards chords from the app's
 * keymap, so an unknown chord cannot reach here.
 */
function replayPageKey(key: BrowserPageKey): void {
  document.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: key.key,
      code: key.code,
      metaKey: key.meta,
      ctrlKey: key.control,
      shiftKey: key.shift,
      altKey: key.alt,
      repeat: key.repeat,
      bubbles: true,
      cancelable: true,
      composed: true
    })
  )
}

/** Whether {@link installBrowserShortcutPublishing} has already run. */
let publishingInstalled = false

/**
 * Keep main's copy of the browser's chords current for the whole session.
 *
 * The keymap pushes its chords whenever the config loads or the user rebinds
 * one, but the browser's handlers in main are window-bound and registered after
 * the first paint, so a push that lands before they exist is dropped and the
 * browser would claim none of its shortcuts until the next keymap change. This
 * publishes once outright and again on every `app:featuresReady`, which main
 * sends after those handlers exist, so the chords are always the effective ones
 * on the window actually on screen.
 *
 * Called once by the browser runtime, because a session that never opens the
 * browser needs no chords claimed for it.
 */
export function installBrowserShortcutPublishing(source: BrowserShortcutKeySource): void {
  if (publishingInstalled) return
  publishingInstalled = true
  subscribe('browser:pageKey', (key) => replayPageKey(key))
  publishBrowserShortcutBindings(source)
  subscribe('app:featuresReady', () => publishBrowserShortcutBindings(source))
}
