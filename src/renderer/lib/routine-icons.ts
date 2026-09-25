import { Workflow } from '@lucide/svelte'
import { getIconSvgDataUrl } from './project-svg-icons'

/** Muted tint used when a routine declares no accent colour of its own. */
export const ROUTINE_ICON_FALLBACK_COLOR = '#8b95a5'

/**
 * The mark a routine without an icon of its own is drawn with.
 *
 * A routine's name is often a whole sentence ("Check my slack messages every
 * morning and evening"), so surfaces never print that name where a routine icon
 * is expected: a routine always has a mark, by falling back to this one.
 */
export const RoutineDefaultIcon = Workflow

/** Minimal routine shape needed to resolve an icon or an accent colour. */
export interface RoutineAppearanceSource {
  color?: string
  iconType?: string
}

/** The accent colour every routine surface tints its routine with. */
export function routineAccentColor(routine: RoutineAppearanceSource): string {
  return routine.color ?? ROUTINE_ICON_FALLBACK_COLOR
}

/**
 * Resolve the best available routine icon image.
 *
 * Priority:
 * 1. Stored custom image icon (the routine's own icon file, read as a data URL)
 * 2. SVG icon type (`routine.iconType`) tinted with the routine's accent colour
 * 3. null   the caller draws `RoutineDefaultIcon`, the routine default mark
 *
 * Every routine surface resolves its icon here, so an edited routine icon and
 * colour read identically in the sidebar row, the search results, and the file
 * tree the routine's own workspace mounts. Null is never a reason to fall back
 * to a generic folder mark or to the routine's name: draw `RoutineDefaultIcon`.
 */
export function getRoutineIcon(
  routine: RoutineAppearanceSource,
  storedIconUrl?: string | null
): string | null {
  if (storedIconUrl) return storedIconUrl
  if (!routine.iconType) return null
  return getIconSvgDataUrl(routine.iconType, routineAccentColor(routine))
}
