<script lang="ts">
  import CioClock from '@pdslng/cio-icon/CioClock.svelte'
  import { followUpsState } from '$lib/stores/follow-ups.svelte'
  import { formatDateTimeWithWeekday } from '$shared/date-time-format'

  /**
   * The mark that says a thread has a wake armed on it.
   *
   * It lives here rather than inline in one row because the sidebar's thread row,
   * the assistant task row and every other surface that lists a thread have to
   * tell the same truth about it: a scheduled wake that only one of them admitted
   * would make the others read as threads nothing is waiting on.
   */
  interface Props {
    /** The thread whose armed wake is reported. */
    threadId: string
    /** Glyph size in pixels, so a dense row can match its neighbours. */
    size?: number
  }

  let { threadId, size = 11 }: Props = $props()

  const soonest = $derived(followUpsState.next(threadId))

  const label = $derived(
    soonest
      ? `${soonest.paused ? 'Scheduled wake on hold' : 'Scheduled wake'} ${formatDateTimeWithWeekday(soonest.dueAt)}: ${soonest.note}`
      : 'Scheduled wake'
  )
</script>

{#if soonest}
  <span
    class="flex shrink-0 items-center {soonest.paused ? 'text-dimmed' : 'text-info'}"
    title={label}
    role="img"
    aria-label={label}
  >
    <CioClock {size} />
  </span>
{/if}
