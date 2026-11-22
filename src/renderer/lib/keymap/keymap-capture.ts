/**
 * Turn a real key press into keymap tokens.
 *
 * The settings capture control owns the keyboard while it listens, so this is
 * the one place a `KeyboardEvent` becomes the symbolic tokens the registry and
 * the config speak (`mod`, `shift`, `escape`, `arrowup`, …). Platform modifiers
 * are normalized here: the primary modifier of the machine becomes `mod`, which
 * is what keeps a saved binding meaningful after a move between macOS and the
 * rest. Pure and event-only, so the mapping is testable without a DOM.
 */

/** `event.key` values the registry names differently from the browser. */
const NAMED_EVENT_KEYS: Readonly<Record<string, string>> = {
  ' ': 'space',
  Spacebar: 'space',
  Escape: 'escape',
  Esc: 'escape',
  Enter: 'enter',
  Tab: 'tab',
  Backspace: 'backspace',
  Delete: 'delete',
  Del: 'delete',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  Insert: 'insert',
  ArrowUp: 'arrowup',
  ArrowDown: 'arrowdown',
  ArrowLeft: 'arrowleft',
  ArrowRight: 'arrowright'
}

/** The bare modifier a `KeyboardEvent` is pressing, if it is one. */
export function eventModifierToken(event: KeyboardEvent, isMac: boolean): string | null {
  switch (event.key) {
    case 'Meta':
      return isMac ? 'mod' : 'cmd'
    case 'Control':
      return isMac ? 'ctrl' : 'mod'
    case 'Alt':
      return 'alt'
    case 'Shift':
      return 'shift'
    default:
      return null
  }
}

/** Normalize a non-modifier key into a registry token. */
function eventKeyToken(event: KeyboardEvent): string | null {
  const named = NAMED_EVENT_KEYS[event.key]
  if (named) return named
  if (event.key.length === 0) return null
  // A shifted letter arrives uppercase; the token is the unshifted key, and
  // `shift` already describes the press. Symbols keep their shifted form.
  const lowered = event.key.toLowerCase()
  if (lowered === 'meta' || lowered === 'control' || lowered === 'alt' || lowered === 'shift') {
    return null
  }
  return lowered
}

/**
 * The tokens for one press, or null when the press alone binds nothing.
 *
 * A modifier-only press is not a binding; it becomes one only when the capture
 * control sees it tapped again (see {@link modifierTapTokens}).
 */
export function capturedKeyTokens(event: KeyboardEvent, isMac: boolean): string[] | null {
  if (eventModifierToken(event, isMac) !== null) return null
  const key = eventKeyToken(event)
  if (!key) return null
  const modifiers: string[] = []
  if (isMac) {
    if (event.metaKey) modifiers.push('mod')
    if (event.ctrlKey) modifiers.push('ctrl')
  } else {
    if (event.ctrlKey) modifiers.push('mod')
    if (event.metaKey) modifiers.push('cmd')
  }
  if (event.altKey) modifiers.push('alt')
  if (event.shiftKey) modifiers.push('shift')
  return [...modifiers, key]
}

/** How long a bare modifier waits for the next tap of the same key. */
export const MODIFIER_TAP_WINDOW_MS = 600

/**
 * The tokens for a run of taps on one bare modifier.
 *
 * A single tap binds nothing (the keys would read as "just Alt"). Two taps are
 * the gestures the registry already uses (`alt alt` for dictation, `alt alt alt`
 * for Don), and two taps of the platform's primary modifier are the double
 * modifier gesture, which is one token rather than a repetition.
 */
export function modifierTapTokens(modifier: string, taps: number): string[] | null {
  if (taps < 2) return null
  if (modifier === 'mod') return ['double-mod']
  return Array.from({ length: taps }, () => modifier)
}
