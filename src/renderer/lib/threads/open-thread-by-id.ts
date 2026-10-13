import { invoke } from '$lib/ipc.svelte'
import { workspaceState } from '$lib/stores/workspace.svelte'

/**
 * Bring a thread the user is not on into view, by its ids alone.
 *
 * A surface that knows where it wants the user to go usually knows only an id:
 * a design board holding the thread that created a design, a memory toast
 * pointing at the thread that raised its proposal. Turning that id into a
 * thread the workspace can select is the same work every time, so it lives
 * here rather than in each caller.
 *
 * The notification open hook is preferred over a bare selection because it
 * first moves to the view that owns the thread's family, so the thread is
 * actually shown instead of selected somewhere that cannot render it. A thread
 * with no project (a hand-off that lost its owner) still opens, without one.
 *
 * Best-effort by design: a deleted thread or a failed lookup leaves the user
 * where they are rather than throwing out of a button's handler.
 */
export async function openThreadById(projectId: string, threadId: string): Promise<void> {
  const selected = workspaceState.selectedThread
  if (selected?.projectId === projectId && selected.id === threadId) return
  try {
    const [project, thread] = await Promise.all([
      invoke('project:get', projectId),
      invoke('thread:get', projectId, threadId)
    ])
    if (!thread) return
    const openFromNotification = workspaceState.openThreadFromNotification
    if (project && openFromNotification) await openFromNotification(thread, project)
    else workspaceState.openThread(thread, project)
  } catch {
    // A deleted thread or a failed lookup must not dead-end the caller: the
    // surface stays where it is and the user can retry.
  }
}
