<script lang="ts">
  import { onDestroy, tick } from 'svelte'
  import { Download, LoaderCircle, Play } from '@lucide/svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { speechController } from '../../speech/speech-controller.svelte'
  import { registerHistoryAudio, setCurrentHistoryAudio } from '../../speech/global-audio'

  interface Props {
    attemptId: string
    mimeType?: string
    label?: string
  }

  let { attemptId, mimeType, label = 'Recording' }: Props = $props()

  let url = $state<string | null>(null)
  let audioEl = $state<HTMLAudioElement | null>(null)
  let loading = $state(false)
  let error = $state<string | null>(null)
  let isPlaying = $state(false)
  let unregister: (() => void) | null = null

  function mimeToExt(mime?: string): string {
    if (!mime) return 'webm'
    if (mime.includes('wav')) return 'wav'
    if (mime.includes('ogg')) return 'ogg'
    if (mime.includes('mp3') || mime.includes('mpeg')) return 'mp3'
    if (mime.includes('webm')) return 'webm'
    return 'webm'
  }

  function mimeToType(mime?: string): string {
    if (!mime) return 'audio/webm'
    if (mime.startsWith('audio/')) return mime
    return 'audio/webm'
  }

  const downloadName = $derived(`recording-${attemptId}.${mimeToExt(mimeType)}`)

  async function ensureUrl(): Promise<string | null> {
    if (url) return url
    loading = true
    error = null
    try {
      const result = await invoke('speech:readAudio', attemptId)
      if (!result.ok) throw new Error(result.error.message)
      const blob = new Blob([result.value as unknown as ArrayBuffer], { type: mimeToType(mimeType) })
      const next = URL.createObjectURL(blob)
      url = next
      return next
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
      return null
    } finally {
      loading = false
    }
  }

  async function handleLoadAndPlay(): Promise<void> {
    const next = await ensureUrl()
    if (!next) return
    await tick()
    if (!audioEl) return
    await speechController.cancelPlayback()
    setCurrentHistoryAudio(audioEl)
    try {
      await audioEl.play()
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    }
  }

  function handlePlay(): void {
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
    if (url) URL.revokeObjectURL(url)
    if (audioEl && !audioEl.paused) audioEl.pause()
  })

  let prevAttempt: string | null = null
  $effect(() => {
    const currentId = attemptId
    if (prevAttempt === null) {
      prevAttempt = currentId
      return
    }
    if (currentId !== prevAttempt) {
      if (url) URL.revokeObjectURL(url)
      url = null
      error = null
      isPlaying = false
      prevAttempt = currentId
    }
  })
</script>

<div class="rounded-lg border bg-elevated p-2">
  {#if url}
    <audio
      bind:this={audioEl}
      src={url}
      controls
      preload="metadata"
      class="h-8 w-full"
      aria-label="{label} audio player"
      onplay={handlePlay}
      onpause={handlePause}
      onended={handleEnded}
    ></audio>
    <div class="mt-1.5 flex items-center justify-between gap-2">
      <span class="text-[10px] text-dimmed">{isPlaying ? 'Playing' : 'Paused'} · seek and volume on player · download below</span>
      <a
        href={url}
        download={downloadName}
        class="inline-flex items-center gap-1 rounded-md border bg-surface px-2 py-1 text-[11px] font-medium text-muted hover:text-foreground"
        title="Download recording"
        aria-label="Download recording {attemptId}"
      >
        <Download size={11} aria-hidden="true" /> Download
      </a>
    </div>
    {#if error}
      <p class="mt-1 text-[11px] text-danger" role="alert">{error}</p>
    {/if}
  {:else}
    <div class="flex items-center gap-2">
      <button
        type="button"
        class="inline-flex items-center gap-1.5 rounded-lg border bg-surface px-3 py-1.5 text-xs font-medium text-muted hover:text-foreground disabled:opacity-50"
        title="Load and play recording with seek and download"
        aria-label="Play recording {attemptId}"
        disabled={loading}
        onclick={() => void handleLoadAndPlay()}
      >
        {#if loading}
          <LoaderCircle size={12} class="animate-spin" aria-hidden="true" />
          Loading…
        {:else}
          <Play size={12} aria-hidden="true" />
          Play
        {/if}
      </button>
      <span class="text-[10px] text-dimmed">Regular player with seek · download after load</span>
    </div>
    {#if error}
      <p class="mt-1.5 text-[11px] text-danger" role="alert">{error}</p>
    {/if}
    <!-- Keep audio element mounted even before url so handleLoadAndPlay can play immediately -->
    <audio
      bind:this={audioEl}
      preload="metadata"
      class="hidden"
      aria-hidden="true"
      onplay={handlePlay}
      onpause={handlePause}
      onended={handleEnded}
    ></audio>
  {/if}
</div>
