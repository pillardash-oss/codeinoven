import type { BrowserDesignTab, BrowserInspectorTarget } from '$shared/ipc-contract'
import type { ResponseReferenceAnchor } from './stores/response-references.svelte'

/**
 * Turning a picked element into a composer reference.
 *
 * A design reference is a `PromptReference` like a response selection, so the
 * send path, the queue, the recovery snapshot and the composer chips all treat
 * it the same way. What differs is the text the model reads: a selection is an
 * excerpt, while a design reference has to name the element precisely enough to
 * find it in the source. The descriptor below is that name, so it carries the
 * CSS path, the ancestor chain, the size, the visible text and the opening
 * markup rather than the whole subtree.
 */

/** Ceiling on the descriptor, well under the 100k the send path allows for one
 *  reference text and consistent with what `chat-engine-pure.ts` accepts. */
const MAX_DESCRIPTOR_LENGTH = 4_000

/** `h1#title.lede [role="heading"]`, the short form used in labels and context. */
export function describeInspectorTarget(target: BrowserInspectorTarget): string {
  let name = target.tag
  if (target.id) name += `#${target.id}`
  if (target.classes.length > 0) name += `.${target.classes.slice(0, 2).join('.')}`
  if (target.role) name += ` [role="${target.role}"]`
  return name
}

/**
 * The descriptor the model reads inside `<element>`.
 *
 * Deliberately plain `key: value` lines rather than JSON: the same text is
 * rendered in the composer popover, and a block of readable lines is what a
 * human wants there too.
 */
export function designElementDescriptor(
  target: BrowserInspectorTarget,
  design: BrowserDesignTab | null
): string {
  const short = describeInspectorTarget(target)
  const context = target.ancestors.length > 0 ? `${target.ancestors.join(' > ')} > ${short}` : null
  const lines = [
    `Design element: ${short}`,
    `selector: ${target.selector}`,
    context ? `context: ${context}` : null,
    `size: ${target.rect.width}x${target.rect.height}`,
    design ? `design: ${design.directory}` : null,
    target.text ? `text: ${JSON.stringify(target.text)}` : null,
    target.html ? `markup: ${target.html}` : null
  ].filter((line): line is string => line !== null)
  return lines.join('\n').slice(0, MAX_DESCRIPTOR_LENGTH)
}

/**
 * Build the composer reference for one pick.
 *
 * The reference id is the page marker's id, so the panel, the page pin and the
 * composer chip all name the same element with one identifier, and a comment
 * reported by the page can update the exact reference it belongs to.
 */
export function designElementReference(
  id: string,
  target: BrowserInspectorTarget,
  design: BrowserDesignTab | null,
  tabId: string
): ResponseReferenceAnchor {
  return {
    id,
    kind: 'design',
    // Renumbered to `Design element N` with its position when it is stored.
    label: 'Design element',
    text: designElementDescriptor(target, design),
    selector: target.selector,
    tabId
  }
}
