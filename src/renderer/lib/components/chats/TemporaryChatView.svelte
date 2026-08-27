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

  function resolveTab(): TemporaryChatContextTab {
    const current = contextSidebarState.temporaryChatTab(tabId)
    if (!current) throw new Error(`Temporary chat tab is unavailable: ${tabId}`)
    return current
  }

  const tab = resolveTab()
  const controller = new TemporaryChatController(tab)

  async function continueInThread(): Promise<void> {
    if (!onContinueInThread) return
    try {
      await onContinueInThread(tab)
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error)
      const clean = raw.replace(/^Error invoking remote method '[^']+': Error:\s*/u, '')
      throw new Error(clean || 'The side chat could not be continued.')
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
  {#key tabId}
    <ThreadView
      thread={syntheticThreadFor(tab)}
      chatMode={true}
      {controller}
      onContinueInThread={continueInThread}
    />
  {/key}
</div>

<style>
  .temporary-chat-view :global(.chat-composer) {
    position: sticky;
    bottom: 0;
    z-index: 10;
  }
</style>
