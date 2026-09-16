<script lang="ts">
  import { ClockFading, WavesHorizontal } from '@lucide/svelte'
  import type { VoiceSendStage } from '$lib/speech/speech-controller.svelte'

  interface Props {
    /** `send` queues the transcript when it lands, `steer` interrupts the turn. */
    stage: VoiceSendStage
    label?: string
    decorative?: boolean
  }

  let { stage, label, decorative = false }: Props = $props()

  const tone = $derived(stage === 'steer' ? 'text-thread-working' : 'text-thread-spec')
</script>

<!-- Armed dictation: the same processing pulse the transcribing bars carry, on
     the icon that says how the transcript will be delivered   a wave for
     "queued behind the run", a clock for "steering into it". -->
<span
  class="voice-send-indicator {tone}"
  role={decorative ? undefined : 'status'}
  aria-label={decorative ? undefined : label}
  aria-hidden={decorative}
  title={decorative ? undefined : label}
>
  {#if stage === 'steer'}
    <ClockFading size={14} aria-hidden="true" />
  {:else}
    <WavesHorizontal size={14} aria-hidden="true" />
  {/if}
</span>

<style>
  @keyframes cio-voice-send-pulse {
    0%,
    100% {
      opacity: 1;
      transform: scale(1);
    }
    50% {
      opacity: 0.55;
      transform: scale(0.88);
    }
  }

  .voice-send-indicator {
    display: flex;
    align-items: center;
    justify-content: center;
    animation: cio-voice-send-pulse 0.9s ease-in-out infinite;
  }
</style>
