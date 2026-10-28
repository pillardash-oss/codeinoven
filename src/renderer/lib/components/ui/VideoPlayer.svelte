<script lang="ts">
  import CioAlertCircle from '@pdslng/cio-icon/CioAlertCircle.svelte'
  import CioMaximize from '@pdslng/cio-icon/CioMaximize.svelte'
  import CioPause from '@pdslng/cio-icon/CioPause.svelte'
  import CioPlay from '@pdslng/cio-icon/CioPlay.svelte'
  import CioVolume from '@pdslng/cio-icon/CioVolume.svelte'
  import CioVolumeX from '@pdslng/cio-icon/CioVolumeX.svelte'
  import SeekBar from './SeekBar.svelte'

  /**
   * The app's video player.
   *
   * A video is played by the app's own controls rather than by the browser's
   * media bar. The native bar belongs to the platform: it brings its own shape,
   * its own type, its own fullscreen control (which leaves the app for a bare
   * element fullscreen instead of opening the viewer) and, when the source cannot
   * be decoded, no statement of what went wrong. The player here is drawn from
   * the app's tokens and the shared seek track, so it reads as part of the
   * application in the conversation and in the fullscreen viewer alike, and a
   * source that fails says so and offers the retry.
   */
  interface Props {
    src: string
    /** The file's name, which names every control here. */
    label: string
    /**
     * Where playback starts, in seconds.
     *
     * The inline player hands over the frame it had reached, so opening the
     * video big resumes the recording instead of restarting it.
     */
    startAt?: number
    /**
     * Opens the file in the fullscreen surface, when the caller has one, at the
     * second the inline player had reached.
     */
    onExpand?: (startAt: number) => void
    /** Reports a source that cannot be played, with the element that failed. */
    onError?: (element: HTMLVideoElement) => void
    /** `fill` takes the whole viewer; `inline` is capped so a message stays readable. */
    fit?: 'inline' | 'fill'
    /** Layout classes from the caller. */
    class?: string
  }

  let {
    src,
    label,
    startAt,
    onExpand,
    onError,
    fit = 'inline',
    class: layout = ''
  }: Props = $props()

  let video = $state<HTMLVideoElement | null>(null)
  let playing = $state(false)
  let started = $state(false)
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
    const element = video
    if (!element || failed) return
    if (element.paused) {
      try {
        await element.play()
        playing = true
      } catch {
        // A refused play is not a silent no-op: the element's own error event
        // (or the next one) draws the failure state below.
        playing = false
      }
      return
    }
    element.pause()
    playing = false
  }

  function toggleMute(): void {
    const element = video
    if (!element) return
    element.muted = !element.muted
    muted = element.muted
  }

  function seekTo(value: number): void {
    const element = video
    if (!element) return
    element.currentTime = value
    currentTime = value
  }

  function retry(): void {
    failed = false
    playing = false
    started = false
    duration = 0
    currentTime = 0
    video?.load()
  }
</script>

<figure
  class={[
    'group/md-video relative min-w-0 max-w-full self-start bg-black',
    fit === 'fill' ? 'flex h-full w-full flex-col' : 'w-full',
    layout
  ]}
>
  <!-- The picture answers a press with play/pause and a double press with the big
       view, which is what every player does; the controls carry the same actions
       for keyboard and for anyone who does not think to press the picture. -->
  <button
    type="button"
    class="relative block min-h-0 w-full cursor-pointer"
    class:h-full={fit === 'fill'}
    aria-label={playing ? `Pause ${label}` : `Play ${label}`}
    title={playing ? `Pause ${label}` : `Play ${label}`}
    onclick={() => void togglePlay()}
    ondblclick={() => onExpand?.(currentTime)}
  >
    <video
      bind:this={video}
      class={['block w-full object-contain', fit === 'fill' ? 'h-full' : 'max-h-96']}
      {src}
      playsinline
      preload="metadata"
      onloadedmetadata={(event) => {
        const element = event.currentTarget
        duration = element.duration
        // A caller that opened this from an inline player hands over the frame it
        // had reached; playback resumes there rather than at the beginning.
        if (startAt && startAt > 0 && startAt < element.duration) {
          element.currentTime = startAt
          currentTime = startAt
        }
      }}
      ondurationchange={(event) => {
        const value = event.currentTarget.duration
        if (Number.isFinite(value)) duration = value
      }}
      ontimeupdate={(event) => {
        if (scrubbing) return
        currentTime = event.currentTarget.currentTime
      }}
      onplay={() => {
        playing = true
        started = true
      }}
      onpause={() => (playing = false)}
      onended={() => {
        playing = false
        currentTime = duration
      }}
      onerror={(event) => {
        failed = true
        playing = false
        const element = event.currentTarget
        if (element instanceof HTMLVideoElement) onError?.(element)
      }}
    >
      <track kind="captions" />
    </video>

    {#if !playing && !failed}
      <!-- A resting picture states the one thing a still frame cannot: that it
           plays. The disc is the app's own mark, not a rounded platform control. -->
      <span
        class="pointer-events-none absolute inset-0 flex items-center justify-center"
        aria-hidden="true"
      >
        <span class="flex size-10 items-center justify-center bg-black/55 text-white shadow-lg">
          <CioPlay size={18} />
        </span>
      </span>
    {/if}
  </button>

  {#if failed}
    <div
      class="flex items-center gap-2 border-t border-border bg-surface px-2 py-1.5"
      role="alert"
    >
      <CioAlertCircle size={12} class="shrink-0 text-danger" aria-hidden="true" />
      <span class="min-w-0 truncate text-[0.75rem] font-medium text-danger">
        This video could not be played
      </span>
      <button
        type="button"
        class="ml-auto shrink-0 px-1.5 py-0.5 text-[0.6875rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
        aria-label="Try playing {label} again"
        title="Try playing {label} again"
        onclick={retry}
      >
        Try again
      </button>
    </div>
  {:else}
    <!-- The control row rides on the picture. It is out of the way while the
         video plays over it, appears on hover or focus, and stays put whenever
         the video is not playing, because that is when the reader is looking
         for a control. -->
    <div
      class={[
        'absolute inset-x-0 bottom-0 flex items-center gap-2 bg-black/70 px-2 py-1.5 transition-opacity duration-150',
        playing && started
          ? 'opacity-0 focus-within:opacity-100 group-hover/md-video:opacity-100'
          : 'opacity-100'
      ]}
      role="group"
      aria-label="{label} playback controls"
    >
      <button
        type="button"
        class="flex size-7 shrink-0 items-center justify-center text-white/85 transition-colors hover:bg-white/10 hover:text-white"
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

      <span class="shrink-0 font-mono text-[0.6875rem] tabular-nums text-white/85">
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

      <span class="shrink-0 font-mono text-[0.6875rem] tabular-nums text-white/70">
        {clock(duration)}
      </span>

      <button
        type="button"
        class="flex size-7 shrink-0 items-center justify-center text-white/85 transition-colors hover:bg-white/10 hover:text-white"
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
          class="flex size-7 shrink-0 items-center justify-center text-white/85 transition-colors hover:bg-white/10 hover:text-white"
          aria-label="Open {label} full screen"
          title="Open {label} full screen"
          onclick={() => onExpand?.(currentTime)}
        >
          <CioMaximize size={13} aria-hidden="true" />
        </button>
      {/if}
    </div>
  {/if}
</figure>
