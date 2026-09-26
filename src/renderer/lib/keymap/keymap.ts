import keymapData from './keymap.json'
import { isMacPlatform } from '$lib/shortcut-display'

/**
 * A single shortcut entry in the keymap registry. `keys` uses symbolic tokens:
 * `mod` (⌘ on macOS / Ctrl elsewhere), `shift`, `alt`, `cmd`, `ctrl`,
 * `double-mod` (the primary modifier tapped twice in quick succession), and
 * plain keys like `enter`, `escape`, `tab`, `space`, `backspace`, `arrowup`,
 * `arrowdown`, `arrowleft`, `arrowright`, `home`, `end`, `click`, letters, and
 * digits.
 *
 * `keys` is both the display list and the trigger: it is parsed into an
 * executable binding by {@link parseKeymapTrigger}. An entry with no keys is
 * intentionally unbound, so a user can assign their own key to a function the
 * app ships without a default.
 */
export interface KeymapShortcut {
  id: string
  keys: string[]
  /** Key tokens that replace `keys` on the matching platform, for actions
   *  whose modifier differs per OS (Option on macOS vs Ctrl/Alt elsewhere).
   *  `mac` covers macOS; `other` covers Windows and Linux. Omitted platforms
   *  fall back to `keys`. */
  platformKeys?: PlatformKeyOverrides
  label: string
  description: string
  scenario: string
}

