<script lang="ts">
  import CioSubagent from '@pdslng/cio-icon/CioSubagent.svelte'

  interface Props {
    /** Action-specific description, used for both `title` and `aria-label`. */
    label: string
    size?: number
  }

  let { label, size = 13 }: Props = $props()
</script>

<!-- Shares the thread row's indicator slot, so it is sized to the same 14px box.
     The mark is the sub-agent glyph the app already uses for spawned work,
     because that is exactly what the row is saying: this thread owns pawn agents
     on threads of their own, and the pawn board is where they are listed. -->
<span
  class="flex h-3.5 w-3.5 shrink-0 items-center justify-center"
  role="status"
  aria-label={label}
  title={label}
>
  <CioSubagent {size} class="text-muted" aria-hidden="true" />
</span>
