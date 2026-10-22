<script lang="ts">
  import CioChevronDown from '@pdslng/cio-icon/CioChevronDown.svelte'
  import CioPause from '@pdslng/cio-icon/CioPause.svelte'
  import CioPlay from '@pdslng/cio-icon/CioPlay.svelte'
  import CioSkipBack from '@pdslng/cio-icon/CioSkipBack.svelte'
  import { onMount } from 'svelte'
  import { invoke } from '$lib/ipc.svelte'
  import EnumSelect from '$lib/components/ui/EnumSelect.svelte'
  import SeekBar from '$lib/components/ui/SeekBar.svelte'
  import Switch from '$lib/components/ui/Switch.svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import { videoTimecode } from '$shared/video/timeline'
  import type {
    VideoAudioTrack,
    VideoJob,
    VideoStudioDocument,
    VideoValue
  } from '$shared/video/studio'

  /** The editor sections, as the timeline's tab strip names them. */
  type EditorSection = 'timeline' | 'captions' | 'audio' | 'exports'

  /**
   * The editable half of a composition: its values, its captions, its audio, its jobs.
   *
   * It is not a card and it has no header of its own. The timeline above draws one
   * tab strip and this is the body of the tab that is open, so a tab titled "Audio"
   * that then said "Settings · Audio tracks" would be the panel restating the tab.
   * Each section therefore draws only its own rows, on the board's own surface,
   * with no frame around them: the panel is already the frame.
   */
  interface Props {
    projectId: string
    directory: string
    /** Which section is open, owned by the timeline's tab strip. */
    section: EditorSection
    /**
     * The composition's jobs, owned by the board.
     *
     * The board polls them because it draws the export in its own dock, so it holds
     * the one list and hands it down instead of these controls reading a second copy
     * that could disagree. The board also cancels a job, so the cancel action is a
     * request rather than a second writer of the same state.
     */
    jobs: VideoJob[]
    onCancelJob: (id: string) => void
    /**
     * Start an export.
     *
     * The board owns the export, so it reports in the shared dockable export panel
     * its own menu opens rather than a second copy of that surface. These controls
     * only say when the user asked for one.
     */
    onExport: () => void
    /**
     * Put the composition's playhead somewhere.
     *
     * A caption and a track are both things placed in time, so opening one is
     * only useful if the picture goes there too. The timeline owns the playhead,
     * so it hands the request down rather than these controls driving the page
     * themselves.
     */
    onSeek?: (seconds: number) => void
    /**
     * Whether these controls hold unsaved edits.
     *
     * The board's Refresh reloads them, so it must know when that would throw work
     * away and ask first. The board owns the question; the controls own the answer.
     */
    onDirtyChange?: (dirty: boolean) => void
    /** Told after a save, so the timeline's bands re-read the file they draw. */
    onSaved?: () => void
  }
  let {
    projectId,
    directory,
    section,
    jobs,
    onCancelJob,
    onExport,
    onSeek,
    onDirtyChange,
    onSaved
  }: Props = $props()
  let studio = $state<VideoStudioDocument | null>(null)
  let revision = ''
  let error = $state('')
  let busy = $state(false)
  let dirty = $state(false)
  let cancelledJob = $state<VideoJob | null>(null)
  let captionPage = $state(0)
  /** Which track boxes are folded open, by index. The first opens by default. */
  let openTracks = $state<Record<number, boolean>>({})
  /** Which caption boxes are folded open, by place in the list. */
  let openCaptions = $state<Record<number, boolean>>({})
  /** Which job records are folded open, by id. A running job opens by itself. */
  let openJobs = $state<Record<string, boolean>>({})
  /**
   * The track being auditioned, and where the file is playing.
   *
   * One element for the whole list rather than one per track: two tracks playing
   * at once is never what a user means by pressing play on a row, and the browser
   * refuses the second play anyway. The index says which row owns the sound.
   */
  let audio = $state<HTMLAudioElement | null>(null)
  let auditionIndex = $state<number | null>(null)
  let auditionSeconds = $state(0)
  let auditionPlaying = $state(false)
  /** The trim window of the track in the element, so playback stops at its end. */
  let auditionWindow = { start: 0, end: 0 }
  let visibleCaptions = $derived(
    studio?.captions.slice(captionPage * 25, captionPage * 25 + 25) ?? []
  )
  let mounted = false
  let panel: HTMLElement | null = null
  /** The caption styles the studio accepts, as the app's own picker form. */
  const CAPTION_STYLES = [
    { id: 'plain', label: 'Plain', hint: 'One line of text, drawn as it is written.' },
    {
      id: 'highlight',
      label: 'Highlight word',
      hint: 'The word being spoken is drawn in the accent colour.'
    },
    { id: 'karaoke', label: 'Karaoke', hint: 'Words fill in as they are spoken.' }
  ] as const
  const labels: Record<string, string> = {
    filmstrip: 'Footage frames',
    waveform: 'Waveform',
    listen: 'Audio excerpt',
    transcribe: 'Transcription',
    cut: 'Video cut',
    export: 'Video export',
    track: 'Motion tracking',
    'remove-background': 'Background removal'
  }
  /** A job still going, which an export would queue behind rather than replace. */
  let running = $derived(jobs.filter((job) => job.state === 'running'))

  function primaryAction(event: KeyboardEvent): void {
    if (
      !(event.target instanceof Node) ||
      !panel?.contains(event.target) ||
      cancelledJob ||
      !keymapState.matches('video-primary-action', event)
    )
      return
    event.preventDefault()
    event.stopPropagation()
    if (dirty) void save()
    else onExport()
  }

  async function load(): Promise<void> {
    busy = true
    try {
      const result = await invoke('video:studio', projectId, directory)
      if (!mounted) return
      studio = result.document
      revision = result.revision
      dirty = false
      error = ''
      captionPage = 0
    } catch (cause) {
      if (mounted) error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      if (mounted) busy = false
    }
  }
  onMount(() => {
    mounted = true
    void load()
    return () => {
      mounted = false
    }
  })

  // Tell the board whether a refresh would discard anything. The board reads this
  // to decide between reloading at once and asking first.
  $effect(() => {
    onDirtyChange?.(dirty)
  })
  function setControl(key: string, value: VideoValue): void {
    const control = studio?.controls.find((item) => item.key === key)
    if (control) {
      control.value = value
      dirty = true
    }
  }
  async function save(): Promise<void> {
    if (!studio || busy) return
    busy = true
    try {
      const result = await invoke(
        'video:save',
        projectId,
        directory,
        $state.snapshot(studio),
        revision
      )
      studio = result.document
      revision = result.revision
      dirty = false
      error = ''
      onSaved?.()
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      busy = false
    }
  }
  function cancel(): void {
    if (!cancelledJob) return
    onCancelJob(cancelledJob.id)
    cancelledJob = null
  }

  /**
   * Where a track's audio is served from.
   *
   * A track names a file relative to the composition folder, and that folder lives
   * inside the project, so the app's own `appfile://` reader resolves it with the
   * Range support a media element needs to seek. Nothing is copied and no second
   * player is invented: the browser plays the same bytes the export will mix.
   */
  function trackUrl(source: string): string {
    const relative = `${directory}/${source}`
      .split('/')
      .filter(Boolean)
      .map((segment) => encodeURIComponent(segment))
      .join('/')
    return `appfile://project/${projectId}/${relative}`
  }

  /** The end of a track's used window, which is where auditioning stops. */
  function trackEnd(track: VideoAudioTrack): number {
    return track.trim + Math.max(track.duration, 0.01)
  }

  /** Play or pause one track in place, from the place it was left at. */
  function auditionTrack(index: number, track: VideoAudioTrack): void {
    const element = audio
    if (!element) return
    if (auditionIndex === index && auditionPlaying) {
      element.pause()
      return
    }
    const url = trackUrl(track.source)
    if (element.src !== url) element.src = url
    if (auditionIndex !== index) {
      auditionIndex = index
      auditionWindow = { start: track.trim, end: trackEnd(track) }
      auditionSeconds = track.trim
      element.currentTime = track.trim
    }
    element.volume = Math.min(1, Math.max(0, track.gain))
    void element.play().catch(() => {
      auditionPlaying = false
    })
  }

  /** Move the audition to a second inside a track's window, loading it if needed. */
  function seekTrack(index: number, track: VideoAudioTrack, seconds: number): void {
    const element = audio
    if (!element) return
    const url = trackUrl(track.source)
    if (element.src !== url) element.src = url
    if (auditionIndex !== index) {
      auditionIndex = index
      auditionWindow = { start: track.trim, end: trackEnd(track) }
    }
    const target = Math.min(Math.max(seconds, auditionWindow.start), auditionWindow.end)
    element.currentTime = target
    auditionSeconds = target
  }

  /** Follow the element, and stop at the end of the track's own window. */
  function auditionTimeUpdate(): void {
    const element = audio
    if (!element) return
    if (element.currentTime >= auditionWindow.end) {
      element.pause()
      element.currentTime = auditionWindow.start
      auditionSeconds = auditionWindow.start
      return
    }
    auditionSeconds = element.currentTime
  }

  /** Fold a track, silencing it if it is the one playing. */
  function toggleTrack(index: number, open: boolean): void {
    openTracks = { ...openTracks, [index]: !open }
    if (!open && auditionIndex === index) audio?.pause()
  }

  /** A job whose record is worth reading: it has files or an error to show. */
  function jobMessages(job: VideoJob): string {
    return [...job.files, job.error ?? ''].filter((line) => line !== '').join('\n')
  }
