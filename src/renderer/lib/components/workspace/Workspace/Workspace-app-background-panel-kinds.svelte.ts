import { contextSidebarState, type ContextSidebarTab } from '$lib/stores/context-sidebar.svelte'
import type { Workspace } from './Workspace-board.svelte'
import { SvelteSet } from 'svelte/reactivity'
/** One concern of the Workspace board. */
export class WorkspaceAppBackgroundPanelKinds {
  #root: Workspace | undefined
  /** The board this unit belongs to; set before any member of it runs. */
  get root(): Workspace {
    if (!this.#root)
      throw new Error('WorkspaceAppBackgroundPanelKinds read its board before it was bound')
    return this.#root
  }
  constructor(root: Workspace) {
    this.#root = root
  }
  /**
   * Panels that paint the app background instead of the sidebar's own surface.
   * The sidebar shell is `bg-surface`, so a panel that sets `bg-app` bleeds
   * straight into the conversation behind it and the two regions read as one.
   * A subtle left border keeps them apart. Panels that keep the shell surface
   * (sources, memory, notifications, the debugger, coordinators) already stand
   * apart from the app background and need no border.
   */
  APP_BACKGROUND_PANEL_KINDS: ReadonlySet<ContextSidebarTab['kind']> = new SvelteSet([
    'files',
    'diff',
    'git',
    'terminal',
    'actions',
    'browser',
    'thread-note',
    'sticky-notes',
    'temporary-chat',
    'attention'
  ])

  /** Whether the right sidebar's active panel would otherwise flush into the
   *  conversation background, so the shell draws a subtle left border. */
  rightSidebarFlushes = $derived.by(() => {
    const tab = contextSidebarState.sidebarActiveTab
    return tab !== null && this.APP_BACKGROUND_PANEL_KINDS.has(tab.kind)
  })
}
