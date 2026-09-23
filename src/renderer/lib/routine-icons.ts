import { getIconSvgDataUrl } from './project-svg-icons'

/** Muted tint used when a routine declares no accent colour of its own. */
export const ROUTINE_ICON_FALLBACK_COLOR = '#8b95a5'

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
 * 3. null   the caller falls back to its own generic routine icon
 *
 * Every routine surface resolves its icon here, so an edited routine icon and
 * colour read identically in the sidebar row, the search results, and the file
 * tree the routine's own workspace mounts.
 */
export function getRoutineIcon(
  routine: RoutineAppearanceSource,
  storedIconUrl?: string | null
): string | null {
  if (storedIconUrl) return storedIconUrl
  if (!routine.iconType) return null
  return getIconSvgDataUrl(routine.iconType, routineAccentColor(routine))
}
