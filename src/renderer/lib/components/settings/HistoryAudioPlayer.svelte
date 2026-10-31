<script lang="ts">
  import CioDownload from '@pdslng/cio-icon/CioDownload.svelte'
  import CioPlay from '@pdslng/cio-icon/CioPlay.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import { onDestroy, tick } from 'svelte'

  import { toast } from 'svelte-sonner'
  import { invoke } from '$lib/ipc.svelte'
  import { osFileManagerLabel, revealExportedPathInOsFileManager } from '$lib/os-file-manager'
  import { speechController } from '../../speech/speech-controller.svelte'
  import { registerHistoryAudio } from '../../speech/global-audio'
  import AudioPlayer from '../ui/AudioPlayer.svelte'

  interface Props {
    attemptId: string
    label?: string
  }

  let { attemptId, label = 'Recording' }: Props = $props()

  let url = $state<string | null>(null)
  let audioEl = $state<HTMLAudioElement | null>(null)
  let preparing = $state(false)
  let saving = $state(false)
  let error = $state<string | null>(null)
  /** Releases the listeners this row put on the player's element. */
  let detach: (() => void) | null = null

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
      url = URL.createObjectURL(new Blob([result.value.bytes], { type: result.value.mimeType }))
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
    // The player mounts on the flush that sets `url`, and reports its element then.
    await tick()
    const element = audioEl
    if (!element) return
    await speechController.cancelPlayback()
    try {
      await element.play()
    } catch (cause) {
      error = describe(cause)
    }
  }

  /**
   * Take the player's element.
   *
   * A recording is one more audio surface in the app, so it enters the same
   * single-playback rule as every other one: starting it stops whatever history
   * recording was playing, and it cancels speech playback, which would otherwise
   * talk over the recording. The app's own player draws the controls, so the
   * coordination listens to the element instead of rendering a second player.
   */
  function attach(element: HTMLAudioElement): void {
    if (audioEl === element) return
    detach?.()
    audioEl = element
    const started = (): void => {
      void speechController.cancelPlayback()
    }
    const unregister = registerHistoryAudio(element)
    element.addEventListener('play', started)
    detach = () => {
      element.removeEventListener('play', started)
      unregister()
    }
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

  onDestroy(() => {
    detach?.()
    detach = null
    if (url) URL.revokeObjectURL(url)
    if (audioEl && !audioEl.paused) audioEl.pause()
  })
</script>

<div class="space-y-2">
  {#if url === null}
    <div class="flex flex-wrap items-center gap-2">
      <button
        type="button"
        class="inline-flex items-center gap-1.5 border border-border bg-surface px-3 py-1.5 text-xs font-medium text-muted hover:text-foreground disabled:opacity-50"
        title="Load and play this recording"
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
      <span class="text-[0.6875rem] text-dimmed">Loaded when you play it</span>
    </div>
  {:else}
    <AudioPlayer src={url} {label} onElement={attach} />
    <div class="flex items-center justify-end gap-2">
      <button
        type="button"
        class="inline-flex items-center gap-1 border border-border bg-surface px-2 py-1 text-[0.6875rem] font-medium text-muted hover:text-foreground disabled:opacity-50"
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
    <p class="text-[0.6875rem] text-danger" role="alert">{error}</p>
  {/if}
</div>
