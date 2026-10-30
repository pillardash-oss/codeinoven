<script lang="ts">
  import CioBack from '@pdslng/cio-icon/CioBack.svelte'
  import CioForward from '@pdslng/cio-icon/CioForward.svelte'
  import CioMessagePlus from '@pdslng/cio-icon/CioMessagePlus.svelte'
  import CioPause from '@pdslng/cio-icon/CioPause.svelte'
  import CioPencil from '@pdslng/cio-icon/CioPencil.svelte'
  import CioPlay from '@pdslng/cio-icon/CioPlay.svelte'
  import CioRefresh from '@pdslng/cio-icon/CioRefresh.svelte'
  import CioVolume from '@pdslng/cio-icon/CioVolume.svelte'
  import CioVolumeX from '@pdslng/cio-icon/CioVolumeX.svelte'
  import CioSquare from '@pdslng/cio-icon/CioSquare.svelte'
  import CompositionFrameAnnotator from './CompositionFrameAnnotator.svelte'
  import DesignElementCommentPopover from './DesignElementCommentPopover.svelte'
  import SeekBar from '$lib/components/ui/SeekBar.svelte'
  import { setAnnotationToolbarHost } from '$lib/annotation-toolbar'
  import { MARK_FRAME_TOLERANCE_SECONDS } from '$lib/annotation-marks'
  import { openAnnotationChat, videoMomentChatContext } from '$lib/annotation-chat'
  import { invoke } from '$lib/ipc.svelte'
  import { compositionPlayheadFor } from '$lib/stores/composition-playhead.svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { browserVisibility } from '$lib/stores/browser-visibility.svelte'
  import { compositionPlaybackPrefs } from '$lib/stores/composition-playback-prefs.svelte'
  import { snapVideoFrame } from '$shared/video/frame-grid'
  import { videoClockLabel, videoTimecode } from '$shared/video/timeline'
  import {
    compositionFrameFocusState,
    type CompositionFrameFocusRequest
  } from '$lib/stores/composition-frame-focus.svelte'
  import {
    responseReferencesState,
    type ResponseReferenceAnchor
  } from '$lib/stores/response-references.svelte'
  import { newVideoNoteId, videoNoteReference } from '$lib/video-note-reference'
  import type { VideoStudioDocument } from '$shared/video/studio'
  import type {
    BrowserCompositionTab,
    BrowserInspectorRect,
    BrowserViewBounds,
    CompositionFrameSnapshot
  } from '$shared/ipc-contract'

  interface Props {
    tabId: string
    titlebar?: boolean
    /** Short clock labels and tighter spacing for sidebar playback. */
    compact?: boolean
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

  let {
    tabId,
    composition,
    active,
    pauseWhenHidden = false,
    projectId,
    threadId,
    titlebar = false,
    compact = false
  }: Props = $props()

  /**
   * How long the bar keeps the second a scrub settled on.
   *
   * The page is asked for that frame and answers within a round trip, but the bar
   * is what the user let go of, so it holds their second for a moment instead of
   * snapping back to where the playhead was. The timer is also what releases it:
   * a composition that never answers must not leave the bar on a second the
   * picture is not on.
   */
  const SCRUB_SETTLE_MS = 400

  // The tab's identity is this bar's identity, so the bar reads the one playhead
  // every other surface of the same tab reads: the picture, the timeline and this
  // row cannot show different seconds, because they show the same answer.
  // svelte-ignore state_referenced_locally
  const playhead = compositionPlayheadFor(tabId)
  /** The page's answer. Null until the first one, because where a composition
   *  starts is the page's to say rather than the app's to assume. */
  const playback = $derived(playhead.playback)
  /** True while the user holds the scrubber, so the bar shows their second. */
  let scrubbing = $state(false)
  let scrubValue = $state(0)
  let scrubRelease: ReturnType<typeof setTimeout> | undefined
  /** Mute follows the native tab across sidebar and fullscreen surfaces. */
  const muted = $derived(contextSidebarState.browserRuntime(tabId).muted)
  let muteBusy = $state(false)
  async function toggleMuted(): Promise<void> {
    if (muteBusy) return
    muteBusy = true
    try {
      const next = !muted
      await invoke('browser:setMuted', tabId, next)
    } finally {
      muteBusy = false
    }
  }
  let loopSyncing = false
  /** The looping answer the page gave last, so one arming is reconciled once. */
  let observedLoop: boolean | null = null
  /** The frame the user asked to write about, once it has been captured. */
  let frameNote = $state<{
    snapshot: CompositionFrameSnapshot
    /** The mark the surface was opened on, when a composer jump opened it. */
    editingId?: string | null
  } | null>(null)
  /**
   * The pane the still stands in for, taken when the pen takes over.
   *
   * The page is a native view over this pane, and the composition surface is what
   * publishes its rectangle; this copy is the floor for the rare frame where that
   * publication has gone away with the page it belonged to.
   */
  let annotationBounds = $state<BrowserViewBounds | null>(null)
  /** The occlusion this surface publishes while the still covers the page. */
  const annotationOcclusionKey = $derived(`composition-annotation-${tabId}`)
  /**
   * Where the pen's own controls are mounted while a frame is being annotated.
   *
   * The mark layer draws the pen and its colour as one toolbar, and it mounts them
   * here: annotating changes the pen control that started it into the palette and
   * the finish mark, instead of adding a strip over the picture naming a moment the
   * user can already see.
   */
  let annotationToolbar = $state<HTMLDivElement>()
  setAnnotationToolbarHost({ target: () => annotationToolbar })
  /**
   * Whether the page has really settled on paused since the pen took over.
   *
   * The playhead reaches this panel by poll, so the first answer after an
   * annotation starts can still report the run that preceded it. Watching for a
   * resume, and for a playhead that disagrees with the still, only once a paused
   * answer has landed is what keeps that stale answer from closing the surface the
   * user just opened.
   */
  let annotationSettled = $state(false)
  /** True while a frame is being drawn and kept, so a click cannot start two. */
  let capturing = $state(false)
  /** Why the last frame capture did not produce a picture. */
  let captureError = $state<string | null>(null)
  /** The moment note whose comment bubble is open, and where it is anchored. */
  let editing = $state<{ id: string; seconds: number } | null>(null)
  let anchor = $state<BrowserInspectorRect | null>(null)
  /** The composition's saved edits, read once per note so its descriptor can
   *  quote the caption and name the controls the moment falls inside. */
  let studio = $state<VideoStudioDocument | null>(null)

  /** A composition always runs for something, and a zero-length timeline would
   *  make every fraction below divide by it. */
  const duration = $derived(Math.max(playback?.duration ?? composition.duration, 0.001))
  const frameStep = $derived(1 / Math.max(composition.fps, 1))
  const time = $derived(playback?.time ?? 0)
  const playing = $derived(playback?.playing ?? false)
  /**
   * Whether this composition repeats at the end.
   *
   * The page answers while it is armed, and the user's own preference stands in
   * until it does: a new tab starts from what the reader chose on the last video
   * rather than from the default the page boots with.
   */
  const loop = $derived(playback?.loop ?? compositionPlaybackPrefs.loopFor(tabId))
  const error = $derived(playback?.error ?? null)
  const shown = $derived(Math.min(scrubbing ? scrubValue : time, duration))
  /** A note needs a picture and a conversation, and a composition declares both. */
  const canNote = $derived(Boolean(projectId && threadId))

  /**
   * Bring a freshly armed page onto the user's looping preference.
   *
   * A reload, or a preview switched to another composition, installs a new
   * transport that starts with its own default. An answer from the page is what
   * notices, so the preference is restored where the state is read, before the end
   * of a film the user asked to play once. The handover happens once per answer the
   * page gives, because a page that keeps reporting the default must not be
   * re-commanded on every tick.
   */
  $effect(() => {
    const next = playback
    if (!next || next.loop === observedLoop) return
    observedLoop = next.loop
    const wanted = compositionPlaybackPrefs.loopFor(tabId)
    if (loopSyncing || next.loop === wanted) return
    loopSyncing = true
    void playhead.command('loop', wanted).finally(() => {
      loopSyncing = false
    })
  })

  /**
   * Take a request that names a mark to reopen.
   *
   * The request arrives before this surface exists, because the click that makes
   * it also opens the board that draws this composition. Reading it here, rather
   * than through the board's props, is what lets whichever transport mounts next
   * act on it.
   */
  $effect(() => {
    if (!projectId || !threadId) return
    const request = compositionFrameFocusState.pending(projectId, threadId, composition.directory)
    if (!request) return
    compositionFrameFocusState.consume(request.token)
    void reopenFrame(request)
  })

  function togglePlay(): void {
    void playhead.command('toggle')
  }

  function stop(): void {
    void playhead.command('stop')
  }

  function step(direction: 1 | -1): void {
    playhead.hold(clamp(shown + direction * frameStep))
  }

  function toggleLoop(): void {
    const next = !loop
    compositionPlaybackPrefs.setLoop(tabId, next)
    void playhead.command('loop', next)
  }

  /**
   * Open the frame on screen as an annotatable picture.
   *
   * The playhead is stopped before the capture, because the picture has to be the
   * frame the user is looking at: a capture taken while the timeline moves can
   * land on a later frame, and the note would then name a moment it does not show.
   * The second that travels with the picture is the playhead the panel is showing,
   * to the millisecond, so a note about a frame is unambiguous.
   *
   * Nothing is opened over the editor: the captured frame is drawn into the pane
   * the composition was playing in, which is where the user was already looking.
   */
  async function annotateFrame(): Promise<void> {
    if (!canNote || capturing || frameNote) return
    capturing = true
    captureError = null
    try {
      await playhead.command('pause')
      const snapshot = await invoke('browser:captureCompositionFrame', tabId, shown)
      if (snapshot) openAnnotation({ snapshot })
      else captureError = 'This composition is no longer open. Reopen it before annotating.'
    } catch (cause: unknown) {
      captureError = cause instanceof Error ? cause.message : 'The frame could not be captured.'
    } finally {
      capturing = false
    }
  }

  /**
   * Put the captured frame in front of the user, ready to be drawn on.
   *
   * The pane's rectangle is read here rather than only from the published frame,
   * because the page is about to step aside and its own publication follows it:
   * the still has to land on the rectangle the user was watching, not on a pane
   * measured after the page went away.
   */
  function openAnnotation(opened: {
    snapshot: CompositionFrameSnapshot
    editingId?: string | null
  }): void {
    annotationBounds = browserVisibility.pageBoundsFor(tabId)
    annotationSettled = false
    frameNote = {
      snapshot: opened.snapshot,
      ...(opened.editingId !== undefined ? { editingId: opened.editingId } : {})
    }
  }

  /**
   * Hand the pane back to the composition page.
   *
   * Resuming is the caller's choice: finishing an annotation with Escape leaves the
   * picture held where the user stopped, while the continue key lets it run, so the
   * next moment can be marked without reopening anything.
   */
  function closeAnnotation(resume = false): void {
    if (!frameNote) return
    frameNote = null
    annotationBounds = null
    if (resume) void playhead.command('play')
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
      studio = (await invoke('video:studio', project, threadId, composition.directory)).document
    } catch {
      // A composition whose document cannot be read still gets its note: the
      // timecode, the frame and the rate are the parts that place it.
      studio = null
    }
    const id = newVideoNoteId()
    writeNote(project, thread, id, seconds, '', studio)
    anchor = button.getBoundingClientRect()
    editing = { id, seconds }
  }

  /**
   * The marks drawn on one moment of this composition.
   *
   * A capture writes a new picture at a new path each time it is opened, so a
   * mark cannot be found by its URL alone: the moment and the folder are what
   * say which frame it was drawn on, and the layer then draws it on whichever
   * capture of that second is in front of the reader.
   *
   * Read from the store every time the surface needs it, because a mark the user
   * draws is written to the store and nowhere else: a list captured when the
   * surface opened would keep showing the reader an empty frame they had already
   * drawn on.
   */
  function marksAt(seconds: number): ResponseReferenceAnchor[] {
    if (!projectId || !threadId) return []
    return responseReferencesState
      .forThread(projectId, threadId)
      .filter(
        (entry) =>
          entry.kind === 'image' &&
          entry.directory === composition.directory &&
          entry.markSeconds !== undefined &&
          Math.abs(entry.markSeconds - seconds) <= MARK_FRAME_TOLERANCE_SECONDS
      )
  }

  /**
   * Reopen the frame a mark was drawn on and open that mark's comment.
   *
   * The composer lists a mark with an edit action, and the mark is drawn on a
   * captured picture rather than on a part of the conversation, so the jump has
   * to produce that picture again: the playhead stops on the mark's second, main
   * draws and keeps it, and the surface opens with the comment already editing.
   */
  async function reopenFrame(request: CompositionFrameFocusRequest): Promise<void> {
    if (!canNote || capturing) return
    // The transport's own playhead moves to the frame the mark was drawn on, so the
    // picture, the row below it and the comment all name one moment.
    playhead.hold(request.seconds)
    capturing = true
    captureError = null
    try {
      const snapshot = await invoke('browser:captureCompositionFrame', tabId, request.seconds)
      if (!snapshot) {
        captureError = 'That frame could not be captured. Try again.'
        return
      }
      frameNote = {
        snapshot,
        editingId: request.referenceId
      }
      annotationBounds = browserVisibility.pageBoundsFor(tabId)
      annotationSettled = false
    } catch {
      // The tab can be closed between the click and the capture.
      captureError = 'That frame could not be captured. Try again.'
    } finally {
      capturing = false
    }
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

  /**
   * Ask about the moment whose comment is open, before writing the comment.
   *
   * The one comment bubble carries the read-only chat pair every annotation
   * offers, so the user can question a moment before committing to a note. The
   * note's own descriptor is the selection, and the composition folder it was
   * noted in is the context the answer is read from; the bubble then closes the
   * way its Cancel does.
   */
  function openMomentChat(mode: 'elaborate' | 'quick'): void {
    const current = editing
    const project = projectId
    const thread = threadId
    if (!current || !project || !thread) return
    const note = responseReferencesState
      .forThread(project, thread)
      .find((entry) => entry.id === current.id)
    if (!note) return
    openAnnotationChat({
      projectId: project,
      threadId: thread,
      mode,
      selection: note.text,
      context: videoMomentChatContext(note.directory ?? composition.directory)
    })
    closeEditor()
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

  /** Hold the picture on one second, because a scrub is still moving. */
  function holdSecond(seconds: number): void {
    scrubValue = clamp(seconds)
    scrubbing = true
    playhead.hold(scrubValue)
  }

  /**
   * Settle the second the user released.
   *
   * The bar keeps their second until the page answers with it, and this timer is
   * what lets it go either way. Nothing else has to hold that frame: the page owns
   * it, and the answer it gives is what every surface of this tab shows next.
   */
  function commitScrub(): void {
    holdSecond(scrubValue)
    clearTimeout(scrubRelease)
    scrubRelease = setTimeout(() => {
      scrubbing = false
    }, SCRUB_SETTLE_MS)
  }

  // The page is a native view painted above every DOM node, so the still that
  // takes its place is only visible once the view steps aside. The overlay rect
  // is what tells every surface displaying this tab to park it, and releasing it
  // is what brings the page back on the very next placement.
  $effect(() => {
    if (!frameNote) return
    const rect = browserVisibility.pageBoundsFor(tabId) ?? annotationBounds
    if (!rect) return
    browserVisibility.publishOcclusion(annotationOcclusionKey, rect)
    return () => browserVisibility.clearOcclusion(annotationOcclusionKey)
  })

  // Annotating is a paused activity. Playback resuming from anywhere (the
  // continue key, the play button, a keyboard action the editor owns) means the
  // user is done with this frame, so the page takes its pane back rather than
  // playing on behind a still picture.
  $effect(() => {
    if (!frameNote) {
      annotationSettled = false
      return
    }
    if (!playing) {
      annotationSettled = true
      return
    }
    if (annotationSettled) closeAnnotation()
  })

  // Moving the playhead off the captured second is the same statement as playing: a
  // still of one frame cannot stand for another. Stepping or scrubbing therefore
  // ends the annotation instead of leaving a picture the playhead disagrees with.
  $effect(() => {
    const note = frameNote
    if (!note || playing || !annotationSettled) return
    if (Math.abs(shown - note.snapshot.seconds) <= MARK_FRAME_TOLERANCE_SECONDS) return
    closeAnnotation()
  })

  function clamp(seconds: number): number {
    return snapVideoFrame(seconds, duration, composition.fps)
  }

  /** Minutes, seconds and milliseconds for the selected frame. */
  function format(seconds: number): string {
    return videoTimecode(seconds)
  }

  // The page owns the clock, so the bar follows the tab's one playhead while it is
  // on screen and gives it back when it leaves. Only the two props this depends on
  // are read here, so an answer from the page cannot restart the timer it just fed.
  $effect(() => {
    if (!active) return
    const pauseOnHide = pauseWhenHidden
    const release = playhead.attach()
    return () => {
      release()
      if (pauseOnHide) void playhead.command('pause')
    }
  })
</script>

<div
  class={[
    'titlebar-no-drag flex shrink-0 items-center border-b border-border bg-surface px-2',
    compact ? 'gap-1' : 'gap-2',
    titlebar ? 'h-10' : 'h-9'
  ]}
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
  <span
    class="shrink-0 tabular-nums text-[0.6875rem] text-dimmed"
    title={`${format(shown)} · frame ${Math.round(shown * composition.fps)}`}
    >{compact
      ? videoClockLabel(shown)
      : `${format(shown)} · f${Math.round(shown * composition.fps)}`}</span
  >
  <SeekBar
    class={compact ? 'min-w-12 flex-1' : 'min-w-0 flex-1'}
    value={shown}
    min={0}
    max={duration}
    step={frameStep}
    label="Seek the composition"
    title="Seek the composition"
    onInput={(seconds) => holdSecond(seconds)}
    onCommit={() => commitScrub()}
  />
  <span class="shrink-0 tabular-nums text-[0.6875rem] text-dimmed" title={format(duration)}
    >{compact ? videoClockLabel(duration) : format(duration)}</span
  >
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
    title={muted ? 'Unmute video playback' : 'Mute video playback'}
    aria-label={muted ? 'Unmute video playback' : 'Mute video playback'}
    aria-pressed={muted}
    disabled={muteBusy}
    onclick={() => void toggleMuted()}
  >
    {#if muted}<CioVolumeX size={13} />{:else}<CioVolume size={13} />{/if}
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
  {#if frameNote}
    <!-- The pen and its colour, mounted by the mark layer right where the pen was
         pressed. Finishing is the same control turned into a check mark, so the
         picture is the picture and nothing else. -->
    <div class="flex shrink-0 items-center" bind:this={annotationToolbar}></div>
  {:else}
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
  {/if}
</div>
{#if frameNote}
  {@const paneBounds = annotationBounds ?? browserVisibility.pageBoundsFor(tabId)}
  {#if paneBounds}
    <!--
      The pen is drawn where the composition plays rather than in a dialog: the
      user is already in the editor's full screen, and covering it meant losing the
      player, the timeline and the control row they annotate from. The captured
      frame takes the page's own pane, and the transport's row below stays put.

      `data-annotation-surface` is what tells the editor around this picture that
      the pen is open: a space beside an annotated frame continues the video, and
      the editor's own play/pause has to stand aside for it.
    -->
    <div data-annotation-surface class="contents">
      <CompositionFrameAnnotator
        projectId={projectId ?? ''}
        threadId={threadId ?? ''}
        snapshot={frameNote.snapshot}
        bounds={paneBounds}
        editingId={frameNote.editingId ?? null}
        marks={marksAt(frameNote.snapshot.seconds)}
        onEditClosed={() => {
          // The jump named one mark; once its editor is closed the request is spent,
          // and reopening the surface from the composer must open it again.
          if (frameNote) frameNote = { ...frameNote, editingId: null }
        }}
        onClose={() => closeAnnotation()}
        onContinue={() => closeAnnotation(true)}
      />
    </div>
  {/if}
{/if}
{#if projectId && threadId}
  <!--
    The bubble a moment is commented on is the app's one comment field, and it
    sits over the composition page: a native `WebContentsView` the compositor
    paints above every DOM node, so a bubble drawn here would be hidden behind
    the picture. The shared native host adopts it instead, which is the same
    route a comment on a design element takes.
  -->
  <DesignElementCommentPopover
    hostId={`composition-moment-${tabId}`}
    comment={editing && anchor
      ? {
          referenceId: editing.id,
          anchor,
          elementName: 'this moment',
          comment: momentComment
        }
      : null}
    targetId={`video-note-comment-${threadId}-${editing?.id ?? ''}`}
    scope={{ kind: 'project', projectId }}
    onDraftChange={(id, comment) => draftComment(id, comment)}
    onDone={(id, comment) => saveComment(id, comment)}
    onRemove={(id) => removeNote(id)}
    onClose={closeEditor}
    onExplain={() => openMomentChat('elaborate')}
    onQuickChat={() => openMomentChat('quick')}
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
