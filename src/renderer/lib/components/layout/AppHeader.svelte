<script lang="ts">
  import { invoke } from '$lib/ipc.svelte'
  import { toast } from 'svelte-sonner'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { gitState } from '$lib/stores/git.svelte'
  import { notificationPanelState } from '$lib/stores/notification-panel.svelte'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import { memoryProposalState } from '$lib/stores/memory-proposals.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import { isSettingsView, type MainView } from '$lib/stores/renderer-recovery.svelte'
  import StatusBadge from '$lib/components/shared/StatusBadge.svelte'
  import { editorPreference } from '$lib/stores/editor-preference.svelte'
  import { gatewayState } from '$lib/stores/gateway.svelte'
  import { Bell, ChevronLeft, ChevronRight, FileText, Globe, Loader2 } from '@lucide/svelte'
  import { createThreadActionsMenu } from '$lib/components/shared/thread-actions-menu.svelte'
  import { navigationHistoryState } from '$lib/stores/navigation-history.svelte'
  import { trafficLightInsetStyle } from '$lib/stores/traffic-light.svelte'
  import { INBOX_PROJECT_ID, isAssistantSetupThread } from '$shared/types'
  import { AppHeaderNavigationController } from './AppHeaderNavigationController.svelte'
  import AppHeaderViewSwitcher from './AppHeaderViewSwitcher.svelte'
  import AppHeaderScopeTabs from './AppHeaderScopeTabs.svelte'
  import AppHeaderCenter from './AppHeaderCenter.svelte'
  import AppHeaderThreadModals from './AppHeaderThreadModals.svelte'
  import AppHeaderEditorMenu from './AppHeaderEditorMenu.svelte'
  import AppHeaderGitChip from './AppHeaderGitChip.svelte'

  type View = MainView

  interface Props {
    activeView: View
    navigate: (view: View) => void
    goBack: () => void
    goForward: () => void
  }

  let { activeView, navigate, goBack, goForward }: Props = $props()

  const navigation = new AppHeaderNavigationController({
    getActiveView: () => activeView,
    navigate: (view) => navigate(view)
  })

  /** Settings takes over the header   no thread title or thread controls. */
  let onSettings = $derived(isSettingsView(activeView))

  let onScope = $derived(activeView === 'scope')

  /** Chats and Assistant must feel like chat   no editor, spec, or terminal controls. */
  let chatMode = $derived(activeView === 'chats' || activeView === 'assistant')

  /** Git controls and polling exist only for local projects configured for Git tracking. */
  let gitAvailable = $derived.by(() => {
    const thread = workspaceState.selectedThread
    const project = workspaceState.activeProject
    return Boolean(
      thread &&
      project &&
      thread.projectId === project.id &&
      project.id !== INBOX_PROJECT_ID &&
      project.source === 'local' &&
      project.path.trim() &&
      project.changeTrackingMode === 'git'
    )
  })

  let notificationsPanelActive = $derived(
    contextSidebarState.visible && contextSidebarState.sidebarActiveTab?.kind === 'notifications'
  )

  // ─── Thread actions (ellipsis dropdown) ──────────────────────────────────

  const threadActionsMenu = createThreadActionsMenu({
    getThread: () => workspaceState.selectedThread,
    onRename: async (thread, newTitle) => {
      const updated = await invoke('thread:update', thread.projectId, thread.id, {
        title: newTitle,
        titleSource: 'manual'
      })
      workspaceState.updateThread(updated)
      scopeState.updateThread(updated)
    },
    onTogglePin: async (thread) => {
      const updated = await invoke('thread:setPinned', thread.projectId, thread.id, !thread.pinned)
      workspaceState.updateThread(updated)
      if (scopeState.allScopeThreads.some((t) => t.id === updated.id)) {
        scopeState.updateThread(updated)
      }
    },
    onFork: async (thread) => {
      const project = workspaceState.activeProject
      const forked = await invoke(
        'thread:fork',
        thread.projectId,
        thread.id,
        `${thread.title} (fork)`
      )
      workspaceState.openThread(forked, project)
      scopeState.updateThread(forked)
    },
    onDelete: async (thread) => {
      await invoke('thread:delete', thread.projectId, thread.id)
      workspaceState.clearThread()
      scopeState.removeThread(thread.id)
    },
    onDeleteError: (error) => reportError(error, 'Could not delete thread'),
    showChangeScope: () => true,
    showNotes: () => true,
    showCopyId: () => true,
    onOpenNotes: (thread) =>
      contextSidebarState.openThreadNote(thread.projectId, thread.id, thread.title, {
        edit: true,
        focusEditor: true
      }),
    // The selected thread can be a routine's how-to thread. It is pinned for
    // life, so the header menu hides it instead of offering Unpin/Delete, which
    // the thread manager would refuse anyway.
    isHowToThread: () => isAssistantSetupThread(workspaceState.selectedThread ?? {}),
    onHideHowTo: async (thread) => {
      if (!thread.routineId) return
      try {
        const updated = await invoke('assistant:setHowToHidden', thread.routineId, true)
        workspaceState.updateThread(updated)
        if (scopeState.allScopeThreads.some((t) => t.id === updated.id)) {
          scopeState.updateThread(updated)
        }
      } catch (error) {
        reportError(error, 'Could not hide the how-to thread')
      }
    }
  })

  /** Cmd/Ctrl+D deletes the actively opened thread through the normal confirm
   *  flow (Escape cancels inside the shared ThreadDeleteConfirm dialog).
   *  Cmd/Ctrl+0-4 switch
   *  primary views: 0 chats, 1 projects, 2 threads, 3 projects with scope state,
   *  4 scope, 9 assistant. Every chord resolves from the keymap registry. */
  function handleWindowKeydown(event: KeyboardEvent): void {
    if (event.repeat || event.isComposing) return
    if (keymapState.matches('nav-delete-thread', event)) {
      if (!workspaceState.selectedThread) return
      event.preventDefault()
      threadActionsMenu.startDelete()
      return
    }
    const viewShortcuts: Array<[string, () => void]> = [
      ['nav-chats', () => void navigation.navigateToView('chats')],
      ['nav-projects', () => void navigation.navigateToView('projects')],
      ['nav-threads', () => void navigation.navigateToView('threads')],
      ['nav-projects-with-scope', () => void navigation.openProjectWithScopeState()],
      ['nav-scope', () => void navigation.navigateToView('scope')],
      ['nav-assistant', () => void navigation.navigateToView('assistant')]
    ]
    for (const [id, run] of viewShortcuts) {
      if (!keymapState.matches(id, event)) continue
      event.preventDefault()
      run()
      return
    }
  }

  $effect(() => {
    memoryProposalState.setContext(workspaceState.selectedThread?.projectId ?? null)
  })

  // ─── Editor preference ───────────────────────────────────────────────

  void editorPreference.load()
  gatewayState.ensureSubscribed()

  let gatewayDashboardUrl = $derived(gatewayState.dashboardUrl)
  let hasGateway = $derived(gatewayState.hasReadyGateway)

  async function openGatewayDashboard(): Promise<void> {
    if (!gatewayDashboardUrl) {
      toast.error('Gateway dashboard is not available   start the gateway first')
      return
    }
    const opened = await gatewayState.openDashboard(gatewayDashboardUrl)
    if (!opened) toast.error('Could not open dashboard')
  }

  // ─── Git status chip ─────────────────────────────────────────────────────

  /** Refresh git status whenever the active thread's project changes. */
  $effect(() => {
    const thread = workspaceState.selectedThread
    if (!thread || !gitAvailable) {
      gitState.deactivate()
      return
    }
    // Activation + refresh are event-driven by the workspace store
    // (`notifyThreadOpened` on every thread open)   this effect only subscribes
    // to agent checkpoints for the active project.
    gitState.ensureProjectEvents(thread.projectId)
  })
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<!-- No mirrored right inset: the header's own pr-1 is the same 4px gutter the
     context dock rail leaves around its 32px tool buttons, so the notification
     bell stays on the dock's x axis on every platform. -->
