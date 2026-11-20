import { describe, expect, it } from 'vitest'
import { KEYMAP, keymapKeys } from '$lib/keymap/keymap'
import { filterKeymapCategories, matchesKeymapQuery } from '$lib/keymap/keymap-search'

const options = { keysFor: (id: string) => keymapKeys(id), isMac: false }

function matchingIds(query: string): string[] {
  return filterKeymapCategories(KEYMAP.categories, query, options).flatMap((category) =>
    category.shortcuts.map((shortcut) => shortcut.id)
  )
}

function allIds(): string[] {
  return KEYMAP.categories.flatMap((category) => category.shortcuts.map((shortcut) => shortcut.id))
}

describe('filterKeymapCategories', () => {
  it('returns the whole registry for an empty query', () => {
    expect(matchingIds('')).toEqual(allIds())
    expect(matchingIds('   ')).toEqual(allIds())
  })

  it('matches on the shortcut label, case insensitively', () => {
    const shortcut = KEYMAP.categories
      .flatMap((category) => category.shortcuts)
      .find((entry) => entry.label.length > 3)
    expect(shortcut).toBeDefined()
    const ids = matchingIds(shortcut!.label.toUpperCase())
    expect(ids).toContain(shortcut!.id)
  })

  it('requires every word of a multi-word query to match', () => {
    const ids = matchingIds('command palette')
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) {
      const found = KEYMAP.categories
        .flatMap((category) => category.shortcuts)
        .find((shortcut) => shortcut.id === id)
      expect(`${found?.label} ${found?.description} ${found?.scenario}`.toLowerCase()).toContain(
        'command'
      )
    }
  })

  it('drops categories with no matching shortcut', () => {
    const categories = filterKeymapCategories(KEYMAP.categories, 'zzzz-no-such-shortcut', options)
    expect(categories).toEqual([])
  })

  it('finds a shortcut by the keys currently bound to it', () => {
    const bound = KEYMAP.categories
      .flatMap((category) => category.shortcuts)
      .find((entry) => keymapKeys(entry.id).length > 0)
    expect(bound).toBeDefined()
    const keyToken = keymapKeys(bound!.id)[0]
    const ids = matchingIds(keyToken)
    expect(ids).toContain(bound!.id)
  })

  it('searches the user override rather than only the default keys', () => {
    const category = KEYMAP.categories[0]
    const shortcut = category.shortcuts[0]
    const overridden = { keysFor: () => ['mod', 'q'], isMac: true }
    expect(matchesKeymapQuery(shortcut, category, ['q'], overridden)).toBe(true)
    const noKeys = { keysFor: () => [], isMac: true }
    expect(matchesKeymapQuery(shortcut, category, ['mod q'], noKeys)).toBe(false)
  })
})
