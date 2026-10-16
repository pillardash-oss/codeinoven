import { DEFAULT_WORK_ROOTS, workRootForKind, type WorkRoots } from '../../lib/design/work-roots'
import { normalizeWorkRoot } from '../../lib/design/work-roots'
import type { Database } from '../database/database'
import type { AuthoredWorkKind, WorkRootRelocationReport } from '../../lib/ipc/design'

/** App defaults and project overrides, restored before boards and agent tools start. */
let roots: WorkRoots = { ...DEFAULT_WORK_ROOTS }
let reports: WorkRootRelocationReport[] = []

/** Seed or replace the live roots. Called at startup and after every config save. */
export function setWorkRoots(next: WorkRoots): void {
  roots = { ...next }
}

/** A copy, so a caller cannot change the live value by accident. */
export function currentWorkRoots(projectId?: string): WorkRoots {
  return { ...(projectId ? (projectRoots.get(projectId)?.roots ?? roots) : roots) }
}

/** One kind's folder, which is what a resolver defaults to. */
export function currentWorkRoot(kind: AuthoredWorkKind, projectId?: string): string {
  return workRootForKind(currentWorkRoots(projectId), kind)
}

/** Remember what the last change moved, for the surfaces that report it. */
export function setWorkRootReports(next: readonly WorkRootRelocationReport[]): void {
  reports = next.map((report) => ({ ...report }))
}

/** What the last change moved, oldest kind first. Empty until a root is changed. */
export function currentWorkRootReports(): WorkRootRelocationReport[] {
  return reports.map((report) => ({ ...report }))
}

interface ProjectRoots {
  roots: WorkRoots
  previous: Record<AuthoredWorkKind, string[]>
}
const projectRoots = new Map<string, ProjectRoots>()
const PROJECT_ROOT_PREFIX = 'authored-work-roots:'

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
  const result: WorkRoots[] = [currentWorkRoots()]
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
