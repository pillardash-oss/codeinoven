<script lang="ts">
  import { onMount } from 'svelte'
  import { invoke } from '$lib/ipc.svelte'
  import type { Thread } from '$shared/types'
  import type { OvenState } from '$shared/ovens'
  import OvenWorkspace from './OvenWorkspace.svelte'

  let { thread }: { thread: Thread } = $props()
  let ovens = $state.raw<OvenState | null>(null)
  let error = $state('')
  onMount(() => {
    void invoke('oven:state')
      .then((state) => (ovens = state))
      .catch((failure: unknown) => {
        error = failure instanceof Error ? failure.message : 'Could not load this Oven.'
      })
  })
</script>

{#if error}
  <p class="p-3 text-xs text-danger" role="alert">{error}</p>
{:else if ovens && thread.settings?.ovenId}
  <div class="flex h-full min-h-0 flex-col">
    <p class="border-b px-3 py-2 text-xs font-medium">
      {ovens.ovens.find((oven) => oven.id === thread.settings?.ovenId)?.name ?? 'Oven'} · SSH
    </p>
    <div class="min-h-0 flex-1">
      <OvenWorkspace
        open
        embedded
        {thread}
        {ovens}
        ovenId={thread.settings.ovenId}
        root={thread.settings.ovenPath ?? ''}
        onClose={() => {}}
        onUseRoot={async (root) => {
          await invoke(
            'oven:selectThread',
            thread.projectId,
            thread.id,
            thread.settings!.ovenId!,
            root
          )
        }}
      />
    </div>
  </div>
{:else}
  <p class="p-3 text-xs text-muted" role="status">Loading Oven workspace…</p>
{/if}
