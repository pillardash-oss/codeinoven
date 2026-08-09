import { APP_SLUG } from '$shared/brand'

const STORAGE_KEY = `${APP_SLUG}.git-deployments.v1`

/**
 * Fast-render cache for the per-project `has_deployments` flag. The git panel
 * reads it synchronously on mount so the Deployments tab appears/disappears
 * instantly, before the authoritative value arrives from the database.
 */
function loadMap(): Record<string, boolean> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const map: Record<string, boolean> = {}
    for (const [projectId, value] of Object.entries(parsed)) {
      if (typeof value === 'boolean') map[projectId] = value
    }
    return map
  } catch {
    return {}
  }
}

function persist(map: Record<string, boolean>): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // Caching is optional; unavailable storage must not break the app.
  }
}

/** Cached flag for a project, or `null` when nothing is known yet. */
export function cachedHasDeployments(projectId: string): boolean | null {
  const value = loadMap()[projectId]
  return value ?? null
}

/** Update the cached flag for a single project. */
export function cacheHasDeployments(projectId: string, hasDeployments: boolean): void {
  const map = loadMap()
  if (map[projectId] === hasDeployments) return
  map[projectId] = hasDeployments
  persist(map)
}
