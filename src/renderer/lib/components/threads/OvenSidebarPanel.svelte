<script lang="ts">
  import type { Thread } from '$shared/types'
  import TerminalPanel from '../terminal/TerminalPanel.svelte'

  interface Props {
    thread: Thread
  }

  let { thread }: Props = $props()

  /** The Oven's own SSH shell, always opened in this thread's checkout. */
  let ovenId = $derived(thread.settings?.ovenId ?? '')
  let checkout = $derived(thread.settings?.ovenPath ?? '')
</script>

{#if ovenId && ovenId !== 'local'}
  {#key `${thread.id}:${ovenId}`}
    <div class="flex h-full min-h-0 flex-col">
      <div class="flex shrink-0 items-baseline gap-2 border-b px-3 py-2">
        <span class="text-xs font-medium text-foreground">Oven shell</span>
        <span
          class="min-w-0 flex-1 truncate text-[0.6875rem] text-muted"
          title={checkout || 'Home directory on the Oven'}
        >
          {checkout || '~'}
        </span>
      </div>
      <div class="min-h-0 flex-1">
        <TerminalPanel
          terminalId={`oven:${ovenId}:${thread.id}`}
          projectId={thread.projectId}
          threadId={thread.id}
          scopeBucketId={thread.scopeBucketId}
        />
      </div>
    </div>
  {/key}
{/if}
