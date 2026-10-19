<script lang="ts">
  import CioAlertCircle from '@pdslng/cio-icon/CioAlertCircle.svelte'
  import CioNetwork from '@pdslng/cio-icon/CioNetwork.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import type { SvelteMap } from 'svelte/reactivity'
  import { ovenRootKey } from '$lib/oven-root-target'
  import { fly } from 'svelte/transition'
  import type { Thread } from '$shared/types'
  import { panelReveal } from '$lib/components/layout/page-reveal'
  import { appPanelSlot } from '$lib/app-panel-portal'
  import { loadPanelModule, PANEL_KEYS, resetPanelModule } from '$lib/lazy-panel'
  import { logRendererError } from '$lib/system/renderer-logger'
  // BrowserPanel is a dynamic import: terminal and browser panels are the dock's
  // two heaviest residents, and the browser one drags the browser's whole model
  // with it. A browser panel can only appear once a browser tab exists, which is
  // also when its chunk is warmed, so nothing on the first paint waits for it.
  import TerminalPanel from '$lib/components/terminal/TerminalPanel.svelte'
  import EmptyState from '$lib/components/ui/EmptyState.svelte'

  import { getProjectIcon } from '$lib/project-icons'
  import { getAssistantIcon, assistantAccentColor } from '$lib/assistant-icons'
  import { assistants } from '$lib/stores/assistants.svelte'
  import {
    contextSidebarState,
    type TemporaryChatContextTab
  } from '$lib/stores/context-sidebar.svelte'
  import {
    coordinatorDockState,
    type CoordinatorDockRegistration
  } from '$lib/stores/coordinator-dock.svelte'
  import { LastKnown } from '$lib/last-known'
  import type { MainView } from '$lib/stores/renderer-recovery.svelte'
  import type { ConnectionSetupRequest } from '$lib/components/assistant/assistant-view'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import {
    INBOX_PROJECT_ID,
    usesThreadWorkspaceMount,
    type AgentPart,
    type Project
  } from '$shared/types'
  import type { WorkspaceBrowserController } from './WorkspaceBrowserController.svelte'

  interface Props {
    active: boolean
    gitPanelProjectId: string | null
    gitPanelScopeBucketId: string
    /** Whether the keep-mounted Git panel is the visible surface right now. */
    gitPanelVisible: boolean
    terminalFullscreenTabId: string | null
    browserFullscreenTabId: string | null
    activeProject: Project | null
    selectedThread?: Thread | null
    projectIcons: SvelteMap<string, string>
    browser: WorkspaceBrowserController
    /** Close the active coordinator tab, used when no coordinator is published
     *  for it so the panel can never trap the user on a blank body. */
    onDismissCoordinator: () => void
    onContinueInThread: (tab: TemporaryChatContextTab) => Promise<void>
    onOpenSubagent: (part: Extract<AgentPart, { type: 'subagent' }>) => void
    /** Navigate to another top-level view (e.g. the Utilities page). */
    navigate: (view: MainView) => void
    /** Open an assistant task, so the workspace owns the selection. */
    onOpenAssistantTask: (task: Thread) => void
    /** Open one assistant connection's setup as a new thread of that assistant. */
    onSetupAssistantConnection: (input: ConnectionSetupRequest) => void
    /** Move a task that belongs to no assistant into one the user picks. */
    onAdoptAssistantTask: (task: Thread) => void
  }

  let {
    active,
    gitPanelProjectId,
    gitPanelScopeBucketId,
    gitPanelVisible,
    terminalFullscreenTabId,
    browserFullscreenTabId,
    activeProject,
    selectedThread = null,
    projectIcons,
    browser,
    onDismissCoordinator,
    onContinueInThread,
    onOpenSubagent,
    navigate,
    onOpenAssistantTask,
    onSetupAssistantConnection,
    onAdoptAssistantTask
  }: Props = $props()

  let activeContextTab = $derived.by(() => {
    const tab = contextSidebarState.sidebarActiveTab
    if (!tab) return null
    // The context sidebar is scoped to the project it is docked on, so a tab is
    // only ever rendered for that project. A mismatch means the sidebar has not
    // followed the thread on screen yet (see `ensureDockedThread`), and drawing
    // the older project's panel in the meantime is what put another project's
    // coordinator board on screen. Refusing the tab drops it instead.
    if (activeProject && 'projectId' in tab && tab.projectId !== activeProject.id) return null
    return tab
  })

  /**
   * The coordinator the active tab belongs to.
   *
   * Read from the tab's own row rather than from the on-screen thread's, because
   * the panel body *is* that row's board: the thread selection is null while a
   * switch or another top-level view keeps it that way, and reading through it
   * dropped a board the user still had open. A row that stops coordinating still
   * answers null here, which is what drops the board to its own empty state.
   */
  let tabCoordinator = $derived.by(() => {
    const tab = activeContextTab
    return tab?.kind === 'coordinator'
      ? coordinatorDockState.forThread(tab.projectId, tab.threadId)
      : null
  })

  /**
   * The registration a coordinator panel reads its own props from: the live one,
   * or the last one this panel rendered.
   *
   * A child's props are getters that re-read their source for as long as the child
   * is mounted, including the frame it unmounts on, so the board must never find a
   * null there. It did: the throw came out of the board's own cleanup and aborted
   * the keyed swap below, which left the pane blank and the board's poll running.
   * Whether a board is shown at all is still `tabCoordinator`'s answer.
   */
  const boardRegistrations = new LastKnown<CoordinatorDockRegistration>()
  let boardRegistration = $derived.by(() => {
    const known = boardRegistrations.get(tabCoordinator)
    // A board belongs to the project it was published for, so it is refused when
    // the workspace is showing another one.
    if (known && activeProject && known.projectId !== activeProject.id) return null
    return known
  })

  /**
   * Identity of the surface the active sidebar tab mounts.
   *
   * Every other kind is keyed by its own tab id, so selecting another tab of the
   * same kind starts that panel fresh. A files panel is keyed by what its body
   * actually depends on instead: the project, and the thread whose own workspace
   * the tree mounts for a chat or an assistant task. Its sidebar tab changes on
   * every file the user opens, so keying it by the tab id unmounted and remounted
   * the whole panel on each file switch, and the full screen file viewer it owns
   * went with it. The entire surface then flashed, its file tree lost its scroll
   * position, and the editor it was showing was rebuilt from scratch.
   */
  let activePanelKey = $derived.by(() => {
    const tab = activeContextTab
    if (!tab) return ''
    if (
      tab.kind === 'coordinator' &&
      tabCoordinator &&
      boardRegistration?.panel.component === 'design'
    ) {
      const props = boardRegistration.panel.props
      return `work:${props.projectId}:${props.threadId}:${props.kind ?? 'session'}`
    }
    if (tab.kind !== 'files') return tab.id
    const mountThreadId =
      usesThreadWorkspaceMount(tab.projectId) ||
      (selectedThread?.settings?.ovenId && selectedThread.settings.ovenId !== 'local')
        ? `${tab.threadId}:${selectedThread?.settings?.ovenId}`
        : 'project'
    return `files:${tab.projectId}:${mountThreadId}`
  })

  let gitPanelThreadId = $derived(
    activeContextTab && 'threadId' in activeContextTab ? activeContextTab.threadId : ''
  )

  /**
   * Bumped by any panel's Retry so its `{#key}` rebuilds and the `{#await}`
   * re-runs. The boot warm (`sidebar-panel-preload.ts`) already fetched the
   * warmed chunks, so those panels normally render from an already-resolved
   * promise and neither the loading nor the failure state is seen.
   */
  let panelReloadNonce = $state(0)

  function retryPanel(key: string): void {
    resetPanelModule(key)
    panelReloadNonce += 1
  }

  /**
   * The browser panel is a native `WebContentsView` floating above the DOM, so it
   * cannot ride a translate: the box it reports as the view's bounds would move
   * with the transform. It fades instead, which leaves its geometry alone.
   */
  let remoteThread = $derived(
    selectedThread?.settings?.ovenId &&
      selectedThread.settings.ovenId !== 'local' &&
      activeContextTab &&
      'projectId' in activeContextTab &&
      activeContextTab.projectId === selectedThread.projectId
      ? selectedThread
      : null
  )

  let activePanelIsBrowser = $derived(activeContextTab?.kind === 'browser')

  /** The thread whose own workspace the file tree mounts. Only a chat or an
   *  assistant task has one; a real project always reads the project root. */
  let filesThreadId = $derived(
    activeContextTab && 'threadId' in activeContextTab ? activeContextTab.threadId : null
  )

  /**
   * Identity of the file tree's root: its name, the label shown beside its icon,
   * its icon, and its accent colour. An assistant behaves like a project, and an
   * assistant task's tree mounts on the assistant's own workspace, so the assistant's
   * edited icon and colour stand in for the hidden assistant space's everywhere
   * the root is drawn. An assistant's name is often a whole sentence, so an assistant
   * root shows no label at all: the icon carries it, and the name is the icon's
   * tooltip.
   */
  let filesRootIdentity = $derived.by(() => {
    const assistant = assistants.assistantForTask(
      filesThreadId === null
        ? null
        : (scopeState.allScopeThreads.find((candidate) => candidate.id === filesThreadId) ?? null)
    )
    if (assistant) {
      return {
        name: assistant.name,
        label: '',
        assistant: true,
        iconUrl: getAssistantIcon(assistant, assistants.iconUrls.get(assistant.id) ?? null),
        accentColor: assistantAccentColor(assistant)
      }
    }
    // The notifications tab carries no project, so the fallback name reads the
    // project id only from a tab that has one.
    const tabProjectId =
      activeContextTab && 'projectId' in activeContextTab ? activeContextTab.projectId : null
    const name =
      tabProjectId === INBOX_PROJECT_ID
        ? 'Chat artifacts'
        : (activeProject?.name ?? 'Project files')
    return {
      name,
      label: name,
      assistant: false,
      iconUrl: activeProject
        ? getProjectIcon(activeProject, projectIcons.get(activeProject.id))
        : null,
      accentColor: null
    }
  })
