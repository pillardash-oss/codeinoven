<script lang="ts">
  import CioTools from '$lib/components/icons/cio/CioTools.svelte'

  interface Props {
    /** Action-specific description, used for both `title` and `aria-label`. */
    label: string
    size?: number
  }

  let { label, size = 13 }: Props = $props()
</script>

<!-- Shares the thread row's indicator slot, so it is sized to the same 14px box
     and carries the Engineering Toolbox mark in the spec status colour   the
     same icon and tone the composer's Toolbox shows while Engineering is on. -->
<span
  class="flex h-3.5 w-3.5 shrink-0 items-center justify-center"
  role="status"
  aria-label={label}
  title={label}
>
  <CioTools
    {size}
    class="text-thread-spec"
    fill="var(--color-thread-spec)"
    fill-opacity={0.18}
    aria-hidden="true"
  />
</span>
