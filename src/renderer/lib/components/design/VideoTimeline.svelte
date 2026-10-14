<script lang="ts">
  import {
    Clapperboard,
    MessageSquarePlus,
    Pause,
    Play,
    SkipBack,
    SkipForward
  } from '@lucide/svelte'
  import { onMount } from 'svelte'
  import ResponseAnnotationComment from '$lib/components/chats/ResponseAnnotationComment.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { responseReferencesState } from '$lib/stores/response-references.svelte'
  import { videoTimelineState } from '$lib/stores/video-timeline.svelte'
  import { videoNoteFocusState } from '$lib/stores/video-note-focus.svelte'
  import { newVideoNoteId, videoNoteReference } from '$lib/video-note-reference'
  import {
    videoAudioLanes,
    videoBandGeometry,
    videoCaptionBands,
    videoTimecode,
    videoTimelineTicks
  } from '$shared/video/timeline'
  import type { VideoStudioDocument } from '$shared/video/studio'
  import type { VideoProjectManifest } from '$shared/video/project'
  import type { BrowserCompositionPlayback, BrowserTransportCommand } from '$shared/ipc-contract'

  interface Props {
    projectId: string
    threadId: string
    directory: string
  }

  let { projectId, threadId, directory }: Props = $props()

  /** How often the playhead catches up with the page that owns the clock. */
  const POLL_MS = 200
  /** Lanes ask for a waveform each; past this many the rest are plain bands. */
  const WAVEFORM_LANE_LIMIT = 12
  const LANE_HEIGHT = '2.5rem'

  let studio = $state<VideoStudioDocument | null>(null)
  let manifest = $state<VideoProjectManifest | null>(null)
  let playback = $state<BrowserCompositionPlayback | null>(null)
  let waveforms = $state.raw<Record<string, string | null>>({})
  /** True while the user holds the band area, so a poll cannot yank the playhead. */
  let scrubbing = $state(false)
  let scrubSeconds = $state(0)
  let error = $state('')
  let mounted = false
  let reading = false
  let bandArea = $state<HTMLElement | null>(null)

  /** The note whose comment bubble is open, and where the bubble is anchored. */
  let editing = $state<{ id: string; seconds: number } | null>(null)
  let anchor = $state<{ x: number; y: number } | null>(null)

  const tab = $derived(videoTimelineState.compositionIn(projectId, threadId, directory))
  const duration = $derived(
    Math.max(manifest?.duration ?? tab?.duration ?? playback?.duration ?? 0, 0.001)
  )
  const fps = $derived(manifest?.fps ?? tab?.fps ?? 30)
  const frameStep = $derived(1 / Math.max(fps, 1))
  const time = $derived(playback?.time ?? 0)
  const playing = $derived(playback?.playing ?? false)
  const shown = $derived(Math.min(Math.max(scrubbing ? scrubSeconds : time, 0), duration))
  const playhead = $derived(`${(shown / duration) * 100}%`)
  const ticks = $derived(videoTimelineTicks(duration))
  const captions = $derived(videoCaptionBands(studio))
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

  async function refresh(): Promise<void> {
    // One read at a time: a slow round trip must not let the next tick stack on
    // top of it, because the page is the only thing that can be behind.
    if (reading) return
    const current = tab
    if (!current) {
      playback = null
      return
    }
    reading = true
    try {
      const next = await videoTimelineState.playback(current.tabId)
      if (mounted && next) playback = next
    } finally {
      reading = false
    }
  }

  async function command(name: BrowserTransportCommand, seconds?: number): Promise<void> {
    const current = tab
    if (!current) return
    const next =
      seconds === undefined
        ? await videoTimelineState.command(current.tabId, name, 0)
        : await videoTimelineState.seek(current.tabId, seconds)
    if (mounted && next) playback = next
  }

  function clamp(seconds: number): number {
    if (!Number.isFinite(seconds)) return 0
    return Math.min(Math.max(seconds, 0), duration)
  }

  /** Go to a second, pinning it, and show the frame the page draws there. */
  function goTo(seconds: number): void {
    const target = clamp(seconds)
    void command('seek', target)
  }

  function step(direction: 1 | -1): void {
    goTo(time + direction * frameStep)
  }

  /** The second a pointer at one x position is pointing at. */
  function secondsAt(clientX: number): number {
    const element = bandArea
    if (!element) return 0
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0) return 0
    return clamp(((clientX - rect.left) / rect.width) * duration)
  }

  function beginScrub(event: PointerEvent): void {
    if (!tab) return
    scrubSeconds = secondsAt(event.clientX)
    scrubbing = true
    bandArea?.setPointerCapture(event.pointerId)
  }

  function moveScrub(event: PointerEvent): void {
    if (!scrubbing) return
    scrubSeconds = secondsAt(event.clientX)
  }

  function endScrub(event: PointerEvent): void {
    if (!scrubbing) return
    scrubbing = false
    bandArea?.releasePointerCapture(event.pointerId)
    goTo(secondsAt(event.clientX))
  }

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
    if (!element) return null
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0) return null
    return { x: rect.left + (clamp(seconds) / duration) * rect.width, y: rect.top }
  }

  /** Open the comment bubble for a note, seeking the composition to its second. */
  function openNote(id: string, seconds: number): void {
    goTo(seconds)
    anchor = anchorAt(seconds)
    editing = { id, seconds }
  }

  /** Comment on the moment the playhead is on: write the note, then open its bubble. */
  function startNote(): void {
    const seconds = shown
    const id = newVideoNoteId()
    writeNote(id, seconds, '')
    openNote(id, seconds)
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
      ? 'absolute top-1 flex h-5 -translate-x-1/2 items-center gap-1 rounded-full border border-primary bg-primary/15 px-1.5 text-[0.5625rem] text-foreground tabular-nums transition-colors'
      : 'absolute top-1 flex h-5 -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-elevated px-1.5 text-[0.5625rem] text-muted tabular-nums transition-colors hover:text-foreground'
  }

  onMount(() => {
    mounted = true
    void load()
    return () => {
      mounted = false
    }
  })

  // The page owns the clock, so the panel reads it rather than running one of its
  // own. Only the tab is read here, so a state report cannot restart the timer.
  $effect(() => {
    const current = tab
    if (!current) return
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  })

  // A jump from the composer names the note it wants; this board is what takes it
  // once it is showing that composition.
  $effect(() => {
    const request = videoNoteFocusState.pending(projectId, threadId)
    if (!request || request.directory !== directory) return
    const match = notes.find((entry) => entry.reference.id === request.referenceId)
    videoNoteFocusState.consume(request.token)
    if (match) openNote(match.reference.id, match.reference.seconds ?? request.seconds)
    else goTo(request.seconds)
  })
