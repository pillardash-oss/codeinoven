<script lang="ts">
  import CioAudioLines from '@pdslng/cio-icon/CioAudioLines.svelte'
  import CioCaptions from '@pdslng/cio-icon/CioCaptions.svelte'
  import CioClapper from '@pdslng/cio-icon/CioClapper.svelte'
  import CioDownload from '@pdslng/cio-icon/CioDownload.svelte'
  import CioTabInfo from '@pdslng/cio-icon/CioTabInfo.svelte'
  import { Popover } from 'bits-ui'
  import { onMount, tick, type Snippet } from 'svelte'
  import { openAnnotationChat, videoMomentChatContext } from '$lib/annotation-chat'
  import ResponseAnnotationComment from '$lib/components/chats/ResponseAnnotationComment.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { responseReferencesState } from '$lib/stores/response-references.svelte'
  import { videoTimelineState } from '$lib/stores/video-timeline.svelte'
  import { videoNoteFocusState } from '$lib/stores/video-note-focus.svelte'
  import { videoNoteReference } from '$lib/video-note-reference'
  import { VideoFrameSeeker } from '$lib/video-frame-seeker'
  import { snapVideoFrame, visibleVideoFrames } from '$shared/video/frame-grid'
  import {
    videoAudioLanes,
    videoBandGeometry,
    videoCaptionBands,
    videoTimecode,
    videoTimelineTicks
  } from '$shared/video/timeline'
  import type { VideoStudioDocument } from '$shared/video/studio'
  import type { VideoProjectManifest } from '$shared/video/project'
  import type { BrowserCompositionPlayback } from '$shared/ipc-contract'

  /** The things a composition editor shows, as the board's one tab strip. */
  type EditorSection = 'timeline' | 'captions' | 'audio' | 'exports'

  const SECTIONS: {
    id: EditorSection
    label: string
    title: string
    icon: typeof CioClapper
  }[] = [
    {
      id: 'timeline',
      label: 'Timeline',
      title: 'Read the composition as a timeline',
      icon: CioClapper
    },
    {
      id: 'captions',
      label: 'Captions',
      title: 'Edit the words drawn over the composition',
      icon: CioCaptions
    },
    {
      id: 'audio',
      label: 'Audio',
      title: 'Manage the audio this composition plays',
      icon: CioAudioLines
    },
    {
      id: 'exports',
      label: 'Exports',
      title: 'Render the composition and follow its jobs',
      icon: CioDownload
    }
  ]

  interface Props {
    projectId: string
    threadId: string
    directory: string
    /**
     * The board's own composition view, when it has one.
     *
     * A board plays its composition in a view of its own, and the thread may also
     * have a browser tab on the same folder. Naming the view is what makes the
     * timeline read the playhead of the page the user is actually watching rather
     * than whichever composition tab reported last. Absent when the board is not
     * playing anything, and the timeline then falls back to the thread's tab.
     */
    tabId?: string
    /**
     * Bumped when the editor saves the composition.
     *
     * The timeline draws the bands from its own read of the same file, so a save
     * made in the controls has to be answered here: without it the lanes would keep
     * the placement the file had before the user moved a track.
     */
    revision?: number
    /**
     * The section body, owned by the controls so every tab stands on one read.
     *
     * It is handed the open section and the way to move the playhead: a caption
     * and a track are both things placed in time, so opening one has to put the
     * picture there, and this surface is the one that owns the clock.
     */
    controls?: Snippet<[EditorSection, (seconds: number) => void]>
  }

  let { projectId, threadId, directory, tabId = '', revision = 0, controls }: Props = $props()

  /** How often the playhead catches up with the page that owns the clock. */
  const POLL_MS = 200
  /** Lanes ask for a waveform each; past this many the rest are plain bands. */
  const WAVEFORM_LANE_LIMIT = 12
  const LANE_HEIGHT = '2.5rem'
  /**
   * How far one wheel notch or one pinch step moves the zoom.
   *
   * A trackpad pinch and Cmd/Ctrl plus a wheel both arrive as a run of small
   * deltas, so the step is per event rather than per notch: a mouse wheel is
   * clamped to a single step below, and a pinch accumulates into a smooth one.
   */
  const ZOOM_STEP = 0.005
  /** One event may never more than halve or double what it found. */
  const ZOOM_LIMIT = 1.5

  let section = $state<EditorSection>('timeline')
  /** How many viewports wide the track is, so `1` is the whole composition. */
  let zoom = $state(1)
  /** Where the scrolled window starts, as a fraction of the composition. */
  let scrollFraction = $state(0)
  /** The same offset in pixels, which is what slides the pinned ruler. */
  let scrollLeft = $state(0)
  let viewportWidth = $state(600)
  let viewport = $state<HTMLDivElement | undefined>()

  let studio = $state<VideoStudioDocument | null>(null)
  let manifest = $state<VideoProjectManifest | null>(null)
  let playback = $state<BrowserCompositionPlayback | null>(null)
  let thumbnails = $state.raw<Record<number, string>>({})
  let thumbnailOwner = ''
  let thumbnailBusy = false
  let thumbnailPending: { owner: string; project: string; folder: string; times: number[] } | null =
    null
  let waveforms = $state.raw<Record<string, string | null>>({})
  /** True while the user holds the band area, so a poll cannot yank the playhead. */
  let scrubbing = $state(false)
  let pendingFrame = $state<number | null>(null)
  let seekRevision = 0
  let scrubSeconds = $state(0)
  let scrubOffset = 0
  let error = $state('')
  /**
   * Whether this timeline is still on the page.
   *
   * True from the moment it is built, because the document it draws is loaded by
   * the revision effect below rather than by `onMount`: a read that answered after
   * the panel was torn down would write state nobody is reading, and that is the
   * only thing this flag prevents.
   */
  let mounted = true
  let reading = false
  let bandArea = $state<HTMLElement | null>(null)
  /** The root element, watched so the poll stops while the timeline is off screen. */
  let root = $state<HTMLElement | null>(null)
  /** Whether the timeline intersects its scroll container, from the observer. */
  let onScreen = $state(true)
  /** Whether the window is visible, from `document.visibilityState`. */
  let pageVisible = $state(true)

  /** The note whose comment bubble is open, and where the bubble is anchored. */
  let editing = $state<{ id: string; seconds: number } | null>(null)
  let anchor = $state<{ x: number; y: number } | null>(null)

  const tab = $derived(
    tabId !== ''
      ? videoTimelineState.compositionByTab(tabId)
      : videoTimelineState.compositionIn(projectId, threadId, directory)
  )
  const duration = $derived(
    Math.max(manifest?.duration ?? tab?.duration ?? playback?.duration ?? 0, 0.001)
  )
  const fps = $derived(manifest?.fps ?? tab?.fps ?? 30)
  const activeTabId = $derived(tab?.tabId ?? '')
  const time = $derived(playback?.time ?? 0)
  const shown = $derived(
    Math.min(Math.max(scrubbing ? scrubSeconds : (pendingFrame ?? time), 0), duration)
  )
  const playhead = $derived(`${(shown / duration) * 100}%`)
  const frame = $derived(Math.round(shown * fps))
  /**
   * The most the track may be stretched.
   *
   * Seventy-two pixels gives each frame a readable thumbnail and keeps even an
   * hour at 120 fps below Chromium's layout-width limit. The ceiling is the
   * composition's own frame count against the width it is drawn at. Pinching past
   * it would only make the ruler coarser than the frames it addresses.
   */
  const maxZoom = $derived(Math.max(1, (duration * fps * 72) / Math.max(viewportWidth, 1)))
  const scale = $derived(Math.min(zoom, maxZoom))
  const frameCells = $derived(
    visibleVideoFrames(
      duration,
      fps,
      scrollFraction * duration,
      Math.min(duration, (scrollFraction + 1 / scale) * duration),
      viewportWidth * scale
    )
  )
  const seeker = new VideoFrameSeeker(
    (id, seconds) => videoTimelineState.command(id, 'freeze', seconds),
    (id, next) => {
      if (mounted && tab?.tabId === id) {
        playback = next
        seekRevision += 1
        pendingFrame = null
      }
    }
  )
  const ticks = $derived(
    videoTimelineTicks(duration, Math.max(2, viewportWidth / 96), {
      start: scrollFraction * duration,
      end: Math.min(duration, (scrollFraction + 1 / scale) * duration),
      fps
    })
  )
  const captions = $derived(videoCaptionBands(studio))
  /**
   * The tabs this composition actually has.
   *
   * Captions are their own section because editing words is not reading a
   * timeline, and a composition that declares none has nothing to put in one, so
   * the tab is absent rather than offering an empty panel.
   */
  const sections = $derived(
    SECTIONS.filter((entry) => entry.id !== 'captions' || captions.length > 0)
  )
  /** The section on screen, which falls back when the tab it named is gone. */
  const openSection = $derived(
    section === 'captions' && captions.length === 0 ? 'timeline' : section
  )
  const lanes = $derived(videoAudioLanes(studio, manifest))
  /**
   * This composition's notes.
   *
   * Each carries its ordinal in the conversation's whole reference list, not in
   * this filtered list, because that is the number the composer chip and the model
   * use: a note shown as `2` here that the model reads as `Video note 2`.
   */
  const notes = $derived(
    responseReferencesState
      .forThread(projectId, threadId)
      .map((reference, index) => ({ reference, number: index + 1 }))
      .filter(
        (entry) => entry.reference.kind === 'video' && entry.reference.directory === directory
      )
  )

  async function load(): Promise<void> {
    try {
      const result = await invoke('video:studio', projectId, directory)
      if (!mounted) return
      studio = result.document
      manifest = result.manifest
      error = ''
      void requestWaveforms()
    } catch (failure) {
      if (!mounted) return
      error = failure instanceof Error ? failure.message : 'The composition could not be read.'
    }
  }

  /**
   * Ask for each lane's waveform picture, one at a time.
   *
   * Sequential rather than concurrent: each picture is a media pass, and a
   * composition with a dozen tracks must not start a dozen of them at once on a
   * machine the user is also working on. Requests past the lane limit are never
   * made at all, so a dense composition stays a set of readable bands.
   */
  async function requestWaveforms(): Promise<void> {
    for (const [index, lane] of lanes.entries()) {
      if (!mounted || index >= WAVEFORM_LANE_LIMIT || lane.key in waveforms) continue
      // The row reads `waveform loading` until this key exists at all, so a key is
      // only written once the answer is in: a picture, or null meaning there is
      // none to draw. Otherwise a lane that will never have a waveform would claim
      // to be loading forever.
      try {
        const picture = await invoke(
          'video:waveform',
          projectId,
          directory,
          lane.source,
          lane.trim,
          lane.duration
        )
        if (!mounted) return
        waveforms = { ...waveforms, [lane.key]: picture }
      } catch {
        if (!mounted) return
        waveforms = { ...waveforms, [lane.key]: null }
      }
    }
  }

  async function refresh(id: string): Promise<void> {
    // One read at a time: a slow round trip must not let the next tick stack on
    // top of it, because the page is the only thing that can be behind.
    if (reading) return
    if (!id) {
      playback = null
      return
    }
    reading = true
    try {
      const revision = seekRevision
      const next = await videoTimelineState.playback(id)
      if (mounted && revision === seekRevision && !scrubbing && pendingFrame === null && next)
        playback = next
    } finally {
      reading = false
    }
  }

  function clamp(seconds: number): number {
    return snapVideoFrame(seconds, duration, fps)
  }

  /**
   * Go to a second, pinning it, and show the frame the page draws there.
   *
   * The stage above the timeline owns the play button, so this surface only ever
   * seeks: a note, a scrub and a jump from the composer all name a moment rather
   * than a transport action.
   */
  async function goTo(seconds: number): Promise<void> {
    const current = tab
    if (!current) return
    const target = clamp(seconds)
    seekRevision += 1
    pendingFrame = target
    scrubSeconds = target
    if (playback) playback = { ...playback, time: target, playing: false }
    seeker.seek(current.tabId, target)
  }

  /** The second a pointer at one x position is pointing at. */
  function secondsAt(clientX: number): number {
    const element = bandArea
    if (!element) return 0
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0) return 0
    return clamp(Math.round(((clientX - rect.left) / rect.width) * duration * fps) / fps)
  }

  /**
   * Stretch or shrink the track around the point the gesture is on.
   *
   * The second under the pointer is the one that stays under it, which is what
   * makes a pinch feel like it is pulling the timeline rather than scrolling it.
   * The scroll offset is written after the track is re-laid out, because until
   * then the element still has the width it had before the zoom.
   */
  async function zoomBy(factor: number, clientX: number): Promise<void> {
    const element = viewport
    if (!element) return
    const next = Math.min(maxZoom, Math.max(1, scale * factor))
    if (Math.abs(next - scale) < 1e-4) return
    const rect = element.getBoundingClientRect()
    const pointer = Math.min(Math.max(clientX - rect.left, 0), rect.width)
    const anchor = element.scrollLeft + pointer
    const ratio = next / scale
    zoom = next
    await tick()
    element.scrollLeft = Math.max(0, anchor * ratio - pointer)
    scrollLeft = element.scrollLeft
    // Written here rather than waiting for the scroll event a programmatic
    // `scrollLeft` fires: the ruler's ticks are computed from this fraction, and
    // one frame of the old window under the new zoom reads as a wrong ruler.
    scrollFraction = scrollLeft / Math.max(1, viewportWidth * scale)
  }

  /**
   * Zoom on a pinch or Cmd/Ctrl plus the wheel.
   *
   * A trackpad pinch reaches the page as a wheel event carrying `ctrlKey`, and a
   * mouse reports the same gesture the same way, so one handler covers both. Only
   * those gestures are taken: a plain scroll is left to the scroller, because the
   * timeline is one band among several and must not swallow the panel's own scroll.
   */
  function zoomOnWheel(event: WheelEvent): void {
    if (!event.ctrlKey && !event.metaKey) return
    const element = viewport
    if (!element) return
    event.preventDefault()
    const delta =
      event.deltaMode === 1
        ? event.deltaY * 16
        : event.deltaMode === 2
          ? event.deltaY * element.clientHeight
          : event.deltaY
    const factor = Math.min(ZOOM_LIMIT, Math.max(1 / ZOOM_LIMIT, 1 - delta * ZOOM_STEP))
    void zoomBy(factor, event.clientX)
  }

  function beginScrub(event: PointerEvent, grabPlayhead = false): void {
    if (!tab) return
    scrubOffset = grabPlayhead ? shown - secondsAt(event.clientX) : 0
    scrubSeconds = clamp(secondsAt(event.clientX) + scrubOffset)
    scrubbing = true
    bandArea?.setPointerCapture(event.pointerId)
    void goTo(scrubSeconds)
  }

  function moveScrub(event: PointerEvent): void {
    if (!scrubbing) return
    scrubSeconds = clamp(secondsAt(event.clientX) + scrubOffset)
    void goTo(scrubSeconds)
  }

  function endScrub(event: PointerEvent): void {
    if (!scrubbing) return
    scrubbing = false
    bandArea?.releasePointerCapture(event.pointerId)
    const target =
      event.type === 'pointercancel' ? scrubSeconds : clamp(secondsAt(event.clientX) + scrubOffset)
    scrubSeconds = target
    void goTo(target)
  }

  async function showFrames(): Promise<void> {
    zoom = maxZoom
    await tick()
    if (!viewport) return
    viewport.scrollLeft = Math.max(
      0,
      (shown / duration) * viewportWidth * scale - viewportWidth / 2
    )
    scrollLeft = viewport.scrollLeft
    scrollFraction = scrollLeft / (viewportWidth * scale)
  }

  async function readThumbnails(): Promise<void> {
    if (thumbnailBusy) return
    thumbnailBusy = true
    try {
      while (thumbnailPending && mounted) {
        const request = thumbnailPending
        thumbnailPending = null
        const missing = request.times.filter((time) => !thumbnails[Math.round(time * fps)])
        if (!missing.length) continue
        const result = await invoke('video:frameStrip', request.project, request.folder, missing)
        if (!mounted || request.owner !== thumbnailOwner) continue
        if (!result.length) continue
        const next = { ...thumbnails }
        for (const item of result) next[Math.round(item.time * fps)] = item.image
        const keys = Object.keys(next)
        const visible = new Set(frameCells.map((cell) => cell.frame))
        for (const key of keys
          .filter((key) => !visible.has(Number(key)))
          .slice(0, Math.max(0, keys.length - 96)))
          delete next[Number(key)]
        thumbnails = next
      }
    } catch {
      // An incomplete composition keeps its frame addresses usable without pictures.
    } finally {
      thumbnailBusy = false
    }
  }

  $effect(() => {
    const owner = JSON.stringify([
      projectId,
      directory,
      revision,
      tab?.sourceRevision,
      fps,
      duration
    ])
    if (owner !== thumbnailOwner) {
      thumbnailOwner = owner
      thumbnails = {}
    }
    if (!onScreen || !pageVisible || section !== 'timeline' || !tab || tab.loading) return
    const times = frameCells.filter((cell) => !thumbnails[cell.frame]).map((cell) => cell.time)
    if (!times.length) return
    const request = { owner, project: projectId, folder: directory, times }
    const timer = setTimeout(() => {
      thumbnailPending = request
      void readThumbnails()
    }, 180)
    return () => {
      clearTimeout(timer)
      thumbnailPending = null
    }
  })

  /**
   * Write one note on the conversation at a second.
   *
   * The reference is a `PromptReference` like a quoted response selection or a
   * picked design element, so it appears in the composer the moment it is stored
   * and travels with the next prompt. Its text is the descriptor the model reads,
   * rebuilt here so a note describes the second it actually sits at.
   */
  function writeNote(id: string, seconds: number, comment: string): void {
    const existing = responseReferencesState.forThread(projectId, threadId)
    const previous = existing.find((candidate) => candidate.id === id)
    // Keep the tab a note was written against when the preview happens to be
    // closed right now, so editing it does not quietly cost the note its seek.
    const tabId = tab?.tabId ?? previous?.tabId
    const reference = {
      ...videoNoteReference(id, seconds, {
        directory,
        composition: tab,
        document: studio,
        ...(tabId ? { tabId } : {})
      }),
      comment
    }
    const merged = previous
      ? existing.map((candidate) => (candidate.id === id ? reference : candidate))
      : [...existing, reference]
    responseReferencesState.setForThread(projectId, threadId, merged)
  }

  /** Where a bubble anchored to a second sits, in viewport coordinates. */
  function anchorAt(seconds: number): { x: number; y: number } | null {
    const element = bandArea
    const rect = element?.getBoundingClientRect()
    const bounds = root?.getBoundingClientRect()
    if (!bounds) return null
    return {
      x: Math.min(
        bounds.right - 16,
        Math.max(
          bounds.left + 16,
          rect ? rect.left + (clamp(seconds) / duration) * rect.width : bounds.right - 16
        )
      ),
      y:
        openSection === 'timeline' && rect
          ? Math.min(bounds.bottom, Math.max(bounds.top + 40, rect.top))
          : bounds.top + 40
    }
  }

  /** Open the comment bubble for a note, seeking the composition to its second. */
  function openNote(id: string, seconds: number): void {
    void goTo(seconds)
    anchor = anchorAt(seconds)
    editing = { id, seconds }
  }

  /** Close the bubble, dropping a note the user left without a comment. */
  function closeEditor(): void {
    const current = editing
    editing = null
    anchor = null
    if (!current) return
    const note = responseReferencesState
      .forThread(projectId, threadId)
      .find((entry) => entry.id === current.id)
    if (note && (note.comment ?? '').trim() === '') removeNote(current.id)
  }

  /**
   * Ask about the moment the open note describes, before changing its comment.
   *
   * A saved note offers the same read-only chat a quoted selection does, so the
   * user can question a moment without writing a second note: the note's own
   * descriptor is the selection, and the composition's folder is the context
   * the answer is read from.
   */
  function openMomentChat(mode: 'elaborate' | 'quick'): void {
    const current = editing
    if (!current) return
    const note = notes.find((entry) => entry.reference.id === current.id)?.reference
    if (!note) return
    openAnnotationChat({
      projectId,
      threadId,
      mode,
      selection: note.text,
      context: videoMomentChatContext(directory)
    })
    closeEditor()
  }

  function saveComment(id: string, comment: string): void {
    const current = editing
    writeNote(id, current?.seconds ?? shown, comment)
    editing = null
    anchor = null
  }

  function draftComment(id: string, comment: string): void {
    responseReferencesState.updateCommentDraft(projectId, threadId, id, comment)
  }

  function removeNote(id: string): void {
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

  function noteMarkerClass(active: boolean): string {
    return active
      ? 'absolute top-1 flex h-5 -translate-x-1/2 items-center gap-1 bg-primary px-1.5 text-[0.5625rem] text-on-primary tabular-nums transition-colors'
      : 'absolute top-1 flex h-5 -translate-x-1/2 items-center gap-1 bg-elevated px-1.5 text-[0.5625rem] text-muted tabular-nums transition-colors hover:text-foreground'
  }

  onMount(() => {
    // A hidden panel neither polls the page nor has anyone to show the playhead
    // to, so the timeline stops while it is off screen or the window is hidden.
    // Its twin in BrowserCompositionTransport.svelte already gates on `active`.
    const element = root
    let observer: IntersectionObserver | null = null
    if (typeof IntersectionObserver !== 'undefined' && element) {
      observer = new IntersectionObserver(
        ([entry]) => {
          onScreen = entry.isIntersecting
        },
        { threshold: 0 }
      )
      observer.observe(element)
    }
    const onVisibility = (): void => {
      pageVisible = document.visibilityState !== 'hidden'
    }
    document.addEventListener('visibilitychange', onVisibility)
    onVisibility()

    return () => {
      mounted = false
      seeker.clear()
      observer?.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  })

  // The page owns the clock, so the panel reads it rather than running one of its
  // own. Only the tab and whether the timeline is on screen are read here, so a
  // state report cannot restart the timer it just fed.
  $effect(() => {
    const id = activeTabId
    if (!id || !onScreen || !pageVisible) return
    void refresh(id)
    const timer = setInterval(() => void refresh(id), POLL_MS)
    return () => {
      clearInterval(timer)
      seeker.clear()
      seekRevision += 1
      pendingFrame = null
    }
  })

  // The bands are read from the composition itself, on mount and again whenever
  // the editor saves it. The revision is the trigger and nothing else is read in
  // here, so a read cannot re-run on the document it just wrote.
  let readRevision: string | null = null
  $effect(() => {
    const source = JSON.stringify([projectId, directory, revision, tab?.sourceRevision])
    if (readRevision === source) return
    readRevision = source
    void load()
  })

  // A jump from the composer names the note it wants; this board is what takes it
  // once it is showing that composition.
  $effect(() => {
    const request = videoNoteFocusState.pending(projectId, threadId)
    if (!request || request.directory !== directory) return
    const match = notes.find((entry) => entry.reference.id === request.referenceId)
    videoNoteFocusState.consume(request.token)
    if (match) openNote(match.reference.id, match.reference.seconds ?? request.seconds)
    else void goTo(request.seconds)
  })
</script>

<div
  bind:this={root}
  class="flex min-h-0 flex-1 flex-col overflow-hidden"
  role="group"
  aria-label="Composition timeline"
>
  <!--
    One row of chrome. The tabs say which half of the editor is open, and the
    strip on the right holds timeline tools and frame information. Commenting on a moment is the
    transport's job, not this row's: the transport carries the playhead, so it
    carries the button that names it, and the note it writes lists itself here as
    a row the reader can reopen.
  -->
  <div class="flex shrink-0 items-center justify-between gap-2 pb-1.5">
    {#if controls}
      <div
        class="flex w-max items-center gap-0.5 border border-border bg-elevated p-0.5"
        role="tablist"
        aria-label="Video editor sections"
      >
        {#each sections as entry (entry.id)}
          {@const Icon = entry.icon}
          <!--
            The open tab names itself and its neighbours do not. The strip shares
            one row with the timeline tools, and a row of words for the tabs
            pushes those off the panel at its default width. An icon still says
            which half of the editor is closed, and its title says the word when
            the pointer rests on it.
          -->
          <button
            type="button"
            class="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium transition-colors {openSection ===
            entry.id
              ? 'bg-surface text-foreground'
              : 'text-muted hover:text-foreground'}"
            role="tab"
            aria-selected={openSection === entry.id}
            aria-label={entry.label}
            title={entry.title}
            onclick={() => (section = entry.id)}
          >
            <Icon size={12} aria-hidden="true" class="shrink-0" />
            {#if openSection === entry.id}
              <span class="whitespace-nowrap">{entry.label}</span>
            {/if}
          </button>
        {/each}
      </div>
    {:else}
      <span></span>
    {/if}
    {#if openSection === 'timeline'}
      <div
        class="ml-auto flex shrink-0 items-center gap-1"
        role="group"
        aria-label="Timeline tools"
      >
        <button
          type="button"
          class="px-2 py-1 text-[0.6875rem] text-muted hover:bg-elevated"
          title="Fit the whole video in the timeline"
          aria-label="Fit the whole video in the timeline"
          onclick={() =>
            zoomBy(1 / scale, (viewport?.getBoundingClientRect().left ?? 0) + viewportWidth / 2)}
          >Fit</button
        >
        <button
          type="button"
          class="px-2 py-1 text-[0.6875rem] text-muted hover:bg-elevated"
          title="Zoom out of the timeline"
          aria-label="Zoom out of the timeline"
          onclick={() =>
            zoomBy(1 / 1.5, (viewport?.getBoundingClientRect().left ?? 0) + viewportWidth / 2)}
          >−</button
        >
        <button
          type="button"
          class="px-2 py-1 text-[0.6875rem] text-muted hover:bg-elevated"
          title="Zoom into the timeline"
          aria-label="Zoom into the timeline"
          onclick={() =>
            zoomBy(1.5, (viewport?.getBoundingClientRect().left ?? 0) + viewportWidth / 2)}
          >+</button
        >
        <button
          type="button"
          class="px-2 py-1 text-[0.6875rem] text-muted hover:bg-elevated"
          title="Show individual frames around the playhead"
          aria-label="Show individual frames around the playhead"
          onclick={showFrames}>Frames</button
        >
        <Popover.Root>
          <Popover.Trigger
            class="flex items-center justify-center px-2 py-1 text-muted hover:bg-elevated"
            title="Show frame and frame rate"
            aria-label="Show frame and frame rate"
          >
            <CioTabInfo size={14} aria-hidden="true" />
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              align="end"
              sideOffset={6}
              class="z-60 border border-border bg-surface px-3 py-2 text-xs text-foreground shadow-lg"
            >
              <span class="tabular-nums">Frame {frame} · {fps} fps</span>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      </div>
    {/if}
  </div>
  {#if error}
    <p class="shrink-0 bg-danger/10 px-2 py-1 text-xs text-danger" role="alert">{error}</p>
  {:else if !manifest}
    <p class="shrink-0 text-xs text-dimmed">
      This folder has no readable composition.json, so there is no timeline to draw.
    </p>
  {:else}
    <div class="min-h-0 flex-1 overflow-y-auto pb-2">
      {#if openSection === 'timeline'}
        {#if !tab}
          <p class="pb-1 text-[0.6875rem] text-dimmed">
            Waiting for the composition to load. The timeline still shows what it declares.
          </p>
        {/if}
        <div class="select-none">
          <!--
            The ruler is pinned to the top of the editor's scroller rather than
            living inside the track, so scrolling down to the captions, the lanes
            and the controls never costs the reader the time. It is not scrollable
            itself: it slides by the track's own offset, which keeps the two in one
            coordinate system without a second scroller to keep in sync.
          -->
          <div
            class="sticky top-0 z-20 h-4 overflow-hidden bg-surface"
            style:width={`${viewportWidth}px`}
            aria-hidden="true"
          >
            <div
              class="relative h-4"
              style:width={`${scale * viewportWidth}px`}
              style:transform={`translateX(${-scrollLeft}px)`}
            >
              {#each ticks as tick (tick.seconds)}
                <span
                  class="absolute top-0 text-[0.625rem] whitespace-nowrap text-dimmed tabular-nums"
                  style={`left: ${tick.fraction * 100}%; transform: translateX(${tick.seconds === 0 ? 0 : tick.seconds === duration ? -100 : -50}%)`}
                  >{tick.label}</span
                >
              {/each}
            </div>
          </div>
          <div
            bind:this={viewport}
            class="overflow-x-auto pb-1"
            onwheel={zoomOnWheel}
            onscroll={(event) => {
              scrollLeft = event.currentTarget.scrollLeft
              scrollFraction = scrollLeft / (viewportWidth * scale)
            }}
            {@attach (node) => {
              const observer = new ResizeObserver(([entry]) => {
                viewportWidth = entry.contentRect.width
              })
              observer.observe(node)
              return () => observer.disconnect()
            }}
          >
            <div style:width={`${scale * 100}%`}>
              <!--
                The tracks, without a rule between them. A caption strip, a lane
                per track and the notes all sit on the one raised band, and the
                clip rectangles are what the eye separates them by: a line per
                lane would draw three borders around a surface the panel already
                frames.
              -->
              <div
                bind:this={bandArea}
                class="relative mt-1 bg-app"
                role="group"
                aria-label="Playhead"
                onpointerdown={beginScrub}
                onpointermove={moveScrub}
                onpointerup={endScrub}
                onpointercancel={endScrub}
              >
                <div class="relative h-14 overflow-hidden" aria-label="Video frame thumbnails">
                  {#each frameCells as cell (cell.frame)}
                    <button
                      type="button"
                      class="absolute top-0 h-full overflow-hidden border-r border-border bg-elevated text-left"
                      style:left={`${(cell.time / duration) * 100}%`}
                      style:width={`${((cell.end - cell.time) / duration) * 100}%`}
                      title={`Seek to frame ${cell.frame}, ${videoTimecode(cell.time)}`}
                      aria-label={`Seek to frame ${cell.frame}, ${videoTimecode(cell.time)}`}
                      onclick={() => goTo(cell.time)}
                    >
                      {#if thumbnails[cell.frame]}<img
                          src={thumbnails[cell.frame]}
                          alt=""
                          class="h-full w-full object-contain"
                        />{/if}
                      <span
                        class="absolute right-0 bottom-0 left-0 bg-app/80 px-1 text-[0.5625rem] text-foreground tabular-nums"
                        >f{cell.frame}</span
                      >
                    </button>
                  {/each}
                </div>
                {#if captions.length > 0}
                  <div class="relative h-6">
                    {#each captions as band (band.key)}
                      {@const geometry = videoBandGeometry(band.start, band.end, duration)}
                      <span
                        class="absolute top-1 h-4 overflow-hidden bg-accent/25 px-1 text-[0.5625rem] leading-4 whitespace-nowrap text-foreground"
                        style={`left: ${geometry.left}; width: ${geometry.width};`}
                        title={`${videoTimecode(band.start)} ${band.text}`}>{band.text}</span
                      >
                    {/each}
                  </div>
                {/if}

                {#each lanes as lane, index (lane.key)}
                  {@const geometry = videoBandGeometry(
                    lane.start,
                    lane.start + lane.duration,
                    duration
                  )}
                  <div class="relative" style={`height: ${LANE_HEIGHT}`}>
                    <span
                      class="absolute top-0.5 left-1 z-10 max-w-[45%] truncate text-[0.5625rem] text-muted"
                      title={`${lane.source} (gain ${lane.gain})`}>{lane.label}</span
                    >
                    <span
                      class="absolute top-0 bottom-0 overflow-hidden bg-accent/15"
                      style={`left: ${geometry.left}; width: ${geometry.width};`}
                    >
                      {#if waveforms[lane.key]}
                        <img
                          src={waveforms[lane.key]}
                          alt=""
                          aria-hidden="true"
                          class="h-full w-full object-fill opacity-70"
                        />
                      {:else}
                        <span
                          class="flex h-full items-center justify-center text-[0.5625rem] text-dimmed"
                        >
                          {index >= WAVEFORM_LANE_LIMIT
                            ? 'lane beyond the waveform limit'
                            : lane.key in waveforms
                              ? 'no waveform'
                              : 'waveform loading'}
                        </span>
                      {/if}
                    </span>
                  </div>
                {/each}
                {#if lanes.length === 0}
                  <div class="flex h-8 items-center px-2 text-[0.625rem] text-dimmed">
                    This composition declares no audio.
                  </div>
                {/if}

                <div class="relative h-7">
                  {#each notes as note (note.reference.id)}
                    {@const seconds = note.reference.seconds ?? 0}
                    <button
                      type="button"
                      class={noteMarkerClass(note.reference.id === editing?.id)}
                      style={`left: ${(Math.min(seconds, duration) / duration) * 100}%`}
                      title={`${videoTimecode(seconds)} ${note.reference.comment ?? ''}`}
                      aria-label={`Edit video note ${note.number}`}
                      onclick={() => openNote(note.reference.id, seconds)}
                    >
                      <CioClapper size={9} aria-hidden="true" />
                      {note.number}
                    </button>
                  {/each}
                </div>

                <button
                  type="button"
                  class="playhead-handle absolute top-0 bottom-0 z-20"
                  style:left={playhead}
                  data-dragging={scrubbing}
                  title="Drag the playhead to scrub frames"
                  aria-label="Drag the playhead to scrub frames"
                  onpointerdown={(event) => {
                    event.stopPropagation()
                    beginScrub(event, true)
                  }}
                >
                  <span class="playhead-line" aria-hidden="true"></span>
                </button>
              </div>
            </div>
          </div>
        </div>
      {/if}
      {#if controls}{@render controls(openSection, (seconds) => void goTo(seconds))}{/if}
    </div>
  {/if}
</div>

{#if editing && anchor}
  <!--
    A moment is commented on the way every other annotation is: the one comment
    bubble the app draws, anchored to the second it belongs to. The bubble is a
    fixed-position overlay, so it takes no space in the timeline and the editor
    below stays a timeline.
  -->
  <ResponseAnnotationComment
    x={anchor.x}
    y={anchor.y}
    title="Comment on this moment"
    dragHandleTitle="Move moment comment"
    closeLabel="Close moment comment"
    removeTitle="Remove this note and its comment"
    initialComment={notes.find((entry) => entry.reference.id === editing?.id)?.reference.comment ??
      ''}
    targetId={`video-note-comment-${threadId}-${editing.id}`}
    scope={{ kind: 'project', projectId }}
    onDraftChange={(comment) => draftComment(editing?.id ?? '', comment)}
    onDone={(comment) => saveComment(editing?.id ?? '', comment)}
    onRemove={() => removeNote(editing?.id ?? '')}
    onClose={closeEditor}
    chatSubject="moment"
    onExplain={() => openMomentChat('elaborate')}
    onQuickChat={() => openMomentChat('quick')}
  />
{/if}

<style>
  .playhead-handle {
    width: 1rem;
    padding: 0;
    border: 0;
    background: transparent;
    transform: translateX(-50%);
    cursor: ew-resize;
  }

  .playhead-line {
    position: absolute;
    inset-block: 0;
    left: 50%;
    width: 0.0625rem;
    transform: translateX(-50%);
    background: var(--color-primary);
    transition:
      width 120ms ease,
      box-shadow 120ms ease;
    pointer-events: none;
  }

  .playhead-handle:hover .playhead-line,
  .playhead-handle:focus-visible .playhead-line,
  .playhead-handle[data-dragging='true'] .playhead-line {
    width: 0.1875rem;
    box-shadow: 0 0 0 0.25rem color-mix(in srgb, var(--color-primary) 20%, transparent);
  }
</style>
