<script lang="ts">
  import { onMount } from 'svelte'
  import { Mic, TriangleAlert } from '@lucide/svelte'
  import { toast } from 'svelte-sonner'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import RecordingIndicator from './RecordingIndicator.svelte'
  import { speechSettingsStore } from '$lib/stores/speech.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { logRendererError } from '$lib/system/renderer-logger'
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
    // Imported artifacts carry their own `capability` tag and have no catalog
    // entry (synthetic `imported-<hash>` ids), so they can't be matched by id.
    // Downloaded artifacts don't set `capability`, so those fall back to the
    // catalog lookup (also gated on non-retired qualification).
    return caps.installedArtifacts.some((a) => {
      if (!a.available) return false
      if (a.capability) return a.capability === 'asr'
      const catalogEntry = catalog.artifacts.find((c) => c.id === a.artifactId)
      return (
        catalogEntry?.capability === 'asr' && catalogEntry.qualification.status !== 'retired'
      )
    })
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
        fetchedHasInstalledAsr = capabilities.value.installedArtifacts.some((artifact) => {
          if (!artifact.available) return false
          if (artifact.capability) return artifact.capability === 'asr'
          const catalogEntry = catalog.value.artifacts.find((c) => c.id === artifact.artifactId)
          return (
            catalogEntry?.capability === 'asr' && catalogEntry.qualification.status !== 'retired'
          )
        })
      }
      fetchedVoiceRecordingEnabled = Boolean(
        (config as unknown as { sound?: { voiceRecordingEnabled?: boolean } })?.sound
          ?.voiceRecordingEnabled
      )
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
    const onFocus = (): void => {
      void refreshFetchedState()
    }
    window.addEventListener('cio:soundChanged', onSoundChanged)
    window.addEventListener('focus', onFocus)
    return () => {
      unsubProgress()
      window.removeEventListener('cio:soundChanged', onSoundChanged)
      window.removeEventListener('focus', onFocus)
    }
  })

  const belongsHere = $derived(speechController.isActiveTarget(targetId))
  const activeRecordingScope = $derived(speechController.recordingScope)
  const recordingHere = $derived(
    activeRecordingScope !== null &&
      scope.kind !== 'global' &&
      activeRecordingScope.kind !== 'global' &&
      activeRecordingScope.threadId === scope.threadId
  )
  const recordingElsewhere = $derived(
    activeRecordingScope !== null &&
      (scope.kind === 'global' ||
        activeRecordingScope.kind === 'global' ||
        activeRecordingScope.threadId !== scope.threadId)
  )
  const action = $derived.by(() => {
    if (recordingHere || (belongsHere && speechController.state.state === 'recording'))
      return 'stop' as const
    if (recordingElsewhere && speechController.state.state === 'recording')
      return 'blocked' as const
    if (belongsHere && speechController.state.state === 'failed') return 'retry' as const
    if (speechController.state.state !== 'idle' && speechController.state.state !== 'failed')
      return 'wait' as const
    return 'start' as const
  })
  const label = $derived.by(() => {
    if (action === 'stop') return 'Stop voice recording'
    if (action === 'blocked')
      return 'Already recording on another thread. Click to open that thread.'
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
    if (disabled || action !== 'start') return
    preparedTarget = getTarget()
    preparedSnapshot = preparedTarget?.capture() ?? null
  }

  async function openBlockedRecordingThread(): Promise<void> {
    const blockedScope = speechController.recordingScope
    if (!blockedScope || blockedScope.kind === 'global') return
    const projectId = blockedScope.kind === 'project' ? blockedScope.projectId : undefined
    const threadId = blockedScope.threadId
    if (!projectId || !threadId) return
    try {
      const [project, thread] = await Promise.all([
        invoke('project:get', projectId),
        invoke('thread:get', projectId, threadId)
      ])
      if (!project || !thread) return
      await workspaceState.openThreadFromNotification?.(thread, project)
    } catch (cause) {
      logRendererError('Could not open the active recording thread.', cause)
    }
  }

  async function showBlockedRecordingToast(): Promise<void> {
    const blockedScope = speechController.recordingScope
    let title = 'Already recording on another thread'
    if (blockedScope && blockedScope.kind !== 'global' && blockedScope.threadId) {
      const projectId = blockedScope.kind === 'project' ? blockedScope.projectId : undefined
      if (projectId) {
        try {
          const thread = await invoke(
            'thread:get',
            projectId,
            blockedScope.threadId
          )
          if (thread?.title) title = `Already recording on “${thread.title}”`
        } catch {
          // fall back to the generic title
        }
      }
    }
    toast.warning(title, {
      id: 'voice-recording-blocked',
      description: 'Finish the current recording before starting a new one.',
      duration: 8_000,
      action: {
        label: 'Open thread',
        onClick: () => void openBlockedRecordingThread()
      }
    })
  }

  async function activate(): Promise<void> {
    if (disabled || action === 'wait') return
    if (action === 'stop') {
      await speechController.stop()
      return
    }
    if (action === 'retry') {
      speechController.resetFailure(targetId)
      return
    }
    if (action === 'blocked') {
      await showBlockedRecordingToast()
      return
    }
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
    class="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-45 {action === 'blocked'
      ? 'opacity-60'
      : ''} {className}"
    title={label}
    aria-label={label}
    aria-pressed={action === 'stop'}
    disabled={disabled || action === 'wait'}
    onpointerdown={(event) => {
      // Keep the editor focused while the pointer activates recording. The
      // target still captures its value and caret before the click is handled.
      event.preventDefault()
      prepareTarget()
    }}
    onkeydown={(event) => {
      if (event.key === 'Enter' || event.key === ' ') prepareTarget()
    }}
    onclick={() => void activate()}
  >
    {#if action === 'stop'}
      <RecordingIndicator decorative />
    {:else if action === 'retry'}
      <TriangleAlert size={14} aria-hidden="true" />
    {:else if action === 'wait'}
      <span class="flex h-3 items-center gap-[2px]" aria-hidden="true">
        <span class="wave-bar"></span>
        <span class="wave-bar wave-bar-delay-1"></span>
        <span class="wave-bar wave-bar-delay-2"></span>
      </span>
    {:else}
      <Mic size={14} aria-hidden="true" />
    {/if}
  </button>

  <span class="sr-only" aria-live="polite">{action !== 'start' ? label : ''}</span>
{/if}

<style>
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
    background: var(--color-warning);
    animation: cio-wave-bar 0.9s ease-in-out infinite;
  }
  .wave-bar-delay-1 {
    animation-delay: 0.15s;
  }
  .wave-bar-delay-2 {
    animation-delay: 0.3s;
  }
</style>
