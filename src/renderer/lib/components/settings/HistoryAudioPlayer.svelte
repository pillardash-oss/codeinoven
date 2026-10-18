<script lang="ts">
  import CioDownload from '@codeinoven/icons/CioDownload.svelte'
  import CioPlay from '@codeinoven/icons/CioPlay.svelte'
  import CioSpinner from '@codeinoven/icons/CioSpinner.svelte'
  import { onDestroy, tick } from 'svelte'

  import { toast } from 'svelte-sonner'
  import { invoke } from '$lib/ipc.svelte'
  import { osFileManagerLabel, revealExportedPathInOsFileManager } from '$lib/os-file-manager'
  import { speechController } from '../../speech/speech-controller.svelte'
  import { registerHistoryAudio, setCurrentHistoryAudio } from '../../speech/global-audio'

  interface Props {
    attemptId: string
    label?: string
  }

  let { attemptId, label = 'Recording' }: Props = $props()

  let url = $state<string | null>(null)
  let downloadName = $state('')
  let audioEl = $state<HTMLAudioElement | null>(null)
  let preparing = $state(false)
  let saving = $state(false)
  let error = $state<string | null>(null)
  let isPlaying = $state(false)
  let unregister: (() => void) | null = null

  function describe(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause)
  }

  /**
   * Load the recording and turn it into a playable blob URL. The main process
   * returns media that the audio element can actually decode, together with the
   * media type and extension describing those exact bytes: the macOS capture
   * worker stores Core Audio Format, which is converted on demand for playback.
   */
  async function prepare(): Promise<boolean> {
    if (url) return true
    if (preparing) return false
    preparing = true
    error = null
    try {
      const result = await invoke('speech:readAudio', attemptId)
      if (!result.ok) throw new Error(result.error.message)
      const next = URL.createObjectURL(
        new Blob([result.value.bytes], { type: result.value.mimeType })
      )
      url = next
      downloadName = `recording-${attemptId}${result.value.extension}`
      // Chromium names a download after its URL, and a blob URL is a bare UUID,
      // so the media controls' own Download item is told what this file is.
      void invoke('download:nameLocalBlob', next, downloadName).catch(() => undefined)
      return true
    } catch (cause) {
      error = describe(cause)
      return false
    } finally {
      preparing = false
    }
  }

  async function handlePlay(): Promise<void> {
    if (!(await prepare())) return
    // The src is applied by the same flush that set `url`.
    await tick()
    if (!audioEl) return
    await speechController.cancelPlayback()
    setCurrentHistoryAudio(audioEl)
    try {
      await audioEl.play()
    } catch (cause) {
      error = describe(cause)
    }
  }

  function handleMediaError(): void {
    const failure = audioEl?.error
    isPlaying = false
    error = failure?.message
      ? `The recording could not be played: ${failure.message}`
      : 'The recording could not be played.'
  }

  /**
   * Save the recording to a path the user picks.
   *
   * The bytes are written by the main process, never handed to the browser's own
   * download: every renderer-initiated download is denied at the session level
   * (see `src/main/bootstrap/session-guards.ts`), which is why the anchor this
   * button used to be did nothing at all   no dialog, no file, no error. The
   * answer also tells the three outcomes apart: a path means the file was
   * written, null means the user closed the dialog, and a failed result is
   * reported here instead of vanishing.
   */
  async function saveRecording(): Promise<void> {
    if (saving) return
    saving = true
    error = null
    try {
      const result = await invoke('speech:exportRecording', attemptId)
      if (!result.ok) throw new Error(result.error.message)
      if (!result.value) return
      const savedPath = result.value
      toast.success('Recording saved', {
        description: savedPath,
        action: {
          label: osFileManagerLabel(),
          onClick: () => void revealSavedRecording(savedPath)
        }
      })
    } catch (cause) {
      error = describe(cause)
    } finally {
      saving = false
    }
  }

  async function revealSavedRecording(savedPath: string): Promise<void> {
    const revealed = await revealExportedPathInOsFileManager(savedPath)
    if (!revealed) toast.error('The saved recording is no longer where it was written.')
  }

  function handlePlaybackStarted(): void {
    isPlaying = true
    if (audioEl) setCurrentHistoryAudio(audioEl)
    void speechController.cancelPlayback()
  }

  function handlePause(): void {
    isPlaying = false
  }

  function handleEnded(): void {
    isPlaying = false
  }

  $effect(() => {
    if (!audioEl) return
    unregister?.()
    unregister = registerHistoryAudio(audioEl)
    return () => {
      unregister?.()
      unregister = null
    }
  })

  onDestroy(() => {
    unregister?.()
    if (url) {
      void invoke('download:nameLocalBlob', url, null).catch(() => undefined)
      URL.revokeObjectURL(url)
    }
    if (audioEl && !audioEl.paused) audioEl.pause()
  })
</script>

<div class="border bg-elevated p-2">
  <!-- One stable element: play() always targets the element carrying the src. -->
  <audio
    bind:this={audioEl}
    src={url ?? undefined}
    controls={url !== null}
    preload={url === null ? 'none' : 'metadata'}
    hidden={url === null}
    class="h-8 w-full"
    aria-label="{label} audio player"
    onplay={handlePlaybackStarted}
    onpause={handlePause}
    onended={handleEnded}
    onerror={handleMediaError}
  ></audio>

  {#if url === null}
    <div class="flex items-center gap-2">
      <button
        type="button"
        class="inline-flex items-center gap-1.5 border bg-surface px-3 py-1.5 text-xs font-medium text-muted hover:text-foreground disabled:opacity-50"
        title="Load and play recording with seek and download"
        aria-label="Play recording {attemptId}"
        disabled={preparing}
        onclick={() => void handlePlay()}
      >
        {#if preparing}
          <CioSpinner size={12} class="animate-spin" aria-hidden="true" />
          Preparing…
        {:else}
          <CioPlay size={12} aria-hidden="true" />
          Play
        {/if}
      </button>
      <span class="text-[0.625rem] text-dimmed">Loaded once · seek and download on player</span>
    </div>
  {:else}
    <div class="mt-1.5 flex items-center justify-between gap-2">
      <span class="text-[0.625rem] text-dimmed"
        >{isPlaying ? 'Playing' : 'Paused'} · seek and volume on player</span
      >
      <button
        type="button"
        class="inline-flex items-center gap-1 border bg-surface px-2 py-1 text-[0.6875rem] font-medium text-muted hover:text-foreground disabled:opacity-50"
        title="Save this recording to a file"
        aria-label="Save recording {attemptId} to a file"
        disabled={saving}
        onclick={() => void saveRecording()}
      >
        {#if saving}
          <CioSpinner size={11} class="animate-spin" aria-hidden="true" /> Saving…
        {:else}
          <CioDownload size={11} aria-hidden="true" /> Download
        {/if}
      </button>
    </div>
  {/if}

  {#if error}
    <p class="mt-1.5 text-[0.6875rem] text-danger" role="alert">{error}</p>
  {/if}
</div>
