import type { ResponseReferenceAnchor } from './stores/response-references.svelte'
import type { ArtifactKind } from './components/markdown/artifact'

/**
 * Turning an element picked inside an inline artifact into a composer
 * reference.
 *
 * The prototype inspector already answers "which element did the user mean" for
 * a page in the app browser by sending a CSS path plus a short description of
 * the element. An inline artifact is the same kind of surface rendered in the
 * conversation instead of in a browser tab, so a pick here is described the same
 * way and travels as a `kind: 'svg'` or `kind: 'html'` reference: the descriptor
 * is what the model reads, and the selector is what lets the artifact card put
 * the pin back on the element after the artifact re-renders.
 */

/** Ceiling on the descriptor, matching what one reference text may carry. */
const MAX_DESCRIPTOR_LENGTH = 4_000

/** Ceiling on the text quoted out of a picked element. */
const MAX_ELEMENT_TEXT = 400

/** Ceiling on how many ancestors the context line names. */
const MAX_ANCESTORS = 6

/** One element picked inside an inline artifact. */
export interface ArtifactInspectorTarget {
  /** CSS path from the artifact's own root to the picked element. */
  selector: string
  tag: string
  id: string | null
  classes: string[]
  /** The element's visible text, clipped. */
  text: string
  /** Nearest-first ancestor names, outermost first. */
  ancestors: string[]
  rect: { x: number; y: number; width: number; height: number }
}

/** Ceiling on quoted element text, applied where the text is captured. */
export function clipElementText(text: string): string {
  return text.slice(0, MAX_ELEMENT_TEXT)
}

/**
 * A stable identity for one artifact card.
 *
 * A pick has to name the card that drew the element, and an artifact card knows
 * nothing but its source, so the identity is derived from that source. Two
 * identical artifacts therefore share a key, which is correct: they draw the
 * same thing, so a mark on one belongs on both.
 */
export function artifactKeyFor(kind: ArtifactKind, code: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < code.length; index += 1) {
    hash ^= code.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${kind}-${(hash >>> 0).toString(36)}-${code.length.toString(36)}`
}

/** `path#id.cls`, the short form used in labels and context. */
function shortTargetName(target: ArtifactInspectorTarget): string {
  let name = target.tag
  if (target.id) name += `#${target.id}`
  if (target.classes.length > 0) name += `.${target.classes.slice(0, 2).join('.')}`
  return name
}

/**
 * The reference kind one artifact kind's picks are stored as.
 *
 * A pick is stored against the kind of artifact it was made in, because that is
 * what its pin is drawn in and what its descriptor says it points at.
 */
export function artifactReferenceKind(kind: ArtifactKind): 'svg' | 'html' {
  return kind === 'svg' ? 'svg' : 'html'
}

/** What a descriptor calls the surface its selector resolves against. */
function artifactSurfaceName(kind: ArtifactKind): string {
  return kind === 'svg' ? 'SVG' : 'HTML'
}

/**
 * The descriptor the model reads inside `<element>`.
 *
 * Plain `key: value` lines rather than JSON, because the same text is shown in
 * the composer popover and a block of readable lines is what a human wants
 * there too. The `rendered in:` line exists so the model knows the selector is
 * resolved against an inline artifact in the conversation rather than a page.
 */
export function artifactElementDescriptor(
  target: ArtifactInspectorTarget,
  kind: ArtifactKind
): string {
  const surface = artifactSurfaceName(kind)
  const short = shortTargetName(target)
  const ancestors = target.ancestors.slice(0, MAX_ANCESTORS)
  const context = ancestors.length > 0 ? `${ancestors.join(' > ')} > ${short}` : null
  const lines = [
    `${surface} artifact element: ${short}`,
    `selector: ${target.selector}`,
    context ? `context: ${context}` : null,
    `size: ${Math.round(target.rect.width)}x${Math.round(target.rect.height)}`,
    `rendered in: an inline ${surface} artifact in this conversation`,
    target.text ? `text: ${JSON.stringify(target.text)}` : null
  ].filter((line): line is string => line !== null)
  return lines.join('\n').slice(0, MAX_DESCRIPTOR_LENGTH)
}

/**
 * Build the composer reference for one pick.
 *
 * The id is generated per pick, so re-picking an element makes a second
 * reference rather than silently rewriting the first: the user asked for both.
 */
export function artifactElementReference(
  id: string,
  target: ArtifactInspectorTarget,
  artifactKey: string,
  kind: ArtifactKind
): ResponseReferenceAnchor {
  return {
    id,
    kind: artifactReferenceKind(kind),
    // Renumbered to `Design element N` with its position when it is stored.
    label: 'Design element',
    text: artifactElementDescriptor(target, kind),
    selector: target.selector,
    artifactKey
  }
}
