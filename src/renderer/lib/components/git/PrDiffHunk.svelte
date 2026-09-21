<script lang="ts">
  /**
   * A unified diff hunk with its file line numbers.
   *
   * Two surfaces read the same geometry: an inline review thread, which anchors
   * on the line a comment was written about, and the pull request's file list,
   * which shows a whole patch. Both need the same thing, which is why the
   * window's clamp is a prop rather than a separate component.
   */
  import { ChevronDown, ChevronUp } from '@lucide/svelte'
  import type { PrCommentSide } from '$shared/types'
  import {
    HUNK_CONTEXT_ROWS,
    hunkWindow,
    patchLineClass,
    type HunkLine
  } from './git-pull-request-detail-format'

  interface Props {
    /** The hunk text, header included. Null when the provider sent none. */
    hunk: string | null
    /** The line being pointed at, when this surface has one. */
    anchor?: number | null
    /** Which file `anchor` numbers, when the caller knows. */
    side?: PrCommentSide | null
    /**
     * How many lines to show ahead of the anchor; null shows the whole hunk,
     * which is also what removes the toggle: a window nothing was clamped out of
     * has no hidden lines to open.
     */
    rows?: number | null
    class?: string
  }

  let {
    hunk,
    anchor = null,
    side = null,
    rows = HUNK_CONTEXT_ROWS,
    class: className = ''
  }: Props = $props()

  /** True once the reader asked for the whole hunk behind the clamp. */
  let expanded = $state(false)

  /**
   * The clamped window is kept beside the shown one so the toggle can say how
   * many lines it is hiding while they are open as well.
   */
  /**
   * The number a line shows in the gutter: the file it exists in after the change
   * for a context line or an addition, and the file before it for a removal, which
   * is the single column GitHub's unified view uses.
   */
  function gutterNumber(line: HunkLine): number | null {
    return line.newNumber ?? line.oldNumber
  }

  const clamped = $derived(hunkWindow(hunk, anchor, rows, side))
  const window = $derived(expanded ? hunkWindow(hunk, anchor, null, side) : clamped)

  /**
   * The number column is only worth its width when some line has one: a hunk of
   * pure additions and removals would otherwise reserve an empty gutter.
   */
  const numbered = $derived(window.lines.some((line: HunkLine) => gutterNumber(line) !== null))

  function toggle(): void {
    expanded = !expanded
  }
</script>

{#if window.lines.length > 0}
  <div class={['overflow-x-auto font-mono text-[0.5625rem] leading-relaxed', className]}>
    {#if clamped.hiddenAbove > 0}
      <button
        type="button"
        class="flex w-full cursor-pointer items-center gap-1 border-b border-border/40 bg-elevated/30 px-2 py-0.5 text-left text-[0.5625rem] text-dimmed hover:bg-elevated"
        aria-expanded={expanded}
        title={expanded
          ? 'Hide the lines above the comment again'
          : 'Show the lines above the comment'}
        onclick={toggle}
      >
        {#if expanded}
          <ChevronUp size={10} class="shrink-0" />
          Hide {clamped.hiddenAbove} earlier lines
        {:else}
          <ChevronDown size={10} class="shrink-0" />
          Show {clamped.hiddenAbove} earlier {clamped.hiddenAbove === 1 ? 'line' : 'lines'}
        {/if}
      </button>
    {/if}
    {#each window.lines as line, index (index)}
      <div
        class={[
          'flex w-max min-w-full border-l-2',
          line.anchor ? 'border-l-info' : 'border-l-transparent',
          patchLineClass(line.text)
        ]}
      >
        {#if numbered}
          <span
            class={[
              'w-8 shrink-0 select-none pr-1.5 text-right tabular-nums',
              line.anchor ? 'font-medium text-info' : 'text-dimmed'
            ]}>{gutterNumber(line) ?? ''}</span
          >
        {/if}
        <span class="whitespace-pre pr-2 pl-1">{line.text || ' '}</span>
      </div>
    {/each}
  </div>
{/if}
