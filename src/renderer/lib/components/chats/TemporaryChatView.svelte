<script lang="ts">
  import ThreadView from '../threads/ThreadView.svelte'
  import {
    contextSidebarState,
    type TemporaryChatContextTab
  } from '$lib/stores/context-sidebar.svelte'
  import { TemporaryChatController } from './TemporaryChatController.svelte'
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

<div class="temporary-chat-view bg-app flex h-full min-h-0 w-full flex-col overflow-hidden">
  {#if tab && controller}
    {#key tabId}
      <ThreadView
        thread={syntheticThreadFor(tab)}
        chatMode={true}
        {controller}
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
