import type { Thread } from '$shared/types'
import type { ComposerAssistantTag } from './composer-mentions'

/**
 * How a composer tag looks, wherever it is drawn.
 *
 * A tag reads as a mark plus a name, and both surfaces that draw one (the
 * mention menu's row and the composer's own badge) need the same parts: the
 * mark as markup, the name as the text, and the line under it naming where the
 * tag points. This module owns what a mark is for each kind of tag, so a new
 * kind of tag is one function here instead of a copy of this logic in every
 * surface. The pieces are markup strings rather than components because the
 * composer badge and the sent message chip are generated HTML, not a component
 * tree   `ComposerTagBadge.svelte` draws those same strings in a component.
 */

/** Attribute-escaped value, because an icon URL is interpolated. */
function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * The mark a thread wears when the project it lives in cannot be resolved: a
 * conversation mark, drawn in the tag's own ink at the 13px a tag holds.
 */
const THREAD_MARK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.6" aria-hidden="true"><path d="M20.5 11.6a7.9 7.9 0 0 1-8.5 7.9 9 9 0 0 1-3.6-.8L4 20l1.4-4a7.6 7.6 0 0 1-.9-3.6A7.9 7.9 0 0 1 12.4 4a7.9 7.9 0 0 1 8.1 7.6z"/></svg>'

/**
 * A tag's mark as markup: the image a project or assistant already draws, or
 * the conversation mark when there is no icon to draw.
 */
export function tagMarkHtml(iconUrl: string | null | undefined): string {
  if (!iconUrl) return THREAD_MARK_SVG
  return `<img src="${escapeAttribute(iconUrl)}" alt="" width="13" height="13" draggable="false" />`
}

/** A project as a tag needs it: the icon it resolved to and its colour. */
export interface TagProject {
  id: string
  name: string
  /** Resolved icon (`getProjectIcon`), absent or null when the project has none. */
  iconUrl?: string | null
  color?: string
}

/**
 * One thread of any project, as a composer tag.
 *
 * The tag wears the icon of the project the thread lives in, not a generic mark:
 * a title only says which thread it names once the reader knows what project it
 * came from, and that project's icon is the identification every other surface
 * already uses for it. Its title rides along untruncated and every surface that
 * draws the tag truncates it to the room it has, so the same tag never reads
 * differently in the menu and in the composer.
 */
export function threadComposerTag(
  thread: Pick<Thread, 'id' | 'title'>,
  project: TagProject | undefined
): ComposerAssistantTag {
  const title = thread.title.trim() || 'Untitled thread'
  return {
    kind: 'thread',
    id: thread.id,
    name: title,
    detail: project ? `Thread · ${project.name}` : 'Thread',
    iconHtml: tagMarkHtml(project?.iconUrl),
    color: project?.color ?? 'var(--color-primary)',
    keywords: []
  }
}
