import { Preferences } from '@capacitor/preferences'
import type { Project } from '#lib/api/types'

/**
 * Which projects this phone worked on, most recent first.
 *
 * The service orders projects by activity, which is a project's own clock and
 * not this person's: a project opened five minutes ago can carry an older
 * activity stamp than one touched last month. A new thread belongs in whichever
 * project was opened last, so the phone keeps its own short list and puts it in
 * front of everything the service returns.
 */

const KEY = 'cio.mobile.project-recency'
const KEEP = 20

export async function readProjectRanking(): Promise<string[]> {
  try {
    const { value } = await Preferences.get({ key: KEY })
    if (!value) return []
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is string => typeof entry === 'string')
  } catch {
    // A preference that cannot be read costs an ordering, never a screen.
    return []
  }
}

/** Put a project at the front of the list, because it is the one in hand now. */
export async function rememberProject(id: string): Promise<void> {
  if (id.length === 0) return
  try {
    const ranking = await readProjectRanking()
    const next = [id, ...ranking.filter((entry) => entry !== id)].slice(0, KEEP)
    await Preferences.set({ key: KEY, value: JSON.stringify(next) })
  } catch {
    // Losing the ordering costs one extra tap the next time a thread starts.
  }
}

/**
 * Projects in the order to offer them: the ones this phone opened, newest
 * first, then the service's own order for everything else.
 */
export function orderProjects(projects: Project[], ranking: string[]): Project[] {
  const byId = new Map(projects.map((project) => [project.id, project]))
  const ranked = ranking
    .map((id) => byId.get(id))
    .filter((project): project is Project => project !== undefined)
  const seen = new Set(ranked.map((project) => project.id))
  return [...ranked, ...projects.filter((project) => !seen.has(project.id))]
}
