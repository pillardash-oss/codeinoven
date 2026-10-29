import { subscribeGuarded } from '$lib/ipc.svelte'
import { flushAllDraftCommits } from '$lib/stores/renderer-recovery.svelte'
import { workspaceState } from '$lib/stores/workspace.svelte'
import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
import { appQuitState } from '$lib/stores/app-quit.svelte'
import { isTerminalFocused } from '$lib/terminal/focus'
import { type InstanceRole } from '$shared/types'
import type { App } from './App-board.svelte'
/** One concern of the App board. */
export class AppState {
  #root: App | undefined
  /** The board this unit belongs to; set before any member of it runs. */
  get root(): App {
    if (!this.#root) throw new Error('AppState read its board before it was bound')
    return this.#root
  }
  constructor(root: App) {
    this.#root = root
  }
  instanceRole = $state<InstanceRole | null>(null)

  /** Clean up renderer resources when the main process signals shutdown. */
  installShutdownSubscription(): () => void {
    // Guarded like the App installer's own subscriptions: a channel this
    // window's preload does not expose yet must cost this one subscription, not
    // the rest of the mount that follows it.
    return subscribeGuarded('window:beforeQuit', () => {
      // Renderer should release event subscriptions   the main process
      // will dispose services and flush logs 500ms after this signal.
      // The window itself only closes at the end of that pipeline, so latch the
      // quit signal here: repeating background reads check it and stop instead
      // of polling into the already-closed database. One-shot user-intent work
      // is not gated. Push any debounced DB draft commits now: the main process
      // closes the database later in its shutdown pipeline, and these invokes
      // must land while the grace period is still open.
      appQuitState.markQuitting()
      flushAllDraftCommits()
    })
  }

  /**
   * Cmd/Ctrl+T while a terminal is focused opens a new terminal tab in the
   * terminal panel (right sidebar or bottom dock). The main process only emits
   * this event when it intercepted the key with a terminal focused, but the
   * renderer's own focus flag is the source of truth   re-check it defensively.
   */
  handleNewTerminalShortcut(): void {
    if (!isTerminalFocused()) return
    const thread = workspaceState.selectedThread
    if (!thread) return
    contextSidebarState.openNewTerminal(thread.projectId, thread.id)
  }
}
