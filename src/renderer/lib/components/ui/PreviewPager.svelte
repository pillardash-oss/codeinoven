<script module lang="ts">
  export type { PreviewPagerState } from './preview-pager-state'
</script>

<script lang="ts">
  import type { PreviewPagerState as PreviewPagerStateData } from './preview-pager-state'
  import CioBack from '@pdslng/cio-icon/CioBack.svelte'
  import CioForward from '@pdslng/cio-icon/CioForward.svelte'
  interface Props {
    pager: PreviewPagerStateData
    class?: string
    /** What the pager steps between, singular, for the controls' accessible
     *  names: a lightbox walks attachments, the passage reader walks the
     *  excerpts one message carries. */
    noun?: string
  }

  let { pager, class: className, noun = 'attachment' }: Props = $props()

  /** The group name reads as a title, the button names as an action: both keep
   *  the noun the caller chose, so the same pager never calls a passage an
   *  attachment. */
  const groupLabel = $derived(`${noun.charAt(0).toUpperCase()}${noun.slice(1)} navigation`)

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
  aria-label={groupLabel}
  class={[
    'titlebar-no-drag flex items-center gap-0.5 border bg-elevated/95 p-1 shadow-lg backdrop-blur-sm',
    className
  ]}
>
  <button
    type="button"
    class="p-1 text-dimmed transition-colors hover:bg-overlay hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
    aria-label={`Previous ${noun}`}
    title={`Previous ${noun}`}
    disabled={atStart}
    onclick={(event) => step(event, pager.onPrevious)}
  >
    <CioBack size={14} />
  </button>
  <span class="min-w-11 text-center font-mono text-[0.625rem] text-dimmed">{position}</span>
  <button
    type="button"
    class="p-1 text-dimmed transition-colors hover:bg-overlay hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
    aria-label={`Next ${noun}`}
    title={`Next ${noun}`}
    disabled={atEnd}
    onclick={(event) => step(event, pager.onNext)}
  >
    <CioForward size={14} />
  </button>
</div>
