<script lang="ts">
  import CioAlertCircle from '@pdslng/cio-icon/CioAlertCircle.svelte'
  import CioPause from '@pdslng/cio-icon/CioPause.svelte'
  import CioPlay from '@pdslng/cio-icon/CioPlay.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import CioVolume from '@pdslng/cio-icon/CioVolume.svelte'
  import { onMount } from 'svelte'

  import { slide } from 'svelte/transition'
  import { probeInstalledTts } from '../../speech/tts-availability'
  import { speechController } from '../../speech/speech-controller.svelte'
  import SeekBar from '$lib/components/ui/SeekBar.svelte'

  interface Props {
    messageId: string
    markdown: string
    disabled?: boolean
  }

  let { messageId, markdown, disabled = false }: Props = $props()
  const playbackState = $derived(speechController.playback)
  const ownsSession = $derived(
    'messageId' in playbackState && playbackState.messageId === messageId
  )
  // Full block range: past audio is real, future lines are calibrated estimates.
  const trackLength = $derived(Math.max(speechController.estimatedTotalDurationSeconds, 0.1))
  /** How much of the block is synthesized, which is what the track fills to. */
  const synthesized = $derived.by(() => {
    if (trackLength <= 0) return 0
    return Math.min(1, speechController.generatedFrontierSeconds / trackLength)
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

  function beginScrub(value: number): void {
    scrubbing = true
    scrubValue = value
  }

  function commitScrub(): void {
    // Commit the value captured while scrubbing, not `input.value`: the
    // pointerup handler clears `scrubbing` before `change` dispatches, which
    // makes the reactive binding overwrite the input with the current playhead
    //   reading it here would seek right back to where playback already is.
    scrubbing = false
    void speechController.seekPlayback(scrubValue)
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
      class="flex h-7 w-7 items-center justify-center text-muted transition-colors hover:bg-elevated hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-40"
      title={buttonTitle}
      aria-label={buttonTitle}
      {disabled}
      onclick={activate}
    >
      {#if ownsSession && playbackState.state === 'preparing'}
        <CioSpinner size={13} class="animate-spin" aria-hidden="true" />
      {:else if ownsSession && playbackState.state === 'playing'}
        <CioPause size={13} aria-hidden="true" />
      {:else if ownsSession && playbackState.state === 'paused'}
        <CioPlay size={13} aria-hidden="true" />
      {:else if ownsSession && playbackState.state === 'failed'}
        <CioAlertCircle size={13} aria-hidden="true" />
      {:else}
        <CioVolume size={13} aria-hidden="true" />
      {/if}
    </button>
    <!-- Separate sibling control, not part of the play/pause button -->
    {#if ownsSession && (playbackState.state === 'playing' || (playbackState.state === 'paused' && speechController.seekControlsActive))}
      <div transition:slide={{ duration: 160 }}>
        <SeekBar
          class="block w-32"
          value={scrubbing ? scrubValue : Math.min(thumbPosition, trackLength)}
          min={0}
          max={trackLength}
          step={0.1}
          fillRatio={synthesized}
          label="Seek spoken audio"
          title="Seek spoken audio"
          {disabled}
          onScrubStart={beginScrub}
          onScrubEnd={() => {
            scrubbing = false
          }}
          onInput={(value) => (scrubValue = value)}
          onCommit={() => commitScrub()}
        />
      </div>
    {/if}
  </div>
{/if}