</script>

<div
  class="rounded-xl border border-border bg-surface p-3"
  role="group"
  aria-label="Composition timeline"
>
  <div class="flex items-center justify-between gap-2">
    <div class="flex items-center gap-1.5">
      <Clapperboard size={13} class="text-accent" aria-hidden="true" />
      <span class="text-xs font-semibold text-foreground">Timeline</span>
      <span class="text-[0.6875rem] text-muted tabular-nums">
        {videoTimecode(shown)} / {videoTimecode(duration)}
      </span>
    </div>
    <div class="flex items-center gap-0.5">
      <button
        type="button"
        class="flex h-7 w-7 items-center justify-center rounded-md text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
        title="Step back one frame"
        aria-label="Step back one frame"
        disabled={!tab}
        onclick={() => step(-1)}
      >
        <SkipBack size={13} />
      </button>
      <button
        type="button"
        class="flex h-7 w-7 items-center justify-center rounded-md text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
        title={playing ? 'Pause the composition' : 'Play the composition'}
        aria-label={playing ? 'Pause the composition' : 'Play the composition'}
        disabled={!tab}
        onclick={() => void command('toggle')}
      >
        {#if playing}
          <Pause size={13} />
        {:else}
          <Play size={13} />
        {/if}
      </button>
      <button
        type="button"
        class="flex h-7 w-7 items-center justify-center rounded-md text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
        title="Step forward one frame"
        aria-label="Step forward one frame"
        disabled={!tab}
        onclick={() => step(1)}
      >
        <SkipForward size={13} />
      </button>
      <button
        type="button"
        class="flex h-7 w-7 items-center justify-center rounded-md text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
        title="Comment on the moment the playhead is on"
        aria-label="Comment on the moment the playhead is on"
        disabled={!manifest}
        onclick={startNote}
      >
        <MessageSquarePlus size={13} />
      </button>
    </div>
  </div>

  {#if error}
    <p class="mt-2 text-xs text-danger">{error}</p>
  {:else if !manifest}
    <p class="mt-2 text-xs text-dimmed">
      This folder has no readable composition.json, so there is no timeline to draw.
    </p>
  {:else}
    {#if !tab}
      <p class="mt-2 text-xs text-dimmed">
        Waiting for the composition to load. The timeline still shows what it declares.
      </p>
    {/if}

    <div class="mt-2 select-none">
      <div class="relative h-4">
        {#each ticks as tick (tick.seconds)}
          <span
            class="absolute top-0 -translate-x-1/2 text-[0.625rem] text-dimmed tabular-nums"
            style={`left: ${tick.fraction * 100}%`}>{tick.label}</span
          >
        {/each}
      </div>

      <div
        bind:this={bandArea}
        class="relative mt-1 rounded-lg border border-border bg-app"
        role="group"
        aria-label="Playhead"
        onpointerdown={beginScrub}
        onpointermove={moveScrub}
        onpointerup={endScrub}
        onpointercancel={endScrub}
      >
        <div class="relative h-6 border-b border-border">
          {#each captions as band (band.key)}
            {@const geometry = videoBandGeometry(band.start, band.end, duration)}
            <span
              class="absolute top-1 h-4 overflow-hidden rounded-sm bg-accent/25 px-1 text-[0.5625rem] leading-4 whitespace-nowrap text-foreground"
              style={`left: ${geometry.left}; width: ${geometry.width};`}
              title={`${videoTimecode(band.start)} ${band.text}`}>{band.text}</span
            >
          {/each}
          {#if captions.length === 0}
            <span class="absolute top-1 left-2 text-[0.625rem] text-dimmed">No captions</span>
          {/if}
        </div>

        {#each lanes as lane, index (lane.key)}
          {@const geometry = videoBandGeometry(lane.start, lane.start + lane.duration, duration)}
          <div
            class="relative border-b border-border last:border-b-0"
            style={`height: ${LANE_HEIGHT}`}
          >
            <span
              class="absolute top-0.5 left-1 z-10 max-w-[45%] truncate text-[0.5625rem] text-muted"
              title={`${lane.source} (gain ${lane.gain})`}>{lane.label}</span
            >
            <span
              class="absolute top-0 bottom-0 overflow-hidden rounded-sm border border-accent/40 bg-accent/10"
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
                <span class="flex h-full items-center justify-center text-[0.5625rem] text-dimmed">
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

        <div class="relative h-7 border-t border-border">
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
              <Clapperboard size={9} aria-hidden="true" />
              {note.number}
            </button>
          {/each}
        </div>

        <span
          class="pointer-events-none absolute top-0 bottom-0 z-20 w-px bg-primary"
          style={`left: ${playhead}`}
          aria-hidden="true"
        ></span>
      </div>

      <p class="mt-2 flex items-center gap-1.5 text-[0.6875rem] text-dimmed">
        <MessageSquarePlus size={11} aria-hidden="true" />
        {notes.length === 0
          ? 'No comments on this composition yet.'
          : `${notes.length} comment${notes.length === 1 ? '' : 's'} on this composition`}
      </p>

      {#if editing && anchor}
        <!--
          A moment is commented on the way every other annotation is: the one
          comment bubble the app draws, anchored to the second it belongs to.
          The bubble is a fixed-position overlay, so it takes no space in the
          timeline and the editor below stays a timeline.
        -->
        <ResponseAnnotationComment
          x={anchor.x}
          y={anchor.y}
          title="Comment on this moment"
          dragHandleTitle="Move moment comment"
          closeLabel="Close moment comment"
          removeTitle="Remove this note and its comment"
          initialComment={notes.find((entry) => entry.reference.id === editing?.id)?.reference
            .comment ?? ''}
          targetId={`video-note-comment-${threadId}-${editing.id}`}
          scope={{ kind: 'project', projectId }}
          onDraftChange={(comment) => draftComment(editing?.id ?? '', comment)}
          onDone={(comment) => saveComment(editing?.id ?? '', comment)}
          onRemove={() => removeNote(editing?.id ?? '')}
          onClose={closeEditor}
        />
      {/if}
    </div>
  {/if}
</div>
