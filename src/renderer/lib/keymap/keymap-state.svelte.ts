import {
  isMacPlatform,
  keymapKeys,
  parseKeymapOverride,
  parseKeymapTrigger,
  triggerMatches,
  type KeymapTriggerParse
} from './keymap'
import { publishBrowserShortcutBindings } from './browser-shortcuts'

/**
 * Runtime keymap: the registry defaults merged with the user's overrides, plus
 * the matching helpers handlers call. Every keyboard handler in the app asks
 * this store whether an event matches a keymap id, so changing `keymap.json`
 * or a user override changes behavior, not just the Keymap settings page.
 *
 * Overrides live in `AppConfig.keybindings` (id → token string) and are pushed
 * in by `appConfigState.sync`. A `Record<string, string>` is parsed with
 * {@link parseKeymapOverride}; an entry mapped to an empty value is unbound.
 */
class KeymapState {
  /** id → key tokens. Only ids the user changed are present. */
  overrides = $state<Record<string, readonly string[]>>({})

  /** Replace every override. Called whenever the persisted config loads or
   *  changes; a missing or empty record restores the registry defaults. */
  setOverrides(overrides: Record<string, string | readonly string[]> | null | undefined): void {
    const next: Record<string, readonly string[]> = {}
    for (const [id, value] of Object.entries(overrides ?? {})) {
      next[id] = typeof value === 'string' ? parseKeymapOverride(value) : [...value]
    }
    this.overrides = next
    // The browser surface's chords are claimed in the main process, which cannot
    // read this keymap, so every change to the bindings is reported to it.
    publishBrowserShortcutBindings(this)
  }

  /** The effective key tokens for an id: the user override when present,
   *  otherwise the registry default. Empty means the entry is unbound. */
  keysFor(id: string): readonly string[] {
    return this.overrides[id] ?? keymapKeys(id)
  }

  /** The effective, parsed trigger for an id. */
  triggerFor(id: string): KeymapTriggerParse {
    return parseKeymapTrigger(this.keysFor(id))
  }

  /** True when the id is the primary modifier tapped twice. The tap detector
   *  owns the timing, so this only reports whether the binding is that gesture. */
  isDoubleModifierShortcut(id: string): boolean {
    const parsed = this.triggerFor(id)
    return parsed.kind === 'binding' && parsed.trigger.kind === 'double-mod'
  }

  /** True when a keyboard event is a press belonging to the id's binding.
   *  Repeat gestures (double Escape, double Alt) match a single press; the
   *  caller owns the window between presses. Unbound and descriptive entries
   *  never match, so a handler can safely fall through. */
  matches(id: string, event: KeyboardEvent): boolean {
    const parsed = this.triggerFor(id)
    if (parsed.kind !== 'binding') return false
    return triggerMatches(parsed.trigger, event, isMacPlatform())
  }
}

export const keymapState = new KeymapState()
