import type { PromptReference } from '$shared/types'

/**
 * Wording for a composer's attached references.
 *
 * A composer can carry six kinds of reference: an excerpt selected from an
 * assistant response, an element picked from a design in the in-app browser, a
 * passage annotated in a project document, a moment noted on a video
 * composition's timeline, a freehand mark drawn on a picture the agent rendered,
 * and an element picked inside an inline SVG artifact. The strip and its popover
 * both show a count, so the count's noun has to agree with what is actually
 * attached rather than always saying "selections".
 */
export interface ComposerReferenceSummary {
  total: number
  /** How many references are picked elements, from a design or an inline SVG. */
  elements: number
  /** How many references are passages annotated in a project document. */
  annotations: number
  /** How many references are moments noted on a video composition's timeline. */
  notes: number
  /** How many references are freehand marks drawn on a rendered picture. */
  marks: number
  /** How many references are response selections. */
  selections: number
  /** Plural noun for the group. */
  noun: 'element' | 'annotation' | 'note' | 'mark' | 'selection' | 'item'
  /** Count plus noun, e.g. `3 selections`. */
  label: string
  /** Sentence fragment for an aria-label, e.g. `3 attached selections`. */
  aria: string
}

export function summarizeComposerReferences(
  references: readonly PromptReference[]
): ComposerReferenceSummary {
  const elements = references.filter(
    (reference) => reference.kind === 'design' || reference.kind === 'svg'
  ).length
  const annotations = references.filter((reference) => reference.kind === 'file').length
  const notes = references.filter((reference) => reference.kind === 'video').length
  const marks = references.filter((reference) => reference.kind === 'image').length
  const selections = references.length - elements - annotations - notes - marks
  // One noun only while every reference is the same kind; a mixed set is named
  // by the group, because neither noun would describe all of it.
  const kinds = [elements, annotations, notes, marks, selections].filter(
    (count) => count > 0
  ).length
  const noun =
    kinds > 1
      ? 'item'
      : notes > 0
        ? 'note'
        : annotations > 0
          ? 'annotation'
          : marks > 0
            ? 'mark'
            : elements > 0
              ? 'element'
              : 'selection'
  const plural = noun === 'item' ? 'items' : `${noun}s`
  // A single reference is named, not counted, so `1 selection` never reads as
  // `1 selections`.
  const counted = references.length === 1 ? noun : plural
  return {
    total: references.length,
    elements,
    annotations,
    notes,
    marks,
    selections,
    noun,
    label: `${references.length} ${counted}`,
    aria: `${references.length} attached ${counted}`
  }
}
