import { getProjectIcon } from '$lib/project-icons'
import { browserTabLabel, type GlobalBrowserTab } from '$lib/stores/global-browser-types'

/**
 * A tab's custom icon as an image data URL, drawn by the very resolver projects
 * and routines use, so a picked image, a pasted SVG and a library icon all
 * render through one code path. Returns null while the tab carries no custom
 * icon, which is what lets the strip fall back to the page's own favicon.
 *
 * A colour on its own is an accent, not an icon: it must never conjure an
 * initials badge into a 16px favicon slot, so it is deliberately not enough to
 * produce a URL here.
 */
export function browserTabIconUrl(
  tab: GlobalBrowserTab,
  storedImageUrl: string | null
): string | null {
  if (!tab.imagePath && !tab.customSvg && !tab.iconType) return null
  return getProjectIcon(
    {
      id: tab.id,
      name: browserTabLabel(tab),
      color: tab.color ?? undefined,
      iconType: tab.iconType ?? undefined,
      customSvg: tab.customSvg ?? undefined
    },
    storedImageUrl ?? undefined
  )
}

/** The tab's accent colour, or null when it has none. */
export function browserTabAccent(tab: GlobalBrowserTab): string | null {
  return tab.color
}
