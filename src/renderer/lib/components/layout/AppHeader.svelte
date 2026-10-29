<script lang="ts">
  import CioBack from '@pdslng/cio-icon/CioBack.svelte'
  import CioForward from '@pdslng/cio-icon/CioForward.svelte'
  import CioNotes from '@pdslng/cio-icon/CioNotes.svelte'
  import CioNotifications from '@pdslng/cio-icon/CioNotifications.svelte'
  import CioSearch from '@pdslng/cio-icon/CioSearch.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import CioTools from '@pdslng/cio-icon/CioTools.svelte'
  import { ICON_SIZE } from '$lib/components/icons/cio/scale'
  import StatusPill from '$lib/components/ui/StatusPill.svelte'
  import type { StatusTone } from '$lib/components/ui/status-tone'
  import StatusBadge from '$lib/components/shared/StatusBadge.svelte'
  import { createThreadActionsMenu } from '$lib/components/shared/thread-actions-menu.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import { buildEnvironmentLabel } from '$shared/build-environment'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import { browserStore } from '$lib/stores/browser-access.svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { gitState } from '$lib/stores/git.svelte'
  import { memoryProposalState } from '$lib/stores/memory-proposals.svelte'
  import { navigationHistoryState } from '$lib/stores/navigation-history.svelte'
  import { notificationPanelState } from '$lib/stores/notification-panel.svelte'
  import { isSettingsView, type MainView } from '$lib/stores/renderer-recovery.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { settingsUiState } from '$lib/stores/settings-ui.svelte'
  import { trafficLightInsetStyle, trafficLightState } from '$lib/stores/traffic-light.svelte'
  import { layoutPanelState } from '$lib/stores/layout-panel.svelte'
  import { threadSwitcherRequest } from '$lib/stores/thread-switcher-request.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'
  import { INBOX_PROJECT_ID, isAssistantSetupThread } from '$shared/types'

  import AppHeaderCenter from './AppHeaderCenter.svelte'
  import AppHeaderGitChip from './AppHeaderGitChip.svelte'
  import type { AppHeaderNavigationController } from './AppHeaderNavigationController.svelte'
  import AppHeaderScopeTabs from './AppHeaderScopeTabs.svelte'
  import AppHeaderThreadModals from './AppHeaderThreadModals.svelte'
  import AppHeaderViewActions from './AppHeaderViewActions.svelte'

  type View = MainView

  interface Props {
    activeView: View
    goBack: () => void
    goForward: () => void
    /** Owned by the app shell so the header and the left view rail share one instance. */
    navigation: AppHeaderNavigationController
  }

  let { activeView, goBack, goForward, navigation }: Props = $props()

  /** Whether this layout keeps the window controls on the left. A bar that
   *  already names the app in its own decoration needs only the short name,
   *  while a bar whose controls sit on the right carries the wordmark. */
  let controlsOnLeft = $derived(trafficLightState.side === 'left')

  /** Space the window controls take from this bar's own left edge. */
  let leftInset = $derived(trafficLightState.side === 'left' ? trafficLightState.offset : 0)

  /** The width the thread panel owns in this bar: the sidebar plus the rail it
   *  sits after, minus whatever the window controls hold on this edge. Zero when
   *  no sidebar is docked, which is also the state a view without one lives in. */
  let panelColumnWidth = $derived.by(() => {
    const docked = layoutPanelState.dockedWidth
    if (docked <= 0) return 0
    return Math.max(0, layoutPanelState.railWidth + docked - leftInset)
  })

  /**
   * Which form the app's name takes in this bar. Only the name ever gives way:
   * the mark, the navigation pair and every view action keep their places at
   * every panel width, so the column follows the panel only until it is as narrow
   * as the chrome itself.
   *
   * `none` is the view without a sidebar (nothing to align to) and the column
   * past the width the chrome needs: the mark alone. `long` needs the room the
   * name itself takes beside three actions; below that the bar falls back to the
   * short name rather than to an ellipsis.
   */
  /** The bar's controls at their narrowest: the mark, the navigation pair and
   *  three view actions. Nothing in the chrome shrinks, so this is what the
   *  panel has to be able to hold. */
  const CHROME_WIDTH = 182
  /** The same column with the short name beside the mark. */
  const CHROME_WIDTH_WITH_SHORT_NAME = 203
  /** And with the whole wordmark. */
  const CHROME_WIDTH_WITH_LONG_NAME = 252

  let brandForm = $derived.by((): 'long' | 'short' | 'none' => {
    const column = panelColumnWidth
    if (column <= 0 || column < CHROME_WIDTH_WITH_SHORT_NAME) return 'none'
    if (controlsOnLeft) return 'short'
    return column >= CHROME_WIDTH_WITH_LONG_NAME ? 'long' : 'short'
  })

  /** The narrowest panel that still contains the header's chrome, so a drag can
   *  never pull the action buttons out of the panel's column and into the
   *  thread's. Measured, not estimated: a dev build carries a build pill the
   *  production bar does not, and an estimate that ignores it lets the chrome
   *  overflow the column by exactly that pill's width. */
  let minimumPanelWidth = $derived.by(() => {
    const chrome = clusterWidth > 0 ? clusterWidth : CHROME_WIDTH
    const floor = chrome + leftInset - layoutPanelState.railWidth
    return Math.max(0, Math.min(420, floor))
  })

  $effect(() => {
    layoutPanelState.minimumWidth = minimumPanelWidth
  })

  /** The chrome's measured width. The column it owns is a target, not a fact: with
   *  no panel docked the cluster is content-sized, and using the worst-case width
   *  there pushed the title a few pixels right of the line it was aligning to. */
  let clusterWidth = $state(0)

  /** How far the thread's block sits from the end of the chrome so that its left
   *  edge lands on the reading surface's own text edge. The page being read is the
   *  bounding box the title aligns to, whether that page is the conversation or the
   *  document a studio is showing; the panel only decides how much room it has.
   *
   *  What it never follows is the centred message column's position: that column
   *  re-centres as soon as a panel narrows the pane from the right, and a
   *  temporary chat opening beside the conversation must not drag the title of the
   *  thread it does not belong to. The surface's gutter only moves with the
   *  sidebar the title is anchored to. */
  let titleInset = $derived.by(() => {
    if (!layoutPanelState.contentVisible) return 0
    const contentLeft = layoutPanelState.readingColumnLeft
    if (contentLeft <= 0) return 0
    const chromeEnd = leftInset + (clusterWidth > 0 ? clusterWidth : CHROME_WIDTH)
    return Math.max(0, Math.round(contentLeft - chromeEnd))
  })

  /** A checkout and a probe run the same source, so the one thing that tells
   *  them apart is where their data lives. The header says which this is, and a
   *  shipped build says nothing at all. */
  let buildLabel = $derived(buildEnvironmentLabel(window.api?.windowInfo.buildEnvironment) ?? null)

  /** A probe runs the same source as a checkout, so its marker wears the
   *  specification's colour: narrowed to two letters it still says which build
   *  this is. */
  let buildTone: StatusTone = $derived(
    window.api?.windowInfo.buildEnvironment === 'probe' ? 'spec' : 'neutral'
  )

  /** Settings takes over the header   no thread title or thread controls. */
  let onSettings = $derived(isSettingsView(activeView))

  let onScope = $derived(activeView === 'scope')

  /**
   * The global browser is its own workspace: its centre shows the page, its
   * quick actions (search the tabs, open one) are registered by the view itself
   * and rendered beside the view switcher like every other view's, and its right
   * cluster keeps only the global controls (the browser entry and the
   * notification bell). No editor, spec, or git controls   those belong to a
   * thread, and a browser tab is not a thread.
   */
  let onBrowser = $derived(activeView === 'browser')

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
  let stickyNotesPanelActive = $derived(
    contextSidebarState.visible && contextSidebarState.sidebarActiveTab?.kind === 'sticky-notes'
  )

  async function toggleStickyNotes(): Promise<void> {
    if (onBrowser) {
      const { globalBrowser } = await import('$lib/stores/global-browser.svelte')
      globalBrowser.hideContextSidebarForAppPanel()
    }
    contextSidebarState.toggleStickyNotes()
  }

  /** The assistant dot's colour is the assistant space's own accent colour,
   *  carried on its notifications, so an assistant run never reads as a
   *  project/chat dot. Every bell dot is just a colour, no icon. */
  let assistantBadgeColor = $derived(notificationPanelState.assistantColor ?? 'var(--color-dimmed)')

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
      const updated = thread.bookmarked
        ? await invoke('thread:setBookmarked', thread.projectId, thread.id, false)
        : await invoke('thread:setPinned', thread.projectId, thread.id, !thread.pinned)
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
    // The selected thread can be an assistant's knowledge thread. It is pinned for
    // life, so the header menu hides it instead of offering Unpin/Delete, which
    // the thread manager would refuse anyway.
    isKnowledgeThread: () => isAssistantSetupThread(workspaceState.selectedThread ?? {}),
    onHideKnowledge: async (thread) => {
      if (!thread.assistantId) return
      try {
        const updated = await invoke('assistant:setKnowledgeHidden', thread.assistantId, true)
        workspaceState.updateThread(updated)
        if (scopeState.allScopeThreads.some((t) => t.id === updated.id)) {
          scopeState.updateThread(updated)
        }
      } catch (error) {
        reportError(error, 'Could not hide the assistant behavior thread')
      }
    }
  })

  /** Cmd/Ctrl+D deletes the actively opened thread through the normal confirm
   *  flow (Escape cancels inside the shared ThreadDeleteConfirm dialog).
   *  Cmd/Ctrl view shortcuts: 0 browser, 1 projects, 2 threads, 3 projects with
   *  scope state, 4 scope, 8 chats, 9 assistant. Every chord resolves from the
   *  keymap registry. */
  function handleWindowKeydown(event: KeyboardEvent): void {
    if (event.repeat || event.isComposing) return
    if (keymapState.matches('nav-delete-thread', event)) {
      if (!workspaceState.selectedThread) return
      event.preventDefault()
      threadActionsMenu.startDelete()
      return
    }
    const viewShortcuts: Array<[string, () => void]> = [
      ['nav-browser', () => void navigation.navigateToView('browser')],
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
  class="app-header titlebar-drag relative z-40 flex h-12 items-center bg-surface pr-1"
  data-guide="header"
  data-controls={controlsOnLeft ? 'left' : 'right'}
  data-panel={panelColumnWidth > 0 ? 'docked' : 'hidden'}
  style={trafficLightInsetStyle({ mirrorRightInset: false, rightPadding: '0.25rem' })}
>
  <nav
    class="header-cluster titlebar-no-drag relative flex shrink-0 items-center gap-1"
    aria-label="Primary navigation"
    style:width={panelColumnWidth > 0 ? `${panelColumnWidth}px` : undefined}
    bind:clientWidth={clusterWidth}
  >
    <button
      type="button"
      class="flex shrink-0 items-center gap-1.5 px-1.5 text-muted transition-colors duration-150 hover:bg-elevated hover:text-foreground"
      aria-label="Open thread switcher"
      title="Open thread switcher"
      onclick={() => threadSwitcherRequest.requestOpen()}
    >
      <VendorIcon name="CodeInOven" size={20} />
      {#if brandForm !== 'none'}
        <span class="header-brand-name">{brandForm === 'long' ? 'CodeInOven' : 'cio'}</span>
      {/if}
    </button>

    {#if buildLabel}
      <StatusPill
        tone={buildTone}
        dot
        truncate
        title="CodeInOven {buildLabel} build"
        aria-label="CodeInOven build: {buildLabel}"
        class="min-w-0 px-1 py-0">{buildLabel}</StatusPill
      >
    {/if}

    <!-- Global navigation: back / forward -->
    <div class="header-cluster-nav flex items-center gap-0.5">
      <button
        class="flex h-7 w-7 items-center justify-center text-foreground transition-colors duration-150 hover:bg-elevated disabled:pointer-events-none disabled:text-muted disabled:opacity-30"
        aria-label="Go back"
        title="Go back"
        disabled={!navigationHistoryState.canGoBack}
        onclick={goBack}
      >
        <CioBack size={ICON_SIZE.control} />
      </button>
      <button
        class="flex h-7 w-7 items-center justify-center text-foreground transition-colors duration-150 hover:bg-elevated disabled:pointer-events-none disabled:text-muted disabled:opacity-30"
        aria-label="Go forward"
        title="Go forward"
        disabled={!navigationHistoryState.canGoForward}
        onclick={goForward}
      >
        <CioForward size={ICON_SIZE.control} />
      </button>
    </div>

    {#if onSettings}
      <!-- Settings owns this slot while it is on screen: the per-view actions
           belong to the view that was here before. -->
      <button
        class="flex h-7 w-7 items-center justify-center transition-colors duration-150 {settingsUiState.searchOpen
          ? 'bg-elevated text-foreground'
          : 'text-dimmed hover:bg-elevated hover:text-muted'}"
        aria-label="Search settings"
        title="Search settings"
        onclick={() => (settingsUiState.searchOpen = true)}
      >
        <CioSearch size={ICON_SIZE.control} />
      </button>
    {:else}
      <div class="header-cluster-actions">
        <!-- Folded only when the bar genuinely has no room for them: no panel
             column to spend, and the context panel open, which is what narrows the
             conversation and the title with it. Both panels closed, or a panel
             docked on the left, and the actions stay in the bar. -->
        <AppHeaderViewActions compact={panelColumnWidth === 0 && contextSidebarState.visible} />
      </div>
    {/if}
  </nav>

  {#if onScope}
    <AppHeaderScopeTabs />
  {:else if onBrowser}
    <!-- The browser's own centre, and its own chunk: the header is on screen for
         every view, so importing this statically would put the browser's model in
         the first-paint chunk. It is fetched the moment the browser view is the
         one on screen, which is also when its runtime is wired. -->
    {#await import('./AppHeaderBrowserCenter.svelte') then { default: AppHeaderBrowserCenter }}
      <AppHeaderBrowserCenter />
    {/await}
  {:else}
    <AppHeaderCenter {activeView} {chatMode} {threadActionsMenu} {titleInset} />
  {/if}

  <AppHeaderThreadModals menu={threadActionsMenu} />

  <div class="titlebar-no-drag ml-auto flex shrink-0 items-center gap-1">
    <!-- Spec studio   only for an existing document or an eligible final-response retry -->
    {#if !chatMode && !onScope && !onBrowser && !onSettings && workspaceState.selectedThread && workspaceState.specStudioAvailable}
      <button
        class="flex h-8 items-center gap-1.5 px-2 transition-colors duration-150 {workspaceState.specStudioOpen
          ? 'bg-elevated text-foreground'
          : workspaceState.specStudioRetryable
            ? 'text-danger hover:bg-danger/10'
            : 'text-dimmed hover:bg-elevated hover:text-muted'} disabled:opacity-50"
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
          <CioSpinner size={ICON_SIZE.control} class="animate-spin" />
        {:else}
          <!-- The specification's own mark, so the toolbox a user learns here is
               the same one a spec-ready row wears. -->
          <CioTools size={ICON_SIZE.control} />
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
    {#if !chatMode && !onScope && !onBrowser && !onSettings && workspaceState.selectedThread && gitAvailable}
      <AppHeaderGitChip {gitAvailable} />
    {/if}

    <!-- Pinned extensions   the extension's own popup, one click away while the
         browser view is the one on screen, and drawn by no other view: a pin is
         chrome of that view, not of the app. This is browser state, so like the
         browser centre it is fetched only once the browser's own modules are up,
         and it draws nothing while no browser tab is running the extension's
         box. -->
    {#if onBrowser && browserStore()}
      {#await import('./AppHeaderPinnedExtensions.svelte') then { default: AppHeaderPinnedExtensions }}
        <AppHeaderPinnedExtensions />
      {/await}
    {/if}

    <!-- Sticky notes and notifications stay available in every view. -->
    <button
      class="flex h-8 w-8 items-center justify-center transition-colors duration-150 {stickyNotesPanelActive
        ? 'bg-elevated text-primary'
        : 'text-dimmed hover:bg-elevated hover:text-muted'}"
      aria-label={stickyNotesPanelActive ? 'Hide sticky notes' : 'Open sticky notes'}
      aria-pressed={stickyNotesPanelActive}
      title={stickyNotesPanelActive ? 'Hide sticky notes' : 'Open sticky notes'}
      onclick={() => void toggleStickyNotes()}
    >
      <CioNotes size={ICON_SIZE.control} />
    </button>

    <button
      class="relative flex h-8 w-8 items-center justify-center transition-colors duration-150 {notificationsPanelActive
        ? 'bg-elevated text-primary'
        : 'text-dimmed hover:bg-elevated hover:text-muted'}"
      aria-label={`Open notifications (${notificationPanelState.totalCount})`}
      aria-pressed={notificationsPanelActive}
      title="Open notifications"
      data-onboarding="notifications"
      data-guide="notifications"
      onclick={() => contextSidebarState.toggleNotifications()}
    >
      <CioNotifications size={ICON_SIZE.control} />
      {#if notificationPanelState.totalCount > 0 || notificationPanelState.hasAssistant}
        <!-- One dot per waiting kind, each in the app's own status colour, so a
             glance at the bell says what is waiting: a project message, a chat
             message, an assistant message, a spec, a request for attention, or
             an error. -->
        <div class="absolute -top-0.5 -left-0.5 flex items-start gap-px">
          {#if notificationPanelState.hasCompleted}
            <StatusBadge color="var(--color-success)" title="Project messages" />
          {/if}
          {#if notificationPanelState.hasTemporaryChat}
            <StatusBadge color="var(--color-chat-success)" title="Temporary chat responses" />
          {/if}
          {#if notificationPanelState.hasAttention}
            <StatusBadge color="var(--color-warning)" title="Notifications needing attention" />
          {/if}
          {#if notificationPanelState.hasSpec}
            <StatusBadge color="var(--color-thread-spec)" title="Specifications ready for review" />
          {/if}
          {#if notificationPanelState.hasError}
            <StatusBadge color="var(--color-danger)" title="Error notifications" />
          {/if}
          {#if notificationPanelState.hasAssistant}
            <StatusBadge color={assistantBadgeColor} title="Assistant notifications" />
          {/if}
        </div>
      {/if}
    </button>
  </div>
</header>

<style>
  .app-header {
    /* Named, because the navigation cluster inside it is a container of its own
       and its queries must not borrow the bar's width. */
    container: header / inline-size;
    /* The centre of the header (the open thread's title, or the browser page's
       title) is capped to this width: a long title truncates inside the middle
       band of the bar instead of stretching towards the view switcher and the
       right-hand actions, so it never reaches over the panels below it. `rem`
       keeps the cap in step with the Appearance font size. */
    --app-header-center-max-width: min(100%, 32rem);
  }

  @container header (max-width: 1100px) {
    .header-control-label {
      display: none;
    }
  }

  /* ─── The panel's column in the bar ─────────────────────────────────────
     Everything left of the boundary is app chrome at the thread panel's width,
     so that boundary is the sidebar's right edge and the header and the body
     share one line instead of two that nearly meet. The column is queried on its
     own width, not on the window's, because it is the panel that squeezes it. */

  .header-cluster {
    /* The bar is never narrower than the controls it carries: the mark, the
       navigation pair and every action stay on screen at every panel width, and
       only the name gives way. */
    min-width: max-content;
  }

  .header-brand-name {
    white-space: nowrap;
    font-size: 0.75rem;
    font-weight: 500;
    letter-spacing: -0.02em;
  }

  .header-cluster-actions {
    display: contents;
  }
</style>
