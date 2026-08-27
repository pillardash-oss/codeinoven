<script lang="ts">
  import { onMount } from 'svelte'
  import { CircleAlert, LoaderCircle, Pause, Play, Volume2 } from '@lucide/svelte'
  import { slide } from 'svelte/transition'
  import { probeInstalledTts } from '../../speech/tts-availability'
  import { speechController } from '../../speech/speech-controller.svelte'

  interface Props {
    messageId: string
    markdown: string
    disabled?: boolean
  }

  let { messageId, markdown, disabled = false }: Props = $props()
  const playbackState = $derived(speechController.playback)
  const ownsSession = $derived('messageId' in playbackState && playbackState.messageId === messageId)
  // Full block range: past audio is real, future lines are calibrated estimates.
  const trackLength = $derived(Math.max(speechController.estimatedTotalDurationSeconds, 0.1))
  const fillPercent = $derived.by(() => {
    if (trackLength <= 0) return 0
    return Math.min(100, (speechController.generatedFrontierSeconds / trackLength) * 100)
  })
  const thumbPosition = $derived(speechController.elapsedPlaybackSeconds)
  let scrubbing = $state(false)
  let scrubValue = $state(0)

  let hasInstalledTts = $state(null as boolean | null)
  let visibilityKnown = $state(false)
  let hidden = $derived(visibilityKnown ? !hasInstalledTts : true)

  onMount(async () => {
    hasInstalledTts = await probeInstalledTts()
    visibilityKnown = true
  })

  function activate(): void {
    void speechController.togglePlayback(messageId, markdown)
  }

  function beginScrub(event: PointerEvent): void {
    const input = event.currentTarget as HTMLInputElement
    scrubbing = true
    scrubValue = Number(input.value)
  }

  function onScrubInput(event: Event): void {
    const input = event.currentTarget as HTMLInputElement
    scrubValue = Number(input.value)
  }

  function commitScrub(event: Event): void {
    const input = event.currentTarget as HTMLInputElement
    scrubbing = false
    void speechController.seekPlayback(Number(input.value))
  }

  const buttonTitle = $derived.by(() => {
    if (!ownsSession) return 'Read the question and its options aloud'
    if (playbackState.state === 'preparing') return 'Preparing spoken question'
    if (playbackState.state === 'playing') return 'Pause spoken question'
    if (playbackState.state === 'paused') return 'Resume spoken question'
    if (playbackState.state === 'failed') return 'Retry spoken question'
    return 'Read the question and its options aloud'
  })
</script>

{#if !hidden}
  <div class="flex shrink-0 items-center gap-1.5">
    <button
      type="button"
      class="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-40"
      title={buttonTitle}
      aria-label={buttonTitle}
      {disabled}
      onclick={activate}
    >
      {#if ownsSession && playbackState.state === 'preparing'}
        <LoaderCircle size={13} class="animate-spin" aria-hidden="true" />
      {:else if ownsSession && playbackState.state === 'playing'}
        <Pause size={13} aria-hidden="true" />
      {:else if ownsSession && playbackState.state === 'paused'}
        <Play size={13} aria-hidden="true" />
      {:else if ownsSession && playbackState.state === 'failed'}
        <CircleAlert size={13} aria-hidden="true" />
      {:else}
        <Volume2 size={13} aria-hidden="true" />
      {/if}
    </button>
    <!-- Separate sibling control, not part of the play/pause button -->
    {#if ownsSession && (playbackState.state === 'playing' || (playbackState.state === 'paused' && speechController.seekControlsActive))}
      <div transition:slide={{ duration: 160 }}>
        <input
          class="question-tts-seek block h-7 w-32 cursor-pointer"
          style="--fill:{fillPercent}%"
          type="range"
          min="0"
          max={trackLength}
          step="0.1"
          value={scrubbing ? scrubValue : Math.min(thumbPosition, trackLength)}
          title="Seek spoken audio"
          aria-label="Seek spoken audio"
          disabled={disabled}
          onpointerdown={beginScrub}
          onpointerup={() => {
            scrubbing = false
          }}
          oninput={onScrubInput}
          onchange={commitScrub}
        />
      </div>
    {/if}
  </div>
{/if}

<style>
  /* Two-tone track: filled (generated audio) vs unfilled (not yet synthesized). */
  .question-tts-seek {
    appearance: none;
    -webkit-appearance: none;
    height: 4px;
    border-radius: 9999px;
    background: linear-gradient(
      to right,
      var(--color-primary) 0%,
      var(--color-primary) var(--fill, 0%),
      var(--color-border) var(--fill, 0%),
      var(--color-border) 100%
    );
    outline-offset: 3px;
  }
  .question-tts-seek:focus-visible {
    outline: 2px solid var(--color-info);
  }
  .question-tts-seek::-webkit-slider-thumb {
    appearance: none;
    -webkit-appearance: none;
    height: 10px;
    width: 10px;
    border-radius: 9999px;
    background: var(--color-primary);
    border: none;
    box-shadow: 0 0 0 1px var(--color-app);
    cursor: pointer;
  }
  .question-tts-seek::-moz-range-thumb {
    height: 10px;
    width: 10px;
    border-radius: 9999px;
    background: var(--color-primary);
    border: none;
    box-shadow: 0 0 0 1px var(--color-app);
    cursor: pointer;
  }
</style>
