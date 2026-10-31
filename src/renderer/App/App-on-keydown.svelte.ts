import { invoke } from '$lib/ipc.svelte'
import {
  closeBlockingSurfaces,
  closeTopVisibleDialog,
  requestCloseTopOverlay
} from '$lib/overlay-close.svelte'
import { activateTopModalPrimaryAction } from '$lib/modal-primary-action.svelte'
import {
  rendererRecovery,
  isSettingsSection,
  isSettingsView,
  settingsViewForSection
} from '$lib/stores/renderer-recovery.svelte'
import { workspaceState } from '$lib/stores/workspace.svelte'
import {
  contentThreadFamily,
  contentViewForThread,
  viewShowsThread
} from '$lib/content-view-threads'
import { viewShowsScopedSidebar } from '$lib/content-view-projects'
import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
import { settingsRouteState } from '$lib/stores/settings-route.svelte'
import { loadBrowser, withBrowser } from '$lib/stores/browser-access.svelte'
import { sidebarState } from '$lib/stores/sidebar.svelte'
import { projectFilesWorkspace } from '$lib/stores/project-files.svelte'
import { findNavState } from '$lib/stores/find-nav.svelte'
import { browserKeyboardFocus } from '$lib/stores/browser-keyboard-focus'
import { browserFindState } from '$lib/stores/browser-find.svelte'
import { temporaryChatUnread } from '$lib/stores/temporary-chat-unread.svelte'
import { keymapState } from '$lib/keymap/keymap-state.svelte'
import { isTerminalFocused } from '$lib/terminal/focus'
import { scopeState } from '$lib/stores/scope.svelte'
import { standaloneFiles } from '$lib/stores/standalone-files.svelte'
import { preloadScopeChunk, preloadSettingsChunk } from '$lib/page-preload'
import type { ActionSelection } from '$lib/actions'
import { actionContext } from '$lib/stores/action-context.svelte'
import {
  DEFAULT_SCOPE_BUCKET_ID,
  INBOX_PROJECT_ID,
  threadTracksReadStatus,
  type Project,
  type Thread
} from '$shared/types'
import { GLOBAL_BROWSER_PROJECT_ID } from '$shared/ipc-contract'
import { actionId, settingsTabs } from '../app-palette-actions'
import { FileSearchPaletteController } from '../app-file-search.svelte'
import { ThreadSearchPaletteController } from '../app-thread-search.svelte'
import { workspaceTourViewFor } from '$lib/guide/guide-stops'
import type { View } from './App-types'
import type { App } from './App-board.svelte'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the App board. */
export class AppOnKeydown extends BoardUnit<App> {
  constructor(root: App) {
    super(root)
  }
  activeView = $state<View>(rendererRecovery.activeView)

  fileSearch = new FileSearchPaletteController()

  threadSearch = new ThreadSearchPaletteController(
    { openThread: (thread) => void this.root.spotlightPalette.openThreadFromSearch(thread) },
    'projects'
  )

  assistantSearch = new ThreadSearchPaletteController(
    {
      openThread: (thread) => void this.root.spotlightPalette.openThreadFromSearch(thread),
      openAssistant: (assistant) =>
        void this.root.openAssistantFromSearch.openAssistantFromSearch(assistant)
    },
    'assistant'
  )

