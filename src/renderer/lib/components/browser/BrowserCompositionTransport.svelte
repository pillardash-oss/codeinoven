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
  import ResponseAnnotationComment from '$lib/components/chats/ResponseAnnotationComment.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { responseReferencesState } from '$lib/stores/response-references.svelte'
  import { newVideoNoteId, videoNoteReference } from '$lib/video-note-reference'
  import type { VideoStudioDocument } from '$shared/video/studio'
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
     * The conversation a note belongs to.
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
  /** The moment note whose comment bubble is open, and where it is anchored. */
  let editing = $state<{ id: string; seconds: number } | null>(null)
  let anchor = $state<{ x: number; y: number } | null>(null)
  /** The composition's saved edits, read once per note so its descriptor can
   *  quote the caption and name the controls the moment falls inside. */
  let studio = $state<VideoStudioDocument | null>(null)

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
   * Open the frame on screen as an annotatable picture.
   *
   * The playhead is stopped before the capture, because the picture has to be the
   * frame the user is looking at: a capture taken while the timeline moves can
   * land on a later frame, and the note would then name a moment it does not show.
   * The second that travels with the picture is the playhead the panel is
   * showing, to the millisecond, so a note about a frame is unambiguous.
   */
  async function annotateFrame(): Promise<void> {
    if (!canNote || capturing) return
    capturing = true
    captureError = null
    try {
      await send('pause')
      const snapshot = await invoke('browser:captureCompositionFrame', tabId, shown)
      if (snapshot) frameNote = { snapshot, armed: true }
      else captureError = 'That frame could not be captured. Try again.'
    } catch {
      // The tab can be closed between the click and the capture.
      captureError = 'That frame could not be captured. Try again.'
    } finally {
      capturing = false
    }
  }

  /** The comment the open bubble starts with, read from the note it edits. */
  const momentComment = $derived(
    editing && projectId && threadId
      ? (responseReferencesState
          .forThread(projectId, threadId)
          .find((entry) => entry.id === editing?.id)?.comment ?? '')
      : ''
  )

  /**
   * Write one note on the conversation at a second.
   *
   * The reference is a `PromptReference` like a quoted selection, so it shows in
   * the composer the moment it is stored and travels with the next prompt. Its
   * text is the descriptor the model reads, built from the second the note sits
   * at rather than from the playhead, so a note written here and a note edited a
   * minute later describe the same moment.
   */
  function writeNote(
    project: string,
    thread: string,
    id: string,
    seconds: number,
    comment: string,
    document: VideoStudioDocument | null
  ): void {
    const existing = responseReferencesState.forThread(project, thread)
    const previous = existing.find((candidate) => candidate.id === id)
    const reference = {
      ...videoNoteReference(id, seconds, {
        directory: composition.directory,
        composition,
        document,
        tabId
      }),
      comment
    }
    const merged = previous
      ? existing.map((candidate) => (candidate.id === id ? reference : candidate))
      : [...existing, reference]
    responseReferencesState.setForThread(project, thread, merged)
  }

  /**
   * Comment on the moment the playhead is on, without leaving the panel.
   *
   * This is the note the timeline used to offer, moved to the transport so it is
   * beside the playhead it describes: the note names the second on screen, so the
   * model reads a timecode, a frame and the caption under it rather than a
   * picture, and the full screen pen is left to the notes that do want one.
   */
  async function commentOnMoment(button: HTMLElement): Promise<void> {
    const project = projectId
    const thread = threadId
    if (!project || !thread) return
    const seconds = shown
    try {
      studio = (await invoke('video:studio', project, composition.directory)).document
    } catch {
      // A composition whose document cannot be read still gets its note: the
      // timecode, the frame and the rate are the parts that place it.
      studio = null
    }
    const id = newVideoNoteId()
    writeNote(project, thread, id, seconds, '', studio)
    const rect = button.getBoundingClientRect()
    anchor = { x: rect.left + rect.width / 2, y: rect.bottom }
    editing = { id, seconds }
  }

  /** Close the bubble, dropping a note the user left without a comment. */
  function closeEditor(): void {
    const current = editing
    editing = null
    anchor = null
    if (!current || !projectId || !threadId) return
    const note = responseReferencesState
      .forThread(projectId, threadId)
      .find((entry) => entry.id === current.id)
    if (note && (note.comment ?? '').trim() === '') removeNote(current.id)
  }

  function saveComment(id: string, comment: string): void {
    if (!projectId || !threadId) return
    writeNote(projectId, threadId, id, editing?.seconds ?? shown, comment, studio)
    editing = null
    anchor = null
  }

  function draftComment(id: string, comment: string): void {
    if (!projectId || !threadId) return
    responseReferencesState.updateCommentDraft(projectId, threadId, id, comment)
  }

  function removeNote(id: string): void {
    if (!projectId || !threadId) return
    responseReferencesState.setForThread(
      projectId,
      threadId,
      responseReferencesState.forThread(projectId, threadId).filter((entry) => entry.id !== id)
    )
    if (editing?.id === id) {
      editing = null
      anchor = null
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
    aria-label="Comment on the moment the playhead is on"
    title={canNote
      ? 'Comment on the moment the playhead is on'
      : 'Comment on a moment from the video panel'}
    disabled={!canNote}
    onclick={(event) => void commentOnMoment(event.currentTarget)}
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
    onclick={() => void annotateFrame()}
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
{#if editing && anchor && projectId && threadId}
  <!--
    A moment is commented on the way every other annotation is: the one comment
    bubble the app draws, anchored to the control the user pressed. It is a fixed
    overlay, so it takes no space in the bar and the transport stays one row.
  -->
  <ResponseAnnotationComment
    x={anchor.x}
    y={anchor.y}
    title="Comment on this moment"
    dragHandleTitle="Move moment comment"
    closeLabel="Close moment comment"
    removeTitle="Remove this note and its comment"
    initialComment={momentComment}
    targetId={`video-note-comment-${threadId}-${editing.id}`}
    scope={{ kind: 'project', projectId }}
    onDraftChange={(comment) => draftComment(editing?.id ?? '', comment)}
    onDone={(comment) => saveComment(editing?.id ?? '', comment)}
    onRemove={() => removeNote(editing?.id ?? '')}
    onClose={closeEditor}
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
