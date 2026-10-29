import { invoke } from '$lib/ipc.svelte'
import { rendererRecovery, type MainView } from '$lib/stores/renderer-recovery.svelte'
import { scopeState } from '$lib/stores/scope.svelte'
import type { Thread } from '$shared/types'
import type { Workspace } from './Workspace-board.svelte'
/** One concern of the Workspace board. */
export class WorkspaceOpenThreadScopeView {
  #root: Workspace | undefined
  /** The board this unit belongs to; set before any member of it runs. */
  get root(): Workspace {
    if (!this.#root)
      throw new Error('WorkspaceOpenThreadScopeView read its board before it was bound')
    return this.#root
  }
  constructor(root: Workspace) {
    this.#root = root
  }
  /** View the shoe toggles back to   whatever the user was on right before the
   *  scoped projects view was opened via the shoe. */
  scopeShoeReturnView: MainView = $state('threads')

  /** Composer scope shoe: on an existing thread, clicking the scope toggles between
   *  the last view the user was on and the scoped projects view (sidebar focused
   *  on this thread). */
  async openThreadScopeView(thread: Thread): Promise<void> {
    // Already on the registered scoped view (projects board with the scope
    // sidebar focused on this thread): bounce back to the view the user came
    // from when the shoe opened it (second half of the toggle).
    if (rendererRecovery.activeView === 'projects-scope' && scopeState.sidebarContext !== null) {
      this.root.props.navigate(this.scopeShoeReturnView)
      return
    }
    this.scopeShoeReturnView = rendererRecovery.activeView
    this.root.props.navigate('projects-scope')
    const allThreads: Thread[] = await invoke('thread:listAll')
    scopeState.setThreads(allThreads)
    await scopeState.activateProject(thread.projectId)
    scopeState.showSidebarForThread(thread)
    void scopeState.ensureBoardLoaded(thread.projectId)
  }
}
