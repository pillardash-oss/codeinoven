import type { Database } from '../database/database'
import { ProjectRepo } from '../database/repositories/project-repo'
import { ThreadRepo } from '../database/repositories/thread-repo'
import { threadAuthoredWorkRoot } from '../../lib/thread-storage-paths'

/**
 * The folder a thread's designs and compositions are written under.
 *
 * Authored work belongs to a conversation, and a conversation runs in exactly one
 * directory: a project's checkout, or the app-owned workspace an assistant task,
 * chat or browser tab mounts. Every surface that lists, serves, moves or exports
 * that work has to agree about which directory that is, so they all ask here
 * rather than each restating the rule. Before this existed, each of them asked
 * only for a local project, which is why an assistant could be handed the design
 * playbook and then refused a preview of the design it had just written.
 *
 * `appOwned` says which kind of root answered, because the board treats the two
 * differently in two places: an app-owned folder has no project record to store
 * its save root in, and it is listed from disk because the registry exists to
 * remember project folders that previews have visited.
 */
export interface AuthoredWorkRoot {
  /** Absolute directory. A design or composition folder stays relative to it. */
  path: string
  /** True when this is a conversation's own workspace rather than a checkout. */
  appOwned: boolean
  /**
   * Whether a repository tracks this root, which is what decides whether the
   * history pane can ask Git for a folder's past or has to answer from the app's
   * own revisions. A conversation workspace is never a repository.
   */
  gitMode: boolean
  /**
   * The assistant whose workspace this is, when the scope is an assistant's.
   *
   * A container id covers every assistant at once, so any caller that keeps
   * per-scope bookkeeping (a tab mark, a moved-folder record) needs this to keep
   * one assistant's entry from answering for another's.
   */
  assistantId: string | null
}

/** Resolve one scope's root, from rows that are already in hand. */
function resolveScope(
  project: {
    source: 'local' | 'ssh'
    path: string
    changeTrackingMode?: 'git' | 'manual'
  } | null,
  projectId: string,
  threadId: string | undefined,
  assistantId: string | undefined
): AuthoredWorkRoot {
  const path = threadAuthoredWorkRoot(project, { projectId, threadId, assistantId })
  if (!path) throw new Error(`Project ${projectId} has no local filesystem root`)
  const checkout = project?.source === 'local' && project.path !== ''
  return {
    path,
    appOwned: !checkout,
    gitMode: checkout && project?.changeTrackingMode === 'git',
    assistantId: assistantId ?? null
  }
}

/**
 * The scope's root, read on the database worker.
 *
 * For an IPC handler or a capability operation, which are both asynchronous and
 * have no reason to hold the main thread for a row read.
 */
export async function authoredWorkRoot(
  database: Database,
  projectId: string,
  threadId?: string
): Promise<AuthoredWorkRoot> {
  const project = await new ProjectRepo(database).getViaWorker(projectId)
  // A checkout answers on its own. The thread read below exists only to name the
  // workspace of a conversation, so a project thread never pays for it.
  if (project?.source === 'local' && project.path)
    return resolveScope(project, projectId, undefined, undefined)
  const assistantId = threadId
    ? (await new ThreadRepo(database).getViaWorker(threadId))?.assistantId
    : undefined
  return resolveScope(project, projectId, threadId, assistantId)
}

/**
 * The same answer for a caller that cannot await, matching the synchronous
 * `requireLocalProject` it replaces: two single-row reads, exactly as that helper
 * already did.
 */
export function authoredWorkRootSync(
  database: Database,
  projectId: string,
  threadId?: string
): AuthoredWorkRoot {
  const project = new ProjectRepo(database).get(projectId)
  if (project?.source === 'local' && project.path)
    return resolveScope(project, projectId, undefined, undefined)
  const assistantId = threadId ? new ThreadRepo(database).get(threadId)?.assistantId : undefined
  return resolveScope(project, projectId, threadId, assistantId)
}
