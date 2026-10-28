<script lang="ts">
  import CioAlertCircle from '@pdslng/cio-icon/CioAlertCircle.svelte'
  import CioMaximize from '@pdslng/cio-icon/CioMaximize.svelte'
  import CioPause from '@pdslng/cio-icon/CioPause.svelte'
  import CioPlay from '@pdslng/cio-icon/CioPlay.svelte'
  import CioVolume from '@pdslng/cio-icon/CioVolume.svelte'
  import CioVolumeX from '@pdslng/cio-icon/CioVolumeX.svelte'
  import SeekBar from './SeekBar.svelte'

  /**
   * The app's audio player.
   *
   * A file in a conversation or in the fullsize viewer is played by the app's own
   * controls rather than by the browser's audio element: the native player is a
   * platform widget with its own shape, its own type and its own idea of a
   * playhead, and it is the one surface in the app that no token can reach. This
   * one is a row of the app's own controls on the app's own surface, built from
   * the shared seek track, so it reads as part of the application in both places
   * it appears.
   */
  interface Props {
    /** The media source. */
    src: string
    /** The file's name, which names every control here. */
    label: string
    /**
     * Opens the file in the fullscreen surface, when the caller has one.
     *
     * The control is revealed on hover, like every other tool on inline content,
     * so the player itself stays a plain strip at rest.
     */
    onExpand?: () => void
    /** Reports a source that cannot be decoded, with the element that failed. */
    onError?: (element: HTMLAudioElement) => void
    /** Layout classes from the caller: a column width, or a centered card. */
    class?: string
  }

  let { src, label, onExpand, onError, class: layout = '' }: Props = $props()

  let audio = $state<HTMLAudioElement | null>(null)
  let playing = $state(false)
  let muted = $state(false)
  let currentTime = $state(0)
  let duration = $state(0)
  let failed = $state(false)
  let scrubbing = $state(false)
  let scrubValue = $state(0)

  /** `m:ss`, or `h:mm:ss` once a recording runs past an hour. */
  function clock(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
    const total = Math.floor(seconds)
    const hours = Math.floor(total / 3600)
    const minutes = Math.floor((total % 3600) / 60)
    const rest = total % 60
    const padded = String(rest).padStart(2, '0')
    return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${padded}` : `${minutes}:${padded}`
  }

  async function togglePlay(): Promise<void> {
    const element = audio
    if (!element) return
    if (element.paused) {
      try {
        await element.play()
        playing = true
      } catch {
        // A refused play (no decodable stream, or a policy refusal) is reported
        // through the element's own error event; the button simply stays idle.
        playing = false
      }
      return
    }
    element.pause()
    playing = false
  }

  function toggleMute(): void {
    const element = audio
    if (!element) return
    element.muted = !element.muted
    muted = element.muted
  }

  function seekTo(value: number): void {
    const element = audio
    if (!element) return
    element.currentTime = value
    currentTime = value
  }

  function resetPlayback(): void {
    playing = false
    currentTime = 0
    duration = 0
    failed = false
    scrubbing = false
    scrubValue = 0
  }
</script>

<div
  class={[
    'group/audio flex min-w-0 items-center gap-2 border border-border bg-surface px-2 py-1.5',
    layout
  ]}
>
  <audio
    bind:this={audio}
    class="hidden"
    {src}
    preload="metadata"
    onloadedmetadata={(event) => {
      duration = event.currentTarget.duration
    }}
    ondurationchange={(event) => {
      const value = event.currentTarget.duration
      if (Number.isFinite(value)) duration = value
    }}
    ontimeupdate={(event) => {
      if (scrubbing) return
      currentTime = event.currentTarget.currentTime
    }}
    onplay={() => (playing = true)}
    onpause={() => (playing = false)}
    onended={() => {
      playing = false
      currentTime = duration
    }}
    onerror={(event) => {
      failed = true
      playing = false
      const element = event.currentTarget
      if (element instanceof HTMLAudioElement) onError?.(element)
    }}
  ></audio>

  {#if failed}
    <p class="flex min-w-0 items-center gap-1.5 text-[0.75rem] font-medium text-danger">
      <CioAlertCircle size={12} aria-hidden="true" />
      <span class="truncate">This audio file could not be loaded</span>
    </p>
    <button
      type="button"
      class="ml-auto shrink-0 px-1.5 py-0.5 text-[0.6875rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
      aria-label="Try playing {label} again"
      title="Try playing {label} again"
      onclick={() => {
        resetPlayback()
        audio?.load()
      }}
    >
      Try again
    </button>
  {:else}
    <button
      type="button"
      class="flex size-7 shrink-0 items-center justify-center text-foreground transition-colors hover:bg-elevated"
      aria-label={playing ? `Pause ${label}` : `Play ${label}`}
      title={playing ? `Pause ${label}` : `Play ${label}`}
      onclick={() => void togglePlay()}
    >
      {#if playing}
        <CioPause size={13} aria-hidden="true" />
      {:else}
        <CioPlay size={13} aria-hidden="true" />
      {/if}
    </button>

    <span class="shrink-0 font-mono text-[0.6875rem] tabular-nums text-muted">
      {clock(scrubbing ? scrubValue : currentTime)}
    </span>

    <SeekBar
      class="block min-w-0 flex-1"
      value={scrubbing ? scrubValue : currentTime}
      min={0}
      max={Math.max(duration, 0.1)}
      step={0.1}
      label="Seek {label}"
      disabled={duration === 0}
      onScrubStart={(value) => {
        scrubbing = true
        scrubValue = value
      }}
      onScrubEnd={() => {
        scrubbing = false
      }}
      onInput={(value) => (scrubValue = value)}
      onCommit={() => seekTo(scrubValue)}
    />

    <span class="shrink-0 font-mono text-[0.6875rem] tabular-nums text-dimmed">
      {clock(duration)}
    </span>

    <button
      type="button"
      class="flex size-7 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
      aria-label={muted ? `Unmute ${label}` : `Mute ${label}`}
      title={muted ? `Unmute ${label}` : `Mute ${label}`}
      aria-pressed={muted}
      onclick={toggleMute}
    >
      {#if muted}
        <CioVolumeX size={13} aria-hidden="true" />
      {:else}
        <CioVolume size={13} aria-hidden="true" />
      {/if}
    </button>

    {#if onExpand}
      <button
        type="button"
        class="flex size-7 shrink-0 items-center justify-center text-dimmed opacity-0 transition-opacity duration-150 hover:bg-elevated hover:text-foreground focus-visible:opacity-100 group-hover/audio:opacity-100"
        aria-label="Open {label} full screen"
        title="Open {label} full screen"
        onclick={onExpand}
      >
        <CioMaximize size={13} aria-hidden="true" />
      </button>
    {/if}
  {/if}
</div>
