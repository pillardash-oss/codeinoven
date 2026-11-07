import {
  ASSISTANT_SPACE_ID,
  DEFAULT_SCOPE_BUCKET_ID,
  GLOBAL_BROWSER_PROJECT_ID,
  INBOX_PROJECT_ID,
  type BoundScope,
  type ScopeTarget,
  type Thread
} from './types'

/**
 * Where a thread actually works, as opposed to where it is listed.
 *
 * `Thread.projectId` answers both questions at once, and for every thread the
 * app had before bound assistant tasks they had the same answer. A task that
 * lives on the Assistant view and runs in a project checkout is the first
 * thread where they differ, so every surface that shows real evidence (the
 * file tree, Changes, Git, the terminal, the run receipt) reads its project
 * from here instead of from `projectId`.
 *
 * Pure by design: no IO, no Electron, no Svelte. Main and renderer both import
 * this one function so a thumbnail, a Git panel and a receipt can never
 * disagree about which checkout a thread belongs to.
 */

/** Project containers whose threads own an app-storage directory, not a checkout. */
function isAppStorageContainer(projectId: string): boolean {
  return (
    projectId === ASSISTANT_SPACE_ID ||
    projectId === INBOX_PROJECT_ID ||
    projectId === GLOBAL_BROWSER_PROJECT_ID
  )
}

/**
 * The project scope a thread reads and writes, or `null` when it works in
 * app-owned storage instead of a checkout.
 *
 * - A project thread resolves to its own project and scope bucket.
 * - A bound assistant task resolves to the scope it is bound to.
 * - An unbound assistant task, a standalone chat and a browser conversation
 *   resolve to nothing: their workspace is the app's own directory, and
 *   inventing a project here would point the rail at a checkout nobody chose.
 */
export function resolveThreadBoundScope(thread: Thread | null | undefined): BoundScope | null {
  if (!thread) return null
  if (!isAppStorageContainer(thread.projectId)) {
    return {
      projectId: thread.projectId,
      scopeBucketId: thread.scopeBucketId ?? DEFAULT_SCOPE_BUCKET_ID
    }
  }
  if (thread.projectId === ASSISTANT_SPACE_ID && thread.boundScope) {
    return {
      projectId: thread.boundScope.projectId,
      scopeBucketId: thread.boundScope.scopeBucketId
    }
  }
  return null
}

/** The scope target every scope-aware read targets for this thread, when it has one. */
export function threadScopeTarget(thread: Thread | null | undefined): ScopeTarget | null {
  const scope = resolveThreadBoundScope(thread)
  return scope ? { projectId: scope.projectId, scopeBucketId: scope.scopeBucketId } : null
}

/**
 * Whether the thread's file surface mounts an app-owned conversation
 * directory. A bound task mounts the project checkout its scope resolves to, so
 * it answers false and the tree, the citations and the editor all read the
 * project's real files.
 */
export function threadMountsAppWorkspace(thread: Thread | null | undefined): boolean {
  if (!thread) return false
  if (thread.projectId === ASSISTANT_SPACE_ID) return thread.boundScope === undefined
  return thread.projectId === INBOX_PROJECT_ID || thread.projectId === GLOBAL_BROWSER_PROJECT_ID
}

/**
 * The project id an evidence surface should open for this thread.
 *
 * Falls back to the thread's own project id so a caller that shows a project
 * panel for an ordinary thread keeps working unchanged.
 */
export function threadEvidenceProjectId(thread: Thread | null | undefined): string | null {
  if (!thread) return null
  const scope = resolveThreadBoundScope(thread)
  return scope ? scope.projectId : null
}

/** Whether a thread is an assistant task bound to a project scope. */
export function isBoundAssistantTask(thread: Thread | null | undefined): boolean {
  return thread?.projectId === ASSISTANT_SPACE_ID && thread.boundScope !== undefined
}
