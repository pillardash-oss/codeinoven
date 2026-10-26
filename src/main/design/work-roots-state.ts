import { DEFAULT_WORK_ROOTS, workRootForKind, type WorkRoots } from '../../lib/design/work-roots'
import { usesThreadWorkspaceMount } from '../../lib/types'
import { normalizeWorkRoot } from '../../lib/design/work-roots'
import type { Database } from '../database/database'
import type { AuthoredWorkKind } from '../../lib/ipc/design'

/**
 * Where each project writes its authored work.
 *
 * The app default is a constant and this module holds only project records, so a
 * project that never changed its folder is answered with the default and nothing
 * has to be written to say so. The records are the single place a project's folder
 * comes from: leaving one design, or one video, somewhere else is a property of
 * that folder rather than of the project, so it never reaches here.
 */

interface ProjectRoots {
  roots: WorkRoots
  /** Folders the project used before, kept so old work stays discoverable. */
  previous: Record<AuthoredWorkKind, string[]>
}
const projectRoots = new Map<string, ProjectRoots>()
const PROJECT_ROOT_PREFIX = 'authored-work-roots:'

/** The folders one project writes into: its own record, or the app default. */
export function currentWorkRoots(projectId?: string): WorkRoots {
  const recorded = projectId ? projectRoots.get(projectId) : undefined
  return recorded ? { ...recorded.roots } : { ...DEFAULT_WORK_ROOTS }
}

/** One kind's folder, which is what a resolver falls back to. */
export function currentWorkRoot(kind: AuthoredWorkKind, projectId?: string): string {
  return workRootForKind(currentWorkRoots(projectId), kind)
}

/** Restore project preferences before preview services and agent tools start. */
export async function loadProjectWorkRoots(database: Database): Promise<void> {
  const result = await database.queryViaWorker(
    'SELECT key, value FROM db_meta WHERE key LIKE ?',
    [`${PROJECT_ROOT_PREFIX}%`],
    0
  )
  if (!result.ok) throw new Error('Could not load project save paths')
  projectRoots.clear()
  for (const row of result.rows as unknown as Array<{ key: string; value: string }>) {
    try {
      const value: ProjectRoots = JSON.parse(row.value)
      if (!normalizeWorkRoot(value.roots.design) || !normalizeWorkRoot(value.roots.video)) continue
      for (const kind of ['design', 'video'] as const) {
        value.previous[kind] = value.previous[kind].filter(
          (path) => normalizeWorkRoot(path) === path
        )
      }
      projectRoots.set(row.key.slice(PROJECT_ROOT_PREFIX.length), value)
    } catch {
      /* A malformed saved preference falls back to the app default. */
    }
  }
}

/** Old roots remain discoverable when only one folder moves. */
export function projectWorkRootPaths(projectId: string, kind: AuthoredWorkKind): string[] {
  return [
    ...new Set([
      currentWorkRoot(kind, projectId),
      ...(projectRoots.get(projectId)?.previous[kind] ?? [])
    ])
  ]
}

export async function saveProjectWorkRoot(
  database: Database,
  projectId: string,
  kind: AuthoredWorkKind,
  root: string
): Promise<void> {
  // A conversation container is not a project that can record a save root: every
  // assistant task shares the same id, so one record would move every assistant's
  // work. Their root is the workspace they run in, and it is not a setting.
  if (usesThreadWorkspaceMount(projectId)) {
    throw new Error('A conversation workspace writes its work into the folder it runs in')
  }
  const current = currentWorkRoots(projectId)
  const previous = projectRoots.get(projectId)?.previous ?? { design: [], video: [] }
  const value: ProjectRoots = {
    roots: { ...current, [kind]: root },
    previous: { ...previous, [kind]: [...new Set([...previous[kind], current[kind]])] }
  }
  const saved = await database.executeViaWorker(
    'INSERT INTO db_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [`${PROJECT_ROOT_PREFIX}${projectId}`, JSON.stringify(value)]
  )
  if (!saved.ok) throw new Error(saved.error ?? 'Could not save project work folder')
  projectRoots.set(projectId, value)
}

/** All current and historical roots, for conservative scratch-cleanup protection. */
export function protectedWorkRoots(): WorkRoots[] {
  const result: WorkRoots[] = [{ ...DEFAULT_WORK_ROOTS }]
  for (const [projectId, value] of projectRoots) {
    result.push(value.roots)
    for (const kind of ['design', 'video'] as const) {
      for (const root of projectWorkRootPaths(projectId, kind))
        result.push({ ...value.roots, [kind]: root })
    }
  }
  return result
}

export function forgetProjectWorkRoots(database: Database, projectId: string): void {
  database.run('DELETE FROM db_meta WHERE key = ?', `${PROJECT_ROOT_PREFIX}${projectId}`)
  projectRoots.delete(projectId)
}
