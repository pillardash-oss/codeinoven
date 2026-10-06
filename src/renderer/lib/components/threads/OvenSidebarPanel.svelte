<script lang="ts">
  import type { Thread } from '$shared/types'
  import TerminalPanel from '../terminal/TerminalPanel.svelte'
  import { ovens } from '$lib/stores/ovens.svelte'

  interface Props {
    thread: Thread
  }

  let { thread }: Props = $props()

  /** The Oven's own SSH shell, always opened in this thread's checkout. */
  let ovenId = $derived(thread.settings?.ovenId ?? '')
  let checkout = $derived(thread.settings?.ovenPath ?? '')
  let identity = $derived(ovens.identity(ovenId))

  $effect(() => {
    if (ovenId && ovenId !== 'local') void ovens.ensure()
  })
</script>

{#if ovenId && ovenId !== 'local'}
  {#key `${thread.id}:${ovenId}`}
    <div class="flex h-full min-h-0 flex-col">
      <div class="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        {#if identity?.iconUrl}
          <img src={identity.iconUrl} alt="" class="h-3 w-3 shrink-0 object-contain" />
        {:else}
          <span
            class="h-2.5 w-2.5 shrink-0 rounded-full"
            style="background-color: {identity?.color || 'var(--color-muted)'}"
          ></span>
        {/if}
        <span class="shrink-0 text-xs font-medium text-foreground">{identity?.name ?? 'Oven'}</span>
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
