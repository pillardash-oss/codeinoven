<script lang="ts">
  import { MousePointer2 } from '@lucide/svelte'

  interface Props {
    /** Action-specific description, used for both `title` and `aria-label`. */
    label: string
    size?: number
  }

  let { label, size = 13 }: Props = $props()
</script>

<!-- Shares the thread row's recording-indicator slot, so it is sized to the
     same 14px box and carries the PiP cursor's accent colour. -->
<span
  class="flex h-3.5 w-3.5 shrink-0 items-center justify-center"
  role="status"
  aria-label={label}
  title={label}
>
  <MousePointer2 {size} strokeWidth={2.5} class="text-accent" aria-hidden="true" />
</span>