  navigate(view: View, options: { reconcileThread?: boolean } = {}): void {
    // Entering another section starts its Utilities page fresh; history
    // restores a recorded Utilities page after this navigation.
    if (view !== this.activeView) settingsRouteState.resetUtilities()
    // Warm the lazy page chunks so the view swap resolves instantly   the
    // sidebar/header hover preloads cover the mouse path; this covers every
    // other entry point (shortcuts, palette, programmatic navigation). The
    // imports are memoized, so repeated calls are no-ops.
    if (view === 'scope') {
      preloadScopeChunk()
    } else if (isSettingsView(view)) {
      preloadSettingsChunk()
    }
    if (view === 'scope') {
      const projectId = workspaceState.selectedThread?.projectId ?? workspaceState.activeProject?.id
      if (projectId) void scopeState.activateProject(projectId)
      scopeState.clearSidebarContext()
    } else if (view === 'chats') {
      scopeState.stashSidebarContext()
    } else if (view === 'threads') {
      scopeState.clearSidebarContext()
    } else if (view === 'assistant') {
      scopeState.clearSidebarContext()
    } else if (view === 'projects') {
      // Leaving the registered scoped view (or any scoped state) for the plain
      // projects view: the sidebar is what defines the scoped state, so close
      // it   the sidebar context itself is stashed for later restore.
      scopeState.clearSidebarContext()
    }
    this.activeView = view
    // Reaching the browser view is the moment its code and its runtime are both
    // needed: the view itself is a dynamic import, and this warms the chunks and
    // builds the stores before it renders. The view asks too, for the session
    // that restores straight onto it without ever navigating here.
    if (view === 'browser') void loadBrowser()
    // Persists the view and tracks the last content / non-settings views, so
    // returning from Settings (even across a restart) lands back where the user
    // was instead of resetting to Projects.
    rendererRecovery.setActiveView(view)
    // A navigation that is only a step on the way to a specific thread skips the
    // reconcile: that step would open the family's remembered thread first, which
    // records a visit, persists it, docks its panels, and leaves it on screen
    // whenever the intended open cannot resolve. The caller opens the real thread
    // immediately after this returns.
    if (options.reconcileThread !== false)
      this.root.spotlightPalette.reconcileThreadForContentView(view)
    this.root.openAssistantFromSearch.observeNavigationLocation()
  }

  installWorkspaceCallbacks(): () => void {
    workspaceState.navigateToSettings = (tab?: string) => {
      this.navigate(isSettingsSection(tab) ? settingsViewForSection(tab) : 'settings')
    }
    workspaceState.navigateToContent = () =>
      this.navigate(this.root.openAssistantFromSearch.lastContentView)
    workspaceState.navigateToBrowser = () => this.navigate('browser')
    workspaceState.openThreadFromNotification = (thread, project, temporaryChatId) =>
      this.openThreadFromNotification(thread, project, temporaryChatId)
    // A thread created or found outside the shell's own navigation (a repeated
    // conversation, a spun-off passage, a process's thread) has to be shown by
    // the view that owns its family; only the shell may move the view.
    workspaceState.navigateToThreadView = (thread) => {
      if (!viewShowsThread(this.activeView, thread)) {
        this.navigate(contentViewForThread(thread), { reconcileThread: false })
      }
    }
    return () => {
      workspaceState.navigateToSettings = null
      workspaceState.navigateToContent = null
      workspaceState.navigateToBrowser = null
      workspaceState.openThreadFromNotification = null
      workspaceState.navigateToThreadView = null
    }
  }

  /**
   * Start the "new thread" flow for whatever the shell is showing. Shared by
   * the Cmd/Ctrl+N chord and the palette's "New thread" action so both always
   * agree.
   *
   * The scoped threads view is the state with the scope sidebar docked. The
   * shell reports it either as its own `projects-scope` view or as `projects`
   * with a live sidebar context, so both spellings are handled here   the same
   * test the header switcher, the sidebar and the notification router use. It
   * targets the docked scope's project and bucket directly, exactly like the
   * sidebar's own new-thread button, which also makes it work from the empty
   * state where no thread (and therefore no active project) is open.
   */
  requestThreadForCurrentView(): void {
    if (this.activeView === 'scope') {
      if (!scopeState.activeProjectId) return
      scopeState.requestCreateScopedThread(
        scopeState.sidebarContext?.bucketId ?? scopeState.buckets[0]?.id ?? DEFAULT_SCOPE_BUCKET_ID
      )
      return
    }

    const scopedContext = scopeState.sidebarContext
    if (scopedContext && viewShowsScopedSidebar(this.activeView, true)) {
      // Docked scoped-threads sidebar: create in the docked scope's project and
      // bucket, never in whatever thread happens to be open.
      workspaceState.requestCreateThread(scopedContext.bucketId)
      return
    }

    if (this.activeView === 'chats') {
      workspaceState.requestNewChat()
      return
    }
    if (this.activeView !== 'projects' && this.activeView !== 'threads') return
    if (workspaceState.activeProject && workspaceState.activeProject.id !== INBOX_PROJECT_ID) {
      // Same-scope inheritance: the new thread inherits the open thread's scope
      // bucket (no stale sidebar bucket, no view switch).
      workspaceState.requestCreateThread()
      return
    }
    // The Threads view mints project threads, so a new thread there still needs a
    // project: ask which one with the project picker instead of starting the
    // add-project flow, matching the view's own new-thread button. The Projects
    // view is where projects themselves are added, so it keeps that flow.
    if (this.activeView === 'threads') {
      workspaceState.requestCreateThread()
      return
    }
    workspaceState.requestAddProject()
  }

