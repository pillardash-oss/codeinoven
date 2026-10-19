<script lang="ts" module>
  /**
   * The reading in a card header, in the design's language: a bordered chip with
   * a clock, sitting before the fold at the far right of the row.
   *
   * It is a card's own clock or state, never decoration. Where a card has a real
   * reading (a countdown, an elapsed run, a retry deadline) it shows that; where
   * it does not, it states the state the card is actually in ("Ready", "Draft",
   * "Waiting"), because an invented time is worse than no time.
   */
  export interface CardChipData {
    /** What the chip reads, e.g. "2:14 left" or "Ready". */
    text: string
    /** `urgent` inks the chip warning; `paused` dims it. */
    tone?: CardChipTone
    /** Hover explanation of what the reading means. */
    title?: string
    /** Screen-reader override when the reading alone is not the whole sentence. */
    label?: string
  }

  export type CardChipTone = 'default' | 'paused' | 'urgent'
</script>

<script lang="ts">
  import CioClock from '@pdslng/cio-icon/CioClock.svelte'
  type Props = CardChipData

  let { text, tone = 'default', title, label }: Props = $props()

  const toneClass = $derived(
    tone === 'urgent'
      ? 'border-warning text-warning'
      : tone === 'paused'
        ? 'text-dimmed'
        : 'text-muted'
  )
</script>

<!-- The reading's own colour carries the state (quiet, paused, urgent), and the
state changes under the reader rather than by their hand, so the colour fades
instead of switching: a countdown turning urgent is a change of degree, not an
alarm to flash. -->
<span
  class="inline-flex shrink-0 items-center gap-1 border border-border px-1.5 py-0.5 text-[0.6875rem] tabular-nums whitespace-nowrap transition-colors {toneClass}"
  {title}
  aria-label={label ?? text}
>
  <CioClock size={11} class="shrink-0" />
  {text}
</span>
