<script lang="ts">
  import ThreadView from '../threads/ThreadView.svelte'
  import {
    contextSidebarState,
    type TemporaryChatContextTab
  } from '$lib/stores/context-sidebar.svelte'
  import { TemporaryChatController } from './TemporaryChatController.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import type { Thread } from '$shared/types'

  interface Props {
    tabId: string
    /** Promote the side chat into a regular thread, then open it. */
    onContinueInThread?: (tab: TemporaryChatContextTab) => void | Promise<void>
  }

  let { tabId, onContinueInThread }: Props = $props()

  function resolveTab(): TemporaryChatContextTab | null {
    return contextSidebarState.temporaryChatTab(tabId)
  }

  // Resolved once per mount; the store remains the sole owner of the live tab
  // object and the controller mutates it through the same proxy. When the tab
  // is already gone (closed/expired between open and render) show a quiet
  // empty state instead of crashing the panel to blank.
  const tab = resolveTab()
  const controller = tab ? new TemporaryChatController(tab) : null

  /**
   * The project this side chat hangs off, read from the same project list the
   * sidebar and the scope view already draw. Its `iconUrl` is the resolved icon
   * (stored image, SVG icon type, then initials), so the head start can name the
   * project the chat belongs to without fetching anything for it.
   */
  const project = $derived(scopeState.projects.find((entry) => entry.id === tab?.projectId) ?? null)

  /**
   * A quick chat exists to explore around a thread without disturbing it, so it
   * gets a head start of its own instead of the projectless Chats view greeting.
   * Explains keep the plain one   they open on their own seeded question.
   */
  const quickChat = tab?.mode === 'quick'

  /** What a reader asks about work they did not write: what is happening, another
   *  way to do it, and why this way. Picking one fills the composer. */
  const quickChatPrompts = [
    'Explain in simple terms what is happening',
    "Let's consider another approach",
    'Why did you go with this direction?'
  ]

  async function continueInThread(): Promise<void> {
    if (!onContinueInThread || !tab) return
    try {
      await onContinueInThread(tab)
    } catch (error: unknown) {
      const raw = error instanceof Error ? error.message : String(error)
      const clean = raw.replace(/^Error invoking remote method '[^']+': Error:\s*/u, '')
      throw new Error(clean || 'The side chat could not be continued.', { cause: error })
    }
  }

  function syntheticThreadFor(tab: TemporaryChatContextTab): Thread {
    const status = 'created' as const
    const now = Date.now()
    return {
      id: tab.temporaryChatId,
      projectId: tab.projectId,
      providerId: tab.settings.providerId ?? '',
      title: tab.title,
      titleSource: 'default',
      status,
      pinned: false,
      archived: false,
      read: true,
      createdAt: now,
      updatedAt: now,
      lastActivity: now,
      workingDirectory: '',
      ...(tab.sessionId ? { sessionId: tab.sessionId } : {}),
      settings: tab.settings
    }
  }
</script>

{#snippet quickChatEmptyStateHeading()}
  <h1
    class="flex items-center justify-center gap-2.5 text-[1.375rem] font-semibold tracking-tight text-foreground"
  >
    <span>{tab?.title ?? 'Quick chat'}</span>
    {#if project?.iconUrl}
      <img
        src={project.iconUrl}
        alt=""
        aria-hidden="true"
        draggable="false"
        class="size-7 shrink-0 rounded-[0.375rem] object-cover"
      />
    {/if}
  </h1>
  <p class="mt-1 text-[0.875rem] text-muted">
    Explore other context without worrying about your agent going off the rails
  </p>
{/snippet}

<div class="temporary-chat-view bg-app flex h-full min-h-0 w-full flex-col overflow-hidden">
  {#if tab && controller}
    {#key tabId}
      <ThreadView
        thread={syntheticThreadFor(tab)}
        chatMode
        {controller}
        emptyStateHeading={quickChat ? quickChatEmptyStateHeading : undefined}
        promptSuggestions={quickChat ? quickChatPrompts : undefined}
        onContinueInThread={continueInThread}
      />
    {/key}
  {:else}
    <div class="flex flex-1 items-center justify-center px-6 text-sm text-dimmed">
      This side chat is no longer available.
    </div>
  {/if}
</div>

<style>
  .temporary-chat-view :global(.chat-composer) {
    position: sticky;
    bottom: 0;
    z-index: 10;
  }
</style>
