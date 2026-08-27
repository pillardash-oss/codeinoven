<script lang="ts">
  import { onMount } from 'svelte'
  import { CircleAlert, LoaderCircle, Pause, Play, Volume2 } from '@lucide/svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { slide } from 'svelte/transition'
  import { speechController } from '../../speech/speech-controller.svelte'

  interface Props {
    messageId: string
    markdown: string
    disabled?: boolean
  }

  let { messageId, markdown, disabled = false }: Props = $props()
  const playbackState = $derived(speechController.playback)
  const ownsSession = $derived('messageId' in playbackState && playbackState.messageId === messageId)
  // The compact seek slider lives in this same row and only appears while the
  // read-along overlay is active — the shared pause-linger timer hides both.
  const seekExpanded = $derived(
    ownsSession &&
      (playbackState.state === 'playing' ||
        (playbackState.state === 'paused' && speechController.seekControlsActive))
  )
  const thumbPosition = $derived(speechController.elapsedPlaybackSeconds)
  const trackLength = $derived(Math.max(speechController.knownPlaybackDurationSeconds, 0.1))
  let scrubbing = $state(false)
  let scrubValue = $state(0)
  const title = $derived.by(() => {
    if (!ownsSession) return 'Read response aloud'
    if (playbackState.state === 'preparing') return 'Preparing spoken response'
    if (playbackState.state === 'playing') return 'Pause spoken response'
    if (playbackState.state === 'paused') return 'Resume spoken response'
    if (playbackState.state === 'failed') return 'Retry spoken response'
    return 'Read response aloud'
  })

  let hasInstalledTts = $state(null as boolean | null)
  let visibilityKnown = $state(false)
  let hidden = $derived(visibilityKnown ? !hasInstalledTts : true)

  onMount(async () => {
    // Single-flight is implicit via shared promise on globalThis
    const g = globalThis as unknown as { __cioTtsProbe?: Promise<boolean>; __cioTtsResult?: boolean | null }
    if (g.__cioTtsResult !== undefined && g.__cioTtsResult !== null) {
      hasInstalledTts = g.__cioTtsResult
      visibilityKnown = true
      return
    }
    if (!g.__cioTtsProbe) {
      g.__cioTtsProbe = (async () => {
        try {
          const [capabilities, catalog] = await Promise.all([
            invoke('speech:getCapabilities'),
            invoke('speech:getCatalog')
          ])
          if (!capabilities.ok || !catalog.ok) return false
          const installedIds = new Set(
            capabilities.value.installedArtifacts
              .filter((artifact) => artifact.available)
              .map((artifact) => artifact.artifactId)
          )
          return catalog.value.artifacts.some(
            (artifact) =>
              artifact.capability === 'tts' &&
              artifact.qualification.status !== 'retired' &&
              installedIds.has(artifact.id)
          )
        } catch {
          return false
        }
      })()
    }
    const result = await g.__cioTtsProbe
    g.__cioTtsResult = result
    g.__cioTtsProbe = undefined
    hasInstalledTts = result
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
</script>

{#if !hidden}
<div class="flex items-center gap-1.5">
  <button
    type="button"
    class="rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground focus-visible:ring-2 focus-visible:ring-info focus-visible:outline-none disabled:opacity-40"
    {title}
    aria-label={title}
    {disabled}
    onclick={activate}
  >
    {#if ownsSession && playbackState.state === 'preparing'}
      <LoaderCircle size={12} class="animate-spin" aria-hidden="true" />
    {:else if ownsSession && playbackState.state === 'playing'}
      <Pause size={12} aria-hidden="true" />
    {:else if ownsSession && playbackState.state === 'paused'}
      <Play size={12} aria-hidden="true" />
    {:else if ownsSession && playbackState.state === 'failed'}
      <CircleAlert size={12} aria-hidden="true" />
    {:else}
      <Volume2 size={12} aria-hidden="true" />
    {/if}
  </button>
  {#if seekExpanded}
    <div transition:slide={{ duration: 160 }}>
      <input
        class="tts-seek block w-28 cursor-pointer"
        type="range"
        min="0"
        max={trackLength}
        step="0.1"
        value={scrubbing ? scrubValue : Math.min(thumbPosition, trackLength)}
        title="Seek spoken audio"
        aria-label="Seek spoken audio"
        disabled={disabled || playbackState.state === 'preparing'}
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
  .tts-seek {
    appearance: none;
    -webkit-appearance: none;
    height: 4px;
    border-radius: 9999px;
    background: var(--color-border);
    outline-offset: 3px;
  }
  .tts-seek:focus-visible {
    outline: 2px solid var(--color-info);
  }
  .tts-seek::-webkit-slider-thumb {
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
  .tts-seek::-moz-range-thumb {
    height: 10px;
    width: 10px;
    border-radius: 9999px;
    background: var(--color-primary);
    border: none;
    box-shadow: 0 0 0 1px var(--color-app);
    cursor: pointer;
  }
</style>
