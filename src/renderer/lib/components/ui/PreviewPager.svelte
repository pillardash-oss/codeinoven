<script module lang="ts">
  /**
   * Sibling navigation for a fullscreen preview opened over several files.
   *
   * `index` is zero-based into the caller's own previewable list, which already
   * excludes every file no preview can render: stepping never lands on an empty
   * frame, it moves straight to the next attachment that can be shown.
   */
  export interface PreviewPagerState {
    index: number
    count: number
    onPrevious: () => void
    onNext: () => void
  }
</script>

<script lang="ts">
  import { ChevronLeft, ChevronRight } from '@lucide/svelte'

  interface Props {
    pager: PreviewPagerState
    class?: string
  }

  let { pager, class: className }: Props = $props()

  const atStart = $derived(pager.index <= 0)
  const atEnd = $derived(pager.index >= pager.count - 1)
  const position = $derived(`${pager.index + 1} of ${pager.count}`)

  /** The previews close on a click of their backdrop, so a pager control must
   *  never let its own click reach that handler. */
  function step(event: MouseEvent, move: () => void): void {
    event.stopPropagation()
    move()
  }
</script>

<div
  role="group"
  aria-label="Attachment navigation"
  class={[
    'titlebar-no-drag flex items-center gap-0.5 rounded-lg border bg-elevated/95 p-1 shadow-lg backdrop-blur-sm',
    className
  ]}
>
  <button
    type="button"
    class="rounded p-1 text-dimmed transition-colors hover:bg-overlay hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
    aria-label="Previous attachment"
    title="Previous attachment"
    disabled={atStart}
    onclick={(event) => step(event, pager.onPrevious)}
  >
    <ChevronLeft size={14} />
  </button>
  <span class="min-w-11 text-center font-mono text-[0.625rem] text-dimmed">{position}</span>
  <button
    type="button"
    class="rounded p-1 text-dimmed transition-colors hover:bg-overlay hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
    aria-label="Next attachment"
    title="Next attachment"
    disabled={atEnd}
    onclick={(event) => step(event, pager.onNext)}
  >
    <ChevronRight size={14} />
  </button>
</div>
