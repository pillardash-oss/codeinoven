import {
  assistantAccentColor,
  getAssistantIcon,
  type AssistantAppearanceSource
} from '../../assistant-icons'

/**
 * Inline markup for the icon an assistant tag wears.
 *
 * A tag never shows the generic task mark: an assistant is identified by its own
 * icon, so the tag, its menu row, and the chip in a sent message all draw what
 * the assistant tab draws for that assistant. Everything here is a string
 * because these icons land in generated HTML (an editor badge, a chip injected
 * after sanitizing), not in a component tree.
 */

/** Attribute-escaped value, because an icon URL or colour is interpolated. */
function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * The assistant default mark as markup: the plush body with its two dots, drawn
 * from `AssistantIcon.svelte`'s rail tier (no ear tufts, which are specks at tag
 * size) so an assistant without an icon still reads as one.
 *
 * Keep this in step with `AssistantIcon.svelte` whenever the default mark changes.
 */
const DEFAULT_MARK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.475" aria-hidden="true"><g transform="translate(-2.64 -2.64) scale(1.22)"><rect x="4.2" y="6.4" width="15.6" height="12.4" rx="6"/><circle cx="9.4" cy="12.4" r="1.5" fill="currentColor" stroke="none"/><circle cx="14.6" cy="12.4" r="1.5" fill="currentColor" stroke="none"/></g></svg>'

/**
 * The icon markup for one assistant: its own image or tinted SVG icon when it
 * has one, else the assistant default mark.
 */
export function assistantTagIconHtml(
  assistant: AssistantAppearanceSource,
  storedIconUrl?: string | null
): string {
  const icon = getAssistantIcon(assistant, storedIconUrl ?? null)
  if (icon) {
    return `<img src="${escapeAttribute(icon)}" alt="" width="13" height="13" draggable="false" />`
  }
  // An assistant with an accent colour keeps it, exactly like its sidebar row.
  if (!assistant.color) return DEFAULT_MARK_SVG
  return DEFAULT_MARK_SVG.replaceAll('currentColor', escapeAttribute(assistantAccentColor(assistant)))
}
