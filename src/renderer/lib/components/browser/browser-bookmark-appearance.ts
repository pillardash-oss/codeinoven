import { getProjectIcon } from '$lib/project-icons'
import { browserAppearanceHasIcon } from './browser-group-appearance'
import type { BrowserBookmark } from '$shared/browser/browser-library'

/**
 * The icon the user gave a saved page, or null while it wears the page's own
 * favicon.
 *
 * A bookmark is the one browser identity whose icon is not its own by default: it
 * is the icon of the page it points at. So this answers only for an icon the user
 * chose, and the row falls back to the stored favicon and then to a globe. Drawn
 * by the very resolver projects and routines use, so a picked image, a pasted SVG
 * and a library icon all render through one code path.
 *
 * A bookmark carries no accent colour, so a library icon takes the deterministic
 * tint its own id seeds. That is the tint the editor previews it in, which is what
 * makes the picker's preview the icon the list will draw.
 */
export function browserBookmarkIconUrl(
  bookmark: BrowserBookmark,
  storedImageUrl: string | null
): string | null {
  if (!browserAppearanceHasIcon(bookmark)) return null
  return getProjectIcon(
    {
      id: bookmark.id,
      name: bookmark.title,
      iconType: bookmark.iconType ?? undefined,
      customSvg: bookmark.customSvg ?? undefined
    },
    storedImageUrl ?? undefined
  )
}
