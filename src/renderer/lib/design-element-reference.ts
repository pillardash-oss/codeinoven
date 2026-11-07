import type {
  BrowserDesignTab,
  BrowserInspectorTarget,
  BrowserInspectorViewport
} from '$shared/ipc-contract'
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
 * The layout a width describes, in the words a reader already uses.
 *
 * A raw number is what the model needs, but the name is what makes the comment
 * legible beside the width: "narrow column" under `390x844 (mobile)` reads as a
 * phone layout rather than a desktop one that happens to be squeezed. The
 * breakpoints are the common ones, ordered widest last.
 */
export function viewportLabel(width: number): string {
  if (width < 768) return 'mobile'
  if (width < 1024) return 'tablet'
  if (width < 1440) return 'desktop'
  return 'wide desktop'
}

/** `0.5x`, a scale written as a number "at 100%" would only repeat. */
function formatScale(scale: number): string {
  return `${Number(scale.toFixed(3))}x`
}

/**
 * The descriptor the model reads inside `<element>`.
 *
 * Deliberately plain `key: value` lines rather than JSON: the same text is
 * rendered in the composer popover, and a block of readable lines is what a
 * human wants there too.
 *
 * The page lines come before the element's own text and markup because the
 * descriptor is clipped to a fixed length: when it has to cut something, it is
 * the clipped opening markup that goes, never the URL, the scroll offset or the
 * viewport that make the comment about one exact render.
 */
export function designElementDescriptor(
  target: BrowserInspectorTarget,
  design: BrowserDesignTab | null
): string {
  const short = describeInspectorTarget(target)
  const context = target.ancestors.length > 0 ? `${target.ancestors.join(' > ')} > ${short}` : null
  const page = target.page
  // The element's place in the whole document, not only in the viewport: a pick
  // reports where it was on screen, and the scroll offset turns that into a place
  // in the page the agent can scroll to and find again.
  const documentX = target.rect.x + page.scroll.x
  const documentY = target.rect.y + page.scroll.y
  const lines = [
    `Design element: ${short}`,
    // The screen an element lives on, because a canvas frames several of them
    // and a selector alone does not say which file to open to find it.
    target.frame ? `screen: ${target.frame}` : null,
    page.url ? `page: ${page.url}` : null,
    page.title ? `title: ${page.title}` : null,
    `selector: ${target.selector}`,
    context ? `context: ${context}` : null,
    `box: ${target.rect.width}x${target.rect.height} CSS px at ${target.rect.x},${target.rect.y} in the viewport (${documentX},${documentY} in the document)`,
    `viewport: ${formatViewport(target.viewport)}`,
    `scroll: ${page.scroll.x},${page.scroll.y} of ${page.extent.width}x${page.extent.height}`,
    `zoom: device pixel ratio ${page.devicePixelRatio}, visual scale ${page.visualScale}`,
    `scheme: ${page.scheme}`,
    target.presented
      ? `canvas: screen framed at ${formatScale(target.presented.scale)} inside ${target.presented.rect.width}x${target.presented.rect.height} at ${target.presented.rect.x},${target.presented.rect.y}`
      : null,
    design ? `design: ${design.directory}` : null,
    target.text ? `text: ${JSON.stringify(target.text)}` : null,
    target.html ? `markup: ${target.html}` : null
  ].filter((line): line is string => line !== null)
  return lines.join('\n').slice(0, MAX_DESCRIPTOR_LENGTH)
}

/**
 * The design page a reference belongs to, named independently of its tab.
 *
 * A design page is one folder's one entry, and the same page can be shown in a
 * thread's own tab, in a tab of its screen from the board, or in a reopened tab
 * the app had to create. The tab is where the page happened to be shown when the
 * comment was written; this is which page it was, so a pin can be drawn on that
 * page wherever it is opened next.
 */
export function designPageIdentity(directory: string, entry: string | undefined | null): string {
  return `${directory}\u0000${entry ?? ''}`
}

/** `390x844 CSS px (mobile)`, the layout the element was measured inside. */
export function formatViewport(viewport: BrowserInspectorViewport): string {
  const label = viewportLabel(viewport.width)
  return `${viewport.width}x${viewport.height} CSS px (${label})`
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
    ...(target.frame ? { frame: target.frame } : {}),
    ...(design ? { directory: design.directory } : {}),
    ...(entry ? { designEntry: entry } : {}),
    ...(design ? { designId: designPageIdentity(design.directory, entry) } : {})
  }
}
