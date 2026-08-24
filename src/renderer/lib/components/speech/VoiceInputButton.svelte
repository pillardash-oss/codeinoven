<script lang="ts">
  import { onMount } from 'svelte'
  import { Mic, TriangleAlert } from '@lucide/svelte'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { speechSettingsStore } from '$lib/stores/speech.svelte'
  import type { SpeechScope } from '../../../../lib/speech/types'
  import type { SpeechEditorSnapshot, SpeechEditorTarget } from '../../speech/editor-target'
  import { speechController } from '../../speech/speech-controller.svelte'

  interface Props {
    targetId: string
    getTarget: () => SpeechEditorTarget | null
    scope: SpeechScope
    disabled?: boolean
    class?: string
  }

  let { targetId, getTarget, scope, disabled = false, class: className = '' }: Props = $props()
  let preparedTarget: SpeechEditorTarget | null = null
  let preparedSnapshot: SpeechEditorSnapshot | null = null
  let fetchedHasInstalledAsr = $state(false)
  let fetchedVoiceRecordingEnabled = $state(false)
  let visibilityKnown = $state(false)

  let storeHasInstalledAsr = $derived.by(() => {
    const caps = speechSettingsStore.capabilities
    const catalog = speechSettingsStore.catalog
    if (!caps || !catalog) return undefined as boolean | undefined
    const installedIds = new Set(
      caps.installedArtifacts.filter((a) => a.available).map((a) => a.artifactId)
    )
    return catalog.artifacts.some(
      (a) => a.capability === 'asr' && a.qualification.status === 'qualified' && installedIds.has(a.id)
    )
  })

  let hasInstalledAsr = $derived(storeHasInstalledAsr ?? fetchedHasInstalledAsr)
  let voiceRecordingEnabled = $derived(fetchedVoiceRecordingEnabled)

  // Mic is hidden only when we know the state and neither a local ASR nor the
  // opt-in audio-to-LLM fallback is available. Store-derived ASR makes this
  // reactive across the app without a restart — import/activate in Sound
  // immediately flows to every mounted composer, edit and comment editor.
  let hidden = $derived(visibilityKnown && !hasInstalledAsr && !voiceRecordingEnabled)

  async function refreshFetchedState(): Promise<void> {
    try {
      const [capabilities, catalog, config] = await Promise.all([
        invoke('speech:getCapabilities'),
        invoke('speech:getCatalog'),
        invoke('config:get')
      ])
      if (capabilities.ok && catalog.ok) {
        const installedIds = new Set(
          capabilities.value.installedArtifacts
            .filter((artifact) => artifact.available)
            .map((artifact) => artifact.artifactId)
        )
        fetchedHasInstalledAsr = catalog.value.artifacts.some(
          (artifact) =>
            artifact.capability === 'asr' &&
            artifact.qualification.status === 'qualified' &&
            installedIds.has(artifact.id)
        )
      }
      fetchedVoiceRecordingEnabled = Boolean((config as unknown as { sound?: { voiceRecordingEnabled?: boolean } })?.sound?.voiceRecordingEnabled)
    } catch {
      // keep mic visible on probe failure
    } finally {
      visibilityKnown = true
    }
  }

  onMount(() => {
    void refreshFetchedState()
    // If Sound settings loads after us, the store-derived ASR flips visibility
    // without waiting for this component to remount. Count store readiness as
    // known as well so hidden recomputes as soon as store populates.
    const unsubProgress = subscribe('speech:progress', () => {
      void refreshFetchedState()
      // also ensure the shared store reloads for other consumers
      void speechSettingsStore.load()
    })
    const onSoundChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ voiceRecordingEnabled?: boolean }>).detail
      if (detail && typeof detail.voiceRecordingEnabled === 'boolean') {
        fetchedVoiceRecordingEnabled = detail.voiceRecordingEnabled
        visibilityKnown = true
      } else {
        void refreshFetchedState()
      }
    }
    const onFocus = () => void refreshFetchedState()
    window.addEventListener('cio:soundChanged', onSoundChanged as EventListener)
    window.addEventListener('focus', onFocus)
    return () => {
      unsubProgress()
      window.removeEventListener('cio:soundChanged', onSoundChanged as EventListener)
      window.removeEventListener('focus', onFocus)
    }
  })

  const belongsHere = $derived(speechController.isActiveTarget(targetId))
  const anotherTargetActive = $derived(
    speechController.state.state !== 'idle' &&
      speechController.state.state !== 'failed' &&
      !belongsHere
  )
  const action = $derived.by(() => {
    if (!belongsHere) return 'start' as const
    if (speechController.state.state === 'recording') return 'stop' as const
    if (speechController.state.state === 'failed') return 'retry' as const
    return 'wait' as const
  })
  const label = $derived.by(() => {
    if (action === 'stop') return 'Stop voice recording'
    if (action === 'retry') {
      return speechController.state.state === 'failed'
        ? `${speechController.state.message} Click to retry voice recording.`
        : 'Retry voice recording'
    }
    if (action === 'wait') {
      return speechController.state.state === 'requesting-permission'
        ? 'Requesting microphone permission'
        : speechController.state.state === 'stopping'
          ? 'Stopping voice recording'
          : 'Transcribing voice recording'
    }
    return 'Start voice recording'
  })

  function prepareTarget(): void {
    if (disabled || anotherTargetActive || action === 'stop' || action === 'wait') return
    preparedTarget = getTarget()
    preparedSnapshot = preparedTarget?.capture() ?? null
  }

  async function activate(): Promise<void> {
    if (disabled || anotherTargetActive || action === 'wait') return
    if (action === 'stop') {
      await speechController.stop()
      return
    }
    if (action === 'retry') speechController.resetFailure(targetId)
    const target = preparedTarget ?? getTarget()
    const snapshot = preparedSnapshot ?? target?.capture()
    preparedTarget = null
    preparedSnapshot = null
    if (!target) return
    await speechController.start(target, scope, snapshot)
  }