  async handlePaletteSelection(selection: ActionSelection): Promise<void> {
    const settingsTab = settingsTabs.find(
      (tab) => actionId(`settings:${tab.id}`) === selection.action.id
    )
    if (settingsTab) {
      this.navigate(settingsViewForSection(settingsTab.id))
      return
    }

    switch (selection.action.id) {
      case 'app:new-project':
        this.root.spotlightPalette.openNewProjectSpotlight()
        return
      case 'app:switch-project':
        this.root.spotlightPalette.projectSwitch.openPalette()
        return
      case 'app:new-chat':
        this.navigate('chats')
        workspaceState.requestNewChat()
        return
      case 'app:new-thread':
        this.requestThreadForCurrentView()
        return
      case 'app:file-search':
        this.fileSearch.openPalette()
        return
      case 'app:thread-search':
        this.threadSearch.openPalette()
        return
      case 'app:chat-search':
        this.root.spotlightPalette.chatSearch.openPalette()
        return
      case 'app:assistant-search':
        this.assistantSearch.openPalette()
        return
      case 'app:browser-tab-search':
        this.root.spotlightPalette.browserTabSearch.openPalette()
        return
      case 'app:notifications':
        contextSidebarState.toggleNotifications()
        return
      case 'app:tour-view': {
        const view = workspaceTourViewFor(this.activeView)
        if (view) workspaceState.requestViewTour(view)
        return
      }
      case 'app:terminal': {
        const thread = workspaceState.selectedThread
        if (!thread) return
        contextSidebarState.openPrimaryTerminal(thread.projectId, thread.id)
        return
      }
      case 'app:git': {
        const thread = workspaceState.selectedThread
        if (!thread) return
        contextSidebarState.openGit(thread.projectId, thread.id)
        return
      }
      case 'app:memory': {
        const thread = workspaceState.selectedThread
        if (!thread) return
        if (
          contextSidebarState.sidebarVisible &&
          contextSidebarState.sidebarActiveTab?.kind === 'memory'
        ) {
          contextSidebarState.hide()
        } else {
          contextSidebarState.openMemory(thread.projectId, thread.id, undefined, thread.assistantId)
        }
        return
      }
      case 'app:sources': {
        const thread = workspaceState.selectedThread
        if (!thread) return
        if (
          contextSidebarState.sidebarVisible &&
          contextSidebarState.sidebarActiveTab?.kind === 'sources'
        ) {
          contextSidebarState.hide()
        } else {
          contextSidebarState.openSources(thread.projectId, thread.id)
        }
        return
      }
      case 'app:projects':
        this.navigate('projects')
        return
      case 'app:chats': {
        // Only a project-family thread is a restorable project thread; an
        // assistant task stashed here would later be restored into the scope
        // sidebar as if it were one.
        const selected = workspaceState.selectedThread
        if (
          this.activeView !== 'chats' &&
          selected &&
          contentThreadFamily(selected) === 'projects'
        ) {
          scopeState.stashedProjectThreadId = selected.id
        }
        this.navigate('chats')
        return
      }
      case 'app:scope':
        this.navigate('scope')
        return
      case 'app:threads':
        this.navigate('threads')
        return
      case 'app:settings':
        this.navigate('settings')
        return
      default:
        await actionContext.current?.onSelect(selection)
    }
  }

  /** Close the whole spotlight, whichever screen is on top. */
  closeSpotlight(): void {
    this.root.spotlightPalette.commandPaletteOpen = false
    if (this.fileSearch.paletteOpen) this.fileSearch.close()
    if (this.threadSearch.paletteOpen) this.threadSearch.close()
    if (this.root.spotlightPalette.chatSearch.paletteOpen)
      this.root.spotlightPalette.chatSearch.close()
    if (this.assistantSearch.paletteOpen) this.assistantSearch.close()
    if (this.root.spotlightPalette.browserTabSearch.paletteOpen)
      this.root.spotlightPalette.browserTabSearch.close()
    if (this.root.spotlightPalette.projectSwitch.paletteOpen)
      this.root.spotlightPalette.projectSwitch.close()
  }

