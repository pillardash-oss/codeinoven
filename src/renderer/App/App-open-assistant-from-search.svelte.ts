import {
  AppHeaderNavigationController,
  type HeaderViewOptionId
} from '$lib/components/layout/AppHeaderNavigationController.svelte'
import { invoke } from '$lib/ipc.svelte'
import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
import { viewShowsWorkspaceShell } from '$lib/content-view-projects'
import {
  navigationHistoryState,
  type NavigationLocation
} from '$lib/stores/navigation-history.svelte'
import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
import { settingsRouteState } from '$lib/stores/settings-route.svelte'
import { loadBrowser } from '$lib/stores/browser-access.svelte'
import { findNavState } from '$lib/stores/find-nav.svelte'
import { assistants } from '$lib/stores/assistants.svelte'
import { preloadScopeChunk } from '$lib/page-preload'
import { ASSISTANT_SPACE_ID, type Assistant } from '$shared/types'
import type { App } from './App-board.svelte'
/** One concern of the App board. */
export class AppOpenAssistantFromSearch {
  #root: App | undefined
  /** The board this unit belongs to; set before any member of it runs. */
  get root(): App {
    if (!this.#root)
      throw new Error('AppOpenAssistantFromSearch read its board before it was bound')
    return this.#root
  }
  constructor(root: App) {
    this.#root = root
  }
  /** Content view to return to when leaving Settings or Scope   persisted in the
   *  recovery snapshot so a restart made while on a Settings page or the Scope
   *  view still returns to the previous content view instead of resetting to Projects. */
  lastContentView = $derived(rendererRecovery.lastContentView)

  /** True while the workspace shell renders the view (Projects, Chats, Threads
   *  and Assistant); the takeover pages (Scope, Settings) layer on top of it.
   *  Shared with the link pipeline, which routes by the same surface. */
  showsContentView = $derived(viewShowsWorkspaceShell(this.root.onKeydown.activeView))

  /** The view the user was on before opening Settings   the Settings back button returns here. */
  lastViewBeforeSettings = $derived(rendererRecovery.lastViewBeforeSettings)

  observeNavigationLocation(): void {
    navigationHistoryState.observe(this.root.spotlightPalette.currentLocation())
  }

  /** Primary-view navigation is owned here, so the header and the left view rail
   *  share one controller (one `lastViewBeforeScope`/`shownHeaderViewOption`). */
  navigation = new AppHeaderNavigationController({
    getActiveView: () => this.root.onKeydown.activeView,
    navigate: (view) => this.root.onKeydown.navigate(view)
  })

  /** Warm the target view's threads (and lazy chunk) before a rail hover lands. */
  handleViewOptionHover(id: HeaderViewOptionId): void {
    if (id === 'scope-board' || id === 'scoped-threads') preloadScopeChunk()
    // Pointing at the browser is the moment we know the user is going there, so
    // its chunks and its runtime are both warmed here rather than at boot.
    if (id === 'browser') void loadBrowser()
    if (id === 'chats') this.navigation.preloadNavigationThreads('chats')
    else if (id === 'scoped-threads') this.navigation.preloadScopedThreads()
    else this.navigation.preloadNavigationThreads('projects')
  }

  /** Re-show the Utilities page captured in a history entry. */
  restoreUtilitiesFromHistory(entry: NavigationLocation): void {
    if (entry.utilities) settingsRouteState.showUtilities(entry.utilities)
  }

  /** Navigate to the location the user backed away from, if any. */
  async goForward(): Promise<void> {
    const entry = navigationHistoryState.forward(this.root.spotlightPalette.currentLocation())
    if (!entry) return
    navigationHistoryState.beginTraversal()
    try {
      this.root.onKeydown.navigate(entry.view)
      this.restoreUtilitiesFromHistory(entry)
      await this.root.spotlightPalette.restoreThreadFromHistory(entry)
    } finally {
      navigationHistoryState.endTraversal()
    }
  }

  /**
   * Focus an assistant picked in assistant search: land on the Assistant view, open
   * the assistant's seed thread so its context becomes the active one, then dock
   * that assistant's knowledge panel on it.
   */
  async openAssistantFromSearch(assistant: Assistant): Promise<void> {
    this.root.onKeydown.navigate('assistant')
    const anchor = await assistants.knowledgeThread(assistant.id).catch(() => null)
    if (!anchor) return
    await this.root.onKeydown.openThreadFromNotification(anchor, null)
    contextSidebarState.openAssistantKnowledge(
      ASSISTANT_SPACE_ID,
      anchor.id,
      assistant.id,
      assistant.name
    )
  }

  navigateToScopedThreads(): void {
    this.root.onKeydown.navigate('projects-scope')
  }

  /**
   * Find in the file reader, on the surface actually on screen. The editor
   * region names the surface it is showing: the source editor counts and
   * replaces its own matches, while every rendered view (annotate, document
   * preview, diff) is plain DOM text that only a document search can read.
   */
  openFilesFind(region: Element): void {
    if (region.getAttribute('data-find-surface') === 'document') {
      findNavState.openFileDocumentFind()
      return
    }
    findNavState.openEditorFind()
  }

  /** Windows/Linux may report both an app command and a renderer mouse event.
   *  macOS can report a raw mouse event or a native swipe. Collapse duplicate
   *  same-direction reports from one physical press. */
  lastMouseHistoryNavigation: { direction: 'back' | 'forward'; at: number } | null = $state(null)

  /** Route a mouse history button to the focused browser page first, then the
   *  app's location history when focus is elsewhere. */
  async handleMouseHistoryNavigation(direction: 'back' | 'forward'): Promise<void> {
    const now = Date.now()
    const previous = this.lastMouseHistoryNavigation
    if (previous && previous.direction === direction && now - previous.at < 150) return
    this.lastMouseHistoryNavigation = { direction, at: now }

    const handledByBrowser = await invoke('browser:mouseHistoryNavigation', direction).catch(
      () => false
    )
    if (handledByBrowser) return
    if (direction === 'back') void this.root.spotlightPalette.goBack()
    else void this.goForward()
  }

  /** Mouse back/forward buttons (button 3 = back, 4 = forward). */
  onMouseHistoryButton(e: MouseEvent): void {
    if (e.button !== 3 && e.button !== 4) return
    e.preventDefault()
    void this.handleMouseHistoryNavigation(e.button === 3 ? 'back' : 'forward')
  }
}
