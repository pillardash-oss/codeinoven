import { invoke } from '$lib/ipc.svelte'
import type { Project } from '$shared/types'
import { getIconSvgDataUrl, generateInitialsIconSvg } from './project-svg-icons'
import { pickColorForSeed } from './project-colors'

/** Minimal project shape needed to resolve an icon. */
export interface ProjectIconSource {
  id: string
  name: string
  color?: string
  iconType?: string
}

/**
 * Resolve the best available icon representation for a project.
 *
 * Priority:
 * 1. Stored custom image icon (project.icon file)
 * 2. SVG icon type (project.iconType) with project colour
 * 3. Initials-on-colour-circle fallback using project colour (or deterministic auto-colour)
 * 4. null  — the caller falls back to a generic icon
 */
export function getProjectIcon(
  project: ProjectIconSource,
  storedIconUrl: string | undefined
): string | null {
  // Priority 1: custom image
  if (storedIconUrl) return storedIconUrl

  // Priority 2: SVG icon type
  const color = project.color
  if (project.iconType && color) {
    return getIconSvgDataUrl(project.iconType, color)
  }
  if (project.iconType) {
    return getIconSvgDataUrl(project.iconType, pickColorForSeed(project.id))
  }

  // Priority 3: initials fallback
  if (color) {
    return generateInitialsIconSvg(project.name, color)
  }
  const autoColor = pickColorForSeed(project.id)
  return generateInitialsIconSvg(project.name, autoColor)
}

/** Fetch stored icon data URLs for every project that declares an icon. */
export async function loadProjectIcons(projects: Project[]): Promise<Map<string, string>> {
  const icons = new Map<string, string>()

  await Promise.all(
    projects
      .filter((p) => p.icon)
      .map(async (p) => {
        try {
          const url = await invoke('project:getIcon', p.id)
          if (url) icons.set(p.id, url)
        } catch {
          // Icon loading is best-effort
        }
      })
  )

  return icons
}

/**
 * Build an `onerror` handler for a project icon `<img>`. If the custom image
 * data URL fails to decode (blank slot), swap the src to the initials fallback
 * so the icon slot is never empty. The swap is one-shot to avoid loops.
 */
export function projectIconOnError(project: ProjectIconSource): (event: Event) => void {
  return (event: Event) => {
    const img = event.currentTarget as HTMLImageElement
    if (img.dataset.iconFallbackApplied) return
    img.dataset.iconFallbackApplied = 'true'
    const fallback = getProjectIcon(project, undefined)
    if (fallback) img.src = fallback
  }
}