  /**
   * Open a thread from a notification while preserving the current view.
   *
   * The target view follows the thread's own family, so a deep link can never
   * select a thread in a content view that does not own it:
   * - Chat thread → switch to the chats view.
   * - Assistant task → switch to the assistant view.
   * - Regular project view → stay there (no scope sidebar).
   * - Scope state / scope view → stay there and reveal the thread in the sidebar.
   * - Threads view → stay there (no scope sidebar), the project family's own timeline.
   * - Settings or any other view → return to Projects for the thread.
   */
  async openThreadFromNotification(
    thread: Thread,
    project: Project | null,
    temporaryChatId?: string
  ): Promise<void> {
    // The click is a decision to go somewhere, so whatever owns the window steps
    // aside first. Without this a full screen reader (or a confirm sheet) stayed
    // up over the workspace and the thread opened behind it, which read as a
    // button that navigated to nothing.
    closeBlockingSurfaces()
    const family = contentThreadFamily(thread)
    const inScopeState =
      this.activeView === 'scope' ||
      viewShowsScopedSidebar(this.activeView, scopeState.sidebarContext !== null)

    if (thread.projectId === GLOBAL_BROWSER_PROJECT_ID) {
      // A browser tab's conversation has no workspace thread and is deliberately
      // in no thread list, so the browser view is the only thing that can show
      // it. Handing it to `workspaceState.openThread` below would select a thread
      // no view owns, which is the dead button this branch exists to avoid.
      this.navigate('browser')
      await withBrowser((store) => store.revealAssistantChat(thread.id))
      return
    }

    if (family === 'chats') {
      // A chat is only ever shown by the chats view.
      this.navigate('chats')
    } else if (family === 'assistant') {
      // An assistant task is only ever shown by the assistant view.
      this.navigate('assistant')
    } else if (inScopeState) {
      // Stay in the scope state: reveal the thread in the scope sidebar.
      if (this.activeView !== 'projects') this.navigate('projects')
      scopeState.showSidebarForThread(thread)
      void scopeState.ensureBoardLoaded(thread.projectId)
    } else if (this.activeView === 'threads') {
      // Stay in the threads view without entering the scope state.
      scopeState.clearSidebarContext()
    } else {
      // A project thread belongs in Projects, so return to it from Settings, the
      // chats view, the assistant view, or any other out-of-family view rather
      // than leaving it selected somewhere that cannot own it.
      if (this.activeView !== 'projects') this.navigate('projects')
      scopeState.clearSidebarContext()
    }

    workspaceState.openThread(thread, project)
    if (threadTracksReadStatus(thread)) {
      const updated = await invoke('thread:markRead', thread.projectId, thread.id)
      scopeState.updateThread(updated)
      workspaceState.updateThread(updated)
    }

    if (temporaryChatId) {
      // A temporary (side) chat notification: opening the parent thread alone
      // is not enough   reveal the sidebar and focus the side chat that has
      // the unread response. When its tab no longer exists the badge would
      // never clear, so drop it here instead.
      if (!contextSidebarState.focusTemporaryChat(thread.projectId, thread.id, temporaryChatId)) {
        temporaryChatUnread.clear(thread.projectId, thread.id, temporaryChatId)
      }
    }
  }

