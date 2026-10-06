import { getProjectIcon } from '$lib/project-icons'
import {
  browserAppearanceAccent,
  browserAppearanceHasIcon,
  browserAppearanceIconUrl
} from './browser-group-appearance'
import type { BrowserBookmark, BrowserBookmarkGroup } from '$shared/browser/browser-library'

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

/**
 * A saved-page group's accent: its own hex colour, or a deterministic one so a
 * colourless group still has a stable identity. Delegates to the shared browser
 * resolver so a bookmark group, a tab group and a box can never drift into
 * different palettes.
 */
export function browserBookmarkGroupAccent(group: BrowserBookmarkGroup): string {
  return browserAppearanceAccent(group)
}

/**
 * A saved-page group's icon as an image data URL, or null while it wears only a
 * colour. Drawn by the very resolver projects, routines, tab groups and boxes
 * use, so a picked image, a pasted SVG and a library icon all render through one
 * code path.
 */
export function browserBookmarkGroupIconUrl(
  group: BrowserBookmarkGroup,
  storedImageUrl: string | null
): string | null {
  return browserAppearanceIconUrl(group, storedImageUrl)
}