/** Per-platform replacement key tokens; see {@link KeymapShortcut.platformKeys}. */
export interface PlatformKeyOverrides {
  mac?: string[]
  other?: string[]
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

/** The full shortcut catalog   single source of truth for the app's keymap. */
export const KEYMAP: KeymapRegistry = keymapData as unknown as KeymapRegistry

/** Platform detection is shared with the action model's display helpers so the
 *  registry and the rest of the app never disagree about the platform. */
export { isMacPlatform }

// ─── Trigger model ────────────────────────────────────────────────────────
//
// The registry's `keys` array is a compact, human-readable trigger grammar.
// Parsing it yields a precise {@link KeymapTrigger} so handlers never compare
// raw key literals: they ask the registry whether an event matches an id.
//
// Grammar, by example:
//   ['mod', 'n']                       one chord: primary modifier + N
//   ['mod', 'shift', 'n']              one chord: two modifiers + N
//   ['escape', 'escape']               the same key pressed twice in a row
//   ['alt', 'alt']                     a bare modifier tapped twice
//   ['double-mod']                     the primary modifier tapped twice
//   ['arrowup', 'arrowdown']           either key (alternatives)
//   ['mod', '[', 'alt', 'arrowleft']   either chord (per-platform alternatives)
//   []                                 unbound: the user may assign a key
//
// A modifier token applies to every key that follows it until the next
// modifier token, so `['alt', 'arrowleft', 'arrowright']` is Alt+Left or
// Alt+Right. Repeated identical chords collapse into a press count.

export type ModifierToken = 'mod' | 'shift' | 'alt' | 'cmd' | 'ctrl'

const MODIFIER_TOKENS: ReadonlySet<string> = new Set<ModifierToken>([
  'mod',
  'shift',
  'alt',
  'cmd',
  'ctrl'
])

/** A single press: the listed modifiers held plus one key. */
export interface KeymapChord {
  modifiers: ModifierToken[]
  key: string
}

export type KeymapTrigger =
  /** Any one of these chords triggers the shortcut. */
  | { kind: 'chords'; chords: KeymapChord[] }
  /** The same chord pressed `count` times in a row (double Escape, double Alt). */
  | { kind: 'repeat'; chord: KeymapChord; count: number }
  /** The primary modifier tapped twice in quick succession. */
  | { kind: 'double-mod' }

export type KeymapTriggerParse =
  /** No keys at all: the entry exists so a user can bind it later. */
  | { kind: 'unbound' }
  /** A precise, executable trigger. */
  | { kind: 'binding'; trigger: KeymapTrigger }
  /** Keys that describe contextual widget behavior and are not one trigger. */
  | { kind: 'descriptive' }

function isModifierToken(token: string): token is ModifierToken {
  return MODIFIER_TOKENS.has(token)
}

/** Parse a registry `keys` array into an executable trigger, or classify why
 *  it is not one. Never throws: unknown shapes become `descriptive`. */
export function parseKeymapTrigger(keys: readonly string[]): KeymapTriggerParse {
  if (keys.length === 0) return { kind: 'unbound' }
  if (keys.length === 1 && keys[0] === 'double-mod') {
    return { kind: 'binding', trigger: { kind: 'double-mod' } }
  }

  // A run of identical modifier tokens is a bare-modifier tap (`alt alt`,
  // `mod mod`) rather than a chord: a bare modifier has no key. A lone
  // modifier token is not a shortcut at all.
  if (keys.length > 1 && keys.every(isModifierToken) && new Set(keys).size === 1) {
    return {
      kind: 'binding',
      trigger: { kind: 'repeat', chord: { modifiers: [], key: keys[0] }, count: keys.length }
    }
  }

  const chords: KeymapChord[] = []
  let modifiers: ModifierToken[] = []
  let producedKey = false
  let trailingModifier = false
  for (const token of keys) {
    if (isModifierToken(token)) {
      // A modifier token that follows a key starts a new group, so
      // `['mod','[','alt','arrowleft']` is Cmd+[ or Alt+Left rather than a
      // four-key chord. Modifiers with no key between them stack instead.
      if (producedKey) {
        modifiers = []
        producedKey = false
      }
      modifiers.push(token)
      trailingModifier = true
      continue
    }
    chords.push({ modifiers: [...modifiers], key: token })
    // A leading modifier applies to every following key until the next
    // modifier token, so `['alt','arrowleft','arrowright']` keeps Alt on both.
    producedKey = true
    trailingModifier = false
  }

  // A trailing modifier with no key means the entry is not a single trigger.
  if (trailingModifier || chords.length === 0) return { kind: 'descriptive' }

  // Repeated identical chords are a press sequence, not alternatives.
  const first = chords[0]
  const allSame = chords.every(
    (chord) => chord.key === first.key && sameModifiers(chord.modifiers, first.modifiers)
  )
  if (allSame && chords.length > 1) {
    return { kind: 'binding', trigger: { kind: 'repeat', chord: first, count: chords.length } }
  }

  return { kind: 'binding', trigger: { kind: 'chords', chords } }
}

function sameModifiers(a: readonly ModifierToken[], b: readonly ModifierToken[]): boolean {
  if (a.length !== b.length) return false
  const sortedA = [...a].sort()
  const sortedB = [...b].sort()
  return sortedA.every((token, index) => token === sortedB[index])
}

/** Normalize an event's `key` into a registry token. */
export function eventKeyToken(event: KeyboardEvent): string {
  const key = event.key
  if (key === ' ' || key === 'Spacebar') return 'space'
  return key.toLowerCase()
}

/** Resolve a bare-modifier token to the `event.key` a bare tap produces. */
function bareModifierKeyToken(token: string, isMac: boolean): string | null {
  switch (token) {
    case 'alt':
      return 'alt'
    case 'shift':
      return 'shift'
    case 'ctrl':
      return 'control'
    case 'cmd':
      return 'meta'
    case 'mod':
      return isMac ? 'meta' : 'control'
    default:
      return null
  }
}

/** The concrete modifier set a chord requires on one platform: `mod` is Command
 *  on macOS and Control elsewhere. Shared by the matcher and by every consumer
 *  that has to describe a chord outside this module (the browser surface pushes
 *  its resolved chords to the main process, which never sees the tokens). */
export interface ResolvedChordModifiers {
  meta: boolean
  control: boolean
  shift: boolean
  alt: boolean
}

/** Resolve a chord's modifiers for a platform. */
export function resolveChordModifiers(
  chord: KeymapChord,
  isMac = isMacPlatform()
): ResolvedChordModifiers {
  return {
    meta: chord.modifiers.includes('cmd') || (chord.modifiers.includes('mod') && isMac),
    control: chord.modifiers.includes('ctrl') || (chord.modifiers.includes('mod') && !isMac),
    shift: chord.modifiers.includes('shift'),
    alt: chord.modifiers.includes('alt')
  }
}

/** True when an event is one press of a chord, with no extra modifiers held. */
function chordMatches(chord: KeymapChord, event: KeyboardEvent, isMac: boolean): boolean {
  const wants = resolveChordModifiers(chord, isMac)
  if (event.metaKey !== wants.meta) return false
  if (event.ctrlKey !== wants.control) return false
  if (event.shiftKey !== wants.shift) return false
  if (event.altKey !== wants.alt) return false
  return eventKeyToken(event) === chord.key
}

/** True when an event is one press of a chord that may be a bare modifier tap. */
function pressMatches(chord: KeymapChord, event: KeyboardEvent, isMac: boolean): boolean {
  if (chord.modifiers.length === 0 && isModifierToken(chord.key)) {
    return eventKeyToken(event) === bareModifierKeyToken(chord.key, isMac)
  }
  return chordMatches(chord, event, isMac)
}

/** True when a keyboard event is one press that belongs to the given trigger.
 *  Repeat triggers (double Escape, double Alt) match a single press here; the
 *  caller owns the timing window between presses. */
export function triggerMatches(
  trigger: KeymapTrigger,
  event: KeyboardEvent,
  isMac = isMacPlatform()
): boolean {
  switch (trigger.kind) {
    case 'chords':
      return trigger.chords.some((chord) => chordMatches(chord, event, isMac))
    case 'repeat':
      return pressMatches(trigger.chord, event, isMac)
    case 'double-mod':
      return false
  }
}

// ─── Display ──────────────────────────────────────────────────────────────

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
    case 'double-mod':
      return isMac ? '⌘ ⌘' : 'Ctrl Ctrl'
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

function chordLabel(chord: KeymapChord, isMac: boolean): string {
  const modifiers = chord.modifiers.map((token) => keyTokenLabel(token, isMac))
  const key = keyTokenLabel(chord.key, isMac)
  return isMac ? `${modifiers.join('')}${key}` : [...modifiers, key].join('+')
}

/** Render a registry `keys` array as one display string per alternative.
 *  `['mod','[']` → `['⌘[']` on macOS; `['arrowup','arrowdown']` → `['↑','↓']`. */
export function keymapKeyGroups(keys: readonly string[], isMac = isMacPlatform()): string[] {
  const parsed = parseKeymapTrigger(keys)
  if (parsed.kind === 'unbound') return []
  if (parsed.kind === 'descriptive') {
    return [keys.map((key) => keyTokenLabel(key, isMac)).join(isMac ? '' : '+')]
  }
  const { trigger } = parsed
  if (trigger.kind === 'double-mod') return [keyTokenLabel('double-mod', isMac)]
  if (trigger.kind === 'repeat') {
    const label = chordLabel(trigger.chord, isMac)
    return Array.from({ length: trigger.count }, () => label)
  }
  return trigger.chords.map((chord) => chordLabel(chord, isMac))
}

/** Renders a shortcut's keys as one platform-aware display string.
 *  Alternatives are separated by ` / `; macOS uses symbol chords (⌘⇧N),
 *  Windows/Linux use joined names (Ctrl+Shift+N). */
export function formatKeyCombo(keys: readonly string[], isMac = isMacPlatform()): string {
  return keymapKeyGroups(keys, isMac).join(' / ')
}

const KEYMAP_BY_ID: Map<string, KeymapShortcut> = new Map(
  KEYMAP.categories.flatMap((category) =>
    category.shortcuts.map((shortcut) => [shortcut.id, shortcut] as const)
  )
)

/** Key tokens for a keymap entry id, resolved for the current platform, e.g.
 *  'nav-new-thread' → ['mod', 'n']. Returns an empty array for unknown ids so
 *  call sites can render nothing. */
export function keymapKeys(id: string, isMac = isMacPlatform()): readonly string[] {
  const shortcut = KEYMAP_BY_ID.get(id)
  if (!shortcut) return []
  const platformKeys = isMac ? shortcut.platformKeys?.mac : shortcut.platformKeys?.other
  return platformKeys ?? shortcut.keys
}

/** Parse a user override value into registry key tokens. Accepts a
 *  whitespace-separated list (`"escape escape"`) and a `+`-joined chord
 *  (`"mod+shift+n"`); an empty string unbinds the entry. */
export function parseKeymapOverride(value: string): string[] {
  return value
    .split(/[\s+]+/)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0)
}
