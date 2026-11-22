import { keymapShortcut } from './keymap'

/**
 * The saved keybinding record and the three edits made to it.
 *
 * Kept apart from the runtime store because the shape, not the app, is what a
 * mistake here breaks: an empty value means *unbound*, while a missing id means
 * *the registry default*. Writing the wrong one of those either pins a chord
 * forever or silently restores the binding a conflict just cleared.
 */

export type KeymapOverrideRecord = Record<string, string>

function sameTokens(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((token, index) => token === b[index])
}

/**
 * Bind one entry to `keys`.
 *
 * An empty `keys` is stored as `''`, which the keymap reads as unbound. That is
 * what a confirmed conflict writes over the chords it replaced: dropping the
 * entry instead would restore the very default the user just overwrote. Binding
 * back to the registry default drops the entry, so a later change to the catalog
 * reaches the user instead of being pinned.
 */
export function withBindingOverride(
  id: string,
  keys: readonly string[],
  overrides: KeymapOverrideRecord
): KeymapOverrideRecord {
  const next = { ...overrides }
  if (keys.length === 0) next[id] = ''
  else if (sameTokens(keys, keymapShortcut(id)?.keys ?? [])) delete next[id]
  else next[id] = keys.join(' ')
  return next
}

/** Put one entry back on its registry default by forgetting its override. */
export function withResetOverride(
  id: string,
  overrides: KeymapOverrideRecord
): KeymapOverrideRecord {
  const next = { ...overrides }
  delete next[id]
  return next
}
