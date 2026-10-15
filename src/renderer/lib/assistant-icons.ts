import { getIconSvgDataUrl } from './project-svg-icons'
import { getCustomSvgDataUrl } from '../../lib/custom-svg-tint'
import AssistantIcon from './components/icons/AssistantIcon.svelte'

/** Muted tint used when an assistant declares no accent colour of its own. */
export const ASSISTANT_ICON_FALLBACK_COLOR = '#8b95a5'

/**
 * The mark an assistant without an icon of its own is drawn with.
 *
 * An assistant's name is often a whole sentence ("Check my slack messages every
 * morning and evening"), so surfaces never print that name where an assistant icon
 * is expected: an assistant always has a mark, by falling back to this one.
 *
 * It is the app's own assistant mark rather than a generic Lucide glyph, because
 * every assistant surface falls back to it and the mark is what makes the
 * assistant read as one place. The generic mark made it read as an unnamed
 * module instead of the product's own helper.
 */
export const AssistantDefaultIcon = AssistantIcon

/** Minimal assistant shape needed to resolve an icon or an accent colour. */
export interface AssistantAppearanceSource {
  color?: string
  iconType?: string
  customSvg?: string
}

/** The accent colour every assistant surface tints its assistant with. */
export function assistantAccentColor(assistant: AssistantAppearanceSource): string {
  return assistant.color ?? ASSISTANT_ICON_FALLBACK_COLOR
}

/**
 * Resolve the best available assistant icon image.
 *
 * Priority:
 * 1. Stored custom image icon (the assistant's own icon file, read as a data URL)
 * 2. SVG icon type (`assistant.iconType`) tinted with the assistant's accent colour
 * 3. null   the caller draws `AssistantDefaultIcon`, the assistant default mark
 *
 * Every assistant surface resolves its icon here, so an edited assistant icon and
 * colour read identically in the sidebar row, the search results, and the file
 * tree the assistant's own workspace mounts. Null is never a reason to fall back
 * to a generic folder mark or to the assistant's name: draw `AssistantDefaultIcon`.
 */
export function getAssistantIcon(
  assistant: AssistantAppearanceSource,
  storedIconUrl?: string | null
): string | null {
  if (storedIconUrl) return storedIconUrl
  if (assistant.customSvg)
    return getCustomSvgDataUrl(assistant.customSvg, assistantAccentColor(assistant))
  if (!assistant.iconType) return null
  return getIconSvgDataUrl(assistant.iconType, assistantAccentColor(assistant))
}
