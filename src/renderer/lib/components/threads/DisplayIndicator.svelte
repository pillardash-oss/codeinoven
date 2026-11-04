<script lang="ts">
  import CioDisplay from '@pdslng/cio-icon/CioDisplay.svelte'

  interface Props {
    /** Action-specific description, used for both `title` and `aria-label`. */
    label: string
    size?: number
  }

  let { label, size = 13 }: Props = $props()
</script>

<!-- Shares the thread row's indicator slot with computer use and the speech
     actions, so it is sized to the same 14px box and carries the accent colour
     that marks "an agent is driving something". -->
<span
  class="flex h-3.5 w-3.5 shrink-0 items-center justify-center"
  role="status"
  aria-label={label}
  title={label}
>
  <CioDisplay {size} strokeWidth={2.5} class="text-accent" aria-hidden="true" />
</span>
