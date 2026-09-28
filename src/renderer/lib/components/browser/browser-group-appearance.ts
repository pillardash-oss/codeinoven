import { getProjectIcon } from '$lib/project-icons'
import { pickColorForSeed } from '$lib/project-colors'
import type { GlobalBrowserGroup } from '$lib/stores/global-browser-types'

/**
 * The browser group's accent, resolved the same way a project's is: its own hex
 * colour, or a deterministic one so a colourless group still has a stable
 * identity. Used for the group row's tint, dot and name.
 */
export function browserGroupAccent(group: GlobalBrowserGroup): string {
  return group.color ?? pickColorForSeed(group.id)
}

/**
 * The group's icon as an image data URL, drawn by the very resolver projects
 * and routines use, so a picked image, a pasted SVG, a library icon and the
 * colour fallback all render through one code path. `storedImageUrl` is the
 * data URL read back from `group.imagePath`, when one has been loaded.
 */
export function browserGroupIconUrl(
  group: GlobalBrowserGroup,
  storedImageUrl: string | null
): string | null {
  return getProjectIcon(
    {
      id: group.id,
      name: group.name,
      color: group.color ?? undefined,
      iconType: group.iconType ?? undefined,
      customSvg: group.customSvg ?? undefined
    },
    storedImageUrl ?? undefined
  )
}

/**
 * The image path a tab or group should end up with after an edit, mirroring how
 * a routine's image and SVG icon interact:
 *
 *  - a freshly picked image wins,
 *  - a pasted SVG replaces a stored image,
 *  - switching to a library SVG icon clears the stored image,
 *  - otherwise the stored image is kept.
 *
 * Kept pure and shared so the tab editor and the group editor cannot drift.
 */
export function resolveAppearanceImagePath(params: {
  currentImagePath: string | null
  currentIconType: string | null
  customSvgSelected: boolean
  customSvg: string | null
  pendingIconPath: string | null
  chosenIconType: string | null
}): string | null {
  const {
    currentImagePath,
    currentIconType,
    customSvgSelected,
    customSvg,
    pendingIconPath,
    chosenIconType
  } = params
  if (customSvgSelected && customSvg && currentImagePath) return null
  if (pendingIconPath && !customSvgSelected) return pendingIconPath
  const switchingToSvgIcon = chosenIconType !== currentIconType && chosenIconType !== null
  return currentImagePath && switchingToSvgIcon ? null : currentImagePath
}
