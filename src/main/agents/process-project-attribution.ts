import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Project } from '../../lib/types'
import { getProjectPath } from '../../lib/utils'

/**
 * Attribute a process row to a project from the directory it works in.
 *
 * Session ownership covers most rows: a harness root is registered with the
 * project and thread it serves, and a child of that root inherits them. Two
 * kinds of row escape that. A daemon that re-parents to launchd (the `adb`
 * fork-server) is adopted from the process snapshot with no session to claim,
 * and a shared runtime (the pooled `opencode serve`) is started app-wide for
 * whichever project needed it first. Both carry a working directory that names
 * the project whose files they are working in, and that directory is the only
 * honest owner left, so the task manager can list them under it instead of
 * under the app-wide node.
 */

/** One filesystem directory whose contents belong to a project. */
export interface ProjectDirectory {
  projectId: string
  /** Canonical absolute directory that belongs to the project. */
  path: string
}

/**
 * Every directory a set of projects owns: the registered checkout, and the
 * app-managed directory that holds the project's scope worktrees
 * (`<config-root>/projects/<id>`, so a worktree under `scope/` matches through
 * its parent). Paths are canonicalised, so a symlinked checkout or a worktree
 * under a resolved `/private/var` path still matches the cwd another process
 * reports.
 */
export async function projectDirectories(
  projects: readonly Project[]
): Promise<ProjectDirectory[]> {
  const entries = await Promise.all(
    projects.flatMap((project) => {
      const candidates = [getProjectPath(project.id)]
      if (project.source === 'local' && project.path.trim().length > 0) {
        candidates.push(project.path)
      }
      return candidates.map(async (path) => ({
        projectId: project.id,
        path: await canonicalPath(path)
      }))
    })
  )
  return entries
}

/**
 * Project a working directory belongs to, or `null` when none does.
 *
 * The longest matching directory wins, so a checkout nested inside another
 * project attributes to the most specific one.
 */
export async function projectIdForWorkingDirectory(
  cwd: string | null,
  directories: readonly ProjectDirectory[]
): Promise<string | null> {
  if (!cwd) return null
  const canonical = await canonicalPath(cwd)
  let match: ProjectDirectory | null = null
  for (const entry of directories) {
    if (!contains(entry.path, canonical)) continue
    if (!match || entry.path.length > match.path.length) match = entry
  }
  return match?.projectId ?? null
}

/**
 * `resolve` then `realpath`, falling back to the resolved path when the
 * directory no longer exists (a process holding a deleted directory) or cannot
 * be resolved.
 */
async function canonicalPath(path: string): Promise<string> {
  const resolved = resolve(path)
  try {
    return await realpath(resolved)
  } catch {
    return resolved
  }
}

/** True when `candidate` is `root` itself or sits inside it. */
function contains(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}
