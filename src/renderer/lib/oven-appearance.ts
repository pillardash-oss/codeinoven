import { PROJECT_COLORS } from '$lib/project-colors'
import { PROJECT_SVG_ICONS } from '$lib/project-svg-icons'

export interface OvenAppearancePick {
  icon: string
  color: string
}

/**
 * Pick an icon and an accent for a brand new Oven from the app's shared sets.
 *
 * Every Oven used to start on the same `server` icon in the same green, which
 * made a list of Ovens read as one repeated entry. A new Oven now draws a random
 * pair instead, and the person can still change either one in the same editor.
 *
 * `random` is injectable so the choice is deterministic under test.
 */
export function randomOvenAppearance(random: () => number = Math.random): OvenAppearancePick {
  const icon = PROJECT_SVG_ICONS[Math.floor(random() * PROJECT_SVG_ICONS.length)].key
  const color = PROJECT_COLORS[Math.floor(random() * PROJECT_COLORS.length)].value
  return { icon, color }
}
