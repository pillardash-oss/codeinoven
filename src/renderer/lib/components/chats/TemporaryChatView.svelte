<script lang="ts">
  import { GitFork, Loader2 } from '@lucide/svelte'
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

  let converting = $state(false)
  let continueError = $state('')

  async function continueInThread(): Promise<void> {
    if (!onContinueInThread || converting) return
    converting = true
    continueError = ''
    try {
      await onContinueInThread(tab)
    } catch (error) {
      continueError =
        error instanceof Error ? error.message : 'The side chat could not be continued.'
    } finally {
      converting = false
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

{#snippet header()}
  <div
    class="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-app px-4 py-2"
  >
    <div class="flex min-w-0 flex-col">
      <span class="truncate text-sm font-medium text-foreground">{tab.title}</span>
      <span class="text-xs text-muted">Temporary chat</span>
    </div>
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-lg border border-border bg-elevated px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-overlay disabled:cursor-not-allowed disabled:opacity-60"
      disabled={converting || tab.busy}
      title="Continue this chat in a thread"
      aria-label="Continue in thread"
      onclick={() => void continueInThread()}
    >
      {#if converting}
        <Loader2 size={12} class="animate-spin" />
        <span>Moving…</span>
      {:else}
        <GitFork size={12} />
        <span>Continue in thread</span>
      {/if}
    </button>
  </div>
  {#if continueError}
    <div
      class="flex shrink-0 items-start justify-between gap-2 border-b border-danger/30 bg-danger/10 px-4 py-2 text-xs text-danger"
    >
      <span>{continueError}</span>
      <button
        type="button"
        class="shrink-0 rounded p-0.5 transition-colors hover:bg-danger/10"
        title="Dismiss error"
        aria-label="Dismiss continue-in-thread error"
        onclick={() => (continueError = '')}
      >
        ✕
      </button>
    </div>
  {/if}
{/snippet}

<ThreadView
  thread={syntheticThreadFor(tab)}
  chatMode={true}
  {controller}
  headerSnippet={header}
  onContinueInThread={continueInThread}
/>