  /**
   * Cmd/Ctrl+W closes the active surface: the topmost modal, the Settings page,
   * the browser tab on screen, a sidebar panel, or the open thread. When nothing
   * is active the shortcut is intentionally a no-op; application shutdown is
   * reserved for explicit quit actions and the native window close control.
   */
  handleCloseShortcut(): void {
    // The spotlight is one surface: the close chord closes it whole, whichever
    // screen is on top. Escape is the key that steps back between screens.
    if (this.root.spotlightPalette.spotlightScreenId) {
      this.closeSpotlight()
      return
    }
    // Reusable modals (Modal / DockableModal) register their close behavior.
    if (requestCloseTopOverlay()) return
    // Bits-ui dialogs and element-level overlay Escape handlers.
    if (closeTopVisibleDialog()) return
    // On a Settings page: leave back to the previous view.
    if (isSettingsView(this.activeView)) {
      this.navigate(this.root.openAssistantFromSearch.lastViewBeforeSettings)
      return
    }
    // The standalone browser view answers the chord with the page it is showing:
    // the tab closes, exactly as a page closes in a browser. A sleeping tab and a
    // blank one close the same way, so repeated presses empty the strip and land
    // on the browser's own empty state. The claim store names the tab main routes
    // browser keys to, which is the one the user is working in; the active tab is
    // the fallback for the moment before that claim lands.
    if (this.activeView === 'browser') {
      const claimed = browserKeyboardFocus.tabId
      void withBrowser((store) => {
        // A claim names the surface the user is working in. When it names a tab
        // this store does not hold (a Peek preview owns its own tab, which is
        // not a strip tab) there is no tab of ours to close. With no claim at
        // all, the view's active tab is the one the chord means.
        const tab = claimed ? store.tabById(claimed) : store.activeTab
        if (tab) store.close(tab.id)
      })
      return
    }
    // Focus inside the context sidebar: close the active tab of the surface that
    // holds it (through Workspace's unsaved-changes confirmation) instead of
    // clearing the thread. A terminal docked at the bottom is its own surface,
    // so the placement of the focused region decides which tab the chord closes.
    const active = document.activeElement instanceof Element ? document.activeElement : null
    const sidebarRegion = active?.closest<HTMLElement>('[data-region="context-sidebar"]')
    if (sidebarRegion) {
      contextSidebarState.requestCloseActiveTab(
        sidebarRegion.dataset.placement === 'bottom' ? 'dock' : 'sidebar'
      )
      return
    }
    // The context rail is the sidebar's own chrome: a rail icon opens or hides a
    // panel but leaves the focus on the rail button, so the panel the user just
    // revealed (a quick chat above all) must still be what the chord closes.
    // With nothing on screen the rail owns no tab, and the chord falls through
    // to the thread below instead of silently doing nothing.
    if (
      active?.closest('[data-region="context-dock"]') &&
      contextSidebarState.requestCloseActiveTab(contextSidebarState.visible ? 'sidebar' : 'dock')
    ) {
      return
    }
    // An open thread: deselect it back to the thread list.
    if (
      (this.activeView === 'projects' ||
        this.activeView === 'chats' ||
        this.activeView === 'threads' ||
        this.activeView === 'assistant') &&
      workspaceState.selectedThread
    ) {
      workspaceState.clearThread()
      return
    }
    // Nothing active   keep the application open.
  }

  handleFind(): void {
    const browserTabId = browserKeyboardFocus.tabId
    if (browserTabId) {
      browserFindState.open(browserTabId)
      return
    }
    if (this.activeView === 'browser') {
      void withBrowser((store) => {
        if (store.activeTab) browserFindState.open(store.activeTab.id)
      })
      return
    }
    const active = document.activeElement instanceof Element ? document.activeElement : null
    if (active?.closest('[data-region="file-tree"]')) {
      findNavState.focusFileTreeFilter++
      return
    }
    if (active?.closest('[data-region="sticky-notes"]')) {
      findNavState.openStickyNotesFind()
      return
    }
    if (active?.closest('[data-region="thread-notes"]')) {
      findNavState.openThreadNotesFind()
      return
    }
    const activeEditor = active?.closest('[data-region="editor"]')
    if (activeEditor) {
      this.root.openAssistantFromSearch.openFilesFind(activeEditor)
      return
    }
    // The sidebar keeps GitStatusPanel mounted but display:none for every
    // context tab, so only treat the git panel as the target when it is
    // actually visible (offsetParent is null while hidden).
    const visibleGitPanel = Array.from(document.querySelectorAll('[data-region="git-panel"]')).some(
      (el) => (el instanceof HTMLElement ? el.offsetParent : null) !== null
    )
    if (
      active?.closest('[data-region="git-panel"]') ||
      (active?.closest('[data-region="context-sidebar"]') && visibleGitPanel)
    ) {
      findNavState.openGitFind()
      return
    }
    if (active?.closest('[data-region="spec-studio"]')) {
      findNavState.openStudioFind()
      return
    }
    if (active?.closest('[data-region="conversation"]')) {
      findNavState.openConversationFind()
      return
    }

    // Toolbar focus still belongs to the visible regular/fullscreen file surface.
    const visibleEditor = document.querySelector('[data-region="editor"][data-find-active="true"]')
    if (visibleEditor) {
      this.root.openAssistantFromSearch.openFilesFind(visibleEditor)
      return
    }
    if (document.querySelector('[data-region="spec-studio"]')) {
      findNavState.openStudioFind()
      return
    }
    if (
      (this.activeView === 'projects' ||
        this.activeView === 'chats' ||
        this.activeView === 'threads' ||
        this.activeView === 'assistant') &&
      document.querySelector('[data-region="conversation"]')
    ) {
      findNavState.openConversationFind()
      return
    }
  }

