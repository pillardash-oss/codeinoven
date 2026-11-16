import { app } from 'electron'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { backgroundIo } from '../system/background-io'
import { getConfigRoot } from '../../lib/utils'
import { Logger } from '../system/logger'
import type { Project } from '../../lib/types'
import type { ProjectDeletionEvent, ProjectDeletionPhase } from '../../lib/project-deletion'
import { listProjectBrowserProfiles } from '../browser/browser-service/browser-profile-store'
import type { ProjectDeletionJob } from './project-deletion-queue'
import type { ThreadSweepSummary } from '../../lib/engines/thread-manager'

export interface ProjectDeletionDeps {
  projectManager: {
    getProject(projectId: string): Promise<Project | null>
    deleteProject(projectId: string): Promise<void>
  }
  threadManager: {
    deleteAllThreadsInProject(
      projectId: string,
      onProgress?: (done: number, total: number) => void
    ): Promise<ThreadSweepSummary>
  }
  scopeManager: {
    getBoard(projectId: string): { buckets: readonly { root: { kind: string } }[] }
    forgetProject(projectId: string): void
  }
  projectFilesService: { disposeProject(projectId: string): void }
  /** The live browser, or null before a window exists. */
  browser: () => { forgetProject(projectId: string): Promise<string[]> } | null
  designService?: () => { forgetProject: (projectId: string) => void } | null
  /** Correct the extension registry when no live browser could do it. */
  forgetProjectJar: (projectId: string) => Promise<unknown>
  /**
   * Mass deletion just freed pages in the database. Reclaiming them is a
   * background sweep of its own, so the deletion only announces the event.
   */
  onFreedSpace?: () => void
}

type Report = (event: ProjectDeletionEvent) => void

/**
 * Erase the trees that belong to a deleted project, through the I/O worker.
 *
 * Returns the paths that could not be removed instead of throwing: an
 * unreachable cache file must never fail a deletion the user already confirmed.
 */
async function purgeTrees(paths: readonly string[], force: boolean): Promise<string[]> {
  if (paths.length === 0) return []
  try {
    const result = await backgroundIo<{
      removed: string[]
      failed: { path: string; error: string }[]
    }>({ kind: 'remove-trees', paths: [...paths], force })
    for (const failed of result.failed) {
      Logger.error('A deleted project left files behind', {
        path: failed.path,
        error: failed.error
      })
    }
    return result.failed.map((failed) => failed.path)
  } catch (error) {
    Logger.error('Project purge could not run on the I/O worker', error)
    return [...paths]
  }
}

/**
 * Refuse a folder that must never be erased wholesale.
 *
 * The filesystem root, the home directory (or any ancestor of it), and the app
 * config root are all one mistake away from wiping a machine. The one exception
 * is a project folder strictly inside the managed `projects-gh/` clones
 * directory: those clones are app-owned project folders the user registered, so
 * erasing one on removal is legitimate while the clones root itself stays.
 */
function assertErasableProjectFolder(target: string): void {
  const homeDir = resolve(app.getPath('home'))
  const configRoot = resolve(getConfigRoot())
  const managedClonesRoot = resolve(join(configRoot, 'projects-gh'))
  const isInside = (child: string, parent: string): boolean => child.startsWith(parent + sep)
  const isManagedClone = isInside(target, managedClonesRoot)
  if (
    target === sep ||
    target === homeDir ||
    isInside(homeDir, target) ||
    target === configRoot ||
    (isInside(target, configRoot) && !isManagedClone)
  ) {
    throw new Error('Refusing to delete a protected directory')
  }
}

/**
 * Delete one project, start to finish, as a resumable sequence of small steps.
 *
 * Every step awaits work that itself runs off the main thread (the database
 * worker, the I/O worker, session teardown), and each one announces itself so a
 * window can show real progress instead of a frozen spinner. The ordering is
 * still transactional where it has to be: the optional folder erasure runs
 * FIRST and gates everything else, because erasing the app's records for a
 * project whose folder survived would leave the user with neither.
 */
