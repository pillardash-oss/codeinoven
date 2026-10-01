import { join } from 'node:path'
import type { Database } from '../database/database'
import { ProjectRepo } from '../database/repositories/project-repo'
import { ThreadRepo } from '../database/repositories/thread-repo'
import { Logger } from '../system/logger'
import type { StorageEngine } from './storage-engine'

/**
 * Reclaim app-owned directories whose database row is gone.
 *
 * Deleting a thread, a project or a routine removes its directory, but the two
 * are not one transaction: a crash between the row delete and the disk removal,
 * a database restored from a backup, or a project registered inside the config
 * root by a test run all leave a directory nothing can reach. The database never
 * lists it and the user never sees it, so it occupies disk forever.
 *
 * Only a directory whose owning row is provably absent is removed: a project
 * directory with no project row, and a thread directory whose project row exists
 * but whose thread row does not. The sweep is bounded per run, so a machine with
 * a large backlog reclaims steadily instead of stalling one launch.
 */

/** Directories one run may remove before it stops until the next launch. */
const MAX_REMOVALS_PER_RUN = 200

export interface OrphanArtifactSweepResult {
  /** Project directories whose project row is gone. */
  removedProjects: number
  /** Thread directories whose thread row is gone. */
  removedThreads: number
}

export async function sweepOrphanProjectArtifacts(
  storage: StorageEngine,
  database: Database
): Promise<OrphanArtifactSweepResult> {
  const result: OrphanArtifactSweepResult = { removedProjects: 0, removedThreads: 0 }
  let projectDirs: string[]
  try {
    projectDirs = await storage.listDirectories('projects')
  } catch (error) {
    Logger.dev('Orphan artifact sweep could not list projects:', error)
    return result
  }
  const projectIds = new Set(await new ProjectRepo(database).listIdsViaWorker())
  const threads = new ThreadRepo(database)
  let removals = 0

  for (const projectDirectory of projectDirs) {
    if (removals >= MAX_REMOVALS_PER_RUN) break
    if (projectDirectory.startsWith('.')) continue
    if (!projectIds.has(projectDirectory)) {
      await removeQuietly(storage, join('projects', projectDirectory))
      result.removedProjects += 1
      removals += 1
      continue
    }
    const threadIds = new Set(await threads.listIdsViaWorker(projectDirectory))
    let threadDirs: string[]
    try {
      threadDirs = await storage.listDirectories(join('projects', projectDirectory, 'threads'))
    } catch {
      continue
    }
    for (const threadDirectory of threadDirs) {
      if (removals >= MAX_REMOVALS_PER_RUN) break
      if (threadIds.has(threadDirectory)) continue
      await removeQuietly(storage, join('projects', projectDirectory, 'threads', threadDirectory))
      result.removedThreads += 1
      removals += 1
    }
  }

  if (removals > 0) {
    Logger.info('Reclaimed orphaned project artifacts', result)
  }
  return result
}

async function removeQuietly(storage: StorageEngine, relativePath: string): Promise<void> {
  try {
    await storage.remove(relativePath)
  } catch (error) {
    // A directory that cannot be removed is retried next launch; it must never
    // fail the sweep and take the rest of the backlog with it.
    Logger.dev('Orphan artifact removal failed:', { relativePath, error: String(error) })
  }
}
