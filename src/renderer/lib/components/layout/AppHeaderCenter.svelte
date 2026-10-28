<script lang="ts">
  import CioMessage from '@pdslng/cio-icon/CioMessage.svelte'
  import CioWindow from '@pdslng/cio-icon/CioWindow.svelte'
  import { slide } from 'svelte/transition'
  import { toast } from 'svelte-sonner'

  import { motionDuration } from '$lib/motion'

  import { getProjectIcon, projectIconOnError } from '$lib/project-icons'
  import { isSettingsView, type MainView } from '$lib/stores/renderer-recovery.svelte'
  import { settingsUiState } from '$lib/stores/settings-ui.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { effectiveThreadTitle } from '$lib/stores/draft-label'
  import { agentRuns } from '$lib/stores/agent-runs.svelte'
  import { foreignRuns } from '$lib/stores/foreign-runs.svelte'
  import { assistants } from '$lib/stores/assistants.svelte'
  import {
    AssistantDefaultIcon,
    getAssistantIcon,
    assistantAccentColor
  } from '$lib/assistant-icons'
  import ProjectInfoDropdown from '$lib/components/shared/ProjectInfoDropdown.svelte'
  import ThreadDropdown from '$lib/components/shared/ThreadDropdown.svelte'
  import { createThreadActionsMenu } from '$lib/components/shared/thread-actions-menu.svelte'
  import { threadBusyForIndicator } from './app-header-thread-status'
  import {
    ASSISTANT_SPACE_ID,
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
    /** Distance from the chrome's end to the conversation column's left edge. */
    titleInset?: number
  }

  let {
    activeView,
    chatMode,
    threadActionsMenu,
    titleInset = 0
  }: Props = $props()

  const viewLabels: Record<string, string> = {
    projects: 'Projects',
    chats: 'Chats',
    'settings-harnesses': 'Harnesses',
    'settings-profile': 'Profile',
    settings: 'Settings',
    scope: 'Scope Board',
    threads: 'Threads',
    assistant: 'Assistant'
  }

  /** Settings takes over the header   no thread title or thread controls. */
  let onSettings = $derived(isSettingsView(activeView))

  /**
   * The settings section on screen. The header nav already names the view
   * ("Settings"), so the centered title only carries the section to avoid
   * repeating it. Falls back to "Settings" in the brief window before a
   * section reports itself.
   */
  let settingsTitle = $derived(settingsUiState.activeTabLabel ?? 'Settings')

  /** Keep the header and project registry in sync after a pin toggle. */
  function handleProjectPinToggled(updated: Project): void {
    workspaceState.activeProject = updated
    scopeState.projectRecords = scopeState.projectRecords.map((record) =>
      record.id === updated.id ? updated : record
    )
  }

  /** The thread's actions menu, opened from the project icon rather than from a
   *  button of its own. */
  let threadMenuOpen = $state(false)

  let headerThreadTitle = $derived(
    workspaceState.selectedThread ? effectiveThreadTitle(workspaceState.selectedThread) : ''
  )

  /**
   * The assistant an assistant thread belongs to, so the header can wear the same
   * assistant icon the sidebar row does. A run inherits its task's `assistantId`, so
   * this resolves for a task and each of its runs alike; an assistant-less task has
   * no assistant and the header falls back to the assistant default mark.
   */
  let headerAssistant = $derived(
    workspaceState.selectedThread?.projectId === ASSISTANT_SPACE_ID
      ? assistants.assistantForTask(workspaceState.selectedThread)
      : null
  )
  let headerAssistantIcon = $derived(
    headerAssistant
      ? getAssistantIcon(headerAssistant, assistants.iconUrls.get(headerAssistant.id) ?? null)
      : null
  )
</script>

<!-- The title block belongs to the thread column, not to the middle of the bar:
     it starts exactly where the header's chrome cluster ends, which is the
     thread panel's edge, and takes the room the trailing controls leave. -->
<!-- Never flush against the end of the chrome: the thread block keeps its own
     gutter even when it is aligned to the conversation column, and that gap is
     the smallest one it will take. -->
<div
  class="flex min-w-0 flex-1 items-center justify-start pr-2"
  style:padding-left={titleInset > 0 ? `${Math.max(titleInset, 8)}px` : undefined}
  class:pl-2={titleInset <= 0}
