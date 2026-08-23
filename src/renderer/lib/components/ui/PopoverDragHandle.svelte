<script lang="ts">
  import { GripVertical } from '@lucide/svelte'

  interface Props {
    title: string
  }

  let { title }: Props = $props()
</script>

<button
  type="button"
  class="flex h-6 w-5 shrink-0 touch-none cursor-grab items-center justify-center rounded text-dimmed outline-none transition-colors hover:bg-elevated hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary"
  data-popover-drag-handle
  {title}
  aria-label={`${title}. Use arrow keys for precise movement.`}
>
  <GripVertical size={13} aria-hidden="true" />
</button>
