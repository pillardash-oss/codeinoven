import { invoke } from '$lib/ipc.svelte'
import type { RepositoryPreflightResult } from '$shared/types'

/**
 * Repository preflight, cached per project.
 *
 * Deciding what the Git panel is looking at costs a `project:get` plus a git
 * process spawn (`repository:preflight` runs `rev-parse --show-toplevel`). The
 * panel is torn down whenever the context sidebar collapses, so without this
 * cache every single re-open paid that spawn again and hid the whole panel
 * behind "Checking repository" while it ran, even though the working tree state
 * was already in the store and the user could have been staging files.
 *
 * The answer is a property of the path, not of the session, so it is safe to
 * hold for a while. It is not safe to hold forever: a repository can be
 * initialized or removed outside the app. `force` is the way out, and the
 * panel's own refresh button and its `git init` path both use it.
 */

const snapshots = new Map<string, RepositoryPreflightSnapshot>()
const requests = new Map<string, Promise<RepositoryPreflightSnapshot>>()

/** How long a preflight answer is trusted without re-checking. */
const PREFLIGHT_TTL_MS = 60_000

export interface RepositoryPreflightSnapshot {
  /** The project's working directory, or an empty string when it has none. */
  path: string
  /** Whether the project has deployment runbooks, when the database knows. */
  hasDeployments: boolean | undefined
  preflight: RepositoryPreflightResult
  fetchedAt: number
}

/** The cached answer for a project, or null when there is none or it has aged out. */
export function cachedRepositoryPreflight(projectId: string): RepositoryPreflightSnapshot | null {
  const snapshot = snapshots.get(projectId)
  if (!snapshot) return null
  if (Date.now() - snapshot.fetchedAt >= PREFLIGHT_TTL_MS) {
    snapshots.delete(projectId)
    return null
  }
  return snapshot
}

/**
 * Read a project's preflight, serving the cache first.
 *
 * Concurrent callers share one request, which is what lets the header chip warm
 * the panel on hover while the panel itself mounts and asks the same question
 * without spawning git twice.
 */
export function loadRepositoryPreflight(
  projectId: string,
  force = false
): Promise<RepositoryPreflightSnapshot> {
  if (!force) {
    const cached = cachedRepositoryPreflight(projectId)
    if (cached) return Promise.resolve(cached)
  }
  const pending = requests.get(projectId)
  if (pending) return pending

  const request = readPreflight(projectId)
    .then((snapshot) => {
      snapshots.set(projectId, snapshot)
      return snapshot
    })
    .finally(() => {
      if (requests.get(projectId) === request) requests.delete(projectId)
    })
  requests.set(projectId, request)
  return request
}

/** Drop a project's answer, so the next read asks the filesystem again. */
export function invalidateRepositoryPreflight(projectId: string): void {
  snapshots.delete(projectId)
}

async function readPreflight(projectId: string): Promise<RepositoryPreflightSnapshot> {
  const project = await invoke('project:get', projectId)
  const path = project?.path ?? ''
  if (!path) {
    return {
      path,
      hasDeployments: project?.hasDeployments,
      // No directory to inspect is the same answer as "not a repository", and
      // saying so here keeps the panel from rendering a checkout it cannot read.
      preflight: { status: 'not_git', projectPath: '' },
      fetchedAt: Date.now()
    }
  }
  const preflight = await invoke('repository:preflight', path)
  return { path, hasDeployments: project?.hasDeployments, preflight, fetchedAt: Date.now() }
}
