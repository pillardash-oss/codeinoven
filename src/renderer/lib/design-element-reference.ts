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
 * The entry file one served page is showing, relative to its design folder.
 *
 * A design folder is served on a loopback origin and each screen inside it is a
 * file on that origin (see `servedFileUrl`), so the page's own URL is what names
 * the screen: reopening a comment uses this to come back to the page the element
 * was picked from rather than to whatever the folder defaults to. No path at
 * all is the folder listing, which no entry describes.
 */
export function designEntryFromUrl(url: string, origin: string): string | undefined {
  if (!url.startsWith(origin)) return undefined
  const path = url.slice(origin.length).split(/[?#]/u)[0]
  const segments = path.split('/').filter((segment) => segment.length > 0)
  if (segments.length === 0) return undefined
  try {
    return segments.map((segment) => decodeURIComponent(segment)).join('/')
  } catch {
    // A URL the browser left with an unescaped `%` cannot be turned back into the
    // file name it came from, and a guessed name would reopen the wrong screen.
    return undefined
  }
}

/**
 * Build the composer reference for one pick.
 *
 * The reference id is the page marker's id, so the panel, the page pin and the
 * composer chip all name the same element with one identifier, and a comment
 * reported by the page can update the exact reference it belongs to.
 *
 * The design folder and the page's entry travel with it so the comment can bring
 * its page back after the tab is closed: the folder says where to serve, the
 * entry says which screen of it to load.
 */
export function designElementReference(
  id: string,
  target: BrowserInspectorTarget,
  design: BrowserDesignTab | null,
  tab: { id: string; url: string }
): ResponseReferenceAnchor {
  const entry = design ? designEntryFromUrl(tab.url, design.origin) : undefined
  return {
    id,
    kind: 'design',
    // Renumbered to `Design element N` with its position when it is stored.
    label: 'Design element',
    text: designElementDescriptor(target, design),
    selector: target.selector,
    tabId: tab.id,
    ...(design ? { directory: design.directory } : {}),
    ...(entry ? { designEntry: entry } : {})
  }
}
