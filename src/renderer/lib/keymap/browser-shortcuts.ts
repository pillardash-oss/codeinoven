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
  BrowserShortcutChord,
  BrowserSwitcherBindings
} from '$shared/ipc-contract'
import { invoke, subscribe } from '$lib/ipc.svelte'
import { isMacPlatform, KEYMAP, parseKeymapTrigger, resolveChordModifiers } from './keymap'

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
  ['designUndo', 'browser-design-undo'],
  ['designRedo', 'browser-design-redo'],
  ['closeTab', 'browser-close-tab'],
  ['newTab', 'browser-new-tab'],
  ['reopenTab', 'browser-reopen-tab'],
  ['find', 'browser-find'],
  ['findNext', 'browser-find-next'],
  ['findPrevious', 'browser-find-previous'],
  // The notes rail is this view's right sidebar, so it answers the same
  // user-visible binding every other view's right sidebar answers, and a user
  // rebind moves both at once.
  ['toggleNotes', 'nav-toggle-right-sidebar'],
  ...(
    [
      'nav-projects',
      'nav-threads',
      'nav-projects-with-scope',
      'nav-scope',
      'nav-chats',
      'nav-browser',
      'nav-assistant'
    ] as const
  ).map((id): readonly [BrowserShortcutAction, string] => [id, id])
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
 * The Ctrl+Tab switcher chords, resolved for this platform.
 *
 * The switcher is a global gesture, not a browser action, but a key pressed in a
 * native page never reaches the renderer. So its chords travel to main the same
 * way the browser table does: main claims them in the page and forwards the
 * gesture back. An unbound entry resolves to no chords, which leaves Ctrl+Tab to
 * the page.
 */
export function browserSwitcherChords(source: BrowserShortcutKeySource): BrowserSwitcherBindings {
  return resolveChords(source.keysFor('thread-switcher'), isMacPlatform())
}

/** The ids main already answers itself, so it must not also hand them back. */
const BROWSER_OWNED_IDS = new Set<string>([
  ...ACTION_ENTRIES.map(([, id]) => id),
  'thread-switcher'
])

/**
 * Keymap entries whose action belongs to the app's own rich text editor.
 *
 * A native page holds the OS keyboard through its own view, so the app's editor
 * can never be the focused surface at the same time, and the page's own inputs
 * and contenteditable regions answer these chords natively (undo, redo, bold,
 * italic). Handing one back would only `preventDefault` the page's own edit and
 * pull focus out of the document for a command nothing on the page could run,
 * exactly as claiming a modifier+arrow chord would (see
 * {@link PAGE_OWNED_ARROW_KEYS}). Derived from the `editor` category so a future
 * editor binding is covered without a second list to remember.
 */
const PAGE_OWNED_EDITOR_IDS: ReadonlySet<string> = new Set(
  (KEYMAP.categories.find((category) => category.id === 'editor')?.shortcuts ?? []).map(
    (shortcut) => shortcut.id
  )
)

/**
 * Keys that always belong to the page's own caret and scroll movement, so the
 * app must never claim them from a page.
 *
 * Modifier+arrow is a native movement gesture in every document: Option+Arrow
 * hops a word on macOS, Ctrl+Arrow does the same on Windows and Linux, and the
 * app knows this itself (the palette's back gesture is guarded so that
 * Option+ArrowLeft keeps its native word-jump while editing). The app's own
 * arrow bindings belong to surfaces that cannot hold the keyboard while a
 * native page does: the terminal translates Option/Ctrl+Arrow into word moves,
 * and a palette's back gesture never fires with a page focused. Claiming one
 * from the page would preventDefault the document's own gesture and pull focus
 * out of the page for a command nothing on that page could run, so a chord that
 * ends on an arrow is never handed back.
 */
const PAGE_OWNED_ARROW_KEYS: ReadonlySet<string> = new Set([
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright'
])

/**
 * Every chord the app itself answers, so a key pressed in a page still reaches
 * the app's own shortcuts.
 *
 * A page holds the OS keyboard through its own view, so `mod+k` never reaches
 * the renderer that owns the spotlight. The whole keymap therefore travels to
 * main, which claims a matching chord in the page and hands the key back. Three
 * rules keep that from eating the page's own shortcuts:
 *
 * - A chord the browser answers itself is claimed first and never reaches this
 *   table, so `mod+r` still reloads the page.
 * - A chord with no Command/Control/Alt is left alone entirely, because a bare
 *   key belongs to whatever the page is doing with it.
 * - A chord that ends on an arrow key is left alone entirely, because the page
 *   owns modifier+arrow for its own word, line and scroll movement; see
 *   {@link PAGE_OWNED_ARROW_KEYS}.
 */
export function appShortcutChords(source: BrowserShortcutKeySource): BrowserShortcutChord[] {
  const isMac = isMacPlatform()
  const chords = new Map<string, BrowserShortcutChord>()
  for (const category of KEYMAP.categories) {
    for (const shortcut of category.shortcuts) {
      if (BROWSER_OWNED_IDS.has(shortcut.id) || PAGE_OWNED_EDITOR_IDS.has(shortcut.id)) continue
      for (const chord of resolveChords(source.keysFor(shortcut.id), isMac)) {
        if (!chord.meta && !chord.control && !chord.alt) continue
        if (PAGE_OWNED_ARROW_KEYS.has(chord.key)) continue
        chords.set(`${chord.key}:${chord.meta}${chord.control}${chord.shift}${chord.alt}`, chord)
      }
    }
  }
  return [...chords.values()]
}

/**
 * Hand the table to the main process. Called on startup and on every keymap
 * change, so the reported chords are always the effective ones. A failure is
 * silent: the feature handlers are not registered until after the first paint,
 * and the browser keeps every app-level shortcut until the report lands.
 */
export function publishBrowserShortcutBindings(source: BrowserShortcutKeySource): void {
  void invoke('browser:setShortcutBindings', browserShortcutBindings(source)).catch(() => {})
  void invoke('browser:setSwitcherBindings', browserSwitcherChords(source)).catch(() => {})
  void invoke('browser:setAppShortcutChords', appShortcutChords(source)).catch(() => {})
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
  subscribe('browser:navigationKey', (chord) => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: chord.key,
        metaKey: chord.meta,
        ctrlKey: chord.control,
        shiftKey: chord.shift,
        altKey: chord.alt,
        bubbles: true,
        cancelable: true
      })
    )
  })
  publishBrowserShortcutBindings(source)
  subscribe('app:featuresReady', () => publishBrowserShortcutBindings(source))
}
