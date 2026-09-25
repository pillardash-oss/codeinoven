import type { PromptReference } from '$shared/types'

/**
 * Wording for a composer's attached references.
 *
 * A composer can carry two kinds of reference: an excerpt selected from an
 * assistant response, and an element picked from a design in the in-app browser.
 * The strip and its popover both show a count, so the count's noun has to agree
 * with what is actually attached rather than always saying "selections".
 */
export interface ComposerReferenceSummary {
  total: number
  /** How many references are picked design elements. */
  elements: number
  /** How many references are response selections. */
  selections: number
  /** Plural noun for the group. */
  noun: 'element' | 'selection' | 'item'
  /** Count plus noun, e.g. `3 selections`. */
  label: string
  /** Sentence fragment for an aria-label, e.g. `3 attached selections`. */
  aria: string
}

export function summarizeComposerReferences(
  references: readonly PromptReference[]
): ComposerReferenceSummary {
  const elements = references.filter((reference) => reference.kind === 'design').length
  const selections = references.length - elements
  const noun = elements > 0 && selections > 0 ? 'item' : elements > 0 ? 'element' : 'selection'
  const plural = noun === 'item' ? 'items' : `${noun}s`
  // A single reference is named, not counted, so `1 selection` never reads as
  // `1 selections`.
  const counted = references.length === 1 ? noun : plural
  return {
    total: references.length,
    elements,
    selections,
    noun,
    label: `${references.length} ${counted}`,
    aria: `${references.length} attached ${counted}`
  }
}
