<script lang="ts">
  import ComposerShoe from '$lib/components/chats/ComposerShoe.svelte'
  import type { ComposerShoeData } from '$lib/components/chats/ComposerShoe.svelte'
  import type { ComposerReadingSurface } from '$lib/components/chats/chat-composer-slash.svelte'

  let { onReveal, onHide }: { onReveal?: () => void; onHide?: () => void } = $props()

  const shoe: ComposerShoeData = { identity: { kind: 'chat' } }
  let shoeComponent: ComposerShoe | undefined = $state(undefined)

  /** Stands in for the composer's `/status` and `/tps` commands reaching the shoe. */
  export function openReading(surface: ComposerReadingSurface): void {
    shoeComponent?.openReading(surface)
  }
</script>

<div>
  <ComposerShoe
    bind:this={shoeComponent}
    {shoe}
    usage={{ usage: undefined, generationRate: 42, onReveal, onHide }}
  />
</div>
