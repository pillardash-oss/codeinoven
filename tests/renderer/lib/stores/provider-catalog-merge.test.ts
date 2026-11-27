import { describe, expect, it } from 'vitest'
import { mergeProviderCatalogEntries } from '../../../../src/renderer/lib/provider-catalog-merge'
import type { ProviderCatalog } from '../../../../src/lib/types'

/**
 * Merging the same catalogs twice answers the same result without merging again.
 *
 * Both model pickers and the composer merge inside derived values, which
 * re-evaluate on every thread switch. On a real account the merge measured 18-54
 * ms per click over inputs that had not moved, so the last merge is kept and
 * reused while the same catalog objects come back. What callers must never see is
 * a shared array: they push their own custom providers onto the result.
 */

function catalog(id: string, models: string[]): ProviderCatalog {
  return {
    id,
    name: id,
    harnessId: 'pi',
    models: models.map((modelId) => ({
      id: modelId,
      providerId: id,
      name: modelId,
      reasoning: false,
      attachment: false,
      toolcall: true,
      fastSupported: false
    }))
  } as ProviderCatalog
}

describe('mergeProviderCatalogEntries', () => {
  it('keeps every model of a provider reported twice', () => {
    const merged = mergeProviderCatalogEntries([catalog('openai', ['a']), catalog('openai', ['b'])])
    expect(merged).toHaveLength(1)
    expect(merged[0].models.map((model) => model.id)).toEqual(['a', 'b'])
  })

  it('answers a repeated merge without a second pass, and never shares its array', () => {
    const first = catalog('openai', ['a'])
    const second = catalog('anthropic', ['b'])
    const merged = mergeProviderCatalogEntries([first, second])
    // A caller pushes its own entries onto the result, the way the catalog store
    // applies custom providers.
    merged.push(catalog('custom', ['c']))
    const again = mergeProviderCatalogEntries([first, second])
    expect(again.map((entry) => entry.id)).toEqual(['openai', 'anthropic'])
    expect(again).not.toBe(merged)
  })

  it('merges again when the catalogs themselves change', () => {
    const original = catalog('openai', ['a'])
    const merged = mergeProviderCatalogEntries([original])
    const replaced = catalog('openai', ['a', 'b'])
    const next = mergeProviderCatalogEntries([replaced])
    expect(merged[0].models).toHaveLength(1)
    expect(next[0].models).toHaveLength(2)
  })
})
