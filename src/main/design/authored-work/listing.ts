import type { Database } from '../../database/database'
import type { AuthoredWorkKind, DesignEntry } from '../../../lib/ipc/design'
import { listProjectWorkFolders } from '../design-listing'
import { listConversationWorkFolders, WorkFolderRegistry } from '../work-folder-registry'
import { currentWorkRoot } from '../work-roots-state'
import { slashPath } from './placement'
import { authoredWorkRoot } from './roots'
import { authoredWorkRoots } from './scope-roots'

/** One project's authored work of one kind, as a board lists it. */
export interface AuthoredWorkListing {
  projectId: string
  threadId: string
  kind: AuthoredWorkKind
}

/**
 * Every folder of one kind a project holds, from every checkout it writes into.
 *
 * One listing serves both boards: a design and a composition are the same sort of
 * thing to the app (a folder of work one root below the kind's folder), so the rule
 * is stated once and a change to where authored work is read applies to both. The
 * primary root answers through the project's registry, which can describe a folder
 * that is no longer on disk and follows one the user moved; every other checkout is
 * read from disk, because the registry is keyed by project-relative folder and
 * cannot describe a checkout the project does not own.
 *
 * Entries found in an additional checkout are spelled by absolute path, which is
 * what keeps a design in a worktree apart from a same-named one in the project's own
 * folder. Nothing is repeated: a root that answers with the same absolute folder is
 * the same work.
 */
export async function listAuthoredWork(
  database: Database,
  listing: AuthoredWorkListing
): Promise<DesignEntry[]> {
  const primary = await authoredWorkRoot(database, listing.projectId, listing.threadId)
  const kindRoot = currentWorkRoot(listing.kind, listing.projectId)
  const listed = primary.appOwned
    ? await listConversationWorkFolders({
        database,
        projectId: listing.projectId,
        threadId: listing.threadId,
        assistantId: primary.assistantId,
        workspacePath: primary.path,
        kind: listing.kind
      })
    : await new WorkFolderRegistry(database).list(listing.projectId, primary.path, listing.kind)
  const roots = await authoredWorkRoots(database, listing.projectId, listing.threadId)
  const folders = [...listed]
  const seen = new Set(listed.map((entry) => entry.directory))
  for (const root of roots.slice(1)) {
    for (const entry of await listProjectWorkFolders(root.path, kindRoot, listing.kind)) {
      const directory = slashPath(`${root.path}/${entry.directory}`)
      if (seen.has(directory)) continue
      seen.add(directory)
      folders.push({ ...entry, directory })
    }
  }
  return folders.sort((left, right) => right.updatedAt - left.updatedAt)
}
