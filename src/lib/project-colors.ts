export interface ProjectColorOption {
  name: string
  value: string
}

export const PROJECT_COLORS: ProjectColorOption[] = [
  { name: 'Slate', value: '#64748b' },
  { name: 'Gray', value: '#6b7280' },
  { name: 'Zinc', value: '#71717a' },
  { name: 'Red', value: '#ef4444' },
  { name: 'Orange', value: '#f97316' },
  { name: 'Amber', value: '#f59e0b' },
  { name: 'Yellow', value: '#eab308' },
  { name: 'Lime', value: '#84cc16' },
  { name: 'Green', value: '#22c55e' },
  { name: 'Emerald', value: '#10b981' },
  { name: 'Teal', value: '#14b8a6' },
  { name: 'Cyan', value: '#06b6d4' },
  { name: 'Sky', value: '#0ea5e9' },
  { name: 'Blue', value: '#3b82f6' },
  { name: 'Indigo', value: '#6366f1' },
  { name: 'Violet', value: '#8b5cf6' },
  { name: 'Purple', value: '#a855f7' },
  { name: 'Fuchsia', value: '#d946ef' },
  { name: 'Pink', value: '#ec4899' },
  { name: 'Rose', value: '#f43f5e' }
]

/** Deterministically pick a colour from the palette based on a seed string. */
export function pickColorForSeed(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i++) {
    hash = seed.charCodeAt(i) + ((hash << 5) - hash)
  }
  return PROJECT_COLORS[Math.abs(hash) % PROJECT_COLORS.length].value
}

/**
 * Pick a colour at random, for a surface that should have an accent of its own
 * from the moment it exists rather than one derived from its name.
 *
 * An assistant built by talking has no name while the conversation settles one,
 * and the name it is given later must not repaint the accent it has been wearing,
 * so its colour is chosen once, at creation, and never derived from the name.
 */
export function pickRandomColor(): string {
  return PROJECT_COLORS[Math.floor(Math.random() * PROJECT_COLORS.length)].value
}