</script>

{#if !hidden}
<button
  type="button"
  class="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-45 {anotherTargetActive
    ? 'pointer-events-none opacity-40'
    : ''}   {className}"
  title={label}
  aria-label={label}
  aria-pressed={belongsHere && speechController.state.state === 'recording'}
  disabled={disabled || anotherTargetActive || action === 'wait'}
  onpointerdown={prepareTarget}
  onkeydown={(event) => {
    if (event.key === 'Enter' || event.key === ' ') prepareTarget()
  }}
  onclick={() => void activate()}
>
  {#if belongsHere && speechController.state.state === 'recording'}
    <Mic size={14} class="mic-recording" aria-hidden="true" />
  {:else if belongsHere && speechController.state.state === 'failed'}
    <TriangleAlert size={14} aria-hidden="true" />
  {:else if belongsHere && speechController.state.state !== 'idle'}
    <span class="flex h-3 items-center gap-[2px]" aria-hidden="true">
      <span class="wave-bar"></span>
      <span class="wave-bar wave-bar-delay-1"></span>
      <span class="wave-bar wave-bar-delay-2"></span>
    </span>
  {:else}
    <Mic size={14} aria-hidden="true" />
  {/if}
</button>

<span class="sr-only" aria-live="polite">{belongsHere ? label : ''}</span>
{/if}

<style>
  @keyframes cio-mic-record-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.35;
    }
  }
  .mic-recording {
    fill: var(--color-danger);
    animation: cio-mic-record-pulse 1.2s ease-in-out infinite;
  }
  @keyframes cio-wave-bar {
    0%,
    100% {
      height: 3px;
    }
    50% {
      height: 12px;
    }
  }
  .wave-bar {
    display: block;
    width: 2px;
    height: 6px;
    border-radius: 1px;
    background: var(--color-danger);
    animation: cio-wave-bar 0.9s ease-in-out infinite;
  }
  .wave-bar-delay-1 {
    animation-delay: 0.15s;
  }
  .wave-bar-delay-2 {
    animation-delay: 0.3s;
  }
</style>
