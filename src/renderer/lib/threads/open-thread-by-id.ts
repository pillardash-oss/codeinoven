import { invoke } from '$lib/ipc.svelte'
import { logRendererError } from '$lib/system/renderer-logger'
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
 * where they are rather than throwing out of a button's handler. Best-effort is
 * not the same as silent, though: a reveal control whose thread cannot be
 * resolved looks like a button that does nothing, and every path that ends
 * nowhere is reported so the log names the id that failed instead of leaving a
 * dead click unexplained.
 */
export async function openThreadById(projectId: string, threadId: string): Promise<void> {
  const selected = workspaceState.selectedThread
  if (selected?.projectId === projectId && selected.id === threadId) return
  try {
    const [project, thread] = await Promise.all([
      invoke('project:get', projectId),
      invoke('thread:get', projectId, threadId)
    ])
    if (!thread) {
      logRendererError(`Could not reveal thread ${threadId}: no thread ${threadId} in ${projectId}`)
      return
    }
    const openFromNotification = workspaceState.openThreadFromNotification
    if (!project || !openFromNotification) {
      workspaceState.openThread(thread, project)
      return
    }
    try {
      await openFromNotification(thread, project)
    } catch (error) {
      // The notification open is the preferred route because it moves the shell to
      // the view that owns the thread. When it cannot finish, selecting the thread
      // directly still answers the question the button was clicked to ask.
      logRendererError(`Could not open thread ${threadId} in its own view`, error)
      workspaceState.openThread(thread, project)
    }
  } catch (error) {
    // A deleted thread or a failed lookup must not dead-end the caller: the
    // surface stays where it is and the user can retry, and the failure is in the
    // log for whoever has to explain why the button did nothing.
    logRendererError(`Could not reveal thread ${threadId} in project ${projectId}`, error)
  }
}
