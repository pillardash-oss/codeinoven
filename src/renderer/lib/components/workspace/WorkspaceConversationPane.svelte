<script lang="ts">
  import { SvelteMap } from 'svelte/reactivity'
  import ThreadView from '$lib/components/threads/ThreadView.svelte'
  import WelcomeStart from './WelcomeStart.svelte'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import type { MainView } from '$lib/stores/renderer-recovery.svelte'
  import { sidebarState } from '$lib/stores/sidebar.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { assistantRoutines } from '$lib/stores/assistant-routines.svelte'
  import { routineHowToComplete, type Project, type Thread } from '$shared/types'
  import type { AppConfig, AppConfigPatch, PromptAttachment } from '$shared/types'

  interface Props {
    mode: 'projects' | 'chats' | 'threads' | 'assistant'
    active: boolean
    selectedThread: Thread | null
    visibleProjects: Project[]
    projectIcons: SvelteMap<string, string>
    threadsByProject: SvelteMap<string, Thread[]>
    config?: AppConfig
    updateConfig?: (patch: AppConfigPatch) => Promise<void>
    /** Remounts the empty-state chats composer to restore a failed first send. */
    restoreKey: number
    /** Whether the view's own sidebar currently holds anything to show. */
    sidebarHasContent: boolean
    /**
     * The open assistant task's run that another instance is streaming, when the
     * task itself is idle. The conversation shows that run's transfer card.
     */
    assistantForeignRunThreadId: string | null
    onNavigate: (view: MainView) => void
    onForked: (thread: Thread) => void
    onContinueInProject: (forked: Thread) => void
    onProjectCreated: (project: Project) => Promise<void>
    onOpenScopeView: (thread: Thread) => void
    onSendChat: (msg: string, files: PromptAttachment[]) => Promise<void>
    /** Hand the welcome composer's unsent draft to a real inbox thread so it
     *  shows in the Chats sidebar as a draft. */
    onStartChatDraft: () => Promise<void>
    onRequestAddProject: (kind: 'local' | 'git-clone') => void
  }

  let {
    mode,
    active,
    selectedThread,
    visibleProjects,
    projectIcons,
    threadsByProject,
    sidebarHasContent,
    assistantForeignRunThreadId,
    onNavigate,
    onForked,
    onContinueInProject,
    onProjectCreated,
    onOpenScopeView,
    onRequestAddProject
  }: Props = $props()

  /** Assistant mode reuses the chat thread renderer, but a routine's task
   *  authors its how-to conversationally, so the view needs the routine. */
  let assistantRoutineId = $derived(
    mode === 'assistant' ? (selectedThread?.routineId ?? null) : null
  )
  let assistantRoutine = $derived(
    assistantRoutineId
      ? (assistantRoutines.routines.find((routine) => routine.id === assistantRoutineId) ?? null)
      : null
  )

  function handleConversationRenderError(error: unknown): void {
    const thread = workspaceState.selectedThread
    if (!thread) return
    reportError(error, 'The conversation could not be rendered.', {
      projectId: thread.projectId,
      threadId: thread.id
    })
  }
</script>

<div
  class="min-h-0 min-w-0 overflow-hidden"
  style:grid-column="1"
  style:grid-row="1"
  data-onboarding="conversation"
>
  {#if selectedThread}
    <div class="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      {#key selectedThread.id}
        <svelte:boundary onerror={handleConversationRenderError}>
          <ThreadView
            thread={selectedThread}
            {active}
            chatMode={mode === 'chats' || mode === 'assistant'}
            assistantMode={mode === 'assistant'}
            {assistantRoutineId}
            assistantRoutineName={assistantRoutine?.name ?? null}
            assistantHowToComplete={assistantRoutine
              ? routineHowToComplete(assistantRoutine)
              : false}
            {assistantForeignRunThreadId}
            allowCenteredComposer={mode === 'chats' ||
              (!workspaceState.headStartUsedThreadIds.has(selectedThread.id) &&
                ((threadsByProject.get(selectedThread.projectId)?.length ?? 0) === 1 ||
                  workspaceState.freshEmptyStateThreadIds.has(selectedThread.id)))}
            {onForked}
            projects={visibleProjects}
            {projectIcons}
            {onContinueInProject}
            {onProjectCreated}
            onOpenScopeView={(thread) => void onOpenScopeView(thread)}
          />
          {#snippet failed(_error: unknown, reset: () => void)}
            <div class="flex h-full min-h-0 items-center justify-center px-6">
              <div
                class="w-full max-w-md rounded-xl border border-danger/30 bg-surface px-5 py-4"
                role="alert"
              >
                <p class="text-sm font-semibold text-foreground">
                  Conversation view failed to render
                </p>
                <p class="mt-1 text-sm text-muted">
                  The thread is still saved. Reload this view to continue.
                </p>
                <button
                  type="button"
                  class="mt-4 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-on-primary transition-opacity hover:opacity-90"
                  onclick={reset}
                >
                  Reload conversation
                </button>
              </div>
            </div>
          {/snippet}
        </svelte:boundary>
      {/key}
    </div>
  {:else if mode === 'chats'}
    <WelcomeStart
      variant="chats"
      {sidebarHasContent}
      onNewChat={() => workspaceState.requestNewChat()}
      onToggleSidebar={() => sidebarState.toggle()}
      onOpenSettings={() => onNavigate('settings')}
      onShowTour={() => workspaceState.requestViewTour('chats')}
    />
  {:else if mode === 'assistant'}
    <!-- Assistant empty state   routines and tasks start here, exactly the way a
         project does in the Projects view. -->
    <WelcomeStart
      variant="assistant"
      onNewRoutine={() => workspaceState.requestAssistantRoutine()}
      onNewTask={() => workspaceState.requestAssistantTask()}
      onOpenSettings={() => onNavigate('settings')}
      onShowTour={() => workspaceState.requestViewTour('assistant')}
    />
  {:else}
    <!-- Projects and Threads empty states   their own copy and their own tour,
         and the sidebar toggle only while that sidebar has content. -->
    <WelcomeStart
      variant={mode === 'threads' ? 'threads' : 'projects'}
      {sidebarHasContent}
      onNewChat={() => onNavigate('chats')}
      onToggleSidebar={() => sidebarState.toggle()}
      onAddProject={() => {
        onNavigate('projects')
        onRequestAddProject('local')
      }}
      onCloneRepo={() => {
        onNavigate('projects')
        onRequestAddProject('git-clone')
      }}
      onOpenSettings={() => onNavigate('settings')}
      onShowTour={() => workspaceState.requestViewTour(mode === 'threads' ? 'threads' : 'projects')}
    />
  {/if}
</div>
