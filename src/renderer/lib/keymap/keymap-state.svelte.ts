import {
  formatKeyCombo,
  isMacPlatform,
  keymapKeys,
  parseKeymapOverride,
  parseKeymapTrigger,
  triggerMatches,
  type KeymapTriggerParse
} from './keymap'
import { publishBrowserShortcutBindings } from './browser-shortcuts'
import { invoke } from '$lib/ipc.svelte'
import {
  withBindingOverride,
  withResetOverride,
  type KeymapOverrideRecord
} from './keymap-overrides'

/**
 * Runtime keymap: the registry defaults merged with the user's overrides, plus
 * the matching helpers handlers call. Every keyboard handler in the app asks
 * this store whether an event matches a keymap id, so changing `keymap.json`
 * or a user override changes behavior, not just the Keymap settings page.
 *
 * Overrides live in `AppConfig.keybindings` (id → token string) and are pushed
 * in by `appConfigState.sync`. A `Record<string, string>` is parsed with
 * {@link parseKeymapOverride}; an entry mapped to an empty value is unbound.
 *
 * Rebinding is written back through this store, because a chord the user saved
 * must be effective before the saved config comes back: the optimistic apply is
 * what makes the very next keypress run the new handler.
 */
class KeymapState {
  /** id → key tokens. Only ids the user changed are present. */
  overrides = $state<Record<string, readonly string[]>>({})

  /** id → the override exactly as it is persisted, so a write never rewrites a
   *  value the user did not touch (and an unbound `''` stays unbound). */
  serialized = $state<Record<string, string>>({})

  /** Replace every override. Called whenever the persisted config loads or
   *  changes; a missing or empty record restores the registry defaults. */
  setOverrides(overrides: Record<string, string | readonly string[]> | null | undefined): void {
    const next: Record<string, readonly string[]> = {}
    const serialized: Record<string, string> = {}
    for (const [id, value] of Object.entries(overrides ?? {})) {
      next[id] = typeof value === 'string' ? parseKeymapOverride(value) : [...value]
      serialized[id] = typeof value === 'string' ? value : value.join(' ')
    }
    this.overrides = next
    this.serialized = serialized
    // The browser surface's chords are claimed in the main process, which cannot
    // read this keymap, so every change to the bindings is reported to it.
    publishBrowserShortcutBindings(this)
  }

  /** The effective key tokens for an id: the user override when present,
   *  otherwise the registry default. Empty means the entry is unbound. */
  keysFor(id: string): readonly string[] {
    return this.overrides[id] ?? keymapKeys(id)
  }

  /** Platform-aware label for the effective binding, including user overrides. */
  labelFor(id: string): string {
    return formatKeyCombo(this.keysFor(id))
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

  /**
   * The override record with one entry bound to `keys`.
   *
   * An empty `keys` is stored as unbound and the registry default is stored as
   * no override at all; see `keymap-overrides` for why both matter.
   */
  withBinding(
    id: string,
    keys: readonly string[],
    overrides: KeymapOverrideRecord = this.serialized
  ): KeymapOverrideRecord {
    return withBindingOverride(id, keys, overrides)
  }

  /** The override record with one entry back on its registry default. */
  reset(id: string, overrides: KeymapOverrideRecord = this.serialized): KeymapOverrideRecord {
    return withResetOverride(id, overrides)
  }

  /**
   * Save a whole override record and adopt it.
   *
   * One write covers a rebind and the chords it replaced, so a confirmed
   * conflict can never half-apply. The save is optimistic: the chords work on
   * the next keypress, and a refusal from main restores what was there before.
   */
  async save(next: KeymapOverrideRecord): Promise<void> {
    const previous = { ...this.serialized }
    this.setOverrides(next)
    try {
      await invoke('config:update', { keybindings: next })
    } catch (cause) {
      this.setOverrides(previous)
      throw cause
    }
  }
}

export const keymapState = new KeymapState()
