<script lang="ts">
  import type { SvelteMap } from 'svelte/reactivity'
  import type { Thread } from '$shared/types'
  // TerminalPanel and BrowserPanel stay static on purpose: both are also
  // statically imported by the keep-mounted fullscreen and terminal-dock
  // wrappers, so a dynamic import here cannot move them out of the eager
  // closure. Deferring them means deferring those wrappers too, which is the
  // native-view mount path, not a chunk split.
  import BrowserPanel from '$lib/components/browser/BrowserPanel.svelte'
  import TerminalPanel from '$lib/components/terminal/TerminalPanel.svelte'
  import EmptyState from '$lib/components/ui/EmptyState.svelte'
  import { Network } from '@lucide/svelte'
  import { getProjectIcon } from '$lib/project-icons'
  import { getRoutineIcon, routineAccentColor } from '$lib/routine-icons'
  import { assistantRoutines } from '$lib/stores/assistant-routines.svelte'
  import {
    contextSidebarState,
    type TemporaryChatContextTab
  } from '$lib/stores/context-sidebar.svelte'
  import { coordinatorDockState } from '$lib/stores/coordinator-dock.svelte'
  import type { MainView } from '$lib/stores/renderer-recovery.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { INBOX_PROJECT_ID, type AgentPart, type Project } from '$shared/types'
  import type { WorkspaceBrowserController } from './WorkspaceBrowserController.svelte'

  interface Props {
    gitPanelProjectId: string | null
    gitPanelScopeBucketId: string
    terminalFullscreenTabId: string | null
    browserFullscreenTabId: string | null
    activeProject: Project | null
    projectIcons: SvelteMap<string, string>
    browser: WorkspaceBrowserController
    coordinator: ReturnType<typeof coordinatorDockState.forThread>
    /** Close the active coordinator tab, used when no coordinator is published
     *  for it so the panel can never trap the user on a blank body. */
    onDismissCoordinator: () => void
    onContinueInThread: (tab: TemporaryChatContextTab) => Promise<void>
    onOpenSubagent: (part: Extract<AgentPart, { type: 'subagent' }>) => void
    /** Navigate to another top-level view (e.g. the Utilities page). */
    navigate: (view: MainView) => void
    /** Open an assistant task, so the workspace owns the selection. */
    onOpenAssistantTask: (task: Thread) => void
  }

  let {
    gitPanelProjectId,
    gitPanelScopeBucketId,
    terminalFullscreenTabId,
    browserFullscreenTabId,
    activeProject,
    projectIcons,
    browser,
    coordinator,
    onDismissCoordinator,
    onContinueInThread,
    onOpenSubagent,
    navigate,
    onOpenAssistantTask
  }: Props = $props()

  let activeContextTab = $derived(contextSidebarState.sidebarActiveTab)
  let gitPanelThreadId = $derived(
    activeContextTab && 'threadId' in activeContextTab ? activeContextTab.threadId : ''
  )

  /** The thread whose own workspace the file tree mounts. Only a chat or an
   *  assistant task has one; a real project always reads the project root. */
  let filesThreadId = $derived(
    activeContextTab && 'threadId' in activeContextTab ? activeContextTab.threadId : null
  )

  /**
   * Identity of the file tree's root: its name, the label shown beside its icon,
   * its icon, and its accent colour. A routine behaves like a project, and an
   * assistant task's tree mounts on the routine's own workspace, so the routine's
   * edited icon and colour stand in for the hidden assistant space's everywhere
   * the root is drawn. A routine's name is often a whole sentence, so a routine
   * root shows no label at all: the icon carries it, and the name is the icon's
   * tooltip.
   */
  let filesRootIdentity = $derived.by(() => {
    const routine = assistantRoutines.routineForTask(
      filesThreadId === null
        ? null
        : (scopeState.allScopeThreads.find((candidate) => candidate.id === filesThreadId) ?? null)
    )
    if (routine) {
      return {
        name: routine.name,
        label: '',
        routine: true,
        iconUrl: getRoutineIcon(routine, assistantRoutines.iconUrls.get(routine.id) ?? null),
        accentColor: routineAccentColor(routine)
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
      routine: false,
      iconUrl: activeProject
        ? getProjectIcon(activeProject, projectIcons.get(activeProject.id))
        : null,
      accentColor: null
    }
  })
</script>

{#if gitPanelProjectId}
  {#key gitPanelProjectId}
    {#await import('../git/GitStatusPanel.svelte') then { default: GitStatusPanel }}
      <div class="h-full" style:display={activeContextTab?.kind === 'git' ? 'block' : 'none'}>
        <GitStatusPanel
          projectId={gitPanelProjectId}
          threadId={gitPanelThreadId}
          scopeBucketId={gitPanelScopeBucketId}
        />
      </div>
    {/await}
  {/key}
{/if}
{#if activeContextTab}
  {#key activeContextTab.id}
    {#if activeContextTab.kind === 'files'}
      {#await import('../files/ProjectFilesPanel.svelte') then { default: ProjectFilesPanel }}
        <ProjectFilesPanel
          projectId={activeContextTab.projectId}
          projectName={filesRootIdentity.name}
          projectLabel={filesRootIdentity.label}
          routineRoot={filesRootIdentity.routine}
          projectIconUrl={filesRootIdentity.iconUrl}
          projectAccentColor={filesRootIdentity.accentColor}
        />
      {/await}
    {:else if activeContextTab.kind === 'diff'}
      {#await import('../files/DiffSidebarPanel.svelte') then { default: DiffSidebarPanel }}
        <DiffSidebarPanel
          projectId={activeContextTab.projectId}
          threadId={activeContextTab.threadId}
          checkpointId={activeContextTab.checkpointId}
          revealPath={activeContextTab.revealPath}
          revealNonce={activeContextTab.revealNonce}
        />
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
        />
      {/if}
    {:else if activeContextTab.kind === 'actions'}
      {#await import('../actions/ActionsPanel.svelte') then { default: ActionsPanel }}
        <ActionsPanel
          projectId={activeContextTab.projectId}
          threadId={activeContextTab.threadId}
          scopeBucketId={workspaceState.activeScopeBucketIdFor(activeContextTab.projectId)}
        />
      {/await}
    {:else if activeContextTab.kind === 'browser'}
      {#if browserFullscreenTabId === activeContextTab.id}
        <div class="flex h-full items-center justify-center text-xs text-muted">
          Browser is open in fullscreen
        </div>
      {:else if browser.clearDataConfirmOpen && browser.clearDataProjectId === activeContextTab.projectId}
        <div class="h-full bg-app" aria-hidden="true"></div>
      {:else}
        <BrowserPanel tab={activeContextTab} />
      {/if}
    {:else if activeContextTab.kind === 'debugger'}
      {#await import('../debug/AgentDebugPanel.svelte') then { default: AgentDebugPanel }}
        <AgentDebugPanel />
      {/await}
    {:else if activeContextTab.kind === 'sources'}
      {#await import('../threads/SourcesPanel.svelte') then { default: SourcesPanel }}
        <SourcesPanel
          sources={workspaceState.sources}
          projectId={activeContextTab.projectId}
          threadId={activeContextTab.threadId}
        />
      {/await}
    {:else if activeContextTab.kind === 'git'}
      <!-- Rendered by the persistent, keep-mounted block above. -->
    {:else if activeContextTab.kind === 'cloud-deployment'}
      {#await import('../cloud/CloudDeploymentPanel.svelte') then { default: CloudDeploymentPanel }}
        <CloudDeploymentPanel
          projectId={activeContextTab.projectId}
          threadId={activeContextTab.threadId}
        />
      {/await}
    {:else if activeContextTab.kind === 'temporary-chat'}
      {#await import('../chats/TemporaryChatView.svelte') then { default: TemporaryChatView }}
        <TemporaryChatView tabId={activeContextTab.id} {onContinueInThread} />
      {/await}
    {:else if activeContextTab.kind === 'notifications'}
      {#await import('../notifications/NotificationPanel.svelte') then { default: NotificationPanel }}
        <NotificationPanel />
      {/await}
    {:else if activeContextTab.kind === 'assistant-how-to'}
      {#await import('../assistant/AssistantPanel.svelte') then { default: HowToPanel }}
        <HowToPanel
          projectId={activeContextTab.projectId}
          threadId={activeContextTab.threadId}
          routineId={activeContextTab.routineId}
          bind:panelTab={activeContextTab.panelTab}
          {navigate}
          onOpenTask={onOpenAssistantTask}
        />
      {/await}
    {:else if activeContextTab.kind === 'coordinator'}
      {#if coordinator}
        {#if coordinator.panel.component === 'assignment'}
          {#await import('../threads/AssignmentCoordinatorPanel.svelte') then { default: AssignmentCoordinatorPanel }}
            <AssignmentCoordinatorPanel {...coordinator.panel.props} />
          {/await}
        {:else if coordinator.panel.component === 'achievement'}
          {#await import('../threads/AchievementCoordinatorPanel.svelte') then { default: AchievementCoordinatorPanel }}
            <AchievementCoordinatorPanel {...coordinator.panel.props} />
          {/await}
        {:else}
          {#await import('../threads/IndependentAuditCoordinatorPanel.svelte') then { default: IndependentAuditCoordinatorPanel }}
            <IndependentAuditCoordinatorPanel {...coordinator.panel.props} />
          {/await}
        {/if}
      {:else}
        <EmptyState
          icon={Network}
          title="Coordinator unavailable"
          description="The coordinator for this thread is not open right now. Close this panel and reopen the coordinator from the rail."
        >
          {#snippet action()}
            <button
              type="button"
              class="rounded-lg border border-border bg-elevated px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-overlay"
              onclick={onDismissCoordinator}
            >
              Close panel
            </button>
          {/snippet}
        </EmptyState>
      {/if}
    {:else if activeContextTab.kind === 'memory'}
      {#await import('../memory/MemoryPanel.svelte') then { default: MemoryPanel }}
        <MemoryPanel
          variant="sidebar"
          projectId={activeContextTab.projectId}
          threadId={activeContextTab.threadId}
          routineId={activeContextTab.routineId}
          bind:activeSection={activeContextTab.memorySection}
        />
      {/await}
    {:else if activeContextTab.kind === 'thread-note'}
      {#await import('../threads/ThreadNotePanel.svelte') then { default: ThreadNotePanel }}
        <ThreadNotePanel tab={activeContextTab} />
      {/await}
    {:else}
      {#await import('../threads/SubagentSessionView.svelte') then { default: SubagentSessionView }}
        <SubagentSessionView tab={activeContextTab} {onOpenSubagent} />
      {/await}
    {/if}
  {/key}
{/if}
