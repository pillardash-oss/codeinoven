<script lang="ts">
  import { onDestroy } from 'svelte'
  import {
    Copy,
    Check,
    FileAudio,
    LoaderCircle,
    Mic,
    Pause,
    Play,
    Square,
    WandSparkles,
    X
  } from '@lucide/svelte'
  import { invoke } from '$lib/ipc.svelte'
  import type { SpeechSettings } from '../../../../lib/speech/types'
  import type { SpeechModelArtifact, SpeechRuntime } from '../../../../lib/speech/types'
  import { speechSettingsStore as speech } from '$lib/stores/speech.svelte'
  import { setCurrentHistoryAudio } from '../../speech/global-audio'

  interface Props {
    settings: SpeechSettings
  }

  let { settings }: Props = $props()

  let audioToken = $state<string | null>(null)
  let audioUrl = $state<string | null>(null)
  let audioLabel = $state('')
  let audioMime = $state('audio/webm')
  let audioElement = $state<HTMLAudioElement | null>(null)
  let isPlaying = $state(false)

  let recording = $state(false)
  let recordedMs = $state(0)
  let recordTimer: ReturnType<typeof setInterval> | null = null

  let transcribing = $state<'plain' | 'cleanup' | null>(null)
  let error = $state('')
  let transcript = $state('')
  let copied = $state(false)

  let recorder: MediaRecorder | null = null
  let stream: MediaStream | null = null
  let chunks: Blob[] = []

  const staged = $derived(audioToken !== null)
  const cleanupReady = $derived.by(() => {
    const installed = speech.capabilities?.installedArtifacts ?? []
    const activeId = settings.cleanupArtifactId
    if (activeId) {
      const match = installed.find((item) => item.artifactId === activeId)
      if (match?.available) return true
    }
    return installed.some((item) => item.available && item.capability === 'cleanup')
  })

  const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'] as const

  function selectedMimeType(): string {
    if (typeof MediaRecorder === 'undefined') return ''
    return MIME_TYPES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? ''
  }

  function stopRecordTimer(): void {
    if (recordTimer) {
      clearInterval(recordTimer)
      recordTimer = null
    }
  }

  function formatClock(ms: number): string {
    const total = Math.floor(ms / 1000)
    const minutes = Math.floor(total / 60)
    const seconds = total % 60
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }

  function clearStagedAudio(): void {
    if (audioToken) void invoke('speech:playgroundDiscard', audioToken).catch(() => undefined)
    audioToken = null
    if (audioUrl) URL.revokeObjectURL(audioUrl)
    audioUrl = null
    audioLabel = ''
    audioMime = 'audio/webm'
    isPlaying = false
  }

  function setError(cause: unknown): void {
    error = cause instanceof Error ? cause.message : String(cause)
  }

  async function startRecording(): Promise<void> {
    error = ''
    try {
      if (typeof navigator.mediaDevices?.getUserMedia !== 'function') {
        throw new Error('Microphone recording is unavailable in this environment.')
      }
      if (typeof MediaRecorder === 'undefined') {
        throw new Error('Audio recording is unavailable in this environment.')
      }
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      })
      const mimeType = selectedMimeType()
      recorder = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: 64_000
      })
      chunks = []
      audioMime = recorder.mimeType || mimeType || 'audio/webm'
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data)
      }
      recorder.onerror = () => void stopRecording()
      recorder.start(1000)
      clearStagedAudio()
      transcript = ''
      recording = true
      recordedMs = 0
      recordTimer = setInterval(() => {
        recordedMs += 1000
      }, 1000)
    } catch (cause) {
      releaseStream()
      setError(cause)
    }
  }

  function releaseStream(): void {
    for (const track of stream?.getTracks() ?? []) track.stop()
    stream = null
    recorder = null
  }

  async function stopRecording(): Promise<void> {
    recording = false
    stopRecordTimer()
    const activeRecorder = recorder
    if (!activeRecorder || activeRecorder.state === 'inactive') {
      releaseStream()
      return
    }
    await new Promise<void>((resolve) => {
      activeRecorder.onstop = () => resolve()
      activeRecorder.stop()
    })
    releaseStream()
    try {
      if (chunks.length === 0) throw new Error('The recording captured no audio.')
      const blob = new Blob(chunks, { type: audioMime })
      chunks = []
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const result = await invoke('speech:playgroundStage', bytes, audioMime)
      if (!result.ok) throw new Error(result.error.message)
      clearStagedAudio()
      audioToken = result.value.token
      audioUrl = URL.createObjectURL(blob)
      audioLabel = `Recording · ${formatClock(recordedMs) || '00:00'}`
    } catch (cause) {
      setError(cause)
    }
  }

  async function pickAudioFile(): Promise<void> {
    error = ''
    try {
      const path = await invoke('dialog:pickFile')
      if (!path) return
      const imported = await invoke('speech:playgroundImportPath', path)
      if (!imported.ok) throw new Error(imported.error.message)
      const audio = await invoke('speech:playgroundReadAudio', imported.value.token)
      if (!audio.ok) throw new Error(audio.error.message)
      clearStagedAudio()
      transcript = ''
      audioToken = imported.value.token
      audioLabel = imported.value.fileName
      const blob = new Blob([audio.value as unknown as ArrayBuffer], {
        type: imported.value.fileName.toLowerCase().endsWith('.mp3') ? 'audio/mpeg' : 'audio/webm'
      })
      audioMime = blob.type
      audioUrl = URL.createObjectURL(blob)
    } catch (cause) {
      setError(cause)
    }
  }

  function asrSelection(): { runtime: SpeechRuntime; artifact: SpeechModelArtifact } | null {
    const installed = (speech.capabilities?.installedArtifacts ?? []).filter(
      (item) => item.available
    )
    const activeId = settings.asrArtifactId
    if (activeId) {
      const match = installed.find((item) => item.artifactId === activeId)
      if (match && match.capability !== 'tts') {
        return {
          runtime: match.runtime,
          artifact: { id: match.artifactId } as SpeechModelArtifact
        }
      }
    }
    const catalogArtifacts = speech.catalog?.artifacts ?? []
    for (const item of installed) {
      const hit = catalogArtifacts.find(
        (candidate) =>
          candidate.id === item.artifactId &&
          candidate.capability === 'asr' &&
          candidate.qualification.status !== 'retired'
      )
      if (hit) return { runtime: item.runtime, artifact: hit }
    }
    for (const item of installed) {
      if (item.capability !== 'tts')
        return { runtime: item.runtime, artifact: { id: item.artifactId } as SpeechModelArtifact }
    }
    return null
  }

  function cleanupModelId(): string | undefined {
    const installed = speech.capabilities?.installedArtifacts ?? []
    const activeId = settings.cleanupArtifactId
    if (activeId && installed.find((item) => item.artifactId === activeId)?.available) {
      return activeId
    }
    const fallback = installed.find(
      (item) => item.available && (item.capability === 'cleanup' || item.runtime === 'gguf')
    )
    return fallback?.artifactId
  }

  async function transcribe(withCleanup: boolean): Promise<void> {
    if (!audioToken || transcribing) return
    const asr = asrSelection()
    if (!asr) {
      error = 'Install a speech-to-text model in the Models tab first.'
      return
    }
    transcribing = withCleanup ? 'cleanup' : 'plain'
    error = ''
    transcript = ''
    try {
      const resolvedCleanupId = withCleanup ? cleanupModelId() : undefined
      const result = await invoke(
        'speech:playgroundTranscribe',
        audioToken,
        asr.runtime,
        asr.artifact.id,
        'auto',
        withCleanup && resolvedCleanupId
          ? {
              kind: 'local',
              artifactId: resolvedCleanupId,
              ...(settings.refinementFlags ? { flags: settings.refinementFlags } : {})
            }
          : { kind: 'disabled' }
      )
      if (!result.ok) throw new Error(result.error.message)
      transcript = result.value.finalTranscript
    } catch (cause) {
      setError(cause)
    } finally {
      transcribing = null
    }
  }

  async function copyTranscript(): Promise<void> {
    if (!transcript) return
    await invoke('clipboard:writeText', transcript)
    copied = true
    setTimeout(() => {
      copied = false
    }, 1500)
  }

  async function togglePlayback(): Promise<void> {
    if (!audioElement || !audioUrl) return
    if (isPlaying) {
      audioElement.pause()
      return
    }
    setCurrentHistoryAudio(audioElement)
    await audioElement.play().catch((cause: unknown) => setError(cause))
  }

  function handlePause(): void {
    isPlaying = false
    setCurrentHistoryAudio(null)
  }

  function resetAll(): void {
    stopRecordTimer()
    if (recorder && recorder.state !== 'inactive') recorder.stop()
    releaseStream()
    clearStagedAudio()
    recording = false
    recordedMs = 0
    transcript = ''
    error = ''
    transcribing = null
  }

  onDestroy(resetAll)
