import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
import { openThreadById } from '$lib/threads/open-thread-by-id'

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
  // A deleted thread or a failed lookup has already been swallowed by the helper,
  // and the panel still opens for the project the proposal came from.
  await openThreadById(projectId, threadId)
  contextSidebarState.openMemory(projectId, threadId, 'proposed')
}
