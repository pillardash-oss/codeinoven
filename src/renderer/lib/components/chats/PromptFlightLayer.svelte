<script lang="ts">
  import { CUBIC_OUT_CSS } from '$lib/motion'
  import {
    PROMPT_FLIGHT_HOLD,
    PROMPT_FLIGHT_MS,
    promptFlight,
    promptFlightTravel
  } from './chat-composer-prompt-flight.svelte'

  let ghost = $state<HTMLDivElement | null>(null)

  const flight = $derived(promptFlight.flight)

  /**
   * Draw the words in the air between the composer and the transcript.
   *
   * The ghost is laid out where the message lands and animated back to the box the
   * draft was typed in, so the flight ends on the exact rect the row occupies and
   * the hand-over is a cross-fade in place. Scripted rather than left to CSS
   * because it is one run per send, and a finished run has to tell the store to
   * drop the ghost rather than leave it parked over the composer.
   */
  $effect(() => {
    const current = flight
    const node = ghost
    if (!current || !node) return
    const travel = promptFlightTravel(current)
    const animation = node.animate(
      [
        { transform: `translate(${travel.x}px, ${travel.y}px)`, opacity: 1 },
        { transform: 'translate(0px, 0px)', opacity: 1, offset: PROMPT_FLIGHT_HOLD },
        { transform: 'translate(0px, 0px)', opacity: 0 }
      ],
      { duration: PROMPT_FLIGHT_MS, easing: CUBIC_OUT_CSS }
    )
    animation.onfinish = () => promptFlight.finish(current.id)
    return () => animation.cancel()
  })
</script>

{#if flight}
  <!-- The words the reader just sent, crossing from the composer to the transcript.
       It floats over both, carries no pointer events, and is never read out: the
       message itself is already in the conversation for assistive tech. -->
  <div class="pointer-events-none fixed inset-0 z-40" aria-hidden="true">
    <div
      bind:this={ghost}
      class="absolute overflow-hidden border-l-2 border-l-foreground bg-surface px-4 py-2.5 text-sm whitespace-pre-wrap text-foreground"
      style:left="{flight.to.left}px"
      style:top="{flight.to.top}px"
      style:width="{flight.to.width}px"
    >
      {flight.text}
    </div>
  </div>
{/if}
