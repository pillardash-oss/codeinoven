<script lang="ts">
  import CioAlertCircle from '@pdslng/cio-icon/CioAlertCircle.svelte'
  import CioPause from '@pdslng/cio-icon/CioPause.svelte'
  import CioPlay from '@pdslng/cio-icon/CioPlay.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import CioVolume from '@pdslng/cio-icon/CioVolume.svelte'
  import { onMount } from 'svelte'
  import SeekBar from '$lib/components/ui/SeekBar.svelte'

  import { slide } from 'svelte/transition'
  import { probeInstalledTts } from '../../speech/tts-availability'
  import { speechController } from '../../speech/speech-controller.svelte'
  import type { SpeechScope } from '../../../../lib/speech/types'

  interface Props {
    messageId: string
    markdown: string
    disabled?: boolean
    /** Lets thread rows show the "Speaking" indicator for this playback. */
    scope?: SpeechScope
    /** What this playback speaks aloud. The tooltip names it, so a surface that
     *  reads something other than a response   a document, for instance   does
     *  not call it one. */
    spokenSubject?: 'response' | 'document'
  }

  let {
    messageId,
    markdown,
    disabled = false,
    scope = undefined,
    spokenSubject = 'response'
  }: Props = $props()
  const playbackState = $derived(speechController.playback)
  const ownsSession = $derived(
    'messageId' in playbackState && playbackState.messageId === messageId
  )
  // The compact seek slider lives in this same row and only appears while the
  // read-along overlay is active   the shared pause-linger timer hides both.
  const seekExpanded = $derived(
    ownsSession &&
      (playbackState.state === 'playing' ||
        (playbackState.state === 'paused' && speechController.seekControlsActive))
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
  const title = $derived.by(() => {
    const subject = spokenSubject
    if (!ownsSession) return `Read ${subject} aloud`
    if (playbackState.state === 'preparing') return `Preparing spoken ${subject}`
    if (playbackState.state === 'playing') return `Pause spoken ${subject}`
    if (playbackState.state === 'paused') return `Resume spoken ${subject}`
    if (playbackState.state === 'failed') return `Retry spoken ${subject}`
    return `Read ${subject} aloud`
  })

  let hasInstalledTts = $state(null as boolean | null)
  let visibilityKnown = $state(false)
  let hidden = $derived(visibilityKnown ? !hasInstalledTts : true)

  onMount(async () => {
    hasInstalledTts = await probeInstalledTts()
    visibilityKnown = true
  })

  function activate(): void {
    void speechController.togglePlayback(messageId, markdown, scope)
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
</script>

{#if !hidden}
  <div class="flex items-center gap-1.5">
    <button
      type="button"
      class="p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground focus-visible:ring-2 focus-visible:ring-info focus-visible:outline-none disabled:opacity-40"
      {title}
      aria-label={title}
      {disabled}
      onclick={activate}
    >
      {#if ownsSession && playbackState.state === 'preparing'}
        <CioSpinner size={12} class="animate-spin" aria-hidden="true" />
      {:else if ownsSession && playbackState.state === 'playing'}
        <CioPause size={12} aria-hidden="true" />
      {:else if ownsSession && playbackState.state === 'paused'}
        <CioPlay size={12} aria-hidden="true" />
      {:else if ownsSession && playbackState.state === 'failed'}
        <CioAlertCircle size={12} aria-hidden="true" />
      {:else}
        <CioVolume size={12} aria-hidden="true" />
      {/if}
    </button>
    {#if seekExpanded}
      <div transition:slide={{ duration: 160 }}>
        <SeekBar
          class="block w-28"
          value={scrubbing ? scrubValue : Math.min(thumbPosition, trackLength)}
          min={0}
          max={trackLength}
          step={0.1}
          fillRatio={synthesized}
          label="Seek spoken audio"
          title="Seek spoken audio"
          disabled={disabled || playbackState.state === 'preparing'}
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
