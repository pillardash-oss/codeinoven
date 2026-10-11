<script lang="ts">
  import type { Snippet } from 'svelte'

  /**
   * One row of a conversation timeline, hung on the rail.
   *
   * The rail is drawn as a stub above the row's mark and a line down from it,
   * rather than as one line behind the whole stream. Two reasons: a line that runs
   * under everything would show through the transparent corners of an avatar, and a
   * per-row line survives rows of wildly different heights, which is what a stream
   * that mixes one-line events with full comments is.
   */
  interface Props {
    /** What sits on the rail for this row: a glyph, or the avatar of its author. */
    gutter: Snippet
    /** The row itself, drawn to the right of the rail. */
    children: Snippet
    /**
     * Whether this row opens the stream. The first row draws no stub above its
     * mark, so the rail starts at the mark instead of hanging from nothing.
     */
    first?: boolean
    /** Whether this row ends the stream, which is what stops the rail at its mark. */
    last?: boolean
    class?: string
  }

  let { gutter, children, first = false, last = false, class: className = '' }: Props = $props()
</script>

<div class={['flex gap-2.5', className]}>
  <!--
    The gutter stretches to the row's own height, so the line below a mark reaches
    the next row without either of them knowing where the other is. `min-h-5` keeps
    a one-line event as tall as its mark.
  -->
  <div class="flex w-5 shrink-0 flex-col items-center">
    {#if !first}
      <span class="h-1 w-px shrink-0 bg-border" aria-hidden="true"></span>
    {/if}
    <span class="flex h-5 w-5 shrink-0 items-center justify-center">
      {@render gutter()}
    </span>
    {#if !last}
      <span class="w-px flex-1 bg-border" aria-hidden="true"></span>
    {/if}
  </div>
  <div class="flex min-h-5 min-w-0 flex-1 flex-col justify-center pb-3">
    {@render children()}
  </div>
</div>