<header
  class="app-header titlebar-drag relative z-40 flex h-12 items-center border-b bg-surface pr-1"
  style={trafficLightInsetStyle({ mirrorRightInset: false })}
>
  <nav
    class="titlebar-no-drag flex shrink-0 items-center gap-1"
    aria-label="Primary navigation"
    data-onboarding="view-switcher"
  >
    <!-- Global navigation: back / forward -->
    <div class="flex items-center gap-0.5">
      <button
        class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-elevated hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
        aria-label="Go back"
        title="Go back"
        disabled={!navigationHistoryState.canGoBack}
        onclick={goBack}
      >
        <ChevronLeft size={16} strokeWidth={1.8} />
      </button>
      <button
        class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-elevated hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
        aria-label="Go forward"
        title="Go forward"
        disabled={!navigationHistoryState.canGoForward}
        onclick={goForward}
      >
        <ChevronRight size={16} strokeWidth={1.8} />
      </button>
    </div>

    <AppHeaderViewSwitcher
      options={navigation.headerViewOptions()}
      shownOption={navigation.shownHeaderViewOption}
      activeIcon={navigation.activeHeaderViewIcon}
      activeLabel={navigation.activeHeaderViewLabel}
      onOptionHover={(id) => {
        if (id === 'chats') navigation.preloadNavigationThreads('chats')
        else navigation.preloadNavigationThreads('projects')
      }}
    />
  </nav>

  {#if onScope}
    <AppHeaderScopeTabs />
  {:else}
    <AppHeaderCenter {activeView} {chatMode} {threadActionsMenu} />
  {/if}

  <AppHeaderThreadModals menu={threadActionsMenu} />

  <div class="titlebar-no-drag ml-auto flex shrink-0 items-center gap-1">
    <!-- Gateway dashboard   global browser entry, visible when gateway is ready -->
    {#if hasGateway && gatewayDashboardUrl}
      <button
        class="flex h-8 w-8 items-center justify-center text-muted transition-colors duration-150 hover:bg-elevated hover:text-foreground"
        aria-label="Open gateway dashboard"
        title="Open gateway dashboard   {gatewayDashboardUrl}"
        onclick={() => void openGatewayDashboard()}
      >
        <Globe size={16} />
      </button>
    {/if}

    <!-- Editor preference   hidden in chat mode, scope view, and when no project is selected -->
    {#if !chatMode && !onScope && workspaceState.activeProject}
      <AppHeaderEditorMenu />
    {/if}

    <!-- Spec studio   only for an existing document or an eligible final-response retry -->
    {#if !chatMode && !onScope && !onSettings && workspaceState.selectedThread && workspaceState.specStudioAvailable}
      <button
        class="flex h-8 items-center gap-1.5 px-2 transition-colors duration-150 {workspaceState.specStudioOpen
          ? 'bg-elevated text-foreground'
          : workspaceState.specStudioRetryable
            ? 'text-danger hover:bg-danger/10'
            : 'text-muted hover:bg-elevated hover:text-foreground'} disabled:opacity-50"
        disabled={workspaceState.specStudioBusy}
        aria-label={workspaceState.specStudioBusy
          ? 'Formulating specification'
          : workspaceState.specStudioOpen
            ? 'Close spec studio'
            : workspaceState.specStudioRetryable
              ? 'Retry specification generation'
              : 'Open spec studio'}
        title={workspaceState.specStudioFormulating
          ? 'Formulating specification'
          : workspaceState.specStudioRetryable
            ? workspaceState.specStudioError || 'Retry specification generation'
            : workspaceState.specStudioOpen
              ? 'Close spec studio'
              : 'Open spec studio'}
        onclick={() => workspaceState.toggleSpecStudio?.()}
      >
        {#if workspaceState.specStudioBusy}
          <Loader2 size={15} class="animate-spin" />
        {:else}
          <FileText size={15} />
        {/if}
        <span class="header-control-label text-[0.6875rem] font-medium">
          {workspaceState.specStudioBusy
            ? workspaceState.specStudioFormulating
              ? 'Formulating…'
              : 'Preparing…'
            : workspaceState.specStudioRetryable
              ? 'Retry spec'
              : 'Spec'}
        </span>
      </button>
    {/if}

    <!-- Git status chip   only when a thread is open in a project view -->
    {#if !chatMode && !onScope && !onSettings && workspaceState.selectedThread && gitAvailable}
      <AppHeaderGitChip {gitAvailable} />
    {/if}

    <!-- Notification bell   available in all views -->
    <button
      class="relative flex h-8 w-8 items-center justify-center text-muted transition-colors duration-150 hover:bg-elevated hover:text-foreground {notificationsPanelActive
        ? 'bg-elevated text-foreground'
        : ''}"
      aria-label={`Open notifications (${notificationPanelState.totalCount})`}
      title="Open notifications"
      data-onboarding="notifications"
      onclick={() => contextSidebarState.toggleNotifications()}
    >
      <Bell size={16} />
      {#if notificationPanelState.totalCount > 0}
        <div class="absolute -top-0.5 -left-0.5 flex items-start gap-px">
          {#if notificationPanelState.hasCompleted}
            <StatusBadge kind="completed" title="Completed notifications" />
          {/if}
          {#if notificationPanelState.hasAttention}
            <StatusBadge kind="attention" title="Notifications needing attention" />
          {/if}
          {#if notificationPanelState.hasSpec}
            <StatusBadge kind="spec" title="Specifications ready for review" />
          {/if}
          {#if notificationPanelState.hasError}
            <StatusBadge kind="error" title="Error notifications" />
          {/if}
        </div>
      {/if}
    </button>
  </div>
</header>

<style>
  .app-header {
    container-type: inline-size;
  }

  @container (max-width: 1100px) {
    .header-control-label {
      display: none;
    }
  }
</style>
