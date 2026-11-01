<script lang="ts">
  import CioAlertCircle from '@pdslng/cio-icon/CioAlertCircle.svelte'
  import CioMaximize from '@pdslng/cio-icon/CioMaximize.svelte'
  import CioPause from '@pdslng/cio-icon/CioPause.svelte'
  import CioPlay from '@pdslng/cio-icon/CioPlay.svelte'
  import CioSkipBack from '@pdslng/cio-icon/CioSkipBack.svelte'
  import CioSkipForward from '@pdslng/cio-icon/CioSkipForward.svelte'
  import CioVolume from '@pdslng/cio-icon/CioVolume.svelte'
  import CioVolumeX from '@pdslng/cio-icon/CioVolumeX.svelte'
  import type { Snippet } from 'svelte'
  import SeekBar from './SeekBar.svelte'
  import { SvelteMap } from 'svelte/reactivity'
  import { preloadNearViewport } from './preload-near-viewport'

  /**
   * The shape of a picture this session has already measured, keyed by source.
   *
   * A video's own dimensions only arrive with its metadata, and until then the
   * element falls back to the browser's 300x150 box. Measured in the running app
   * while scrolling a long conversation, that fallback is what makes reaching a
   * recording feel like a stumble: the box grew from 150px to 360px at the
   * moment metadata landed, and the document shifted under the reader (three
   * layout shifts, 0.07 and 0.06 of the viewport, in the same frame). Reserving
   * the box at the ratio we already know keeps that frame still, and remembering
   * the ratio means the second visit to a video never has to guess.
   */
  const measuredRatios = new SvelteMap<string, number>()
  /** What an unmeasured video reserves: the shape nearly every recording has. */
  const FALLBACK_RATIO = 16 / 9

  /** The part of a painted-frame report this player reads. */
  interface PaintedFrame {
    /** The media time of the frame just presented, in seconds. */
    mediaTime: number
  }

  /** One square, icon-only control on the transport row. */
  const CONTROL_BUTTON =
    'flex size-7 shrink-0 items-center justify-center text-white/85 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-default disabled:text-white/35 disabled:hover:bg-transparent'

  /** The frame rates a recording is almost certainly one of. */
  const FRAME_RATES = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60]

  /**
   * The frame interval a measured one is within a percent of, or the measurement.
   *
   * The gap between two painted frames is what a callback measures, and it
   * jitters by a millisecond or two. Snapping it to the rate it is that close to
   * keeps stepping on the recording's own grid instead of drifting off it.
   */
  function snapFrameRate(measured: number): number {
    let best = measured
    let error = measured * 0.02
    for (const fps of FRAME_RATES) {
      const interval = 1 / fps
      const distance = Math.abs(interval - measured)
      if (distance < error) {
        error = distance
        best = interval
      }
    }
    return best
  }

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
     * Opens the file in the fullscreen surface, when the caller has one.
     *
     * It hands over the second the inline player had reached and whether it was
     * running at that moment. The picture in the conversation stays mounted behind
     * the fullscreen surface   the conversation is not unmounted while a viewer is
     * open   so a player that kept running here would play on, and its sound would
     * keep coming from a player nobody can see while the one on screen sat paused.
     * Reporting the state is what lets the surface that takes over continue the
     * recording instead of starting it again.
     */
    onExpand?: (startAt: number, playing: boolean) => void
    /**
     * Whether the picture starts running as soon as it has metadata.
     *
     * The fullscreen viewer adopts a recording that was already playing, so it
     * picks up both the frame and the fact that the user was watching it move.
     */
    autoPlay?: boolean
    /** Reports a source that cannot be played, with the element that failed. */
    onError?: (element: HTMLVideoElement) => void
    /** `fill` takes the whole viewer; `inline` is capped so a message stays readable. */
    fit?: 'inline' | 'fill'
    /**
     * Drawn over the picture, for a surface that answers the video rather than
     * only watching it: the artifact video's mark layer lands here.
     */
    overlay?: Snippet
    /**
     * Whether pressing the picture plays it.
     *
     * Off when an overlay owns the pointer, because a surface that draws on the
     * picture cannot also treat every press as play, and a mark layer inside a
     * play button is neither valid markup nor a working gesture.
     */
    interactive?: boolean
    /** The media element, so a caller can drive it (pause, seek) of its own accord. */
    onElement?: (element: HTMLVideoElement) => void
    /** The playhead, in seconds, on every update. */
    onTime?: (seconds: number) => void
    /** Metadata arrived: duration and intrinsic picture size are known. */
    onMetadata?: (element: HTMLVideoElement) => void
    /**
     * Whether the picture carries the centred play/pause mark.
     *
     * It is the player's own statement that this is a picture that plays, and it
     * is drawn in the conversation and in the viewer alike. A surface that has
     * armed a pen over the picture turns it off while the pen is in hand.
     */
    showCenterControl?: boolean
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
    overlay,
    interactive = true,
    onElement,
    onTime,
    onMetadata,
    showCenterControl = true,
    autoPlay = false,
    class: layout = ''
  }: Props = $props()

  let video = $state<HTMLVideoElement | null>(null)
  /** Intrinsic width/height, as soon as this element's metadata reports it. */
  let measuredRatio = $state<number | null>(null)
  let playing = $state(false)
  let started = $state(false)
  let muted = $state(false)
  let currentTime = $state(0)
  let duration = $state(0)
  let failed = $state(false)
  let scrubbing = $state(false)
  let scrubValue = $state(0)
  /**
   * How long one frame of this recording lasts, in seconds.
   *
   * Media metadata carries no frame rate, so it starts at the rate nearly every
   * recording uses and is corrected from the frames the element reports painting
   * while it plays. It is the grid both a single step and the track's arrow keys
   * land on.
   */
  let frameDuration = $state(1 / 30)
  /** The newest frame the element reported painting, in seconds. */
  let paintedAt = -1

  /** The box the picture reserves, so metadata can land without moving it. */
  const ratio = $derived(measuredRatio ?? measuredRatios.get(src) ?? FALLBACK_RATIO)

  /** `m:ss.cc`: hundredths, so moving one frame is visible in the readout. */
  function timecode(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00.00'
    const hundredths = Math.round(seconds * 100)
    const hours = Math.floor(hundredths / 360_000)
    const minutes = Math.floor((hundredths % 360_000) / 6000)
    const tail = ((hundredths % 6000) / 100).toFixed(2).padStart(5, '0')
    return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${tail}` : `${minutes}:${tail}`
  }

  /** `m:ss`, or `h:mm:ss` once a recording runs past an hour. */
  function clock(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
    const total = Math.floor(seconds)
    const hours = Math.floor(total / 3600)
    const minutes = Math.floor((total % 3600) / 60)
    const rest = total % 60
    const padded = String(rest).padStart(2, '0')
    return hours > 0
      ? `${hours}:${String(minutes).padStart(2, '0')}:${padded}`
      : `${minutes}:${padded}`
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

  /** The newest position a scrub has asked for, while a seek is still resolving. */
  let previewTarget: number | null = null
  let seekInFlight = false
  let seekTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * Move the picture while the thumb is still down.
   *
   * A range input reports every position the pointer crosses, and assigning each
   * of them to `currentTime` while the previous one is still resolving makes the
   * decoder drop its work and start again: measured in the app's browser against
   * a 30fps recording, a drag across two seconds presented three frames that way,
   * so the picture sat still and jumped only when the pointer was released. One
   * seek at a time, each one taking the newest position reached, presented 31
   * frames for that same gesture, which is what makes a still frame reachable
   * without ever pressing play.
   */
  function previewSeek(value: number): void {
    scrubValue = value
    if (duration === 0) return
    previewTarget = value
    pumpPreview()
  }

  function pumpPreview(): void {
    if (seekInFlight || previewTarget === null) return
    const element = video
    if (!element) return
    const next = previewTarget
    previewTarget = null
    startSeek()
    element.currentTime = next
  }

  /**
   * Mark a seek as running, and release it if the element never reports it.
   *
   * A read that stalls never fires `seeked`, and a flag stuck on would end the
   * scrub there, so the bound is what keeps the newest position still applied.
   */
  function startSeek(): void {
    seekInFlight = true
    clearTimeout(seekTimer)
    seekTimer = setTimeout(() => {
      seekInFlight = false
      pumpPreview()
    }, 1_000)
  }

  /** The element finished the seek it was given: ask it for the next position. */
  function settleSeek(): void {
    seekInFlight = false
    clearTimeout(seekTimer)
    pumpPreview()
  }

  function seekTo(value: number): void {
    previewTarget = null
    const element = video
    if (!element) return
    startSeek()
    element.currentTime = value
    currentTime = value
  }

  /**
   * Land on the frame beside the one on screen, still.
   *
   * Stepping stops the recording first, because the point of the gesture is to
   * study a still. The element reports the newest frame it painted, and a forward
   * step that would land inside that same frame is pushed a hair past it: seeking
   * from a still that the decoder has already presented is otherwise the press
   * that appears to do nothing.
   */
  function stepFrame(direction: 1 | -1): void {
    const element = video
    if (!element || !Number.isFinite(element.duration) || element.duration <= 0) return
    if (!element.paused) {
      element.pause()
      playing = false
    }
    started = true
    const step = frameDuration
    let next = element.currentTime + direction * step
    if (direction > 0 && paintedAt >= 0 && next <= paintedAt + step / 2) next = paintedAt + step
    const last = Math.max(0, element.duration - step / 2)
    seekTo(Math.min(last, Math.max(0, next)))
  }

  // The element reports every frame it paints, which is the only place a
  // recording's frame rate can be read: a step that lands on exactly one frame,
  // and a track whose arrow keys move that same frame, both need it.
  $effect(() => {
    const element = video
    if (!element) return
    let handle = 0
    let stopped = false
    let previous = -1
    const observe = (_now: number, metadata: PaintedFrame): void => {
      if (stopped) return
      paintedAt = metadata.mediaTime
      if (previous >= 0 && !element.paused) {
        const gap = metadata.mediaTime - previous
        if (gap > 0.008 && gap < 0.06) {
          const measured = snapFrameRate(gap)
          if (Math.abs(measured - frameDuration) > 1e-4) frameDuration = measured
        }
      }
      previous = metadata.mediaTime
      handle = element.requestVideoFrameCallback(observe)
    }
    handle = element.requestVideoFrameCallback(observe)
    return () => {
      stopped = true
      if (handle !== 0) element.cancelVideoFrameCallback(handle)
    }
  })

  function retry(): void {
    failed = false
    playing = false
    started = false
    duration = 0
    currentTime = 0
    video?.load()
  }

  /**
   * Hand this picture over to the surface that is taking it.
   *
   * The element is stopped first, because the two players are mounted at once for
   * as long as the fullscreen surface is open: leaving this one running would play
   * the recording twice, once silently behind the viewer. Its frame and whether it
   * was running travel with the hand-off, so the viewer continues the recording
   * rather than restarting it at a still.
   */
  function handOver(): void {
    if (!onExpand) return
    const element = video
    const seconds = element ? element.currentTime : currentTime
    const wasPlaying = element !== null && !element.paused && !element.ended && !failed
    element?.pause()
    playing = false
    onExpand(seconds, wasPlaying)
  }
</script>

{#snippet picture()}
  <!-- The picture fetches its metadata when it comes into view rather than when
       the message mounts (see `preload-near-viewport`), and it is drawn inside a
       box reserved at its own shape, so the frame that measures it does not also
       move the document under the reader. -->
  <div
    class={['relative w-full overflow-hidden bg-black', fit === 'fill' ? 'h-full' : 'max-h-96']}
    style={fit === 'fill' ? undefined : `aspect-ratio: ${ratio}`}
  >
    <video
      bind:this={video}
      class="block size-full object-contain"
      {src}
      playsinline
      preload="none"
      use:preloadNearViewport
      onloadedmetadata={(event) => {
        const element = event.currentTarget
        onElement?.(element)
        onMetadata?.(element)
        if (element.videoWidth > 0 && element.videoHeight > 0) {
          measuredRatio = element.videoWidth / element.videoHeight
          measuredRatios.set(src, measuredRatio)
        }
        duration = element.duration
        // A caller that opened this from an inline player hands over the frame it
        // had reached; playback resumes there rather than at the beginning.
        if (startAt && startAt > 0 && startAt < element.duration) {
          element.currentTime = startAt
          currentTime = startAt
        }
        if (autoPlay) void element.play().catch(() => {})
      }}
      ondurationchange={(event) => {
        const value = event.currentTarget.duration
        if (Number.isFinite(value)) duration = value
      }}
      ontimeupdate={(event) => {
        if (scrubbing) return
        currentTime = event.currentTarget.currentTime
        onTime?.(currentTime)
      }}
      onseeked={(event) => {
        settleSeek()
        if (scrubbing) return
        currentTime = event.currentTarget.currentTime
        onTime?.(currentTime)
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
        seekInFlight = false
        clearTimeout(seekTimer)
        failed = true
        playing = false
        const element = event.currentTarget
        if (element instanceof HTMLVideoElement) onError?.(element)
      }}
    >
      <track kind="captions" />
    </video>
  </div>

  {#if overlay}
    {@render overlay()}
  {/if}

  {#if showCenterControl && !failed}
    <!-- The centre of the picture states the one thing a still frame cannot: that
         it plays. It is a play mark at rest, a pause mark while the picture runs
         and the pointer is over it, and it is drawn wherever the player is drawn:
         the conversation and the fullscreen viewer behave the same way. A picture
         whose pointer belongs to an overlay (the artifact mark layer) gets a real
         button here instead, so a press in the middle still plays it. -->
    {#if interactive}
      <span
        class={[
          'pointer-events-none absolute inset-0 flex items-center justify-center transition-opacity duration-150',
          playing ? 'opacity-0 group-hover/md-video:opacity-100' : 'opacity-100'
        ]}
        aria-hidden="true"
      >
        <span class="flex size-11 items-center justify-center bg-black/55 text-white shadow-lg">
          {#if playing}
            <CioPause size={18} />
          {:else}
            <CioPlay size={18} />
          {/if}
        </span>
      </span>
    {:else}
      <button
        type="button"
        class={[
          'absolute inset-0 flex items-center justify-center transition-opacity duration-150',
          playing
            ? 'opacity-0 focus-visible:opacity-100 group-hover/md-video:opacity-100'
            : 'opacity-100'
        ]}
        aria-label={playing ? `Pause ${label}` : `Play ${label}`}
        title={playing ? `Pause ${label}` : `Play ${label}`}
        onclick={() => void togglePlay()}
      >
        <span class="flex size-11 items-center justify-center bg-black/55 text-white shadow-lg">
          {#if playing}
            <CioPause size={18} />
          {:else}
            <CioPlay size={18} />
          {/if}
        </span>
      </button>
    {/if}
  {/if}
{/snippet}

<figure
  class={[
    'group/md-video relative min-w-0 max-w-full self-start bg-black',
    fit === 'fill' ? 'flex h-full w-full flex-col' : 'w-full',
    layout
  ]}
>
  <!-- The picture answers a press with play/pause and a double press with the big
       view, which is what every player does; the controls carry the same actions
       for keyboard and for anyone who does not think to press the picture. A
       surface with an overlay draws on the picture instead of playing it, so the
       picture is a plain box there and the overlay owns the pointer. -->
  {#if interactive}
    <button
      type="button"
      class="relative block min-h-0 w-full cursor-pointer"
      class:h-full={fit === 'fill'}
      aria-label={playing ? `Pause ${label}` : `Play ${label}`}
      title={playing ? `Pause ${label}` : `Play ${label}`}
      onclick={() => void togglePlay()}
      ondblclick={handOver}
    >
      {@render picture()}
    </button>
  {:else}
    <div class="relative block min-h-0 w-full" class:h-full={fit === 'fill'}>
      {@render picture()}
    </div>
  {/if}

  {#if failed}
    <div class="flex items-center gap-2 border-t border-border bg-surface px-2 py-1.5" role="alert">
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
        class={CONTROL_BUTTON}
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

      <!-- One frame at a time, in both directions: the recording can be studied
           still, without playing it, which is what a scrub track alone does not
           give. -->
      <button
        type="button"
        class={CONTROL_BUTTON}
        disabled={duration === 0}
        aria-label="Previous frame of {label}"
        title="Previous frame of {label}"
        onclick={() => stepFrame(-1)}
      >
        <CioSkipBack size={13} aria-hidden="true" />
      </button>

      <button
        type="button"
        class={CONTROL_BUTTON}
        disabled={duration === 0}
        aria-label="Next frame of {label}"
        title="Next frame of {label}"
        onclick={() => stepFrame(1)}
      >
        <CioSkipForward size={13} aria-hidden="true" />
      </button>

      <span class="shrink-0 font-mono text-[0.6875rem] tabular-nums text-white/85">
        {timecode(scrubbing ? scrubValue : currentTime)}
      </span>

      <SeekBar
        class="block min-w-0 flex-1"
        value={scrubbing ? scrubValue : currentTime}
        min={0}
        max={Math.max(duration, 0.1)}
        step={frameDuration}
        label="Seek {label}"
        disabled={duration === 0}
        onScrubStart={(value) => {
          scrubbing = true
          scrubValue = value
        }}
        onScrubEnd={() => {
          scrubbing = false
        }}
        onInput={previewSeek}
        onCommit={() => {
          // The release is the one signal a missed pointerup cannot swallow:
          // settling here is what returns the readout to the element's own clock.
          scrubbing = false
          seekTo(scrubValue)
        }}
      />

      <span class="shrink-0 font-mono text-[0.6875rem] tabular-nums text-white/70">
        {clock(duration)}
      </span>

      <button
        type="button"
        class={CONTROL_BUTTON}
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
          class={CONTROL_BUTTON}
          aria-label="Open {label} full screen"
          title="Open {label} full screen"
          onclick={handOver}
        >
          <CioMaximize size={13} aria-hidden="true" />
        </button>
      {/if}
    </div>
  {/if}
</figure>
