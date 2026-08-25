<script lang="ts">
  import { onMount } from 'svelte'
  import { CircleAlert, LoaderCircle, Pause, Play, Volume2 } from '@lucide/svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { speechController } from '../../speech/speech-controller.svelte'

  interface Props {
    messageId: string
    markdown: string
    disabled?: boolean
  }

  let { messageId, markdown, disabled = false }: Props = $props()
  const playbackState = $derived(speechController.playback)
  const ownsSession = $derived('messageId' in playbackState && playbackState.messageId === messageId)
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
</script>

{#if !hidden}
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
{/if}
