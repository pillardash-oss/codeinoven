import { keymapKeyGroups } from './keymap'
import type { KeymapCategory, KeymapShortcut } from './keymap'

/** A category narrowed to the shortcuts that matched a query. Categories with
 *  no matches are dropped from the result. */
export interface KeymapCategoryMatch extends KeymapCategory {
  shortcuts: KeymapShortcut[]
}

/** Resolves the effective key tokens for a shortcut id, so a search finds an
 *  entry by the keys the user actually has bound rather than the defaults. */
export type KeymapKeysResolver = (id: string) => readonly string[]

export interface KeymapSearchOptions {
  keysFor: KeymapKeysResolver
  isMac: boolean
}

/** Everything a single shortcut is searchable by, lowercased once so a query
 *  with several words can be tested token by token. */
function searchableText(
  shortcut: KeymapShortcut,
  category: KeymapCategory,
  { keysFor, isMac }: KeymapSearchOptions
): string {
  const keys = keysFor(shortcut.id)
  return [
    shortcut.id,
    shortcut.label,
    shortcut.description,
    shortcut.scenario,
    category.label,
    keys.join(' '),
    keymapKeyGroups(keys, isMac).join(' ')
  ]
    .join(' ')
    .toLowerCase()
}

function normalizeQuery(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean)
}

/** True when every word of the query appears somewhere in the shortcut's
 *  label, description, scenario, category or current keys. */
export function matchesKeymapQuery(
  shortcut: KeymapShortcut,
  category: KeymapCategory,
  tokens: readonly string[],
  options: KeymapSearchOptions
): boolean {
  if (tokens.length === 0) return true
  const text = searchableText(shortcut, category, options)
  return tokens.every((token) => text.includes(token))
}

/** The categories and shortcuts that match a free-text query. An empty query
 *  returns the registry untouched, so the page reads as the full keymap. */
export function filterKeymapCategories(
  categories: readonly KeymapCategory[],
  query: string,
  options: KeymapSearchOptions
): KeymapCategoryMatch[] {
  const tokens = normalizeQuery(query)
  if (tokens.length === 0)
    return categories.map((category) => ({ ...category, shortcuts: [...category.shortcuts] }))
  const matches: KeymapCategoryMatch[] = []
  for (const category of categories) {
    const shortcuts = category.shortcuts.filter((shortcut) =>
      matchesKeymapQuery(shortcut, category, tokens, options)
    )
    if (shortcuts.length > 0) matches.push({ ...category, shortcuts })
  }
  return matches
}
