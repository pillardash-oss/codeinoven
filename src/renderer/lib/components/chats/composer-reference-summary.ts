import type { PromptReference } from '$shared/types'

/**
 * Wording for a composer's attached references.
 *
 * A composer can carry three kinds of reference: an excerpt selected from an
 * assistant response, an element picked from a design in the in-app browser, and
 * a passage annotated in a project document. The strip and its popover both show
 * a count, so the count's noun has to agree with what is actually attached
 * rather than always saying "selections".
 */
export interface ComposerReferenceSummary {
  total: number
  /** How many references are picked design elements. */
  elements: number
  /** How many references are passages annotated in a project document. */
  annotations: number
  /** How many references are response selections. */
  selections: number
  /** Plural noun for the group. */
  noun: 'element' | 'annotation' | 'selection' | 'item'
  /** Count plus noun, e.g. `3 selections`. */
  label: string
  /** Sentence fragment for an aria-label, e.g. `3 attached selections`. */
  aria: string
}

export function summarizeComposerReferences(
  references: readonly PromptReference[]
): ComposerReferenceSummary {
  const elements = references.filter((reference) => reference.kind === 'design').length
  const annotations = references.filter((reference) => reference.kind === 'file').length
  const selections = references.length - elements - annotations
  // One noun only while every reference is the same kind; a mixed set is named
  // by the group, because neither noun would describe all of it.
  const kinds = [elements, annotations, selections].filter((count) => count > 0).length
  const noun =
    kinds > 1 ? 'item' : annotations > 0 ? 'annotation' : elements > 0 ? 'element' : 'selection'
  const plural = noun === 'item' ? 'items' : `${noun}s`
  // A single reference is named, not counted, so `1 selection` never reads as
  // `1 selections`.
  const counted = references.length === 1 ? noun : plural
  return {
    total: references.length,
    elements,
    annotations,
    selections,
    noun,
    label: `${references.length} ${counted}`,
    aria: `${references.length} attached ${counted}`
  }
}
