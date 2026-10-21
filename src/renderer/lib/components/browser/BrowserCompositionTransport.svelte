<script lang="ts">
  import CioBack from '@pdslng/cio-icon/CioBack.svelte'
  import CioForward from '@pdslng/cio-icon/CioForward.svelte'
  import CioMessagePlus from '@pdslng/cio-icon/CioMessagePlus.svelte'
  import CioPause from '@pdslng/cio-icon/CioPause.svelte'
  import CioPencil from '@pdslng/cio-icon/CioPencil.svelte'
  import CioPlay from '@pdslng/cio-icon/CioPlay.svelte'
  import CioRefresh from '@pdslng/cio-icon/CioRefresh.svelte'
  import CioSquare from '@pdslng/cio-icon/CioSquare.svelte'
  import CompositionFrameNote from './CompositionFrameNote.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import type {
    BrowserCompositionPlayback,
    BrowserCompositionTab,
    BrowserTransportCommand,
    CompositionFrameSnapshot
  } from '$shared/ipc-contract'

  interface Props {
    tabId: string
    /** The composition the tab is showing, from `browser:state`. */
    composition: BrowserCompositionTab
    /**
     * Whether the panel is on screen. A hidden panel neither polls the page nor
     * has anyone to show the playhead to, so nothing runs while it is false.
     */
    active: boolean
    /** Board playback must stop when its surface goes away. */
    pauseWhenHidden?: boolean
    /**
     * The conversation a frame note belongs to.
     *
     * A note is a composer reference, so it needs the thread it is written for.
     * The transport drives a tab rather than a conversation, and the board's
     * video panel names both; a tab shown without a conversation has nothing to
     * write a note into, and the two note buttons stay out of the bar.
     */
    projectId?: string
    threadId?: string
  }

  let { tabId, composition, active, pauseWhenHidden = false, projectId, threadId }: Props = $props()

  /** How often the scrubber catches up with the page it is driving. */
  const POLL_MS = 250

  /**
   * The playhead as the page reports it.
   *
   * Null until the first answer, because the app does not assume where a
   * composition starts: it asks the tab that is playing it.
   */
  let playback = $state<BrowserCompositionPlayback | null>(null)
  /** True while the user holds the scrubber, so a poll cannot yank it back. */
  let scrubbing = $state(false)
  let scrubValue = $state(0)
  /** The frame the user asked to write about, once it has been captured. */
  let frameNote = $state<{ snapshot: CompositionFrameSnapshot; armed: boolean } | null>(null)
  /** True while a frame is being drawn and kept, so a click cannot start two. */
  let capturing = $state(false)
  /** Why the last frame capture did not produce a picture. */
  let captureError = $state<string | null>(null)

  /** A composition always runs for something, and a zero-length timeline would
   *  make every fraction below divide by it. */
  const duration = $derived(Math.max(composition.duration, 0.001))
  const frameStep = $derived(1 / Math.max(composition.fps, 1))
  const time = $derived(playback?.time ?? 0)
  const playing = $derived(playback?.playing ?? false)
  const loop = $derived(playback?.loop ?? true)
  const error = $derived(playback?.error ?? null)
  const shown = $derived(Math.min(scrubbing ? scrubValue : time, duration))
  /** A note needs a picture and a conversation, and a composition declares both. */
  const canNote = $derived(Boolean(projectId && threadId))
  /** How much of the track is behind the playhead, for the filled scrubber. */
  const fill = $derived(`${(shown / duration) * 100}%`)

  /** One answer from the page, applied only when it carries a playhead. A null
   *  means the tab is no longer armed, which the next state report settles. */
  function apply(next: BrowserCompositionPlayback | null): void {
    if (!next) return
    playback = next
    if (!scrubbing) scrubValue = next.time
  }

  async function refresh(): Promise<void> {
    try {
      apply(await invoke('browser:transportState', tabId))
    } catch {
      // The tab can be closed while a poll is in flight.
    }
  }

  async function send(
    command: BrowserTransportCommand,
    value: number | boolean = 0
  ): Promise<void> {
    try {
      apply(await invoke('browser:transport', tabId, command, value))
    } catch {
      // The tab can be closed between the click and the command.
    }
  }

  function togglePlay(): void {
    void send('toggle')
  }

  function stop(): void {
    void send('stop')
  }

  function step(direction: 1 | -1): void {
    void send('seek', clamp(time + direction * frameStep))
  }

  function toggleLoop(): void {
    void send('loop', !loop)
  }

  /**
   * Keep the frame on screen and open it for a note.
   *
   * The playhead is stopped before the capture, because the picture has to be the
   * frame the user is looking at: a capture taken while the timeline moves can
   * land on a later frame, and the note would then name a moment it does not show.
   * The second that travels with the picture is the playhead the panel is
   * showing, to the millisecond, so a note about a frame is unambiguous.
   */
  async function noteFrame(armed: boolean): Promise<void> {
    if (!canNote || capturing) return
    capturing = true
    captureError = null
    try {
      await send('pause')
      const snapshot = await invoke('browser:captureCompositionFrame', tabId, shown)
      if (snapshot) frameNote = { snapshot, armed }
      else captureError = 'That frame could not be captured. Try again.'
    } catch {
      // The tab can be closed between the click and the capture.
      captureError = 'That frame could not be captured. Try again.'
    } finally {
      capturing = false
    }
  }

  function commitScrub(): void {
    scrubbing = false
    void send('seek', clamp(scrubValue))
  }

  function clamp(seconds: number): number {
    if (!Number.isFinite(seconds)) return 0
    return Math.min(Math.max(seconds, 0), duration)
  }

  /** Minutes and tenths, which is the resolution a frame step is measured in. */
  function format(seconds: number): string {
    const safe = Math.max(0, seconds)
    const minutes = Math.floor(safe / 60)
    const rest = safe - minutes * 60
    return `${minutes}:${rest.toFixed(1).padStart(4, '0')}`
  }

  // The page owns the clock, so the panel reads it rather than running one of its
  // own. Only the two props the poll depends on are read here, so a state report
  // cannot restart the timer it just fed.
  $effect(() => {
    if (!active) return
    const playbackTabId = tabId
    const pauseOnHide = pauseWhenHidden
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => {
      clearInterval(timer)
      if (pauseOnHide) void invoke('browser:transport', playbackTabId, 'pause', 0).catch(() => {})
    }
  })
