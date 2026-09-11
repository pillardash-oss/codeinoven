<script lang="ts">
  import MarkdownView from './MarkdownView.svelte'

  interface Props {
    /** Markdown source   may be an incomplete, still-streaming message. */
    text: string
    /**
     * True while this content is still receiving streamed deltas. While true,
     * the rendered text trails the newest source behind a short animated
     * reveal so coalesced ~50ms IPC flushes paint as a smooth token flow.
     * When false (or when the source stops growing), the full text renders.
     */
    streaming?: boolean
    class?: string
    onCiteFile?: (path: string, line?: number) => void
  }

  let { text, streaming = false, class: className = '', onCiteFile }: Props = $props()

  /**
   * How far (in milliseconds) the reveal trail lags behind the newest flushed
   * text. Larger values look smoother but delay visibility; ~140ms hides the
   * 50-100ms coalescing cadence without feeling like a slow typewriter.
   */
  const TRAIL_MS = 140
  /** Never reveal fewer than this many characters per frame while behind. */
  const MIN_CHARS_PER_FRAME = 2

  /** Leading source slice currently revealed to the reader. */
  let revealedText = $state('')
  let rafId: number | null = null
  let lastTick = 0

  let smoothedText = $derived.by(() => {
    if (!streaming) return text
    const revealed = revealedText
    // A shrinking or non-appending change (part replaced, fork, history
    // reload, final snapshot rewinding the stream) cannot be smoothed   snap
    // to the end so stale characters never linger and old text never re-runs.
    if (revealed.length > text.length || !text.startsWith(revealed)) return text
    return revealed
  })

  // Scheduling effect only   the reveal itself advances inside the rAF loop,
  // which needs imperative timing state that $derived cannot express.
  $effect(() => {
    if (!streaming) return
    lastTick = performance.now()
    rafId = requestAnimationFrame(tick)
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId)
      rafId = null
    }
  })

  function tick(now: number): void {
    rafId = null
    const target = text
    if (revealedText.length >= target.length) return
    const dt = Math.min(now - lastTick, 100)
    lastTick = now
    const pending = target.length - revealedText.length
    // Adaptive step: the backlog clears in ~TRAIL_MS regardless of how large
    // the coalesced flush was, with a floor so slow streams still creep.
    const step = Math.max(MIN_CHARS_PER_FRAME, Math.ceil((pending * dt) / TRAIL_MS))
    revealedText = target.slice(0, revealedText.length + step)
    if (revealedText.length < target.length) rafId = requestAnimationFrame(tick)
  }
</script>

<MarkdownView text={smoothedText} class={className} {onCiteFile} />