</script>

<svelte:window onkeydown={primaryAction} />
{#snippet compositionValues()}
  {#if studio !== null && studio.controls.length > 0}
    <div class="space-y-1.5 pt-1">
      {#each studio.controls as control (control.key)}
        <div class="flex items-center justify-between gap-2">
          <label for={`video-${control.key}`} class="min-w-0 truncate text-xs text-muted">
            {control.label}
          </label>
          {#if control.kind === 'switch'}
            <Switch
              checked={control.value === true}
              label={control.label}
              title={control.label}
              aria-label={control.label}
              onchange={(value) => setControl(control.key, value)}
            />
          {:else if control.kind === 'color'}
            <input
              id={`video-${control.key}`}
              class="h-7 w-12 shrink-0 cursor-pointer border border-border bg-elevated p-0.5"
              type="color"
              value={String(control.value)}
              title={control.label}
              aria-label={control.label}
              oninput={(event) => setControl(control.key, event.currentTarget.value)}
            />
          {:else}
            <input
              id={`video-${control.key}`}
              class="h-7 w-28 shrink-0 border border-border bg-elevated px-2 text-xs text-foreground tabular-nums outline-none focus:border-primary"
              type={control.kind === 'number' ? 'number' : 'text'}
              value={String(control.value)}
              min={control.min}
              max={control.max}
              step="any"
              oninput={(event) =>
                setControl(
                  control.key,
                  control.kind === 'number'
                    ? Number(event.currentTarget.value)
                    : event.currentTarget.value
                )}
            />
          {/if}
        </div>
      {/each}
    </div>
  {:else}
    <p class="pt-1 text-[0.6875rem] text-dimmed">This composition declares no values to edit.</p>
  {/if}
{/snippet}

<div
  {@attach (node) => {
    panel = node
    return () => {
      panel = null
    }
  }}
  class="min-w-0 pr-2.5"
  role="group"
  aria-label="Composition editor"
>
  {#if error}
    <p class="mb-2 bg-danger/10 px-2 py-1 text-xs text-danger" role="alert">
      {error}
    </p>
  {/if}
  {#if studio}
    <form
      onsubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <fieldset disabled={busy} class="min-w-0">
        <legend class="sr-only">Composition editor</legend>
        {#if dirty}
          <div class="mb-2 flex items-center justify-end gap-2">
            <span class="text-[0.6875rem] text-dimmed">Unsaved changes</span>
            <button
              type="submit"
              class="flex h-7 shrink-0 items-center bg-primary px-2.5 text-xs font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
            >
              Save changes
            </button>
          </div>
        {/if}

        {#if section === 'timeline'}
          {#if studio.captions.length === 0}{@render compositionValues()}{/if}
        {:else if section === 'captions'}
          {@render compositionValues()}
          {#if studio.captions.length > 0}
            <div class="mt-3 space-y-2">
              <div class="flex items-center justify-between gap-2">
                <span class="text-[0.6875rem] font-medium text-muted">
                  Captions
                  <span class="tabular-nums text-dimmed">{studio.captions.length}</span>
                </span>
                <EnumSelect
                  options={CAPTION_STYLES}
                  value={studio.captionStyle}
                  placeholder="Plain"
                  ariaLabel="Caption style"
                  title="How the captions are drawn over the composition"
                  inline
                  compact
                  onChange={(style) => {
                    if (!studio) return
                    studio.captionStyle = style
                    dirty = true
                  }}
                />
              </div>
              <!--
                One box per caption, folded, exactly like a track in the audio
                section. The header is the caption as the reader looks for it: its
                opening words and when it is on screen. Opening it also puts the
                playhead where the words start, because a caption is a moment
                before it is a piece of text, and editing one without seeing the
                frame it lands on is editing blind.
              -->
              <div class="space-y-1.5">
                {#each visibleCaptions as caption, index (index)}
                  {@const position = captionPage * 25 + index}
                  {@const open = openCaptions[position] ?? false}
                  <div class="border border-border">
                    <div class="flex items-center gap-1">
                      <button
                        type="button"
                        class="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left transition-colors hover:bg-elevated"
                        aria-expanded={open}
                        title={`${open ? 'Fold' : 'Open'} this caption and put the playhead at ${videoTimecode(caption.start)}`}
                        onclick={() => {
                          openCaptions[position] = !open
                          onSeek?.(caption.start)
                        }}
                      >
                        <CioChevronDown
                          size={12}
                          aria-hidden="true"
                          class="shrink-0 text-muted {open
                            ? 'rotate-180'
                            : ''} transition-transform"
                        />
                        <span class="min-w-0 flex-1 truncate text-xs text-foreground">
                          {caption.text.trim() === '' ? 'Empty caption' : caption.text}
                        </span>
                        <span class="shrink-0 text-[0.625rem] text-dimmed tabular-nums">
                          {videoTimecode(caption.start)} ·
                          {(caption.end - caption.start).toFixed(2)}s
                        </span>
                      </button>
                      <button
                        type="button"
                        class="flex h-7 w-7 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                        title={`Put the playhead at ${videoTimecode(caption.start)}`}
                        aria-label={`Put the playhead where this caption starts, ${videoTimecode(caption.start)}`}
                        onclick={() => onSeek?.(caption.start)}
                      >
                        <CioSkipBack size={12} />
                      </button>
                    </div>
                    {#if open}
                      <div class="space-y-1.5 px-2 pt-0.5 pb-2">
                        <textarea
                          class="w-full border border-border bg-elevated p-1.5 text-xs leading-snug text-foreground outline-none focus:border-primary"
                          rows="2"
                          aria-label={`Text of the caption at ${videoTimecode(caption.start)}`}
                          bind:value={caption.text}
                          oninput={() => {
                            caption.words = undefined
                            dirty = true
                          }}></textarea>
                        <div class="grid grid-cols-2 gap-1.5">
                          {#each ['start', 'end'] as field (field)}
                            {@const key = field as 'start' | 'end'}
                            <label
                              class="flex items-center justify-between gap-1 text-[0.6875rem] text-muted"
                            >
                              {field}
                              <input
                                type="number"
                                class="h-7 w-16 border border-border bg-elevated px-2 text-xs text-foreground tabular-nums outline-none focus:border-primary"
                                min="0"
                                step="0.01"
                                bind:value={caption[key]}
                                onchange={() => {
                                  caption.words = undefined
                                  dirty = true
                                }}
                              />
                            </label>
                          {/each}
                        </div>
                      </div>
                    {/if}
                  </div>
                {/each}
              </div>
              {#if studio.captions.length > 25}
                <div class="flex items-center justify-between gap-2 pt-1">
                  <button
                    type="button"
                    class="h-7 px-2 text-[0.6875rem] text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
                    disabled={captionPage === 0}
                    onclick={() => {
                      captionPage -= 1
                    }}
                  >
                    Previous
                  </button>
                  <span class="text-[0.6875rem] text-dimmed tabular-nums">
                    {captionPage * 25 + 1}–{Math.min(
                      (captionPage + 1) * 25,
                      studio.captions.length
                    )} of {studio.captions.length}
                  </span>
                  <button
                    type="button"
                    class="h-7 px-2 text-[0.6875rem] text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
                    disabled={(captionPage + 1) * 25 >= studio.captions.length}
                    onclick={() => {
                      captionPage += 1
                    }}
                  >
                    Next
                  </button>
                </div>
              {/if}
            </div>
          {:else}
            <p class="pt-1 text-[0.6875rem] text-dimmed">
              This composition declares no captions. They arrive with the composition's transcript.
            </p>
          {/if}
        {:else if section === 'audio'}
          {#if studio.audioTracks.length === 0}
            <p class="pt-1 text-[0.6875rem] text-dimmed">
              This composition declares no audio tracks to place.
            </p>
          {:else}
            <!--
              One box per track, and each box folds. A track is a thing the user
              works on whole: its placement, its trim and how loud it sits. The
              header is where it is named and where it is played, because
              auditioning a file is how a placement is decided, and the two
              belong on one line rather than in a player somewhere else.
            -->
            <div class="space-y-1.5 pt-1">
              {#each studio.audioTracks as track, index (index)}
                {@const open = openTracks[index] ?? index === 0}
                {@const playing = auditionIndex === index && auditionPlaying}
                {@const at = auditionIndex === index ? auditionSeconds : track.trim}
                <div class="border border-border">
                  <div class="flex items-center gap-1">
                    <button
                      type="button"
                      class="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left transition-colors hover:bg-elevated"
                      aria-expanded={open}
                      title={`${open ? 'Fold' : 'Open'} ${track.source}, ${videoTimecode(track.start)} for ${track.duration.toFixed(2)}s at gain ${track.gain}`}
                      onclick={() => {
                        toggleTrack(index, open)
                        onSeek?.(track.start)
                      }}
                    >
                      <CioChevronDown
                        size={12}
                        aria-hidden="true"
                        class="shrink-0 text-muted {open ? 'rotate-180' : ''} transition-transform"
                      />
                      <span class="min-w-0 flex-1 truncate text-xs text-foreground">
                        {track.source.split('/').pop() ?? track.source}
                      </span>
                      <span class="shrink-0 text-[0.625rem] text-dimmed tabular-nums">
                        {videoTimecode(track.start)} · {track.duration.toFixed(2)}s
                      </span>
                    </button>
                    <button
                      type="button"
                      class="flex h-7 w-7 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                      title={playing
                        ? `Pause ${track.source} here`
                        : `Play ${track.source} from ${videoTimecode(at)}`}
                      aria-label={playing
                        ? `Pause ${track.source} here`
                        : `Play ${track.source} from ${videoTimecode(at)}`}
                      onclick={() => auditionTrack(index, track)}
                    >
                      {#if playing}
                        <CioPause size={12} />
                      {:else}
                        <CioPlay size={12} />
                      {/if}
                    </button>
                    <button
                      type="button"
                      class="flex h-7 w-7 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
                      title="Seek this track back to its trim start"
                      aria-label="Seek this track back to its trim start"
                      disabled={at <= track.trim}
                      onclick={() => seekTrack(index, track, track.trim)}
                    >
                      <CioSkipBack size={12} />
                    </button>
                  </div>
                  {#if open}
                    <div class="flex items-center gap-2 px-2 pt-0.5 pb-2">
                      <SeekBar
                        class="min-w-0 flex-1"
                        value={at}
                        min={track.trim}
                        max={trackEnd(track)}
                        step={0.05}
                        label={`Seek ${track.source}`}
                        title={`Seek ${track.source}`}
                        onInput={(seconds) => seekTrack(index, track, seconds)}
                      />
                      <span class="shrink-0 text-[0.625rem] text-muted tabular-nums">
                        {videoTimecode(at)}<span class="text-dimmed">
                          / {videoTimecode(trackEnd(track))}</span
                        >
                      </span>
                    </div>
                    <div class="space-y-1.5 px-2 pb-2">
                      <div class="grid grid-cols-2 gap-1.5">
                        {#each ['start', 'trim', 'duration', 'gain'] as field (field)}
                          {@const key = field as 'start' | 'trim' | 'duration' | 'gain'}
                          <label
                            class="flex items-center justify-between gap-1 text-[0.6875rem] text-muted"
                          >
                            {field}
                            <input
                              type="number"
                              class="h-7 w-16 border border-border bg-elevated px-2 text-xs text-foreground tabular-nums outline-none focus:border-primary"
                              min="0"
                              step="0.01"
                              bind:value={track[key]}
                              onchange={() => {
                                dirty = true
                              }}
                            />
                          </label>
                        {/each}
                      </div>
                      <p
                        class="truncate font-mono text-[0.625rem] text-dimmed"
                        title={track.source}
                      >
                        {track.source}
                      </p>
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        {:else}
          <div class="flex items-center justify-between gap-2 pt-1">
            <p class="min-w-0 text-[0.6875rem] leading-relaxed text-muted">
              {running.length > 0
                ? `${running.length} job${running.length === 1 ? '' : 's'} still running in this composition.`
                : 'Render the composition to a video file. It opens in the export panel while it runs.'}
            </p>
            <button
              type="button"
              class="flex h-7 shrink-0 items-center gap-1.5 bg-primary px-2.5 text-xs font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
              title="Render this composition to a video file"
              aria-label="Render this composition to a video file"
              onclick={onExport}
            >
              Export video
            </button>
          </div>
        {/if}
      </fieldset>
    </form>
  {/if}

  {#if section === 'exports'}
    <!--
      The jobs, one folded box each. A job's record is a list of paths and the
      reason it failed, which is reading matter rather than a row: it lives in a
      code block under the fold so a finished render reads as one line and the
      panel does not turn into a log. A running job keeps its progress in sight.
    -->
    <div class="mt-2 space-y-1.5">
      {#each jobs as job (job.id)}
        {@const messages = jobMessages(job)}
        {@const open = openJobs[job.id] ?? job.state === 'running'}
        <div class="border border-border">
          <div class="flex items-center gap-1">
            <button
              type="button"
              class="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left transition-colors hover:bg-elevated disabled:cursor-default disabled:hover:bg-transparent"
              aria-expanded={open}
              disabled={messages === '' && job.state !== 'running'}
              title={`${open ? 'Fold' : 'Open'} ${labels[job.operation] ?? 'video processing'}, ${job.state}`}
              onclick={() => (openJobs = { ...openJobs, [job.id]: !open })}
            >
              <CioChevronDown
                size={12}
                aria-hidden="true"
                class="shrink-0 text-muted {open ? 'rotate-180' : ''} transition-transform"
              />
              <span class="min-w-0 flex-1 truncate text-xs text-foreground">
                {labels[job.operation] ?? 'Video processing'}
                <span class="text-muted">· {job.stage}</span>
              </span>
              <span
                class="shrink-0 text-[0.625rem] tabular-nums {job.state === 'failed'
                  ? 'text-danger'
                  : job.state === 'running'
                    ? 'text-muted'
                    : 'text-dimmed'}"
              >
                {job.state === 'running' ? `${Math.round(job.progress * 100)}%` : job.state}
              </span>
            </button>
            {#if job.state === 'running'}
              <button
                type="button"
                class="shrink-0 px-2 text-[0.6875rem] text-danger transition-colors hover:underline"
                title="Cancel this render"
                onclick={() => {
                  cancelledJob = job
                }}
              >
                Cancel
              </button>
            {/if}
          </div>
          {#if job.state === 'running'}
            <progress
              class="h-0.5 w-full accent-primary"
              value={job.progress}
              max="1"
              aria-label={`${labels[job.operation] ?? job.operation} progress`}
            ></progress>
          {/if}
          {#if open && messages !== ''}
            <pre
              class="overflow-x-auto bg-app px-2 py-1.5 font-mono text-[0.625rem] leading-relaxed whitespace-pre-wrap text-muted"><code
                >{messages}</code
              ></pre>
          {/if}
        </div>
      {/each}
      {#if jobs.length === 0}
        <p class="text-[0.6875rem] text-dimmed">No render has run for this composition yet.</p>
      {/if}
    </div>
  {/if}
</div>

<!--
  The one player for the audio section.

  It has no controls of its own: the track headers are the controls, so this is
  the element they drive rather than a second surface the user would have to
  match a row against. It stays mounted so a paused audition resumes where the
  user left it, and folds away with nothing to show.
-->
<audio
  {@attach (node) => {
    audio = node
    return () => {
      node.pause()
      audio = null
    }
  }}
  hidden
  preload="metadata"
  onplay={() => (auditionPlaying = true)}
  onpause={() => (auditionPlaying = false)}
  onended={() => (auditionPlaying = false)}
  ontimeupdate={auditionTimeUpdate}
></audio>

<ConfirmDialog
  open={cancelledJob !== null}
  title="Cancel video processing?"
  confirmLabel="Cancel processing"
  cancelLabel="Keep processing"
  onCancel={() => {
    cancelledJob = null
  }}
  onConfirm={cancel}
>
  <p>The unfinished output will be discarded. Your source footage and composition will be kept.</p>
</ConfirmDialog>
