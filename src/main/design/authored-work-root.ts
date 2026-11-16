import type { Database } from '../database/database'
import { ProjectRepo } from '../database/repositories/project-repo'
import { ThreadRepo } from '../database/repositories/thread-repo'
import { threadAuthoredWorkRoot } from '../../lib/thread-storage-paths'
import type { Thread } from '../../lib/types'
import type { ThreadScopeRootProvider } from '../../lib/engines/thread-manager'

/**
 * The folder a thread's designs and compositions are written under.
 *
 * Authored work belongs to a conversation, and a conversation runs in exactly one
 * directory: a project's checkout, the managed worktree its scope points at, or
 * the app-owned workspace an assistant task, chat or browser tab mounts. Every
 * surface that lists, serves, moves or exports that work has to agree about which
 * directory that is, so they all ask here rather than each restating the rule.
 * Before this existed, each of them asked only for a local project, which is why
 * an assistant could be handed the design playbook and then refused a preview of
 * the design it had just written.
 *
 * The root follows the thread's **scope**, not the project record: a thread in a
 * managed worktree runs its session in that worktree, so the `.cio/designs` an
 * agent writes there is the folder its board, its video studio and its previews
 * have to read. Resolving the project checkout instead put the work the agent
 * wrote in one tree and the board that lists it in another, which is why a design
 * made in a new scope looked like it had left that scope.
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

/**
 * The scope resolver this module asks which checkout a thread's scope runs in.
 *
 * Bound once at startup rather than threaded through every capability executor:
 * authored work is read by the design service, the video studio, the preview
 * executors and the browser's own composition frames, and a resolver argument on
 * each of them is how one caller ends up resolving a different folder from the
 * rest. Without a provider the module keeps the previous behaviour of answering
 * with the project checkout, which is what a process that never wired scopes
 * (a test, or an Oven root standing in for one) still expects.
 */
let scopeRoots: ThreadScopeRootProvider | null = null

/** Wire the scope authority authored work resolves its checkout through. */
export function installAuthoredWorkScopeRoots(provider: ThreadScopeRootProvider): void {
  scopeRoots = provider
}

/**
 * The checkout a thread's work belongs under, or null when the thread names no
 * scope of its own.
 *
 * A task dispatched by an assistant into a project answers with its bound scope
 * rather than its home container: the binding is what says which checkout the
 * session actually runs in. The scope bucket is read as the session reads it, so
 * a worktree's folder is the same one the agent wrote into.
 */
async function scopeCheckout(
  projectId: string,
  thread: Thread | null
): Promise<{ projectId: string; path: string } | null> {
  if (!scopeRoots || !thread) return null
  const bound = thread.boundScope
  const scopeProjectId = bound?.projectId ?? projectId
  const scopeBucketId = bound?.scopeBucketId ?? thread.scopeBucketId
  if (!scopeBucketId) return null
  const path = await scopeRoots.resolveCompatibilityRoot(scopeProjectId, scopeBucketId)
  return path === null ? null : { projectId: scopeProjectId, path }
}

/** A checkout root, which is always version-controllable work rather than scratch. */
function checkoutRoot(
  path: string,
  project: { changeTrackingMode?: 'git' | 'manual' },
  assistantId: string | null
): AuthoredWorkRoot {
  return {
    path,
    appOwned: false,
    gitMode: project.changeTrackingMode === 'git',
    assistantId
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
  const thread = threadId ? await new ThreadRepo(database).getViaWorker(threadId) : null
  const assistantId = thread?.assistantId ?? null
  // A thread bound into a project answers with that project, not the container
  // it appears in: the binding is what says which checkout the session runs in.
  // A checkout is read before its scope is resolved, because a container id (a
  // chat, the assistant space, a browser tab) has no checkout and no scope to
  // resolve, and asking anyway would turn a working workspace into an error.
  const bound = thread?.boundScope
  const scopeProjectId = bound?.projectId ?? projectId
  const checkout = await new ProjectRepo(database).getViaWorker(scopeProjectId)
  if (checkout?.source === 'local' && checkout.path) {
    const scoped = await scopeCheckout(scopeProjectId, thread)
    return checkoutRoot(scoped?.path ?? checkout.path, checkout, assistantId)
  }
  const project = await new ProjectRepo(database).getViaWorker(projectId)
  if (project?.source === 'local' && project.path) {
    return checkoutRoot(project.path, project, assistantId)
  }
  // A conversation container always names the thread it belongs to, because its
  // workspace is that thread's (or its assistant's): the container id alone
  // covers every assistant at once and cannot name one folder.
  const path = threadAuthoredWorkRoot(project, { projectId, threadId, assistantId })
  if (!path) throw new Error(`Project ${projectId} has no local filesystem root`)
  return { path, appOwned: true, gitMode: false, assistantId }
}
