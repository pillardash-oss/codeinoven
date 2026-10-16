<script lang="ts">
  import CioGrip from '$lib/components/icons/cio/CioGrip.svelte'

  interface Props {
    title: string
  }

  let { title }: Props = $props()
</script>

<button
  type="button"
  class="flex h-6 w-5 shrink-0 touch-none cursor-grab items-center justify-center text-dimmed outline-none transition-colors hover:bg-elevated hover:text-foreground"
  data-popover-drag-handle
  {title}
  aria-label={`${title}. Use arrow keys for precise movement.`}
>
  <CioGrip size={13} aria-hidden="true" />
</button>
