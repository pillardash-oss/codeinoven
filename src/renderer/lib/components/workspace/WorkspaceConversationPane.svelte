<script lang="ts">
  import { SvelteMap } from 'svelte/reactivity'
  import ThreadView from '$lib/components/threads/ThreadView.svelte'
  import WelcomeStart from './WelcomeStart.svelte'
  import ConversationFirstPaint from './ConversationFirstPaint.svelte'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import { threadReveal } from '$lib/components/layout/page-reveal'
  import { fly } from 'svelte/transition'
  import type { MainView } from '$lib/stores/renderer-recovery.svelte'
  import { sidebarState } from '$lib/stores/sidebar.svelte'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { assistants } from '$lib/stores/assistants.svelte'
  import { assistantKnowledgeComplete, type Project, type Thread } from '$shared/types'
  import type { AppConfig, AppConfigPatch, PromptAttachment } from '$shared/types'
  import { ASSISTANT_SPACE_ID } from '$shared/types'

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
    /** Opens another Assistant tab thread from a tagged thread in the conversation. */
    onOpenAssistantThread: (thread: Thread) => void
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
    onOpenAssistantThread,
    onRequestAddProject
  }: Props = $props()

  /** Assistant mode reuses the chat thread renderer, but an assistant's task
   *  authors its knowledge conversationally, so the view needs the assistant. */
  let assistantId = $derived(mode === 'assistant' ? (selectedThread?.assistantId ?? null) : null)
  let assistant = $derived(
    assistantId
      ? (assistants.assistants.find((assistant) => assistant.id === assistantId) ?? null)
      : null
  )
  /**
   * The Assistant tab's threads, when one of them is open: what the composer's
   * `@` menu can tag, and what names a tagged thread in the conversation. No
   * other view has an assistant space to point at.
   */
  let assistantSpaceThreads = $derived(
    mode === 'assistant'
      ? (threadsByProject.get(ASSISTANT_SPACE_ID) ?? []).filter((thread) => !thread.archived)
      : undefined
  )

  function handleConversationRenderError(error: unknown): void {
    const thread = workspaceState.selectedThread
    if (!thread) return
    reportError(error, 'The conversation could not be rendered.', {
      projectId: thread.projectId,
      threadId: thread.id
    })
  }

  /**
   * The thread this launch is restoring, while the workspace is still resolving
   * its row.
   *
   * The persisted selection is known before any list is: the conversation's own
   * transcript is already being read against it (see
   * `preloadRestoredThreadConversation`), so the first screen can show what the
   * user was reading instead of holding an empty surface until the thread list,
   * the projects and the conversation renderer have all arrived.
   */
  let restoringSelection = $derived(
    workspaceState.restoringLastThread ? rendererRecovery.selectedThread : null
  )
</script>

<div
  class="min-h-0 min-w-0 overflow-hidden"
  style:grid-column="1"
  style:grid-row="1"
  data-onboarding="conversation"
>
  {#if selectedThread}
    {#key selectedThread.id}
      <!-- The container is the keyed child, so the arriving thread fades and
           rises in on its own (`threadReveal`) instead of the switch being a hard
           swap. The reveal is intro-only on purpose: a keyed `out:` would defer
           ThreadView's teardown past the switch and let it clear the history
           state the arriving thread just published. -->
      <div
        class="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
        in:fly={threadReveal()}
      >
        <svelte:boundary onerror={handleConversationRenderError}>
          <ThreadView
            thread={selectedThread}
            {active}
            chatMode={mode === 'chats' || mode === 'assistant'}
            assistantMode={mode === 'assistant'}
            {assistantId}
            assistantName={assistant?.name ?? null}
            assistantKnowledgeComplete={assistant ? assistantKnowledgeComplete(assistant) : false}
            {assistantForeignRunThreadId}
            {assistantSpaceThreads}
            {onOpenAssistantThread}
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
                class="w-full max-w-md border border-danger/30 bg-surface px-5 py-4"
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
                  class="mt-4 bg-primary px-3 py-2 text-xs font-semibold text-on-primary transition-opacity hover:opacity-90"
                  onclick={reset}
                >
                  Reload conversation
                </button>
              </div>
            </div>
          {/snippet}
        </svelte:boundary>
      </div>
    {/key}
  {:else if restoringSelection}
    <!-- The saved thread is being restored: paint the part that is already in
         hand instead of flashing the Welcome screen through a blank surface.
         `ThreadView` replaces this the moment the workspace resolves the row. -->
    <ConversationFirstPaint
      projectId={restoringSelection.projectId}
      threadId={restoringSelection.threadId}
    />
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
    <!-- Assistant empty state   assistants and tasks start here, exactly the way a
         project does in the Projects view. -->
    <WelcomeStart
      variant="assistant"
      onNewAssistant={() => workspaceState.requestAssistant()}
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
