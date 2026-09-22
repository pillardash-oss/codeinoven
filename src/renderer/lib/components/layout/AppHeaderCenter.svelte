<script lang="ts">
  import { toast } from 'svelte-sonner'
  import { AppWindow, Loader2 } from '@lucide/svelte'
  import { getProjectIcon, projectIconOnError } from '$lib/project-icons'
  import { isSettingsView, type MainView } from '$lib/stores/renderer-recovery.svelte'
  import { settingsUiState } from '$lib/stores/settings-ui.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { effectiveThreadTitle } from '$lib/stores/draft-label'
  import { agentRuns } from '$lib/stores/agent-runs.svelte'
  import { foreignRuns } from '$lib/stores/foreign-runs.svelte'
  import ProjectInfoDropdown from '$lib/components/shared/ProjectInfoDropdown.svelte'
  import ThreadDropdown from '$lib/components/shared/ThreadDropdown.svelte'
  import { createThreadActionsMenu } from '$lib/components/shared/thread-actions-menu.svelte'
  import { threadBusyForIndicator } from './app-header-thread-status'
  import {
    coordinatorHasActiveDelegates,
    INBOX_PROJECT_ID,
    isThreadRetryPaused,
    type Project
  } from '$shared/types'

  interface Props {
    activeView: MainView
    /** Chats must feel like chat   no editor, spec, or terminal controls. */
    chatMode: boolean
    /** Shared thread action menu owned by the header shell. */
    threadActionsMenu: ReturnType<typeof createThreadActionsMenu>
  }

  let { activeView, chatMode, threadActionsMenu }: Props = $props()

  const viewLabels: Record<string, string> = {
    projects: 'Projects',
    chats: 'Chats',
    'settings-harnesses': 'Harnesses',
    'settings-profile': 'Profile',
    settings: 'Settings',
    scope: 'Scope Board',
    threads: 'Threads'
  }

  /** Settings takes over the header   no thread title or thread controls. */
  let onSettings = $derived(isSettingsView(activeView))

  /** "Settings · <Section>" while a settings tab is on screen. */
  let settingsTitle = $derived(
    settingsUiState.activeTabLabel ? `Settings · ${settingsUiState.activeTabLabel}` : 'Settings'
  )

  /** Keep the header and project registry in sync after a pin toggle. */
  function handleProjectPinToggled(updated: Project): void {
    workspaceState.activeProject = updated
    scopeState.projectRecords = scopeState.projectRecords.map((record) =>
      record.id === updated.id ? updated : record
    )
  }

  let headerThreadTitle = $derived(
    workspaceState.selectedThread ? effectiveThreadTitle(workspaceState.selectedThread) : ''
  )
</script>

<div class="flex min-w-0 flex-1 items-center justify-center px-2">
  {#if onSettings}
    <div class="pointer-events-none">
      <h1 class="text-[0.6875rem] font-semibold uppercase tracking-[0.16em] text-dimmed">
        {settingsTitle}
      </h1>
    </div>
  {:else if workspaceState.selectedThread}
    {@const thread = workspaceState.selectedThread}
    {@const isWorking =
      workspaceState.specStudioFormulating ||
      threadBusyForIndicator(thread) ||
      coordinatorHasActiveDelegates(thread, scopeState.allScopeThreads)}
    {@const isRetryPaused = isThreadRetryPaused(thread)}
    {@const isForeignRun = foreignRuns.isForeign(thread.projectId, thread.id)}
    {@const activeRunActivity = agentRuns.activity(thread.projectId, thread.id)}
    {@const activeRunActivityDetail = agentRuns.activityDetail(thread.projectId, thread.id)}
    <div class="titlebar-no-drag relative flex min-w-0 max-w-full items-center gap-2">
      {#if !chatMode && thread.projectId !== INBOX_PROJECT_ID}
        {@const headerProject =
          workspaceState.activeProject ??
          scopeState.projectRecords.find((candidate) => candidate.id === thread.projectId) ??
          null}
        {#if headerProject}
          {@const resolvedProjectIcon = getProjectIcon(
            headerProject,
            workspaceState.activeProjectIconUrl ?? undefined
          )}
          {#if resolvedProjectIcon}
            <div class="pointer-events-auto shrink-0">
              <ProjectInfoDropdown
                project={headerProject}
                iconUrl={resolvedProjectIcon}
                branch={thread.branch ?? null}
                class="group/icon relative h-5 w-5"
                onPinToggled={handleProjectPinToggled}
                onEdit={(projectId) => workspaceState.openProjectEdit(projectId)}
                onError={(message) => toast.error(message)}
              >
                <img
                  src={resolvedProjectIcon}
                  alt=""
                  class="h-4 w-4 object-contain"
                  onerror={projectIconOnError(headerProject)}
                />
              </ProjectInfoDropdown>
            </div>
          {/if}
        {/if}
      {/if}
      <div class="flex min-w-0 items-center gap-1.5 overflow-hidden">
        <h1
          class="truncate text-[0.6875rem] font-medium tracking-tight text-foreground"
          title={headerThreadTitle}
        >
          {headerThreadTitle}
        </h1>
        <ThreadDropdown items={threadActionsMenu.items} onOpen={() => {}} />
        {#if isWorking}
          <span
            class="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[0.625rem] {isRetryPaused
              ? 'bg-warning/10 text-warning'
              : 'bg-info/10 text-info'}"
          >
            {#if isForeignRun}
              <AppWindow size={10} />
            {:else}
              <Loader2 size={10} class="animate-spin" />
            {/if}
            <span class="header-status-label">
              {workspaceState.specStudioFormulating
                ? 'Formulating…'
                : isForeignRun
                  ? 'Running in another instance'
                  : isRetryPaused
                    ? 'Waiting to retry'
                    : activeRunActivity === 'brainstorm_report'
                      ? activeRunActivityDetail?.phase === 'create'
                        ? 'Generating report'
                        : 'Refreshing report'
                      : 'Working'}
            </span>
          </span>
        {/if}
      </div>
    </div>
  {:else}
    <div class="pointer-events-none">
      <h1 class="text-[0.6875rem] font-semibold uppercase tracking-[0.16em] text-dimmed">
        {viewLabels[activeView]}
      </h1>
    </div>
  {/if}
</div>

<style>
  @container (max-width: 760px) {
    .header-status-label {
      display: none;
    }
  }
</style>
