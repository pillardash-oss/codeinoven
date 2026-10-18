<script lang="ts">
  import CioAudioLines from '@codeinoven/icons/CioAudioLines.svelte'
  import CioCaptions from '@codeinoven/icons/CioCaptions.svelte'
  import CioChevronDown from '@codeinoven/icons/CioChevronDown.svelte'
  import CioTabSettings from '@codeinoven/icons/CioTabSettings.svelte'
  import { onMount } from 'svelte'
  import { invoke } from '$lib/ipc.svelte'
  import EnumSelect from '$lib/components/ui/EnumSelect.svelte'
  import Switch from '$lib/components/ui/Switch.svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import type { VideoJob, VideoStudioDocument, VideoValue } from '$shared/video/studio'

  /**
   * What the composition declares as values, and what it is doing.
   *
   * The board reads the composition from the timeline and the picture; this card is
   * the editable half of the same file. It carries the parameters the composition
   * reads at draw time, the caption text and its style, the audio tracks, and the
   * jobs that are turning any of it into a file.
   *
   * It is a card like the timeline, not a second panel: the same icon-and-title
   * header, the same `text-xs` rows, the same inputs and pickers as the rest of the
   * app. Nothing here is titled "video controls", because the board is already the
   * video board and a label that restates its own surface is noise.
   */
  interface Props {
    projectId: string
    directory: string
    /**
     * The composition's jobs, owned by the board.
     *
     * The board polls them because it draws the export above these controls, so it
     * holds the one list and hands it down instead of the controls reading a second
     * copy that could disagree. The board also cancels a job, so the cancel action is
     * a request rather than a second writer of the same state.
     */
    jobs: VideoJob[]
    onCancelJob: (id: string) => void
    /**
     * Start an export.
     *
     * The board owns the export, so it reports in the shared dockable export
     * panel its own menu opens rather than a second copy of that surface. These
     * controls only say when the user asked for one.
     */
    onExport: () => void
    /**
     * Whether these controls hold unsaved edits.
     *
     * The board's Refresh reloads them, so it must know when that would throw work
     * away and ask first. The board owns the question; the controls own the answer.
     */
    onDirtyChange?: (dirty: boolean) => void
  }
  let { projectId, directory, jobs, onCancelJob, onExport, onDirtyChange }: Props = $props()
  let studio = $state<VideoStudioDocument | null>(null)
  let revision = ''
  let error = $state('')
  let busy = $state(false)
  let dirty = $state(false)
  let cancelledJob = $state<VideoJob | null>(null)
  let captionPage = $state(0)
  let captionsOpen = $state(false)
  let tracksOpen = $state(false)
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
</script>

<svelte:window onkeydown={primaryAction} />
<section
  {@attach (node) => {
    panel = node
    return () => {
      panel = null
    }
  }}
  class="mb-3 border border-border bg-surface p-3"
  aria-label="Composition settings"