</script>

<section id="settings-block-sound-playground" class="rounded-xl border bg-surface p-4">
  <div class="mb-3 flex items-start justify-between gap-3">
    <div>
      <h2 class="text-xs font-semibold uppercase tracking-wide text-muted">Playground</h2>
      <p class="mt-1 text-[0.6875rem] text-dimmed">
        Record your voice or import an audio file and transcribe it. Nothing is saved — the audio
        and transcript live only while this page is open.
      </p>
    </div>
    {#if staged || transcript || recording}
      <button
        type="button"
        class="inline-flex shrink-0 items-center gap-1 rounded-lg border bg-elevated px-2.5 py-1 text-xs text-muted hover:text-foreground"
        title="Clear audio and transcript"
        aria-label="Clear audio and transcript"
        onclick={resetAll}
      >
        <X size={12} aria-hidden="true" /> Clear
      </button>
    {/if}
  </div>

  {#if error}
    <p class="mb-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">{error}</p>
  {/if}

  <div class="flex flex-wrap items-center gap-2">
    {#if recording}
      <button
        type="button"
        class="inline-flex items-center gap-2 rounded-lg bg-danger px-3 py-2 text-sm font-medium text-on-danger hover:bg-danger/90"
        title="Stop recording"
        aria-label="Stop recording"
        onclick={() => void stopRecording()}
      >
        <Square size={14} aria-hidden="true" /> Stop · {formatClock(recordedMs)}
      </button>
    {:else}
      <button
        type="button"
        class="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-on-primary hover:bg-primary/90 disabled:opacity-50"
        title="Record your voice"
        aria-label="Record your voice"
        onclick={() => void startRecording()}
      >
        <Mic size={14} aria-hidden="true" /> Record
      </button>
      <button
        type="button"
        class="inline-flex items-center gap-2 rounded-lg border bg-elevated px-3 py-2 text-sm font-medium text-foreground hover:bg-overlay disabled:opacity-50"
        title="Pick an audio file"
        aria-label="Pick an audio file"
        onclick={() => void pickAudioFile()}
      >
        <FileAudio size={14} aria-hidden="true" /> Pick audio file
      </button>
    {/if}
  </div>

  {#if staged && audioUrl}
    <div class="mt-3 flex items-center gap-3 rounded-lg border bg-elevated/40 p-3">
      <button
        type="button"
        class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary hover:bg-primary/90"
        title={isPlaying ? 'Pause audio' : 'Play audio'}
        aria-label={isPlaying ? 'Pause audio' : 'Play audio'}
        onclick={() => void togglePlayback()}
      >
        {#if isPlaying}
          <Pause size={14} aria-hidden="true" />
        {:else}
          <Play size={14} aria-hidden="true" />
        {/if}
      </button>
      <div class="min-w-0 flex-1">
        <p class="truncate text-sm font-medium" title={audioLabel}>{audioLabel}</p>
      </div>
      <audio
        bind:this={audioElement}
        src={audioUrl}
        onplay={() => (isPlaying = true)}
        onpause={handlePause}
        onended={() => (isPlaying = false)}
        class="hidden"
      ></audio>
    </div>

    <div class="mt-3 flex flex-wrap items-center gap-2">
      <button
        type="button"
        class="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-on-primary hover:bg-primary/90 disabled:opacity-50"
        title="Transcribe the audio without cleanup"
        aria-label="Transcribe the audio"
        disabled={transcribing !== null}
        onclick={() => void transcribe(false)}
      >
        {#if transcribing === 'plain'}
          <LoaderCircle size={13} class="animate-spin" aria-hidden="true" />
        {:else}
          <FileAudio size={13} aria-hidden="true" />
        {/if}
        Transcribe
      </button>
      <button
        type="button"
        class="inline-flex items-center gap-2 rounded-lg border bg-elevated px-3 py-2 text-sm font-medium text-foreground hover:bg-overlay disabled:opacity-50"
        title={cleanupReady
          ? 'Transcribe, then clean the transcript with the local cleanup model'
          : 'Download a cleanup model in the Models tab to enable cleanup'}
        aria-label="Transcribe and clean up the transcript"
        disabled={transcribing !== null || !cleanupReady}
        onclick={() => void transcribe(true)}
      >
        {#if transcribing === 'cleanup'}
          <LoaderCircle size={13} class="animate-spin" aria-hidden="true" />
        {:else}
          <WandSparkles size={13} aria-hidden="true" />
        {/if}
        Transcribe &amp; cleanup
      </button>
      {#if !cleanupReady}
        <span class="text-[0.6875rem] text-dimmed">
          Cleanup needs a local cleanup model — download one in the Models tab.
        </span>
      {/if}
    </div>
  {:else if !recording}
    <p class="mt-3 rounded-lg border border-dashed px-3 py-6 text-center text-xs text-dimmed">
      Record your voice or pick an audio file to begin.
    </p>
  {/if}

  {#if transcript || transcribing}
    <div class="mt-4">
      <div class="mb-1.5 flex items-center justify-between gap-3">
        <p class="text-xs font-semibold uppercase tracking-wide text-muted">Transcript</p>
        <div class="flex items-center gap-2">
          <span class="text-[0.625rem] text-dimmed tabular-nums">{transcript.length} chars</span>
          <button
            type="button"
            class="inline-flex items-center gap-1 rounded-md border bg-elevated px-2 py-1 text-[0.6875rem] font-medium text-muted hover:text-foreground disabled:opacity-50"
            title="Copy transcript to the clipboard"
            aria-label="Copy transcript"
            disabled={!transcript}
            onclick={() => void copyTranscript()}
          >
            {#if copied}
              <Check size={11} aria-hidden="true" /> Copied
            {:else}
              <Copy size={11} aria-hidden="true" /> Copy
            {/if}
          </button>
        </div>
      </div>
      {#if transcribing}
        <p
          class="flex items-center gap-2 rounded-lg border bg-elevated/40 px-3 py-3 text-xs text-muted"
        >
          <LoaderCircle size={13} class="animate-spin" aria-hidden="true" />
          Transcribing{transcribing === 'cleanup' ? ' and cleaning up' : ''}…
        </p>
      {:else}
        <textarea
          readonly
          class="min-h-40 w-full resize-y rounded-lg border bg-elevated/40 px-3 py-2 text-sm leading-relaxed text-foreground outline-none focus:border-primary"
          aria-label="Transcription result"
          bind:value={transcript}
          placeholder="The transcription will appear here."></textarea>
      {/if}
    </div>
  {/if}
</section>
