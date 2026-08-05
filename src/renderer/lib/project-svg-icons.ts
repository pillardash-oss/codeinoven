export interface ProjectSvgIcon {
  key: string
  label: string
  /** SVG path data (the `d` attribute of a `<path>` element) — always 16×16, 1.5px stroke. */
  path: string
}

/**
 * Each icon is a 16×16 SVG path drawn with a 1.5px stroke, no fill.
 * Used as the basis for coloured SVG data-URLs at render time.
 */
export const PROJECT_SVG_ICONS: ProjectSvgIcon[] = [
  {
    key: 'folder',
    label: 'Folder',
    path: 'M1.75 3.5h4.586a1 1 0 0 1 .707.293l1.414 1.414a1 1 0 0 0 .707.293H14.25a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H1.75a1 1 0 0 1-1-1v-8.5a1 1 0 0 1 1-1Z'
  },
  {
    key: 'code',
    label: 'Code',
    path: 'M10 3 6 13.5M4 5.5 1.5 8 4 10.5M12 5.5l2.5 2.5L12 10.5'
  },
  {
    key: 'terminal',
    label: 'Terminal',
    path: 'M2 3.5h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1ZM4.5 8.5 6 7 4.5 5.5M8.5 9.5H11'
  },
  {
    key: 'git',
    label: 'Git',
    path: 'M8 1.5 3 6.5a1.5 1.5 0 0 0 0 2.12l4.5 4.5a1.5 1.5 0 0 0 2.12 0l4.5-4.5a1.5 1.5 0 0 0 0-2.12L10.12 1.5a1.5 1.5 0 0 0-2.12 0ZM1.5 14.5l3-3M14.5 1.5 10 6'
  },
  {
    key: 'globe',
    label: 'Globe',
    path: 'M8 1.5A6.5 6.5 0 1 0 8 14.5 6.5 6.5 0 0 0 8 1.5ZM2.5 8h11M8 1.5c-1.8 0-3.25 2.9-3.25 6.5S6.2 14.5 8 14.5s3.25-2.9 3.25-6.5S9.8 1.5 8 1.5Z'
  },
  {
    key: 'database',
    label: 'Database',
    path: 'M2 3.5c0 1.1 2.7 2 6 2s6-.9 6-2M2 3.5v9c0 1.1 2.7 2 6 2s6-.9 6-2v-9M2 8c0 1.1 2.7 2 6 2s6-.9 6-2'
  },
  {
    key: 'server',
    label: 'Server',
    path: 'M1.75 8.5h12.5a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H1.75a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1ZM4 11h.01M7 11h.01M4 13h.01M7 13h.01M1.75 1.5h12.5a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H1.75a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1ZM4 4h.01M7 4h.01'
  },
  {
    key: 'cloud',
    label: 'Cloud',
    path: 'M11.25 11.5a3.75 3.75 0 1 0-3.17-5.63A4.25 4.25 0 1 0 5 11.5h6.25Z'
  },
  {
    key: 'book',
    label: 'Book',
    path: 'M2 2.5h4a2 2 0 0 1 2 2v9a2 2 0 0 0-2-2H2v-9ZM14 2.5h-4a2 2 0 0 0-2 2v9a2 2 0 0 1 2-2h4v-9Z'
  },
  {
    key: 'star',
    label: 'Star',
    path: 'M8 1.5 9.96 5.52l4.34.63-3.15 3.07.74 4.34L8 11.41l-3.89 2.05.74-4.34L1.7 6.15l4.34-.63L8 1.5Z'
  },
  {
    key: 'rocket',
    label: 'Rocket',
    path: 'M8 8.5c-2 0-4-1-5-4 1.5-.5 3-1 5-1s3.5.5 5 1c-1 3-3 4-5 4ZM8 8.5V13M6.5 13h3M10.5 5.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z'
  },
  {
    key: 'zap',
    label: 'Lightning',
    path: 'M5.5 1.5 3 9h3.5l-1 5.5L12 7H8.5L11 1.5H5.5Z'
  },
  {
    key: 'shield',
    label: 'Shield',
    path: 'M8 1.5 2 3.5v4.5c0 4 2.5 6.5 6 7 3.5-.5 6-3 6-7V3.5L8 1.5ZM6 8.5 7.5 10 10 6.5'
  },
  {
    key: 'puzzle',
    label: 'Puzzle',
    path: 'M4.5 3.5V2a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M4.5 3.5H3a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1h1.5M10.5 3.5V2a1 1 0 0 0-1-1h-1a1 1 0 0 0-1 1v1.5M10.5 3.5H13a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1h-1.5M4.5 10.5v2A1.5 1.5 0 0 0 6 14h1a1 1 0 0 0 1-1v-.5M10.5 10.5v2A1.5 1.5 0 0 1 10 14H9a1 1 0 0 1-1-1v-.5'
  },
  {
    key: 'settings',
    label: 'Settings',
    path: 'M8 1.5a1 1 0 0 1 .87.51l.76 1.38a7.9 7.9 0 0 1 1.26.52l1.52-.61a1 1 0 0 1 1.1.33l1 1.25a1 1 0 0 1 .17 1.09l-.68 1.5c.1.5.1 1.02 0 1.52l.68 1.5a1 1 0 0 1-.17 1.09l-1 1.25a1 1 0 0 1-1.1.33l-1.52-.61c-.4.2-.82.38-1.26.52l-.76 1.38a1 1 0 0 1-.87.51H7.13a1 1 0 0 1-.87-.51l-.76-1.38a7.9 7.9 0 0 1-1.26-.52l-1.52.61a1 1 0 0 1-1.1-.33l-1-1.25a1 1 0 0 1-.17-1.09l.68-1.5a5.87 5.87 0 0 1 0-1.52l-.68-1.5a1 1 0 0 1 .17-1.09l1-1.25a1 1 0 0 1 1.1-.33l1.52.61c.4-.2.82-.38 1.26-.52l.76-1.38A1 1 0 0 1 7.13 1.5H8ZM6.5 8a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0Z'
  },
  {
    key: 'heart',
    label: 'Heart',
    path: 'M8 13.5 2.5 8.2A4.25 4.25 0 0 1 8 3.3a4.25 4.25 0 0 1 5.5 4.9L8 13.5Z'
  }
]

const iconCache = new Map<string, string>()

/**
 * Build an SVG data-URL for the given icon type and colour.
 * Results are cached by `${key}:${color}`.
 */
export function getIconSvgDataUrl(key: string, color: string): string {
  const cacheKey = `${key}:${color}`
  const cached = iconCache.get(cacheKey)
  if (cached) return cached

  const icon = PROJECT_SVG_ICONS.find((i) => i.key === key)
  const d = icon?.path ?? PROJECT_SVG_ICONS[0].path

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none">`,
    `  <path d="${d}" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
    `</svg>`
  ].join('\n')

  const url = `data:image/svg+xml;base64,${btoa(svg)}`
  iconCache.set(cacheKey, url)
  return url
}

/**
 * Generate an SVG data-URL showing the first character of `name` on a coloured
 * circle background. Used as the fallback when no custom icon, icon type, or
 * colour is configured.
 */
export function generateInitialsIconSvg(name: string, color: string): string {
  const initial = name.charAt(0).toUpperCase()

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">`,
    `  <circle cx="8" cy="8" r="8" fill="${color}" opacity="0.2"/>`,
    `  <text x="8" y="11" text-anchor="middle" font-size="10" font-weight="600" fill="${color}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">${initial}</text>`,
    `</svg>`
  ].join('\n')

  return `data:image/svg+xml;base64,${btoa(svg)}`
}
