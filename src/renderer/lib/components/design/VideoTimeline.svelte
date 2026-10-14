<script lang="ts">
  import {
    Clapperboard,
    Pause,
    Pencil,
    Play,
    Plus,
    SkipBack,
    SkipForward,
    Trash2,
    X
  } from '@lucide/svelte'
  import { onMount } from 'svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { responseReferencesState } from '$lib/stores/response-references.svelte'
  import { videoTimelineState } from '$lib/stores/video-timeline.svelte'
  import { videoNoteFocusState } from '$lib/stores/video-note-focus.svelte'
  import { newVideoNoteId, videoNoteReference } from '$lib/video-note-reference'
  import {
    videoAudioLanes,
    videoBandGeometry,
    videoCaptionBands,
    videoFrameAt,
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
  /** Main refuses a comment longer than this on send, so a note is written within it. */
  const MAX_NOTE_LENGTH = 2_000
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

  /** The note being written or edited, and the second it belongs to. */
  let editingId = $state<string | null>(null)
  let draft = $state('')
  let pinnedSeconds = $state<number | null>(null)

  const tab = $derived(videoTimelineState.compositionIn(projectId, threadId, directory))
  const duration = $derived(
    Math.max(manifest?.duration ?? tab?.duration ?? playback?.duration ?? 0, 0.001)
  )
  const fps = $derived(manifest?.fps ?? tab?.fps ?? 30)
  const frameStep = $derived(1 / Math.max(fps, 1))
  const time = $derived(playback?.time ?? 0)
  const playing = $derived(playback?.playing ?? false)
  const shown = $derived(Math.min(Math.max(scrubbing ? scrubSeconds : time, 0), duration))
  /** Where a note would land: the pinned second, or wherever the playhead is. */
  const noteSeconds = $derived(pinnedSeconds ?? shown)
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
    pinnedSeconds = target
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

  function editNote(id: string, seconds: number, comment: string): void {
    editingId = id
    draft = comment
    goTo(seconds)
  }

  function resetDraft(): void {
    editingId = null
    pinnedSeconds = null
    draft = ''
  }

  /**
   * Write or update the note at the pinned second, and attach it to the composer.
   *
   * The reference is a `PromptReference` like any other, so it appears in the
   * composer the moment it is stored and travels with the next prompt. Its text
   * is the descriptor the model reads, rebuilt here so a note moved to another
   * second describes the second it actually sits at.
   */
  function commit(): void {
    const text = draft.trim().slice(0, MAX_NOTE_LENGTH)
    if (!text) return
    const id = editingId ?? newVideoNoteId()
    const existing = responseReferencesState.forThread(projectId, threadId)
    const previous = existing.find((candidate) => candidate.id === id)
    // Keep the tab a note was written against when the preview happens to be
    // closed right now, so editing it does not quietly cost the note its seek.
    const tabId = tab?.tabId ?? previous?.tabId
    const reference = {
      ...videoNoteReference(id, noteSeconds, {
        directory,
        composition: tab,
        document: studio,
        ...(tabId ? { tabId } : {})
      }),
      comment: text
    }
    const merged = previous
      ? existing.map((candidate) => (candidate.id === id ? reference : candidate))
      : [...existing, reference]
    responseReferencesState.setForThread(projectId, threadId, merged)
    resetDraft()
  }

  function removeNote(id: string): void {
    responseReferencesState.setForThread(
      projectId,
      threadId,
      responseReferencesState.forThread(projectId, threadId).filter((entry) => entry.id !== id)
    )
    if (editingId === id) resetDraft()
  }

  function onDraftKeydown(event: KeyboardEvent): void {
    if (!(event.metaKey || event.ctrlKey) || event.key !== 'Enter') return
    event.preventDefault()
    event.stopPropagation()
    commit()
  }

  function noteMarkerClass(active: boolean): string {
    return active
      ? 'absolute top-1 flex h-5 -translate-x-1/2 items-center gap-1 rounded-full border border-danger bg-danger/10 px-1.5 text-[0.5625rem] tabular-nums transition-colors'
      : 'absolute top-1 flex h-5 -translate-x-1/2 items-center gap-1 rounded-full border border-accent bg-accent/20 px-1.5 text-[0.5625rem] tabular-nums transition-colors'
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
    if (match)
      editNote(
        match.reference.id,
        match.reference.seconds ?? request.seconds,
        match.reference.comment ?? ''
      )
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
        Open the composition preview to play, scrub and step. The timeline still shows what the
        composition declares.
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
              class={noteMarkerClass(note.reference.id === editingId)}
              style={`left: ${(Math.min(seconds, duration) / duration) * 100}%`}
              title={`${videoTimecode(seconds)} ${note.reference.comment ?? ''}`}
              aria-label={`Edit video note ${note.number}`}
              onclick={() => editNote(note.reference.id, seconds, note.reference.comment ?? '')}
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

      <form
        class="mt-2 space-y-2"
        onsubmit={(event) => {
          event.preventDefault()
          commit()
        }}
      >
        <div class="flex items-center justify-between gap-2">
          <span class="flex items-center gap-1.5 text-[0.6875rem] text-muted">
            <Pencil size={11} aria-hidden="true" />
            {editingId ? 'Editing note at' : 'New note at'}
            <button
              type="button"
              class="rounded bg-elevated px-1.5 py-0.5 font-medium text-foreground tabular-nums"
              title="Pin the note to this second, instead of following the playhead"
              aria-label="Pin the note to this second"
              onclick={() => (pinnedSeconds = shown)}
            >
              {videoTimecode(noteSeconds)}
            </button>
            <span class="text-dimmed">frame {videoFrameAt(noteSeconds, fps)}</span>
          </span>
          {#if editingId}
            <button
              type="button"
              class="flex h-6 w-6 items-center justify-center rounded text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
              title="Stop editing this note"
              aria-label="Stop editing this note"
              onclick={resetDraft}
            >
              <X size={12} />
            </button>
          {/if}
        </div>
        <textarea
          class="w-full resize-y rounded-lg border border-border bg-app px-2 py-1.5 text-xs text-foreground placeholder:text-dimmed focus:border-primary focus:outline-none"
          rows="2"
          placeholder="What should change at this moment? Time the cut, fix the caption, redraw the frame."
          aria-label="Video note"
          maxlength={MAX_NOTE_LENGTH}
          bind:value={draft}
          onkeydown={onDraftKeydown}></textarea>
        <div class="flex items-center gap-2">
          <button
            type="submit"
            class="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
            disabled={draft.trim().length === 0}
            title={editingId
              ? 'Update this note and keep it on the composer'
              : 'Attach this note to the composer'}
            aria-label={editingId ? 'Update this note' : 'Attach this note to the composer'}
          >
            <Plus size={12} aria-hidden="true" />
            {editingId ? 'Update note' : 'Add note'}
          </button>
          {#if editingId}
            <button
              type="button"
              class="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-danger transition-colors hover:bg-danger/10"
              title="Delete this note and detach it from the composer"
              aria-label="Delete this note"
              onclick={() => removeNote(editingId ?? '')}
            >
              <Trash2 size={12} aria-hidden="true" /> Delete
            </button>
          {/if}
          <span class="text-[0.6875rem] text-dimmed">
            {notes.length} note{notes.length === 1 ? '' : 's'} attached to this conversation
          </span>
        </div>
      </form>
    </div>
  {/if}
</div>
