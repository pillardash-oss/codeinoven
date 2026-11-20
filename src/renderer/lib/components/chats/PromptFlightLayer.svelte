<script lang="ts">
  import { promptFlight, promptFlightAnimation } from './chat-composer-prompt-flight.svelte'

  const flight = $derived(promptFlight.flight)
</script>

{#if flight}
  <!-- The words the reader just sent, crossing from the composer to the transcript.
       It floats over both, carries no pointer events, and is never read out: the
       message itself is already in the conversation for assistive tech. Keyed by
       the flight so one send never inherits another's ghost. -->
  {#key flight.id}
    <div class="pointer-events-none fixed inset-0 z-40" aria-hidden="true">
      <div
        class="absolute overflow-hidden border-l-2 border-l-foreground bg-surface px-4 py-2.5 text-sm whitespace-pre-wrap text-foreground"
        style:left="{flight.to.left}px"
        style:top="{flight.to.top}px"
        style:width="{flight.to.width}px"
        {@attach promptFlightAnimation(flight)}
      >
        {flight.text}
      </div>
    </div>
  {/key}
{/if}