</script>

{#snippet panelLoading(label: string)}
  <div
    class="flex h-full items-center justify-center gap-2 text-xs text-dimmed"
    role="status"
    aria-label={`Loading ${label}`}
  >
    <CioSpinner size={14} class="animate-spin" aria-hidden="true" />
    Loading {label}
  </div>
{/snippet}

{#snippet panelLoadFailed(key: string, label: string, error: unknown)}
  {logRendererError(`The ${label} panel could not be loaded`, error)}
  <div class="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
    <CioAlertCircle size={18} class="text-warning" aria-hidden="true" />
    <p class="text-xs font-medium text-foreground">{label} could not load</p>
    <p class="max-w-[34ch] text-[0.625rem] leading-relaxed text-muted">
      Loading it was interrupted. Try again.
    </p>
    <button
      class="mt-1 bg-primary px-2 py-1 text-[0.625rem] text-on-primary transition-colors hover:bg-primary-hover"
      title={`Try loading the ${label} panel again`}
      aria-label={`Try loading the ${label} panel again`}
      onclick={() => retryPanel(key)}
    >
      Retry
    </button>
  </div>
{/snippet}

{#if gitPanelProjectId}
  {#key `${gitPanelProjectId}:${panelReloadNonce}`}
    {#await loadPanelModule(PANEL_KEYS.gitStatus, () => import('../git/GitStatusPanel.svelte'))}
      <div class="h-full" style:display={gitPanelVisible ? 'block' : 'none'}>
        {@render panelLoading('Git')}
      </div>
    {:then { default: GitStatusPanel }}
      <div class="h-full" style:display={gitPanelVisible ? 'block' : 'none'}>
        <GitStatusPanel
          projectId={gitPanelProjectId}
          threadId={gitPanelThreadId}
          scopeBucketId={ovenRootKey(gitPanelProjectId) ?? gitPanelScopeBucketId}
        />
      </div>
    {:catch error}
      <div class="h-full" style:display={gitPanelVisible ? 'block' : 'none'}>
        {@render panelLoadFailed(PANEL_KEYS.gitStatus, 'Git', error)}
      </div>
    {/await}
  {/key}
{/if}
{#if activeContextTab}
  <!-- Cross-fades the panel body when the active tool changes. Both the
       out-going and the in-coming panel are absolutely placed in the same cell,
       so they overlap for the length of the switch instead of one blinking off
       before the other appears. Only the incoming panel rises: the outgoing one
       is always positioned with no translate, because a transition's params are
       re-read when the block is destroyed   by then the active tab is already
       the new one, so a rising outgoing browser panel would slide the native
       `WebContentsView` it reports the bounds of. -->
  <div class="relative h-full">
    {#key `${activePanelKey}:${panelReloadNonce}`}
      <div
        class="absolute inset-0"
        data-panel-kind={activeContextTab.kind}
        in:fly={panelReveal(activePanelIsBrowser)}
        out:fly={panelReveal(true)}
      >
        {#if activeContextTab.kind === 'oven'}
          {#await loadPanelModule(PANEL_KEYS.oven, () => import('../threads/OvenSidebarPanel.svelte'))}
            {@render panelLoading('Oven')}
          {:then { default: OvenSidebarPanel }}
            {#if remoteThread}<OvenSidebarPanel thread={remoteThread} />{/if}
          {:catch error}
            {@render panelLoadFailed(PANEL_KEYS.oven, 'Oven', error)}
          {/await}
        {:else if remoteThread && activeContextTab.kind === 'diff'}
          <!-- Rendered by the persistent, keep-mounted Git panel above: an Oven
               thread has no local turn checkpoints to diff. -->
        {:else if activeContextTab.kind === 'files'}
          {#await loadPanelModule(PANEL_KEYS.projectFiles, () => import('../files/ProjectFilesPanel.svelte'))}
            {@render panelLoading('Files')}
          {:then { default: ProjectFilesPanel }}
            <ProjectFilesPanel
              projectId={activeContextTab.projectId}
              projectName={filesRootIdentity.name}
              projectLabel={filesRootIdentity.label}
              assistantRoot={filesRootIdentity.assistant}
              projectIconUrl={filesRootIdentity.iconUrl}
              projectAccentColor={filesRootIdentity.accentColor}
            />
          {:catch error}
            {@render panelLoadFailed(PANEL_KEYS.projectFiles, 'Files', error)}
          {/await}
        {:else if activeContextTab.kind === 'diff'}
          {#await loadPanelModule(PANEL_KEYS.diffSidebar, () => import('../files/DiffSidebarPanel.svelte'))}
            {@render panelLoading('Changes')}
          {:then { default: DiffSidebarPanel }}
            <DiffSidebarPanel
              projectId={activeContextTab.projectId}
              threadId={activeContextTab.threadId}
              checkpointId={activeContextTab.checkpointId}
              revealPath={activeContextTab.revealPath}
              revealNonce={activeContextTab.revealNonce}
            />
          {:catch error}
            {@render panelLoadFailed(PANEL_KEYS.diffSidebar, 'Changes', error)}
          {/await}
        {:else if activeContextTab.kind === 'terminal'}
          {#if terminalFullscreenTabId === activeContextTab.id}
            <div class="flex h-full items-center justify-center text-xs text-muted">
              Terminal is open in fullscreen
            </div>
          {:else}
            <TerminalPanel
              terminalId={activeContextTab.terminalId}
              projectId={activeContextTab.projectId}
              threadId={activeContextTab.threadId}
              scopeBucketId={workspaceState.activeScopeBucketIdFor(activeContextTab.projectId)}
              directory={activeContextTab.startingDirectory}
            />
          {/if}
        {:else if activeContextTab.kind === 'actions'}
          {#await loadPanelModule(PANEL_KEYS.actions, () => import('../actions/ActionsPanel.svelte'))}
            {@render panelLoading('Actions')}
          {:then { default: ActionsPanel }}
            <ActionsPanel
              projectId={activeContextTab.projectId}
              threadId={activeContextTab.threadId}
              scopeBucketId={workspaceState.activeScopeBucketIdFor(activeContextTab.projectId)}
            />
          {:catch error}
            {@render panelLoadFailed(PANEL_KEYS.actions, 'Actions', error)}
          {/await}
        {:else if activeContextTab.kind === 'browser'}
          {#if browserFullscreenTabId === activeContextTab.id}
            <div class="flex h-full items-center justify-center text-xs text-muted">
              Browser is open in fullscreen
            </div>
          {:else if browser.clearDataConfirmOpen && browser.clearDataProjectId === activeContextTab.projectId}
            <div class="h-full bg-app" aria-hidden="true"></div>
          {:else}
            {#await loadPanelModule(PANEL_KEYS.browser, () => import('$lib/components/browser/BrowserPanel.svelte'))}
              {@render panelLoading('Browser')}
            {:then { default: BrowserPanel }}
              <BrowserPanel tab={activeContextTab} />
            {:catch error}
              {@render panelLoadFailed(PANEL_KEYS.browser, 'Browser', error)}
            {/await}
          {/if}
        {:else if activeContextTab.kind === 'debugger'}
          {#await loadPanelModule(PANEL_KEYS.debugger, () => import('../debug/AgentDebugPanel.svelte'))}
            {@render panelLoading('Debugger')}
          {:then { default: AgentDebugPanel }}
            <AgentDebugPanel />
          {:catch error}
            {@render panelLoadFailed(PANEL_KEYS.debugger, 'Debugger', error)}
          {/await}
        {:else if activeContextTab.kind === 'sources'}
          {#await loadPanelModule(PANEL_KEYS.sources, () => import('../threads/SourcesPanel.svelte'))}
            {@render panelLoading('Sources')}
          {:then { default: SourcesPanel }}
            <SourcesPanel
              sources={workspaceState.sources}
              projectId={activeContextTab.projectId}
              threadId={activeContextTab.threadId}
            />
          {:catch error}
            {@render panelLoadFailed(PANEL_KEYS.sources, 'Sources', error)}
          {/await}
        {:else if activeContextTab.kind === 'git'}
          <!-- Rendered by the persistent, keep-mounted block above. -->
        {:else if activeContextTab.kind === 'cloud-deployment'}
          {#await loadPanelModule(PANEL_KEYS.cloudDeployment, () => import('../cloud/CloudDeploymentPanel.svelte'))}
            {@render panelLoading('Cloud deployment')}
          {:then { default: CloudDeploymentPanel }}
            <CloudDeploymentPanel
              projectId={activeContextTab.projectId}
              threadId={activeContextTab.threadId}
            />
          {:catch error}
            {@render panelLoadFailed(PANEL_KEYS.cloudDeployment, 'Cloud deployment', error)}
          {/await}
        {:else if activeContextTab.kind === 'temporary-chat'}
          {#await loadPanelModule(PANEL_KEYS.temporaryChat, () => import('../chats/TemporaryChatView.svelte'))}
            {@render panelLoading('Chat')}
          {:then { default: TemporaryChatView }}
            <TemporaryChatView tabId={activeContextTab.id} {onContinueInThread} />
          {:catch error}
            {@render panelLoadFailed(PANEL_KEYS.temporaryChat, 'Chat', error)}
          {/await}
        {:else if activeContextTab.kind === 'notifications' || activeContextTab.kind === 'sticky-notes'}
          <!-- The app's global panels are mounted once by `AppPanelHost`; this
               rail only offers the body slot it fills. The slot is dropped
               while the workspace is not the view on screen, so the panel can
               never be parked in a hidden rail behind Scope or Settings. -->
          {#if active}
            <div class="h-full" {@attach appPanelSlot}></div>
          {/if}
        {:else if activeContextTab.kind === 'assistant-knowledge'}
          {#await loadPanelModule(PANEL_KEYS.assistantKnowledge, () => import('../assistant/AssistantPanel.svelte'))}
            {@render panelLoading('Knowledge')}
          {:then { default: KnowledgePanel }}
            <KnowledgePanel
              projectId={activeContextTab.projectId}
              threadId={activeContextTab.threadId}
              assistantId={activeContextTab.assistantId}
              bind:panelTab={activeContextTab.panelTab}
              {navigate}
              onOpenTask={onOpenAssistantTask}
              onSetupConnection={onSetupAssistantConnection}
              onAdoptTask={onAdoptAssistantTask}
            />
          {:catch error}
            {@render panelLoadFailed(PANEL_KEYS.assistantKnowledge, 'Knowledge', error)}
          {/await}
        {:else if activeContextTab.kind === 'coordinator'}
          <!--
            The panel a coordinator row published.

            Every branch reads its props from `boardRegistration`, which is this
            row's live registration or the last one this panel rendered. The live
            `tabCoordinator` is what decides whether there is a board at all, so a
            row that stops coordinating still falls through to the empty state
            below.
          -->
          {#if tabCoordinator && boardRegistration}
            {#if boardRegistration.panel.component === 'assignment'}
              {#await loadPanelModule(PANEL_KEYS.assignmentCoordinator, () => import('../threads/AssignmentCoordinatorPanel.svelte'))}
                {@render panelLoading('Assignment')}
              {:then { default: AssignmentCoordinatorPanel }}
                <AssignmentCoordinatorPanel {...boardRegistration.panel.props} />
              {:catch error}
                {@render panelLoadFailed(PANEL_KEYS.assignmentCoordinator, 'Assignment', error)}
              {/await}
            {:else if boardRegistration.panel.component === 'achievement'}
              {#await loadPanelModule(PANEL_KEYS.achievementCoordinator, () => import('../threads/AchievementCoordinatorPanel.svelte'))}
                {@render panelLoading('Achievement')}
              {:then { default: AchievementCoordinatorPanel }}
                <AchievementCoordinatorPanel {...boardRegistration.panel.props} />
              {:catch error}
                {@render panelLoadFailed(PANEL_KEYS.achievementCoordinator, 'Achievement', error)}
              {/await}
            {:else if boardRegistration.panel.component === 'design'}
              {#await loadPanelModule(PANEL_KEYS.designCoordinator, () => import('../design/DesignCoordinatorPanel.svelte'))}
                {@render panelLoading('Design')}
              {:then { default: DesignCoordinatorPanel }}
                {#key `${boardRegistration.projectId}:${boardRegistration.panel.props.threadId}:${boardRegistration.panel.props.kind ?? 'session'}`}
                  <DesignCoordinatorPanel
                    {...boardRegistration.panel.props}
                    viewingThreadId={selectedThread?.id ?? boardRegistration.threadId}
                    active={active && contextSidebarState.sidebarVisible}
                  />
                {/key}
              {:catch error}
                {@render panelLoadFailed(PANEL_KEYS.designCoordinator, 'Design', error)}
              {/await}
            {:else}
              {#await loadPanelModule(PANEL_KEYS.independentAuditCoordinator, () => import('../threads/IndependentAuditCoordinatorPanel.svelte'))}
                {@render panelLoading('Audit')}
              {:then { default: IndependentAuditCoordinatorPanel }}
                <IndependentAuditCoordinatorPanel {...boardRegistration.panel.props} />
              {:catch error}
                {@render panelLoadFailed(PANEL_KEYS.independentAuditCoordinator, 'Audit', error)}
              {/await}
            {/if}
          {:else}
            <EmptyState
              icon={CioNetwork}
              title="Coordinator unavailable"
              description="The coordinator for this thread is not open right now. Close this panel and reopen the coordinator from the rail."
            >
              {#snippet action()}
                <button
                  type="button"
                  class="border border-border bg-elevated px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-overlay"
                  onclick={onDismissCoordinator}
                >
                  Close panel
                </button>
              {/snippet}
            </EmptyState>
          {/if}
        {:else if activeContextTab.kind === 'memory'}
          {#await loadPanelModule(PANEL_KEYS.memory, () => import('../memory/MemoryPanel.svelte'))}
            {@render panelLoading('Memory')}
          {:then { default: MemoryPanel }}
            <MemoryPanel
              variant="sidebar"
              projectId={activeContextTab.projectId}
              threadId={activeContextTab.threadId}
              assistantId={activeContextTab.assistantId}
              bind:activeSection={activeContextTab.memorySection}
            />
          {:catch error}
            {@render panelLoadFailed(PANEL_KEYS.memory, 'Memory', error)}
          {/await}
        {:else if activeContextTab.kind === 'thread-note'}
          {#await loadPanelModule(PANEL_KEYS.threadNote, () => import('../threads/ThreadNotePanel.svelte'))}
            {@render panelLoading('Note')}
          {:then { default: ThreadNotePanel }}
            <ThreadNotePanel tab={activeContextTab} />
          {:catch error}
            {@render panelLoadFailed(PANEL_KEYS.threadNote, 'Note', error)}
          {/await}
        {:else if activeContextTab.kind === 'attention'}
          {#await loadPanelModule(PANEL_KEYS.attention, () => import('../notifications/AttentionPanel.svelte'))}
            {@render panelLoading('Attention')}
          {:then { default: AttentionPanel }}
            <AttentionPanel
              projectId={activeContextTab.projectId}
              threadId={activeContextTab.threadId}
            />
          {:catch error}
            {@render panelLoadFailed(PANEL_KEYS.attention, 'Attention', error)}
          {/await}
        {:else if activeContextTab.kind === 'subagent'}
          <!-- The sub-agent transcript is the only tab kind left after the branches
            above, so it is named explicitly instead of being an `{:else}`: the
            browser rail's downloads and popup-window tabs share the tab union but
            are never in this sidebar's tab list, and rendering them in
            SubagentSessionView would be wrong. -->
          {#await loadPanelModule(PANEL_KEYS.subagent, () => import('../threads/SubagentSessionView.svelte'))}
            {@render panelLoading('Sub-agent')}
          {:then { default: SubagentSessionView }}
            <SubagentSessionView tab={activeContextTab} {onOpenSubagent} />
          {:catch error}
            {@render panelLoadFailed(PANEL_KEYS.subagent, 'Sub-agent', error)}
          {/await}
        {/if}
      </div>
    {/key}
  </div>
{/if}
