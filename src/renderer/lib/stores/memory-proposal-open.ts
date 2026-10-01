import { invoke } from '$lib/ipc.svelte'
import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
import { workspaceState } from '$lib/stores/workspace.svelte'

/**
 * Open the memory panel on the proposal a toast announced, from wherever that
 * toast is drawn.
 *
 * The sidebar only renders the tabs of the *active* project context, and that
 * context becomes active when one of its threads is opened. A proposal can be
 * raised by a thread the user has since left, so Review has to open that thread
 * first, otherwise the memory panel it docks is never the visible one. The
 * notification open hook is reused so the current view is preserved the same way
 * an 'Open thread' notification preserves it.
 *
 * This lives outside the toast because the toast can be drawn in two windows:
 * the app's own, and the native overlay that covers a browser page. The overlay
 * can only report the click, so the flow has to be reachable from the app
 * renderer alone, and both callers share this one implementation.
 */
export async function openMemoryProposal(projectId: string, threadId: string): Promise<void> {
  try {
    const selected = workspaceState.selectedThread
    if (selected?.projectId !== projectId || selected.id !== threadId) {
      const [project, thread] = await Promise.all([
        invoke('project:get', projectId),
        invoke('thread:get', projectId, threadId)
      ])
      if (thread) {
        const openFromNotification = workspaceState.openThreadFromNotification
        if (project && openFromNotification) await openFromNotification(thread, project)
        else workspaceState.openThread(thread, project)
      }
    }
  } catch {
    // A deleted thread or a failed lookup must not dead-end the button: the panel
    // still opens for the project the proposal came from.
  }
  contextSidebarState.openMemory(projectId, threadId, 'proposed')
}
