<script lang="ts">
  import { ElapsedTimer } from '$lib/elapsed.svelte'
  import { formatDurationMs } from '$lib/format/duration'

  /**
   * The total duration of one coordinator run, drawn where the run's counts are.
   *
   * A coordinator's work is many tasks, some sequential and some simultaneous,
   * so the number is the wall-clock span of the run, never a sum: two workers
   * running for the same minute are one minute of run, not two. The clock only
   * moves while something in the run is genuinely working, and it freezes the
   * moment the run is stopped, paused or settled, so the reader sees how long
   * the work actually took rather than how long the panel stayed open.
   */
  interface Props {
    /** When the run's first work started. Absent hides the timer: nothing ran. */
    startedAt?: number
    /** When the run settled. Absent leaves the live clock in charge. */
    endedAt?: number
    /** True while any part of the run is working. False freezes the timer. */
    live?: boolean
    /** What the frozen or live span measures, for the tooltip and screen readers. */
    label?: string
  }

  let { startedAt, endedAt, live = false, label = 'Total run time' }: Props = $props()

  const clock = new ElapsedTimer()
  /** Spans the run spent stopped or paused. A resumed run continues from the
   *  value it froze at instead of jumping forward by the length of the pause. */
  let pausedTotal = 0
  let pausedAt: number | null = null

  $effect(() => {
    const running = startedAt !== undefined && live && endedAt === undefined
    if (running) {
      if (pausedAt !== null) {
        pausedTotal += Date.now() - pausedAt
        pausedAt = null
      }
      clock.start()
    } else {
      if (pausedAt === null) pausedAt = Date.now()
      clock.stop()
    }
    return () => clock.stop()
  })

  const text = $derived(
    startedAt === undefined
      ? ''
      : formatDurationMs(Math.max(0, (endedAt ?? clock.now()) - startedAt - pausedTotal))
  )
</script>

{#if text}
  <span
    class="shrink-0 text-[0.625rem] font-medium tabular-nums text-muted"
    title={label}
    aria-label={`${label}: ${text}`}
  >
    {text}
  </span>
{/if}
