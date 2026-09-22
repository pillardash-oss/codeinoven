<script lang="ts">
  /**
   * The code a review comment is about, with the file line numbers either side
   * of it.
   *
   * Two surfaces read the same geometry: an inline review thread, which points at
   * the line a comment was written on, and the pull request's file list, which
   * shows a whole patch. The thread prefers the file's own patch and falls back to
   * GitHub's comment hunk, because only the patch carries the lines after the
   * commented one, and only the hunk survives the line going outdated.
   */
  import type { PrCommentSide } from '$shared/types'
  import {
    DIFF_CONTEXT_LINES,
    diffContext,
    patchLineClass,
    type HunkLine
  } from './git-pull-request-detail-format'

  interface Props {
    /** The file's whole patch, when the surface has it. */
    patch?: string | null
    /** The hunk GitHub attached to a comment, the fallback when the patch cannot place the anchor. */
    hunk?: string | null
    /** The line being pointed at, when this surface has one. */
    anchor?: number | null
    /** Which file `anchor` numbers, when the caller knows. */
    side?: PrCommentSide | null
    /**
     * Lines shown each side of the anchor. Null renders everything it was given,
     * which is what the Files view asks for: a whole patch has nothing to window.
     */
    context?: number | null
    class?: string
  }

  let {
    patch = null,
    hunk = null,
    anchor = null,
    side = null,
    context = DIFF_CONTEXT_LINES,
    class: className = ''
  }: Props = $props()

  const window = $derived(diffContext({ patch, hunk, anchor, side, context }))

  /**
   * The number a line shows in the gutter: the file it exists in after the change
   * for a context line or an addition, and the file before it for a removal, which
   * is the single column GitHub's unified view uses.
   */
  function gutterNumber(line: HunkLine): number | null {
    return line.newNumber ?? line.oldNumber
  }

  /**
   * The number column is only worth its width when some line has one: a patch of
   * pure additions and removals would otherwise reserve an empty gutter.
   */
  const numbered = $derived(window.lines.some((line: HunkLine) => gutterNumber(line) !== null))
</script>

{#if window.lines.length > 0}
  <div class={['overflow-x-auto font-mono text-[0.5625rem] leading-relaxed', className]}>
    {#each window.lines as line, index (index)}
      {#if line.gap}
        <!-- The window jumped across a hunk, so the file is not contiguous here.
             Saying so is the difference between two regions and a lie. -->
        <div class="flex w-full items-center gap-1.5 px-2 py-0.5 text-dimmed">
          <span class="h-px flex-1 bg-border/60"></span>
          <span title="Lines not shown here">⋯</span>
          <span class="h-px flex-1 bg-border/60"></span>
        </div>
      {:else}
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
      {/if}
    {/each}
  </div>
{/if}