>
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
    <!-- The block is as wide as the room the bar leaves it, so a long thread name
         uses the whole column before it gives up any of itself. -->
    <!-- No width cap of its own: the block takes every pixel the bar leaves between
         the chrome and the trailing controls, and the name truncates there. A second,
         measured bound is what trimmed it while the conversation was still wide. -->
    <div class="titlebar-no-drag relative flex min-w-0 items-center gap-2">
      {#if thread.projectId === ASSISTANT_SPACE_ID}
        <!-- An assistant thread wears its assistant's icon, exactly as its sidebar
             row does, so the header names the assistant at a glance. A
             assistant-less task falls back to the assistant default mark. -->
        <span
          class="pointer-events-none flex h-4 w-4 shrink-0 items-center justify-center"
          title={headerAssistant?.name ?? 'Assistant'}
        >
          {#if headerAssistantIcon}
            <img src={headerAssistantIcon} alt="" class="h-4 w-4 object-contain" />
          {:else}
            <AssistantDefaultIcon
              size={14}
              style="color: {headerAssistant
                ? assistantAccentColor(headerAssistant)
                : 'var(--color-muted)'}"
            />
          {/if}
        </span>
      {:else if chatMode || thread.projectId === INBOX_PROJECT_ID}
        <!-- A chat thread has no project, but it still wears a mark in the same
             place and at the same size as one, so the bar reads the same whichever
             kind of thread is open. -->
        <span
          class="flex shrink-0 items-center justify-center text-muted transition-[height,width] duration-200 ease-out {isWorking
            ? 'h-6 w-6'
            : 'h-4 w-4'}"
          title="Chat"
          aria-hidden="true"
        >
          <CioMessage class="h-full w-full" />
        </span>
      {:else if !chatMode && thread.projectId !== INBOX_PROJECT_ID}
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
            <!-- One control, two menus. The icon's left click is the project's own
                 dropdown; its context menu is the thread's actions, which is why
                 the bar carries no second ellipsis button. The corner cue is the
                 only thing that says a second menu exists. -->
            <div
              class="header-project-menu pointer-events-auto relative shrink-0"
              oncontextmenu={(event: MouseEvent) => {
                event.preventDefault()
                threadMenuOpen = true
              }}
              onkeydown={(event: KeyboardEvent) => {
                if (event.key !== 'F10' || !event.shiftKey) return
                event.preventDefault()
                threadMenuOpen = true
              }}
            >
              <ProjectInfoDropdown
                project={headerProject}
                iconUrl={resolvedProjectIcon}
                branch={thread.branch ?? null}
                class="group/icon relative shrink-0 transition-[height,width] duration-200 ease-out {isWorking
                  ? 'h-6 w-6'
                  : 'h-4 w-4'}"
                onPinToggled={handleProjectPinToggled}
                onEdit={(projectId) => workspaceState.openProjectEdit(projectId)}
                onError={(message) => toast.error(message)}
              >
                <img
                  src={resolvedProjectIcon}
                  alt=""
                  class="h-full w-full object-contain"
                  onerror={projectIconOnError(headerProject)}
                />
              </ProjectInfoDropdown>
              <ThreadDropdown
                items={threadActionsMenu.items}
                bind:open={threadMenuOpen}
                anchorOnly
                title="Thread actions"
              />
            </div>
          {/if}
        {/if}
      {/if}
      <!-- The name owns its row and the state sits under it, so neither pushes
           the other sideways: the title is never shortened to make room for a
           badge, and a long name still has the whole column before it truncates. -->
      <div class="flex min-w-0 flex-col justify-center">
        <h1
          class="truncate text-[0.6875rem] font-medium tracking-tight text-foreground"
          title={headerThreadTitle}
        >
          {headerThreadTitle}
        </h1>
        {#if isWorking}
          <span
            class="flex min-w-0 items-center gap-1 overflow-hidden text-[0.5625rem] tracking-[0.06em] uppercase {isRetryPaused
              ? 'text-warning'
              : 'text-info'}"
            transition:slide={{ duration: motionDuration(160) }}
          >
            <span class="block h-1 w-1 shrink-0 rounded-full bg-current"></span>
            {#if isForeignRun}
              <CioWindow size={9} />
            {/if}
            <span class="header-status-label truncate">
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
