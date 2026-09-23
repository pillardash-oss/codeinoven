<script lang="ts">
  import type { SvelteMap } from 'svelte/reactivity'
  import AgentDebugPanel from '$lib/components/debug/AgentDebugPanel.svelte'
  import ActionsPanel from '$lib/components/actions/ActionsPanel.svelte'
  import BrowserPanel from '$lib/components/browser/BrowserPanel.svelte'
  import DiffSidebarPanel from '$lib/components/files/DiffSidebarPanel.svelte'
  import ProjectFilesPanel from '$lib/components/files/ProjectFilesPanel.svelte'
  import TerminalPanel from '$lib/components/terminal/TerminalPanel.svelte'
  import ThreadNotePanel from '$lib/components/threads/ThreadNotePanel.svelte'
  import AchievementCoordinatorPanel from '$lib/components/threads/AchievementCoordinatorPanel.svelte'
  import AssignmentCoordinatorPanel from '$lib/components/threads/AssignmentCoordinatorPanel.svelte'
  import IndependentAuditCoordinatorPanel from '$lib/components/threads/IndependentAuditCoordinatorPanel.svelte'
  import HowToPanel from '$lib/components/assistant/AssistantPanel.svelte'
  import type { Thread } from '$shared/types'
  import EmptyState from '$lib/components/ui/EmptyState.svelte'
  import { Network } from '@lucide/svelte'
  import { getProjectIcon } from '$lib/project-icons'
  import {
    contextSidebarState,
    type TemporaryChatContextTab
  } from '$lib/stores/context-sidebar.svelte'
  import { coordinatorDockState } from '$lib/stores/coordinator-dock.svelte'
  import type { MainView } from '$lib/stores/renderer-recovery.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
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
      <ProjectFilesPanel
        projectId={activeContextTab.projectId}
        projectName={activeContextTab.projectId === INBOX_PROJECT_ID
          ? 'Chat artifacts'
          : (activeProject?.name ?? 'Project files')}
        projectIconUrl={activeProject
          ? getProjectIcon(activeProject, projectIcons.get(activeProject.id))
          : null}
      />
    {:else if activeContextTab.kind === 'diff'}
      <DiffSidebarPanel
        projectId={activeContextTab.projectId}
        threadId={activeContextTab.threadId}
        checkpointId={activeContextTab.checkpointId}
        revealPath={activeContextTab.revealPath}
        revealNonce={activeContextTab.revealNonce}
      />
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
      <ActionsPanel
        projectId={activeContextTab.projectId}
        threadId={activeContextTab.threadId}
        scopeBucketId={workspaceState.activeScopeBucketIdFor(activeContextTab.projectId)}
      />
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
      <AgentDebugPanel />
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
      <HowToPanel
        projectId={activeContextTab.projectId}
        threadId={activeContextTab.threadId}
        routineId={activeContextTab.routineId}
        {navigate}
        onOpenTask={onOpenAssistantTask}
      />
    {:else if activeContextTab.kind === 'coordinator'}
      {#if coordinator}
        {#if coordinator.panel.component === 'assignment'}
          <AssignmentCoordinatorPanel {...coordinator.panel.props} />
        {:else if coordinator.panel.component === 'achievement'}
          <AchievementCoordinatorPanel {...coordinator.panel.props} />
        {:else}
          <IndependentAuditCoordinatorPanel {...coordinator.panel.props} />
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
      <ThreadNotePanel tab={activeContextTab} />
    {:else}
      {#await import('../threads/SubagentSessionView.svelte') then { default: SubagentSessionView }}
        <SubagentSessionView tab={activeContextTab} {onOpenSubagent} />
      {/await}
    {/if}
  {/key}
{/if}
