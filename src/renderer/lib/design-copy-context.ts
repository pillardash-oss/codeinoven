import { ovens } from '$lib/stores/ovens.svelte'
import { scopeState } from '$lib/stores/scope.svelte'
import { workspaceState } from '$lib/stores/workspace.svelte'
import { DEFAULT_SCOPE_BUCKET_ID, type Thread } from '$shared/types'
import { designCopyPayload, type DesignCopyPayload } from '$lib/design-copy-path'

/**
 * The copy decision for a design, read from the stores the board already shows.
 *
 * The rule itself lives in `design-copy-path.ts`; this is only the gathering of
 * the pieces it needs   the active project, the thread's own Oven, the project's
 * Oven, and whether the thread is rooted at the project or in a worktree.
 */
export function designCopyFor(
  directory: string,
  entry?: string | null
): DesignCopyPayload | null {
  const project = workspaceState.activeProject
  if (!project || project.source !== 'local' || !project.path) return null
  const thread = workspaceState.selectedThread
  return designCopyPayload(
    {
      project,
      thread,
      threadOven: ovens.record(thread?.settings?.ovenId),
      projectOven: ovens.record(project.ovenId),
      threadScopeIsProject: threadScopeIsProject(thread)
    },
    directory,
    entry
  )
}

/** Whether a thread's own scope root is the project directory, so an `@` tag
 *  resolves against the folder the design actually lives in. A scope board that
 *  has not loaded yet is treated as the project root, which is the common case. */
function threadScopeIsProject(thread: Thread | null): boolean {
  if (!thread) return false
  const bucket = scopeState.bucketFor(
    thread.projectId,
    thread.scopeBucketId ?? DEFAULT_SCOPE_BUCKET_ID
  )
  return bucket === null || bucket.root.kind === 'project'
}
