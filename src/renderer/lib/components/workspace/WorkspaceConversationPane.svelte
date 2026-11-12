<script lang="ts">
  import { SvelteMap } from 'svelte/reactivity'
  import type { Attachment } from 'svelte/attachments'
  import ThreadView from '$lib/components/threads/ThreadView.svelte'
  import WelcomeStart from './WelcomeStart.svelte'
  import ConversationSkeleton from '$lib/components/threads/ThreadView/ConversationSkeleton.svelte'
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
  import {
    captureThreadScreen,
    isThreadScreenScroller,
    mountThreadScreen,
    peekThreadScreen,
    type ThreadScreenSnapshot
  } from './thread-screen-snapshots'

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
  let selectedThreadId = $derived(selectedThread?.id ?? null)

  /**
   * A thread left recently comes back as its cached screen first: the frozen copy
   * paints, and only on the frame after does the live view mount underneath and
   * hydrate the new tail, so the rebuild never holds the switch on a blank pane.
   * A thread with no cached screen mounts live at once. Each visit is told apart
   * by the snapshot object itself, since every departure records a fresh one.
   */
  let cachedScreen = $derived(selectedThreadId ? peekThreadScreen(selectedThreadId) : null)
  let liveMountedOver = $state.raw<ThreadScreenSnapshot | null>(null)
  let coverLiftedFrom = $state.raw<ThreadScreenSnapshot | null>(null)
  let liveMounted = $derived(cachedScreen === null || liveMountedOver === cachedScreen)
  let coverShown = $derived(cachedScreen !== null && coverLiftedFrom !== cachedScreen)

  /** No rise-in under a cached screen: the screen is already where it belongs. */
  const NO_REVEAL = { duration: 0 }

  /** Paint a cached screen, mount the live view after that paint, then lift it. */
  function paintCachedScreen(cached: ThreadScreenSnapshot): Attachment<HTMLElement> {
    return (host) => {
      mountThreadScreen(host, cached)
      let frame = requestAnimationFrame(() => {
        settle = setTimeout(() => {
          liveMountedOver = cached
          frame = requestAnimationFrame(() => {
            frame = requestAnimationFrame(() => {
              coverLiftedFrom = cached
            })
          })
        }, 0)
      })
      let settle: ReturnType<typeof setTimeout> | undefined
      return () => {
        cancelAnimationFrame(frame)
        clearTimeout(settle)
      }
    }
  }

  /** Record the live screen's scroll offset and copy the screen when it leaves. */
  function cacheOnLeave(threadId: string): Attachment<HTMLElement> {
    return (node) => {
      let scrollTop = 0
      const onScroll = (event: Event): void => {
        if (event.target instanceof HTMLElement && isThreadScreenScroller(event.target)) {
          scrollTop = event.target.scrollTop
        }
      }
      node.addEventListener('scroll', onScroll, { capture: true, passive: true })
      return () => {
        node.removeEventListener('scroll', onScroll, { capture: true })
        captureThreadScreen(threadId, node, scrollTop)
      }
    }
  }

  let restoringSelection = $derived(
    workspaceState.restoringLastThread ? rendererRecovery.selectedThread : null
  )
</script>

<div
  class="relative min-h-0 min-w-0 overflow-hidden"
  style:grid-column="1"
  style:grid-row="1"
  data-onboarding="conversation"
>
  {#if selectedThread}
    {#if coverShown && cachedScreen}
      <div
        class="absolute inset-0 z-10 overflow-hidden bg-app"
        inert
        aria-hidden="true"
        {@attach paintCachedScreen(cachedScreen)}
      ></div>
    {/if}
    {#if liveMounted}
      {#key selectedThread.id}
        <!-- The container is the keyed child, so the arriving thread fades and
           rises in on its own (`threadReveal`) instead of the switch being a hard
           swap. The reveal is intro-only on purpose: a keyed `out:` would defer
           ThreadView's teardown past the switch and let it clear the history
           state the arriving thread just published. -->
        <div
          class="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
          in:fly={cachedScreen ? NO_REVEAL : threadReveal()}
          {@attach cacheOnLeave(selectedThread.id)}
        >
          <svelte:boundary onerror={handleConversationRenderError}>
            <ThreadView
              thread={selectedThread}
              {active}
              ownsReadingColumn
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
    {/if}
  {:else if restoringSelection}
    <!-- The saved thread is being restored: paint the part that is already in
         hand instead of flashing the Welcome screen through a blank surface.
         `ThreadView` replaces this the moment the workspace resolves the row. -->
    <div class="flex h-full min-h-0 flex-col overflow-hidden px-6 pb-6">
      <div class="mx-auto flex min-h-full w-full min-w-0 max-w-3xl flex-col justify-end gap-4 pt-6">
        <ConversationSkeleton />
      </div>
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
