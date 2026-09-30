import { getProjectIcon } from '$lib/project-icons'
import { pickColorForSeed } from '$lib/project-colors'
import type { GlobalBrowserGroup } from '$lib/stores/global-browser-types'

/**
 * Whether an appearance carries a real icon (a library key, a pasted SVG or a
 * picked image) rather than only a colour. A colour alone resolves to a dot in a
 * tight slot, so the tab row's box badge and the boxes panel can decide without
 * each testing the three fields itself.
 */
export function browserAppearanceHasIcon(entity: {
  iconType: string | null
  customSvg: string | null
  imagePath: string | null
}): boolean {
  return Boolean(entity.iconType || entity.customSvg || entity.imagePath)
}

/**
 * Whether the user styled an identity at all: a colour, a library icon, a pasted
 * SVG or a picked image. An entity wearing none of them has no identity to show,
 * which is what lets the rail keep its own glyph for a box nobody styled while
 * still wearing the icon and colour of one that was.
 */
export function browserAppearanceIsCustomised(entity: {
  color: string | null
  iconType: string | null
  customSvg: string | null
  imagePath: string | null
}): boolean {
  return Boolean(entity.color || entity.iconType || entity.customSvg || entity.imagePath)
}

/**
 * The accent of anything wearing the browser appearance vocabulary, a group or a
 * box: its own hex colour, or a deterministic one so a colourless identity still
 * has a stable accent. Shared so the two cannot drift into different palettes.
 */
export function browserAppearanceAccent(entity: { id: string; color: string | null }): string {
  return entity.color ?? pickColorForSeed(entity.id)
}

/**
 * The browser group's accent, resolved the same way a project's is: its own hex
 * colour, or a deterministic one so a colourless group still has a stable
 * identity. Used for the group row's tint, dot and name.
 */
export function browserGroupAccent(group: GlobalBrowserGroup): string {
  return browserAppearanceAccent(group)
}

/**
 * The icon of anything wearing the browser appearance vocabulary, drawn by the
 * very resolver projects and routines use, so a picked image, a pasted SVG, a
 * library icon and the colour fallback all render through one code path.
 * `storedImageUrl` is the data URL read back from the entity's `imagePath`,
 * when one has been loaded. Shared by the group and box rows.
 */
export function browserAppearanceIconUrl(
  entity: {
    id: string
    name: string
    color: string | null
    iconType: string | null
    customSvg: string | null
  },
  storedImageUrl: string | null
): string | null {
  return getProjectIcon(
    {
      id: entity.id,
      name: entity.name,
      color: entity.color ?? undefined,
      iconType: entity.iconType ?? undefined,
      customSvg: entity.customSvg ?? undefined
    },
    storedImageUrl ?? undefined
  )
}

/**
 * The group's icon as an image data URL. Delegates to the shared resolver so a
 * group and a box can never render their identical appearance differently.
 */
export function browserGroupIconUrl(
  group: GlobalBrowserGroup,
  storedImageUrl: string | null
): string | null {
  return browserAppearanceIconUrl(group, storedImageUrl)
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