  /** Global application shortcuts. */
  onKeydown(e: KeyboardEvent): void {
    const isMac = window.api?.windowInfo?.platform === 'darwin'
    if (keymapState.matches('app-quit-direct', e)) {
      // Quit for real, bypassing background mode's park to the menu bar. Main
      // runs the shutdown pipeline, so a turn still running settles as a
      // deliberate close on the next launch instead of a crash.
      e.preventDefault()
      if (e.repeat) return
      void invoke('app:quitDirect')
      return
    }
    if (keymapState.matches('ui-modal-primary-action', e)) {
      // ⌘/Ctrl+Enter runs the topmost open modal's primary action. The shared
      // LIFO registry (modal-primary-action.svelte.ts) resolves which modal is
      // in focus; when no modal claims the chord, composers (chat send, git
      // commit, PR sheet) keep their existing focused-element behavior.
      //
      // Held chords fire auto-repeat keydowns; without this guard a repeat
      // that lands after a PR sheet's success screen rendered would re-claim
      // the chord and click "View PR", closing the modal the user just got.
      if (e.repeat) return
      if (activateTopModalPrimaryAction()) {
        e.preventDefault()
        return
      }
    }
    if (keymapState.matches('nav-close-surface', e)) {
      // Primary path is the main process `before-input-event` → the
      // `window:closeShortcut` event. This is a fallback for platforms where
      // the key still reaches the renderer (the main process preventDefaults
      // the page keydown, so this normally never fires twice).
      //
      // On non-mac platforms Ctrl+W is the shell's delete-word binding while a
      // terminal is focused   leave it alone so it reaches the shell.
      if (!isMac && isTerminalFocused()) return
      e.preventDefault()
      if (e.repeat) return
      this.handleCloseShortcut()
      return
    }
    // DOM focus in browser chrome must answer the same bindings as the native
    // page. This also covers the interval before its main-process claim lands.
    const browserTabId = browserKeyboardFocus.tabId
    if (browserTabId || this.activeView === 'browser') {
      if (keymapState.matches('browser-find', e)) {
        e.preventDefault()
        if (!e.repeat) this.handleFind()
        return
      }
      const previous = keymapState.matches('browser-find-previous', e)
      if (previous || keymapState.matches('browser-find-next', e)) {
        e.preventDefault()
        if (!e.repeat) {
          if (browserTabId) browserFindState.step(browserTabId, previous ? 'previous' : 'next')
          else
            void withBrowser((store) => {
              if (store.activeTab)
                browserFindState.step(store.activeTab.id, previous ? 'previous' : 'next')
            })
        }
        return
      }
    }
    if (keymapState.matches('nav-find', e)) {
      e.preventDefault()
      if (e.repeat) return
      this.handleFind()
      return
    }
    if (keymapState.matches('nav-toggle-right-sidebar', e)) {
      // Cmd/Ctrl+Shift+S toggles the right sidebar. Which panel it shows is
      // decided inside Workspace, which owns what the on-screen thread actually
      // offers (file tree, git, terminal, sources...), so the chord only
      // forwards the request. Only the workspace views own that sidebar.
      // The browser view's right rail is its own (per-tab notes), so it answers
      // the same chord directly instead of forwarding a thread-sidebar request.
      if (this.activeView === 'browser') {
        e.preventDefault()
        if (e.repeat) return
        void withBrowser((store) => store.toggleContextSidebar())
        return
      }
      const rightSidebarViews = ['projects', 'projects-scope', 'chats', 'threads', 'assistant']
      if (!rightSidebarViews.includes(this.activeView)) return
      e.preventDefault()
      if (e.repeat) return
      workspaceState.requestToggleContextSidebar()
      return
    }
    if (keymapState.matches('nav-toggle-left-sidebar', e)) {
      // The browser view's left sidebar is the app's own sidebar (its chrome and
      // tab strip), so the chord folds it the same way it folds the workspace
      // one. Page save is unbound by default, so the chord reaches this handler
      // instead of the browser.
      if (this.activeView === 'browser') {
        e.preventDefault()
        if (e.repeat) return
        sidebarState.toggle()
        return
      }
      // On the plain workspace (no studio, no conflict being resolved, no dirty
      // file tab, no edited file opened from the OS) the Cmd/Ctrl+S save chord
      // is otherwise unused, so it folds/unfolds the left sidebar. Anywhere a
      // save binding owns the chord (a Spec/Assignment/Brainstorm studio, the
      // conflict resolution editor, a project file tab with unsaved changes, or
      // an edited standalone file) it keeps priority: we return without
      // preventDefault so that handler saves instead of toggling.
      // Shift is excluded so Cmd/Ctrl+Shift+S reaches the right-sidebar toggle
      // above, which used to fall through to this branch and fold the left
      // sidebar instead.
      if (e.repeat) return
      const leftSidebarViews = ['projects', 'chats', 'threads', 'assistant']
      const studioOpen = Boolean(document.querySelector('[data-region="spec-studio"]'))
      // The conflict editor holds resolved progress that its Save draft owns, so
      // the chord belongs to it even while no plain file tab is dirty.
      const conflictOpen = Boolean(document.querySelector('[data-region="conflict-editor"]'))
      const dirtyFiles = projectFilesWorkspace.getUnsavedFiles().length > 0
      if (!leftSidebarViews.includes(this.activeView) || studioOpen || conflictOpen || dirtyFiles) {
        return
      }
      if (standaloneFiles.activeHasUnsavedChanges) return
      e.preventDefault()
      sidebarState.toggle()
      return
    }
    if (keymapState.matches('nav-command-palette', e)) {
      e.preventDefault()
      if (e.repeat) return
      this.root.spotlightPalette.toggleCommandPalette()
      return
    }
    if (keymapState.matches('nav-settings', e)) {
      e.preventDefault()
      this.navigate('settings')
    }
    // Keyboard fallback for back/forward: Cmd+[ / Cmd+] is the convention
    // third-party mouse utilities (Logi Options+, SteerMouse, Mac Mouse Fix)
    // remap side buttons to on macOS, since there's no native OS-level
    // back/forward gesture API for non-Apple mice. Alt+Left/Alt+Right mirrors
    // the same convention on Windows/Linux.
    if (
      keymapState.matches('nav-history-back', e) ||
      keymapState.matches('nav-history-forward', e)
    ) {
      e.preventDefault()
      if (e.repeat) return
      if (keymapState.matches('nav-history-back', e)) void this.root.spotlightPalette.goBack()
      else void this.root.openAssistantFromSearch.goForward()
    }
    if (
      keymapState.matches('nav-new-project', e) ||
      keymapState.matches('assistant-new-assistant', e)
    ) {
      e.preventDefault()
      if (e.repeat) return
      // The Assistant view owns Cmd/Ctrl+Shift+N for a new assistant.
      if (this.activeView === 'assistant') {
        if (this.root.spotlightPalette.spotlightScreenId) this.closeSpotlight()
        workspaceState.requestAssistant()
        return
      }
      // Cmd/Ctrl+Shift+N → new-project spotlight from any view except chats (inbox).
      if (this.activeView === 'chats') return
      if (this.root.spotlightPalette.spotlightScreenId) this.closeSpotlight()
      this.root.spotlightPalette.openNewProjectSpotlight()
      return
    }
    if (keymapState.matches('nav-new-thread', e) || keymapState.matches('assistant-new-task', e)) {
      e.preventDefault()
      if (e.repeat) return

      // When the file tree has focus, Cmd/Ctrl+N creates a new file there
      // instead of starting a new thread. The tree's own handler manages it.
      const active = document.activeElement instanceof Element ? document.activeElement : null
      if (active?.closest('[data-region="file-tree"]')) return

      // The Assistant view owns Cmd/Ctrl+N for a new task: inside the assistant
      // the user is currently in when there is one, assistant-less otherwise.
      if (this.activeView === 'assistant') {
        workspaceState.requestAssistantTask()
        return
      }

      // The browser view owns it for a new tab, which is what a browser does.
      if (this.activeView === 'browser') {
        void withBrowser((store) => store.openNewTabAddress())
        return
      }

      this.requestThreadForCurrentView()
      return
    }
    if (keymapState.matches('browser-reopen-tab', e)) {
      // The browser's own page is a native view, so this normally never fires:
      // main claims the chord in the page and forwards the same action to the
      // view that owns the strip. It is the fallback for the one state where no
      // page holds the keyboard   the Browser view with every tab closed   so a
      // mistaken last close can still be undone.
      if (this.activeView !== 'browser') return
      e.preventDefault()
      if (e.repeat) return
      void withBrowser((store) => store.reopenLastClosedTab())
    }
  }
}
