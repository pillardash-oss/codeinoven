import { Palette } from '@lucide/svelte'
import { SvelteMap } from 'svelte/reactivity'
import { invoke } from '$lib/ipc.svelte'
import type { ThreadDesignState } from '$shared/ipc-contract'
import { contextSidebarState } from './context-sidebar.svelte'
import { coordinatorDockState } from './coordinator-dock.svelte'

/**
 * The design coordinator's place in the workspace.
 *
 * A design session belongs to a thread, and the panel it docks is the user's way
 * back to their design: which folder it is, a picture of it, and a button that
 * brings the browser tab forward. The knowledge lives in main (the `@cio-design`
 * tag in the thread's messages, the `thread_designs` row, and the project's
 * `.cio/designs` listing), so this store's job is only to ask, publish the panel
 * when the answer says the thread is a design session, and dock it.
 *
 * Nothing here decides whether a thread is a design session: main does, from
 * persisted data, which is what makes this survive a restart.
 */

const DESIGN_COORDINATOR_LABEL = 'Design coordinator'

function threadKey(projectId: string, threadId: string): string {
  return `${projectId}\u0000${threadId}`
}

class DesignCoordinatorState {
  /** Last state fetched per thread, so a panel can render before its own load
   *  settles and the rail can label the tab without a second round trip. */
  private readonly states = new SvelteMap<string, ThreadDesignState>()
  /** Threads with a fetch in flight, so a burst of re-attaches cannot stack. */
  private readonly pending = new Set<string>()

  /** The last answer for a thread, or null before the first one arrives. */
  stateFor(projectId: string, threadId: string): ThreadDesignState | null {
    return this.states.get(threadKey(projectId, threadId)) ?? null
  }

  /**
   * Ask main what this thread's design looks like, and publish or withdraw the
   * coordinator accordingly.
   *
   * Called when the on-screen thread changes and again whenever that thread sees
   * activity, because a design session can start mid-thread: the `@cio-design`
   * tag arrives on a later message, and the coordinator has to appear then,
   * without the user reloading anything.
   */
  async refresh(projectId: string, threadId: string): Promise<void> {
    const key = threadKey(projectId, threadId)
    if (this.pending.has(key)) return
    this.pending.add(key)
    try {
      const state = await invoke('design:state', projectId, threadId)
      this.states.set(key, state)
      // The dock holds one registration per row, and an engineering board is the
      // more specific owner of a thread that coordinates work. Design sessions and
      // coordinator threads do not overlap in practice, but nothing may clobber
      // the other's panel if they ever do.
      const existing = coordinatorDockState.forThread(projectId, threadId)
      const ownsRow = existing === null || existing.panel.component === 'design'
      if (!state.active) {
        if (ownsRow && existing !== null) coordinatorDockState.withdraw(projectId, threadId)
        return
      }
      if (!ownsRow) return
      coordinatorDockState.register({
        projectId,
        threadId,
        label: DESIGN_COORDINATOR_LABEL,
        icon: Palette,
        panel: { component: 'design', props: { projectId, threadId } }
      })
      // Docks itself the first time a design session appears, unless the user
      // closed it before; later refreshes are no-ops because the tab exists.
      if (
        coordinatorDockState.autoOpen &&
        !contextSidebarState.hasCoordinator(projectId, threadId)
      ) {
        contextSidebarState.openCoordinator(projectId, threadId, DESIGN_COORDINATOR_LABEL)
      }
    } catch {
      // A failed read leaves the last answer in place rather than blanking a
      // coordinator the user is looking at.
    } finally {
      this.pending.delete(key)
    }
  }
}

export const designCoordinatorState = new DesignCoordinatorState()