>
  {#if error}
    <p class="mb-2 border border-danger/20 bg-danger/10 px-2 py-1 text-xs text-danger" role="alert">
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
      <fieldset disabled={busy} class="space-y-2">
        <legend class="sr-only">Composition settings</legend>
        <div class="flex items-center justify-between gap-2">
          <div class="flex min-w-0 items-center gap-1.5">
            <CioTabSettings size={13} class="text-accent" aria-hidden="true" />
            <span class="text-xs font-semibold text-foreground">Settings</span>
            {#if dirty}
              <span class="truncate text-[0.6875rem] text-muted">Unsaved changes</span>
            {/if}
          </div>
          {#if dirty}
            <button
              type="submit"
              class="flex h-7 shrink-0 items-center bg-primary px-2.5 text-xs font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
            >
              Save changes
            </button>
          {/if}
        </div>
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
        {#if studio.captions.length > 0}
          <div class="border-t border-border pt-2">
            <button
              type="button"
              class="flex w-full items-center justify-between gap-2 py-1 text-xs text-muted transition-colors hover:text-foreground"
              aria-expanded={captionsOpen}
              title={`Captions, ${studio.captions.length} in this composition`}
              aria-label={`Captions, ${studio.captions.length} in this composition`}
              onclick={() => (captionsOpen = !captionsOpen)}
            >
              <span class="flex items-center gap-1.5">
                <CioCaptions size={12} aria-hidden="true" />
                <span class="font-medium text-foreground">Captions</span>
                <span class="tabular-nums text-dimmed">{studio.captions.length}</span>
              </span>
              <CioChevronDown
                size={12}
                aria-hidden="true"
                class={captionsOpen ? 'rotate-180 transition-transform' : 'transition-transform'}
              />
            </button>
            {#if captionsOpen}
              <div class="mt-1 space-y-2 border border-border bg-app p-2">
                <div class="flex items-center justify-between gap-2">
                  <span class="text-xs text-muted">Style</span>
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
                {#each visibleCaptions as caption (caption)}
                  <div class="space-y-1 border-t border-border pt-2 first:border-t-0 first:pt-0">
                    <label class="block text-xs text-muted">
                      Caption at {caption.start.toFixed(2)}s
                      <textarea
                        class="mt-1 w-full border border-border bg-elevated p-1.5 text-xs text-foreground outline-none focus:border-primary"
                        rows="2"
                        bind:value={caption.text}
                        oninput={() => {
                          caption.words = undefined
                          dirty = true
                        }}></textarea>
                    </label>
                    <div class="flex gap-2">
                      <label class="flex items-center gap-1 text-xs text-muted">
                        Start
                        <input
                          type="number"
                          class="h-7 w-20 border border-border bg-elevated px-2 text-xs text-foreground tabular-nums outline-none focus:border-primary"
                          min="0"
                          step="0.01"
                          bind:value={caption.start}
                          onchange={() => {
                            caption.words = undefined
                            dirty = true
                          }}
                        />
                      </label>
                      <label class="flex items-center gap-1 text-xs text-muted">
                        End
                        <input
                          type="number"
                          class="h-7 w-20 border border-border bg-elevated px-2 text-xs text-foreground tabular-nums outline-none focus:border-primary"
                          min="0"
                          step="0.01"
                          bind:value={caption.end}
                          onchange={() => {
                            caption.words = undefined
                            dirty = true
                          }}
                        />
                      </label>
                    </div>
                  </div>
                {/each}
                {#if studio.captions.length > 25}
                  <div class="flex items-center justify-between gap-2 border-t border-border pt-2">
                    <button
                      type="button"
                      class="h-7 border border-border px-2 text-[0.6875rem] text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
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
                      class="h-7 border border-border px-2 text-[0.6875rem] text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
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
            {/if}
          </div>
        {/if}
        {#if studio.audioTracks.length > 0}
          <div class="border-t border-border pt-2">
            <button
              type="button"
              class="flex w-full items-center justify-between gap-2 py-1 text-xs text-muted transition-colors hover:text-foreground"
              aria-expanded={tracksOpen}
              title={`Audio tracks, ${studio.audioTracks.length} in this composition`}
              aria-label={`Audio tracks, ${studio.audioTracks.length} in this composition`}
              onclick={() => (tracksOpen = !tracksOpen)}
            >
              <span class="flex items-center gap-1.5">
                <CioAudioLines size={12} aria-hidden="true" />
                <span class="font-medium text-foreground">Audio tracks</span>
                <span class="tabular-nums text-dimmed">{studio.audioTracks.length}</span>
              </span>
              <CioChevronDown
                size={12}
                aria-hidden="true"
                class={tracksOpen ? 'rotate-180 transition-transform' : 'transition-transform'}
              />
            </button>
            {#if tracksOpen}
              <div class="mt-1 space-y-2 border border-border bg-app p-2">
                {#each studio.audioTracks as track (track)}
                  <div class="space-y-1.5 border-t border-border pt-2 first:border-t-0 first:pt-0">
                    <p class="truncate font-mono text-[0.625rem] text-muted" title={track.source}>
                      {track.source}
                    </p>
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
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </fieldset>
    </form>
  {/if}
  {#each jobs as job (job.id)}
    <div class="mt-2 space-y-1 border border-border bg-app p-2">
      <div class="flex items-center justify-between gap-2 text-xs">
        <span class="min-w-0 truncate">
          {labels[job.operation] ?? 'Video processing'}
          <span class="text-muted">· {job.stage}</span>
        </span>
        {#if job.state === 'running'}
          <button
            type="button"
            class="shrink-0 text-[0.6875rem] text-danger transition-colors hover:underline"
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
          class="h-1 w-full accent-primary"
          value={job.progress}
          max="1"
          aria-label={`${job.operation} progress`}
        ></progress>
      {/if}
      {#if job.error}
        <p class="text-[0.6875rem] text-danger">{job.error}</p>
      {/if}
      {#each job.files as file (file)}
        <p class="truncate font-mono text-[0.625rem] text-muted" title={file}>{file}</p>
      {/each}
    </div>
  {/each}
</section>

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
