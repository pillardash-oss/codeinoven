<script lang="ts">
  import CioPhone from '$lib/components/icons/cio/CioPhone.svelte'

  interface Props {
    /** Action-specific description, used for both `title` and `aria-label`. */
    label: string
    size?: number
  }

  let { label, size = 13 }: Props = $props()
</script>

<!-- Shares the thread row's indicator slot with computer use and the speech
     actions, so it is sized to the same 14px box and carries the accent colour
     that marks "an agent is driving something". A handset rather than a monitor:
     the monitor already means "runs on this computer" two slots away. -->
<span
  class="flex h-3.5 w-3.5 shrink-0 items-center justify-center"
  role="status"
  aria-label={label}
  title={label}
>
  <CioPhone {size} strokeWidth={2.5} class="text-accent" aria-hidden="true" />
</span>
