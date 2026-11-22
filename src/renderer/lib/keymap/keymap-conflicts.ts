import {
  isMacPlatform,
  keymapKeys,
  keymapShortcut,
  keymapShortcuts,
  parseKeymapTrigger,
  resolveChordModifiers,
  type KeymapChord,
  type KeymapTrigger
} from './keymap'
import { keymapContextsOverlap, type KeymapContextId } from './keymap-contexts'

/**
 * Which other shortcuts a rebind would fight with.
 *
 * A shared chord is not automatically a collision: the registry deliberately
 * gives `Escape` to a dozen surfaces that can never be on screen together, and
 * `mod+f` means "find" in the app, in the browser, in the conversation and in
 * the file surface. A conflict is therefore a shared chord *and* two handlers
 * that can be listening at once, which the registry states per entry as a
 * `context` (see `keymap-contexts`).
 *
 * The same chord under conditions that keep the two handlers apart is still
 * worth mentioning, so it comes back in a second list that never blocks a save.
 * Pure resolution with no store or IPC import, so the rule is testable.
 */

/** What the rebind dialog needs to explain a collision. */
export interface KeymapConflict {
  id: string
  label: string
  description: string
  scenario: string
  /** The tokens of the other entry's effective binding. */
  keys: readonly string[]
}

export interface KeymapConflictReport {
  /** Same chord, listening at the same time: saving must be confirmed. */
  conflicts: KeymapConflict[]
  /** Same chord, mutually exclusive surfaces: worth saying, never blocking. */
  sharedWith: KeymapConflict[]
}

export interface KeymapOverrideTokens {
  readonly [id: string]: readonly string[]
}

/** A chord reduced to the modifiers and key a press must match. */
function chordSignature(chord: KeymapChord, isMac: boolean): string {
  const modifiers = resolveChordModifiers(chord, isMac)
  const flags = [
    modifiers.meta ? 'meta' : '',
    modifiers.control ? 'control' : '',
    modifiers.alt ? 'alt' : '',
    modifiers.shift ? 'shift' : ''
  ]
    .filter(Boolean)
    .join('+')
  return `${flags}|${chord.key}`
}

/** The chords a trigger needs pressed. The double modifier tap has none. */
function triggerSignatures(trigger: KeymapTrigger, isMac: boolean): Set<string> {
  if (trigger.kind === 'double-mod') return new Set()
  const chords = trigger.kind === 'chords' ? trigger.chords : [trigger.chord]
  return new Set(chords.map((chord) => chordSignature(chord, isMac)))
}

interface ParsedBinding {
  signatures: Set<string>
  doubleMod: boolean
}

function parsedBinding(keys: readonly string[], isMac: boolean): ParsedBinding | null {
  const parsed = parseKeymapTrigger(keys)
  if (parsed.kind !== 'binding') return null
  return {
    signatures: triggerSignatures(parsed.trigger, isMac),
    doubleMod: parsed.trigger.kind === 'double-mod'
  }
}

/** True when pressing one key can reach both bindings on this platform. */
function bindingsCollide(a: ParsedBinding, b: ParsedBinding): boolean {
  if (a.doubleMod || b.doubleMod) return a.doubleMod && b.doubleMod
  for (const signature of a.signatures) {
    if (b.signatures.has(signature)) return true
  }
  return false
}

/** The effective tokens of an entry: the user override, else the registry value
 *  resolved for that platform. An override means the same thing on every OS. */
function effectiveKeys(
  id: string,
  isMac: boolean,
  overrides: KeymapOverrideTokens
): readonly string[] {
  return overrides[id] ?? keymapKeys(id, isMac)
}

/**
 * Both platforms are checked, so a binding that is free on this machine cannot
 * collide after a move to another one. The registry ships different chords per
 * OS (`mod+[` here, `alt+Left` there), and only the cross-platform check sees
 * the other set.
 */
const PLATFORMS: readonly boolean[] = [true, false]

/**
 * Every other binding that would answer the same press.
 *
 * `overrides` are the tokens currently in effect, so a chord already moved off
 * its default is judged where the user put it.
 */
export function findKeymapBindingConflicts(
  id: string,
  keys: readonly string[],
  overrides: KeymapOverrideTokens
): KeymapConflictReport {
  const conflicts: KeymapConflict[] = []
  const sharedWith: KeymapConflict[] = []
  const candidate = PLATFORMS.map((isMac) => ({
    isMac,
    parsed: parsedBinding(keys, isMac)
  })).filter((entry): entry is { isMac: boolean; parsed: ParsedBinding } => entry.parsed !== null)
  if (candidate.length === 0) return { conflicts, sharedWith }

  // The entry being rebound is the only one whose context the yes/no answer
  // needs, so it is read once rather than per collision.
  const context: KeymapContextId = keymapShortcut(id)?.context ?? 'global'

  for (const shortcut of keymapShortcuts()) {
    if (shortcut.id === id) continue
    const collides = candidate.some(({ isMac, parsed }) => {
      const other = parsedBinding(effectiveKeys(shortcut.id, isMac, overrides), isMac)
      return other !== null && bindingsCollide(parsed, other)
    })
    if (!collides) continue
    const entry: KeymapConflict = {
      id: shortcut.id,
      label: shortcut.label,
      description: shortcut.description,
      scenario: shortcut.scenario,
      // Shown in the dialog, so it is resolved for the machine on screen even
      // though the collision above was decided for both.
      keys: effectiveKeys(shortcut.id, isMacPlatform(), overrides)
    }
    if (keymapContextsOverlap(shortcut.context, context)) conflicts.push(entry)
    else sharedWith.push(entry)
  }

  return { conflicts, sharedWith }
}