export async function deleteProjectCascade(
  deps: ProjectDeletionDeps,
  job: ProjectDeletionJob,
  report: Report
): Promise<void> {
  const { projectId } = job
  const phase = (value: ProjectDeletionPhase): void => {
    report({ projectId, status: 'progress', phase: value })
  }

  // Read the row once: the folder guard needs it, and later steps race with its
  // removal, so every decision is made from this snapshot.
  const project = await deps.projectManager.getProject(projectId)

  if (job.deleteFolder) {
    phase('folder')
    if (!project?.path || !isAbsolute(project.path)) {
      throw new Error('This project has no local folder on disk to delete')
    }
    const target = resolve(project.path)
    assertErasableProjectFolder(target)
    // `force` treats an already-missing folder as deleted; a real failure
    // (permissions, path is a file) aborts the whole deletion, and the project
    // stays exactly as it was in CodeInOven.
    const remaining = await purgeTrees([target], true)
    if (remaining.length > 0) throw new Error('The project folder could not be deleted')
  }

  // Never orphan a registered managed worktree silently: refuse deletion until
  // every managed association is detached or removed through the guarded
  // lifecycle (dirty and unpushed work is protected).
  const board = deps.scopeManager.getBoard(projectId)
  const managedBuckets = board.buckets.filter((bucket) => bucket.root.kind === 'worktree')
  if (managedBuckets.length > 0) {
    throw new Error(
      `Cannot delete the project while ${managedBuckets.length} managed worktree scope(s) exist; remove them first`
    )
  }

  // The project's browser goes with the project, before its threads are torn
  // down: the browser service owns the live tabs and the session that holds the
  // profile open, and a profile can be gigabytes that nothing could reach once
  // the project row is gone. A launch with no browser (no window yet) still
  // removes the profiles; that is all there is to do.
  phase('browsers')
  const browser = deps.browser()
  if (browser) {
    await browser.forgetProject(projectId)
  } else {
    const profiles = await listProjectBrowserProfiles(projectId)
    await purgeTrees(
      profiles.map((profile) => profile.path),
      false
    )
    // Its extensions are installed for that project's own browser jar, so they
    // go with it. A live browser would have done this itself; with none to ask,
    // the registry file is what the next launch loads, so it is corrected here.
    await deps.forgetProjectJar(projectId).catch((error: unknown) => {
      Logger.dev('A deleted project left its extensions behind:', error)
    })
  }

  // Delete every thread through the same path as `thread:delete` (session
  // teardown, message-row cleanup, disk artifact removal), in bounded batches
  // that report how far they got. A thread that could not be swept does not
  // stop the project from going away.
  phase('threads')
  const sweep = await deps.threadManager.deleteAllThreadsInProject(projectId, (done, total) => {
    report({ projectId, status: 'progress', phase: 'threads', done, total })
  })
  if (sweep.unresolved > 0) {
    Logger.error('Threads survived the project deletion sweep', {
      projectId,
      swept: sweep.swept,
      unresolved: sweep.unresolved
    })
  }

  phase('project')
  await deps.projectManager.deleteProject(projectId)

  // Project-scoped rows that no foreign key covers go with the project. Left
  // behind, they keep the deleted project id alive in board scans, design
  // history, work-folder lists and grading queues, which is how a deleted
  // project resurfaces in the UI and gets written to again.
  phase('cleanup')
  deps.scopeManager.forgetProject(projectId)
  deps.designService?.()?.forgetProject(projectId)
  deps.projectFilesService.disposeProject(projectId)
  // App-owned scratch data keyed by this project id (spec-context attachments,
  // any leftover per-thread directories) that isn't tied to an individual
  // thread and so isn't covered by the per-thread cleanup above. Best-effort:
  // the database rows are already gone either way.
  await purgeTrees([join(getConfigRoot(), 'projects', projectId)], true)

  // Mass deletion just freed potentially thousands of pages. Reclaiming them
  // is a bounded background sweep that starts only once the queue is idle; it
  // must never be a full VACUUM here, which holds the database's write lock
  // for the whole file and froze every synchronous write on the main thread.
  deps.onFreedSpace?.()
}
