<script lang="ts">
  import CioMonogram from '$lib/components/icons/cio/CioMonogram.svelte'

  interface Props {
    /** Action-specific description, used for both `title` and `aria-label`. */
    label: string
    size?: number
  }

  let { label, size = 13 }: Props = $props()
</script>

<!-- Shares the thread row's indicator slot, so it is sized to the same 14px box.
     The mark is the app's own monogram   the same glyph the orchestrator board
     and the workstation rail wear   because the thread wearing it is the one that
     started work elsewhere, not a thread of any particular project, chat or
     assistant kind. -->
<span
  class="flex h-3.5 w-3.5 shrink-0 items-center justify-center"
  role="status"
  aria-label={label}
  title={label}
>
  <CioMonogram {size} class="text-primary" aria-hidden="true" />
</span>
