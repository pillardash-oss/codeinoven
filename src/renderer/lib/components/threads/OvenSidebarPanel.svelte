<script lang="ts">
  import type { Thread } from '$shared/types'
  import TerminalPanel from '../terminal/TerminalPanel.svelte'

  interface Props {
    thread: Thread
  }

  let { thread }: Props = $props()

  /**
   * The Oven's own SSH shell, always opened in this thread's checkout.
   *
   * The panel is the terminal itself: the sidebar header already names the Oven
   * and wears its mark, so a second row repeating the name and the checkout path
   * would be a toolbar with nothing to add.
   */
  let ovenId = $derived(thread.settings?.ovenId ?? '')
</script>

{#if ovenId && ovenId !== 'local'}
  {#key `${thread.id}:${ovenId}`}
    <div class="flex h-full min-h-0 flex-col">
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
