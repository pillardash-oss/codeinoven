<script lang="ts">
  import { Columns3, Rows3 } from '@lucide/svelte'
  import { diffLayoutState } from '$lib/stores/diff-layout.svelte'

  interface Props {
    /** Action-specific description of what the toggle does. */
    title: string
    size?: number
  }

  let { title, size = 14 }: Props = $props()

  function handleClick(event: MouseEvent): void {
    event.preventDefault()
    event.stopPropagation()
    diffLayoutState.toggle()
  }
</script>

<button
  type="button"
  {title}
  aria-label={title}
  class="flex h-6 w-6 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
  onclick={handleClick}
>
  {#if diffLayoutState.layout === 'vertical'}
    <Rows3 {size} />
  {:else}
    <Columns3 {size} />
  {/if}
</button>