</script>

<div
  class="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-surface px-2"
  role="group"
  aria-label={`Playback of ${composition.directory}`}
>
  <button
    type="button"
    class="flex h-7 w-7 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
    aria-label={playing ? 'Pause the composition' : 'Play the composition'}
    title={playing ? 'Pause the composition' : 'Play the composition'}
    onclick={togglePlay}
  >
    {#if playing}
      <CioPause size={14} />
    {:else}
      <CioPlay size={14} />
    {/if}
  </button>
  <button
    type="button"
    class="flex h-7 w-7 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
    aria-label="Stop and return to the start"
    title="Stop and return to the start"
    onclick={stop}
  >
    <CioSquare size={12} />
  </button>
  <button
    type="button"
    class="flex h-7 w-7 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
    aria-label="Step back one frame"
    title={`Step back one frame (${composition.fps} fps)`}
    onclick={() => step(-1)}
  >
    <CioBack size={14} />
  </button>
  <button
    type="button"
    class="flex h-7 w-7 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
    aria-label="Step forward one frame"
    title={`Step forward one frame (${composition.fps} fps)`}
    onclick={() => step(1)}
  >
    <CioForward size={14} />
  </button>
  <span class="shrink-0 tabular-nums text-[0.6875rem] text-dimmed">{format(shown)}</span>
  <input
    class="composition-seek min-w-0 flex-1 cursor-pointer"
    style="--fill:{fill}"
    type="range"
    min="0"
    max={duration}
    step={frameStep}
    value={shown}
    aria-label="Seek the composition"
    title="Seek the composition"
    oninput={(event) => {
      scrubbing = true
      scrubValue = Number(event.currentTarget.value)
    }}
    onchange={commitScrub}
  />
  <span class="shrink-0 tabular-nums text-[0.6875rem] text-dimmed">{format(duration)}</span>
  <button
    type="button"
    class={[
      'flex h-7 w-7 shrink-0 items-center justify-center transition-colors',
      loop ? 'bg-elevated text-foreground' : 'text-dimmed hover:bg-elevated hover:text-foreground'
    ]}
    aria-label={loop ? 'Stop looping at the end' : 'Loop the composition'}
    aria-pressed={loop}
    title={loop ? 'Looping: play again at the end' : 'Play once and hold the last frame'}
    onclick={toggleLoop}
  >
    <CioRefresh size={13} />
  </button>
  <button
    type="button"
    class="flex h-7 w-7 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
    aria-label="Copy this frame as a note"
    title={canNote
      ? 'Open this frame to comment on it'
      : 'Open a frame to comment on it from the video panel'}
    disabled={!canNote || capturing}
    onclick={() => void noteFrame(false)}
  >
    <CioMessagePlus size={13} />
  </button>
  <button
    type="button"
    class="flex h-7 w-7 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
    aria-label="Annotate this frame"
    title={canNote
      ? 'Annotate this frame: circle an area and write why'
      : 'Annotate a frame from the video panel'}
    disabled={!canNote || capturing}
    onclick={() => void noteFrame(true)}
  >
    <CioPencil size={13} />
  </button>
</div>
{#if frameNote}
  <CompositionFrameNote
    projectId={projectId ?? ''}
    threadId={threadId ?? ''}
    snapshot={frameNote.snapshot}
    armed={frameNote.armed}
    onClose={() => (frameNote = null)}
  />
{/if}
{#if captureError}
  <p
    class="shrink-0 border-b border-danger/20 bg-danger/10 px-3 py-1 text-[0.6875rem] text-danger"
    role="alert"
  >
    {captureError}
  </p>
{/if}
{#if error}
  <p
    class="shrink-0 border-b border-danger/20 bg-danger/10 px-3 py-1 text-[0.6875rem] text-danger"
    role="alert"
  >
    A frame stopped playback: {error}
  </p>
{/if}

<style>
  /* The scrubber is the same two-tone track the spoken-audio bar uses, so a
     playhead looks the same wherever the app draws one. */
  .composition-seek {
    appearance: none;
    -webkit-appearance: none;
    height: 4px;
    background: linear-gradient(
      to right,
      var(--color-primary) 0%,
      var(--color-primary) var(--fill, 0%),
      var(--color-border) var(--fill, 0%),
      var(--color-border) 100%
    );
    outline-offset: 3px;
  }
  .composition-seek:focus-visible {
    outline: 2px solid var(--color-info);
  }
  .composition-seek::-webkit-slider-thumb {
    appearance: none;
    -webkit-appearance: none;
    height: 10px;
    width: 10px;
    background: var(--color-primary);
    border: none;
    box-shadow: 0 0 0 1px var(--color-app);
    cursor: pointer;
  }
  .composition-seek::-moz-range-thumb {
    height: 10px;
    width: 10px;
    background: var(--color-primary);
    border: none;
    box-shadow: 0 0 0 1px var(--color-app);
    cursor: pointer;
  }
</style>
