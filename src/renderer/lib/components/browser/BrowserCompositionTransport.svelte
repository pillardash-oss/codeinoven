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
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import { on } from 'svelte/events'
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
    /**
     * Whether a space pressed here plays and pauses the composition.
     *
     * The bar is the composition's own player, so it answers the play/pause key
     * wherever the focus is inside it, and on nothing at all when the bar is the
     * only surface left. It stands down when the full screen editor is around it:
     * that editor claims the key for the whole window, and both answering it would
     * toggle twice and land back where the user started.
     */
    ownsPlaybackKey?: boolean
    /**
     * Whether this bar takes the caret when it appears.
     *
     * A full screen player opens over a modal that would otherwise put the caret in
     * the first text field it finds, and a play/pause key typed there is a space in a
     * box. The bar owns the key, so the bar takes the caret: focus is on the control
     * the key belongs to from the first press.
     */
    claimsFocus?: boolean
  }

  let {
    tabId,
    composition,
    active,
    pauseWhenHidden = false,
    projectId,
    threadId,
    titlebar = false,
    compact = false,
    ownsPlaybackKey = true,
    claimsFocus = false
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
   * Whether the pen is in hand.
   *
   * An armed pen outlives the frame it was picked up on: a user marks a moment, lets
   * the video run, stops it again and marks the next one without leaving the tool.
   * Only the check mark, Escape or the pen control itself puts it down.
   */
  let penArmed = $state(false)
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
   * The control that had the keyboard before a comment or the pen took it.
   *
   * A comment is written in its own window above the picture, and the pen draws on
   * it, so neither is the app window's keyboard while it is open. Remembering what
   * was focused is what lets the bar take the keyboard back when they close: space
   * over a video is play and pause, and that only works while a surface that
   * answers it is the one being typed at.
   */
  let focusBeforeOverlay: HTMLElement | null = null
  let playButton = $state<HTMLButtonElement>()

  /** Remember the surface the user was working on, before an overlay takes it. */
  function rememberFocus(): void {
    const focused = document.activeElement
    focusBeforeOverlay =
      focused instanceof HTMLElement && focused !== document.body ? focused : null
  }

  /**
   * Give the keyboard back to the bar once an overlay closes.
   *
   * The comment window holds the operating system's focus while it is open, so the
   * app window is brought forward first and the play control is what takes the
   * caret: it is the control space is for, and focusing it is what makes the panel
   * visibly the surface being typed at again.
   *
   * The handover is deferred by one task because the bubble is still in the tree
   * when this is called: closing it moves the app's own DOM back into the window and
   * focuses the control that was clicked, and that runs after this. Taking the
   * keyboard after it settles is what leaves the caret in the panel rather than on a
   * button the bubble just removed.
   */
  function returnFocus(): void {
    setTimeout(() => {
      const target = focusBeforeOverlay?.isConnected ? focusBeforeOverlay : playButton
      focusBeforeOverlay = null
      window.focus()
      target?.focus({ preventScroll: true })
    }, 0)
  }

  /**
   * Whether a key pressed here belongs to a field.
   *
   * A space typed into a comment is a space. The pen is not a field: its surface is
   * the picture, and the play/pause key over a picture plays and pauses it without
   * putting the pen away.
   */
  function overlayOwnsKeys(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false
    if (target.isContentEditable) return true
    return target.closest('input,textarea,select,[data-floating-document]') !== null
  }

  /**
   * Space plays and pauses the composition, wherever the focus is in this bar.
   *
   * A page is a native view, so a key pressed over it never reaches the app; this
   * bar is the app's own surface for that page, and it answers the key the way the
   * full screen editor does. A press that lands on no control at all is the bar's
   * too, because a composition the user is watching is the surface space belongs
   * to, and nothing else in the app does anything with it.
   */
  /**
   * Whether a press belongs to this player.
   *
   * Three places are the player's: the bar itself, a window with nothing focused in
   * it, and the modal the bar is drawn in. A modal focuses its own panel rather than
   * a control, so a press that lands on that panel is still a press in the player; a
   * dialog somewhere else on screen is not.
   */
  function pressBelongsToPlayer(target: EventTarget | null): boolean {
    if (target === document || target === document.body || target === document.documentElement)
      return true
    const bar = root
    if (!(target instanceof HTMLElement) || !bar) return false
    if (bar.contains(target)) return true
    // The whole panel the bar belongs to: its picture, its pen, its empty space.
    const panel = target.closest('[data-composition-player]')
    if (panel !== null && panel.contains(bar)) return true
    // The pen draws in the pane the picture plays in, which is this player's own
    // surface: a space pressed there is about the video under the pen.
    if (target.closest('[data-annotation-surface]') !== null) return true
    const modal = target.closest('[aria-modal="true"]')
    return modal !== null && modal.contains(bar)
  }

  function playbackKey(event: KeyboardEvent): void {
    if (!ownsPlaybackKey || event.defaultPrevented) return
    const target = event.target
    if (!pressBelongsToPlayer(target)) return
    if (overlayOwnsKeys(target)) return
    if (!keymapState.matches('video-edit-play', event)) return
    event.preventDefault()
    event.stopPropagation()
    // A held key is one press, not a toggle at the keyboard's repeat rate.
    if (!event.repeat) togglePlay()
  }

  /** The caret is taken once, when the control that answers the key exists. */
  let claimedFocus = false
  $effect(() => {
    if (!claimsFocus || claimedFocus || !playButton || !active) return
    claimedFocus = true
    playButton.focus({ preventScroll: true })
  })

  let root: HTMLDivElement | undefined
  // Registered while the bar exists, not while some other bookkeeping says the
  // surface is visible: a row that decided it was hidden went deaf, which is a
  // play/pause key that works everywhere except the sidebar panel.
  $effect(() => {
    if (!ownsPlaybackKey) return
    return on(window, 'keydown', playbackKey, { capture: true })
  })

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
    if (!canNote || capturing || penArmed) return
    rememberFocus()
    penArmed = true
    captureError = null
    await playhead.command('pause')
    await holdFrame(shown)
  }

  /**
   * Hold the frame the picture stopped on, so the pen has something to draw on.
   *
   * A pen is armed for as long as the user is annotating, which outlasts any one
   * frame: they mark a moment, let the picture run, stop it again and mark the next
   * one. This is the half that captures, and it runs on every stop rather than once
   * when the pen is picked up.
   */
  async function holdFrame(seconds: number): Promise<void> {
    if (capturing) return
    capturing = true
    captureError = null
    try {
      const snapshot = await invoke('browser:captureCompositionFrame', tabId, seconds)
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
    frameNote = {
      snapshot: opened.snapshot,
      ...(opened.editingId !== undefined ? { editingId: opened.editingId } : {})
    }
  }

  /**
   * Put the pen down and hand the pane back to the composition page.
   *
   * This is the end of annotating, and the only thing that ends it: the pen's own
   * check mark, Escape, or the pen control itself. Letting the picture run does not
   * end it, because a user marking several moments in one pass never leaves the pen.
   */
  function closeAnnotation(resume = false): void {
    const held = frameNote !== null
    penArmed = false
    marksHeldFor = null
    frameNote = null
    annotationBounds = null
    if (held) returnFocus()
    if (held && resume) void playhead.command('play')
  }

  /** What the picture was doing on the last look, so a change is a change. */
  let penWasPlaying = false
  /** Whether the picture has run since the pen last held a frame. */
  let penRanSinceCapture = false

  /**
   * The pen is a mode, and play/pause moves only the picture inside it.
   *
   * Three rules, and every one of them is about the pen never leaving by itself:
   *
   * 1. Arming captures the frame the user stopped on and holds it, which is what
   *    they draw on.
   * 2. Playing hands the pane back, because a still cannot be the video the user
   *    asked to watch. The pen is still in hand: this is the pause in the middle of
   *    annotating, not the end of it.
   * 3. Pausing takes the frame it stopped on again, so the very next thing the user
   *    does is draw. Coming back for any other reason - a scrub, a step - leaves the
   *    pen armed and does not re-cut the frame under it.
   *
   * Reading the transition rather than the state is what makes the second pause work
   * every time: two presses a tenth of a second apart land on the same frame, and a
   * capture keyed to the second instead of the change would skip it and leave the
   * user looking at a video with no pen on it.
   */
  $effect(() => {
    const now = playing
    const was = penWasPlaying
    penWasPlaying = now
    if (!penArmed) return
    if (now) {
      penRanSinceCapture = true
      if (!frameNote) return
      frameNote = null
      annotationBounds = null
      return
    }
    // One run, one frame. The tools come back on the first stop after the picture has
    // run, which is the moment the user pressed pause to draw, and a report that
    // repeats "stopped" without a run in between never cuts a second frame and cannot
    // blink the canvas under the pen.
    if (!was || !penRanSinceCapture) return
    penRanSinceCapture = false
    if (frameNote) return
    void holdFrame(shown)
  })

  /** The marks drawn on the second the picture is stopped on. */
  const marksHere = $derived(frameNote ? [] : marksAt(shown))

  /** The second a frame was last held for so its marks could be read. */
  let marksHeldFor: number | null = null

  /**
   * A stopped frame that carries marks shows them.
   *
   * A mark is a stroke on a picture, and a lane cannot draw it: what the reader wants
   * when they land on a commented moment is the frame with its marks on it, and the
   * several comments one frame can carry each reachable from its own badge. Holding
   * the frame is the same still the pen draws on, minus the pen, so the tools are not
   * drawn and every badge is a button.
   */
  $effect(() => {
    if (penArmed || capturing || playing) return
    const marks = marksHere
    if (marks.length === 0) return
    if (frameNote) return
    const second = shown
    if (marksHeldFor !== null && Math.abs(marksHeldFor - second) < 0.001) return
    marksHeldFor = second
    void holdFrame(second)
  })

  /** A frame held only for its marks goes back to the page once they are elsewhere. */
  $effect(() => {
    if (penArmed || !frameNote || playing) return
    if (marksHere.length > 0) return
    frameNote = null
    annotationBounds = null
    marksHeldFor = null
  })

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
    rememberFocus()
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
    rememberFocus()
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
    returnFocus()
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
    returnFocus()
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
      returnFocus()
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

  // The pen stays in hand until the check mark ends it.
  //
  // Annotating is a paused activity, but resuming the picture is not the pen being
  // done: a user who presses space to pause, circles a moment and writes about it
  // presses space again for the next moment, and taking the drawn frame away on that
  // press would throw away the note they were halfway through. One control ends an
  // annotation, and it is the one that says so.

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
  bind:this={root}
  data-video-chrome
  class={[
    'titlebar-no-drag flex shrink-0 items-center border-b border-border bg-surface px-2',
    compact ? 'gap-1' : 'gap-2',
    titlebar ? 'h-10' : 'h-9'
  ]}
  role="group"
  aria-label={`Playback of ${composition.directory}`}
>
  {#if titlebar}
    <!--
      The surface names itself before its controls. This row is the title bar of the
      window the video is watched in, so it carries the title the way the editor's own
      row does, and the controls follow it instead of starting at the window edge.
    -->
    <span class="shrink-0 text-xs font-medium text-foreground">Video player</span>
    <span class="mx-1 h-4 w-px shrink-0 bg-border" aria-hidden="true"></span>
  {/if}
  <button
    type="button"
    bind:this={playButton}
    data-video-play
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
  <!--
    The pen's own controls are drawn on the picture it marks, never here. This row is
    the player's, and a strip that appeared above the video the moment the pen opened
    was chrome between the user and the frame they were drawing on: the pen control
    below only reports whether the pen is in hand.
  -->
  <button
    type="button"
    class={[
      'flex h-7 w-7 shrink-0 items-center justify-center transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40',
      penArmed ? 'bg-elevated text-foreground' : 'text-dimmed'
    ]}
    aria-label={penArmed ? 'Finish annotating' : 'Annotate this frame'}
    aria-pressed={penArmed}
    title={!canNote
      ? 'Annotate a frame from the video panel'
      : penArmed
        ? 'Finish annotating: the pen stays in hand while the video plays, and comes back when you stop it'
        : 'Annotate this frame: circle an area and write why'}
    disabled={!canNote || capturing}
    onclick={() => (penArmed ? closeAnnotation() : void annotateFrame())}
  >
    <CioPencil size={13} />
  </button>
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
    <div data-annotation-surface data-video-chrome class="contents">
      <CompositionFrameAnnotator
        readOnly={!penArmed}
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
