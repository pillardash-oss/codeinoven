<script lang="ts">
  import CioBack from '@codeio/icon/CioBack.svelte'
  import CioForward from '@codeio/icon/CioForward.svelte'
  import { fly } from 'svelte/transition'
  import { tickArrive } from './card-motion'

  /**
   * The step control for a card that asks for several things in a row: the pair
   * of arrows and the position reading, `[prev] [next] 1/2`.
   *
   * It is navigation and nothing else, so neither arrow is gated on the entry
   * being answered. Gating the forward arrow on an answer is what once left a
   * user standing on question one of three with no way back to the end: the
   * walkthrough advances itself as options are picked, so by the time every
   * entry has an answer the card is already on the last one, and a step back
   * used to have nothing to step forward with. Submitting is the card's own
   * primary action, and that is still gated on every entry being answered.
   */
  interface Props {
    /** Noun the control titles name, e.g. "question" or "secret". */
    subject: string
    /** Zero-based index of the entry on screen. */
    index: number
    /** Entry count. One entry needs no stepper, and renders none. */
    total: number
    /** Fired by the forward arrow, resolved through the user's keymap when the
     *  card has one: the hint belongs on the control it actually advances. */
    advanceHint?: string
    /** Disables both arrows while the card is submitting or resolving. */
    disabled?: boolean
    onPrev: () => void
    onNext: () => void
  }

  let { subject, index, total, advanceHint, disabled = false, onPrev, onNext }: Props = $props()

  const positionLabel = $derived(`${subject} ${index + 1} of ${total}`)
  const stepClass =
    'flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center border border-border text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40'
</script>

{#if total > 1}
  <div class="flex shrink-0 items-center gap-1">
    <button
      type="button"
      class={stepClass}
      disabled={disabled || index === 0}
      onclick={onPrev}
      title="Previous {subject}"
      aria-label="Previous {subject}"
    >
      <CioBack size={14} class="shrink-0" />
    </button>
    <button
      type="button"
      class={stepClass}
      disabled={disabled || index === total - 1}
      onclick={onNext}
      title={advanceHint ? `Next ${subject} (${advanceHint})` : `Next ${subject}`}
      aria-label="Next {subject}"
    >
      <CioForward size={14} class="shrink-0" />
    </button>
    <!-- The reading stays after the pair, so it names where the arrows landed
       rather than sitting between the two controls. It is keyed by the entry
       for the same reason: the count lands from the side the step came from
       instead of blinking to its next value under the card's motion. -->
    {#key index}
      <span
        class="ml-0.5 text-[0.6875rem] tabular-nums text-dimmed"
        title={positionLabel}
        aria-label={positionLabel}
        in:fly={tickArrive()}
      >
        {index + 1}/{total}
      </span>
    {/key}
  </div>
{/if}
